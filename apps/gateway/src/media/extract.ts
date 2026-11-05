import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import mammoth from "mammoth";
import { PDFParse, PasswordException } from "pdf-parse";
import XLSX from "xlsx";

const RAW_TEXT_MIME_TYPES = new Set([
  "application/json",
  "text/csv",
  "text/markdown",
  "text/plain",
]);

const SPREADSHEET_MIME_TYPES = new Set([
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

export const PDF_OCR_LIMITS = {
  bytes: 25 * 1024 * 1024, pages: 30, outputChars: 250_000,
  executionMs: 45_000, concurrency: 2, queue: 8, queueWaitMs: 10_000,
  aggregateInputBytes: 50 * 1024 * 1024, childRssMb: 512,
  childCpuMs: 40_000,
} as const;
const MAX_PDF_BYTES = PDF_OCR_LIMITS.bytes;
const MAX_OCR_PAGES = PDF_OCR_LIMITS.pages;
const MAX_PDF_OUTPUT = PDF_OCR_LIMITS.outputChars;
const OCR_TIMEOUT_MS = PDF_OCR_LIMITS.executionMs;
const MAX_OCR_CONCURRENCY = PDF_OCR_LIMITS.concurrency;
let activeOcrWorkers = 0;
let admittedOcrBytes = 0;
const ocrWaiters: Array<{ bytes: number; resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }> = [];

export class ExtractionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ExtractionError";
  }
}

export async function extractText(
  filePath: string,
  mimeType: string,
  signal?: AbortSignal
): Promise<string | null> {
  return (await extractTextDetails(filePath, mimeType, signal)).text;
}

export async function extractTextDetails(
  filePath: string,
  mimeType: string,
  signal?: AbortSignal
): Promise<{ text: string | null; note?: string }> {
  signal?.throwIfAborted();
  if (RAW_TEXT_MIME_TYPES.has(mimeType)) {
    return { text: await fs.readFile(filePath, { encoding: "utf8", signal }) };
  }

  if (mimeType === "application/pdf") {
    return extractPdfBufferDetails(await fs.readFile(filePath, { signal }), signal);
  }

  if (
    mimeType ===
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    const result = await mammoth.extractRawText({ path: filePath });
    return { text: result.value };
  }

  if (SPREADSHEET_MIME_TYPES.has(mimeType)) {
    return { text: extractSpreadsheetText(filePath) };
  }

  return { text: null };
}

export async function extractPdfBuffer(buffer: Buffer, signal?: AbortSignal): Promise<string> {
  return (await extractPdfBufferDetails(buffer, signal)).text;
}

export async function extractPdfBufferDetails(buffer: Buffer, signal?: AbortSignal): Promise<{ text: string; note?: string }> {
  signal?.throwIfAborted();
  if (buffer.length > MAX_PDF_BYTES) throw new ExtractionError("File too large for text extraction (max 25 MB)");
  const parser = new PDFParse({ data: new Uint8Array(buffer) });

  try {
    const result = await parser.getText();
    signal?.throwIfAborted();
    const sparsePages = result.pages
      .filter((page) => page.text.trim().length < 40)
      .map((page) => page.num);
    if (sparsePages.length === 0) {
      const text = result.text.trim();
      if (text.length > MAX_PDF_OUTPUT) throw new ExtractionError("Text too long (over 250,000 characters)");
      return { text };
    }
    const pagesToOcr = sparsePages.sort((a, b) => a - b).slice(0, MAX_OCR_PAGES);
    const skippedPages = new Set(sparsePages.slice(MAX_OCR_PAGES));
    const ocrPages = await runPdfOcr(buffer, pagesToOcr, signal);
    const text = result.pages
      .map((page) => skippedPages.has(page.num) ? "" : ocrPages.get(page.num) || page.text.trim())
      .filter(Boolean)
      .join("\n\n");
    if (text.length > MAX_PDF_OUTPUT) throw new ExtractionError("Text too long (over 250,000 characters)");
    if (!text.trim() && skippedPages.size) {
      throw new ExtractionError(`Too many pages to OCR (${sparsePages.length} scanned pages, max ${MAX_OCR_PAGES})`);
    }
    return {
      text,
      ...(skippedPages.size ? { note: `Partial text: ${pagesToOcr.length} of ${sparsePages.length} scanned pages read` } : {}),
    };
  } catch (error) {
    if (error instanceof PasswordException) {
      throw new ExtractionError("PDF is password-protected", { cause: error });
    }
    throw error;
  } finally {
    await parser.destroy();
  }
}

function ocrFailure(message: string): Error {
  const reasons: Record<string, string> = {
    "PDF is encrypted and cannot be extracted": "PDF is password-protected",
    "PDF text exceeds output limit": "Text too long (over 250,000 characters)",
    "PDF OCR exceeded the 512MB memory limit": "OCR exceeded resource limits",
    "PDF OCR timed out after 45 seconds": "OCR timed out",
    "PDF OCR queue is full; try again shortly": "OCR busy, try again shortly",
    "PDF OCR queue timed out after 10 seconds": "OCR busy, try again shortly",
    "PDF OCR input admission limit reached; try again shortly": "OCR busy, try again shortly",
    "PDF OCR exceeded the 40 second CPU limit": "OCR exceeded resource limits",
  };
  const cause = new Error(message);
  return Object.hasOwn(reasons, message) ? new ExtractionError(reasons[message], { cause }) : cause;
}

export function runPdfOcr(data: Buffer, pages: number[], signal?: AbortSignal): Promise<Map<number, string>> {
  return acquireOcrSlot(data.length, signal).then(() => new Promise((resolve, reject) => {
    let released = false;
    const onAbort = () => finish(signal?.reason instanceof Error ? signal.reason : new Error("PDF OCR cancelled"));
    const release = () => {
      if (released) return;
      released = true;
      signal?.removeEventListener("abort", onAbort);
      activeOcrWorkers -= 1;
      admittedOcrBytes -= data.length;
      ocrWaiters.shift()?.resolve();
    };
    if (signal?.aborted) {
      release();
      reject(signal.reason);
      return;
    }
    let child: ReturnType<typeof fork>;
    let settled = false;
    let result: Array<{ number: number; text: string }> | undefined;
    let failure: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let settleTimer: NodeJS.Timeout | undefined;
    const finish = (error?: Error, pagesResult?: Array<{ number: number; text: string }>) => {
      if (settled) return;
      settled = true;
      failure = error;
      result = pagesResult;
      clearTimeout(timer);
      child.kill();
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
      settleTimer = setTimeout(() => {
        release();
        if (failure) reject(failure);
        else resolve(new Map(result?.map((page) => [page.number, page.text])));
      }, 2_000);
    };
    try {
      const sourceWorker = fileURLToPath(new URL("./pdf-ocr-worker.ts", import.meta.url));
      const workerPath = existsSync(sourceWorker)
        ? sourceWorker
        : fileURLToPath(new URL("./pdf-ocr-worker.js", import.meta.url));
      child = fork(workerPath, [], {
        serialization: "advanced",
        execArgv: existsSync(sourceWorker)
          ? ["--import", "tsx", "--max-old-space-size=256"]
          : ["--max-old-space-size=256"],
        env: { ...process.env, YOPLAI_PDF_OCR_WORKER: "1" },
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
    } catch (error) {
      release();
      reject(error);
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => finish(ocrFailure("PDF OCR timed out after 45 seconds")), OCR_TIMEOUT_MS);
    child.on("message", (message: { pages?: Array<{ number: number; text: string }>; error?: string; rss?: number; cpuMs?: number }) => {
      if (message.rss && message.rss > PDF_OCR_LIMITS.childRssMb * 1024 * 1024) finish(ocrFailure("PDF OCR exceeded the 512MB memory limit"));
      else if (message.cpuMs !== undefined && message.cpuMs > PDF_OCR_LIMITS.childCpuMs) finish(ocrFailure("PDF OCR exceeded the 40 second CPU limit"));
      else if (message.error) finish(ocrFailure(message.error));
      else if (message.pages) finish(undefined, message.pages);
    });
    child.once("error", (error) => finish(error));
    child.once("exit", (code) => {
      clearTimeout(timer); release();
      if (killTimer) clearTimeout(killTimer);
      if (settleTimer) clearTimeout(settleTimer);
      if (!settled) reject(new Error(`PDF OCR child exited before completing (code ${code ?? "unknown"})`));
      else if (failure) reject(failure);
      else resolve(new Map(result?.map((page) => [page.number, page.text])));
    });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    try {
      child.send({ data, pages, maxPages: MAX_OCR_PAGES, maxOutput: MAX_PDF_OUTPUT }, (error) => { if (error) finish(error); });
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  }));
}

function acquireOcrSlot(bytes: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (admittedOcrBytes + bytes > PDF_OCR_LIMITS.aggregateInputBytes) return Promise.reject(ocrFailure("PDF OCR input admission limit reached; try again shortly"));
  admittedOcrBytes += bytes;
  if (activeOcrWorkers < MAX_OCR_CONCURRENCY) {
    activeOcrWorkers += 1;
    return Promise.resolve();
  }
  if (ocrWaiters.length >= PDF_OCR_LIMITS.queue) { admittedOcrBytes -= bytes; return Promise.reject(ocrFailure("PDF OCR queue is full; try again shortly")); }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(waiter.timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      const index = ocrWaiters.indexOf(waiter);
      if (index < 0) return;
      ocrWaiters.splice(index, 1);
      admittedOcrBytes -= bytes;
      cleanup();
      reject(signal?.reason);
    };
    const waiter = {
      bytes,
      resolve: () => { cleanup(); activeOcrWorkers += 1; resolve(); },
      reject,
      timer: setTimeout(() => {
        const index = ocrWaiters.indexOf(waiter);
        if (index >= 0) ocrWaiters.splice(index, 1);
        admittedOcrBytes -= bytes;
        cleanup();
        reject(ocrFailure("PDF OCR queue timed out after 10 seconds"));
      }, PDF_OCR_LIMITS.queueWaitMs),
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    ocrWaiters.push(waiter);
  });
}

function extractSpreadsheetText(filePath: string): string {
  const workbook = XLSX.readFile(filePath);

  return workbook.SheetNames.map((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    const csv = XLSX.utils.sheet_to_csv(sheet);
    return `# ${sheetName}\n${csv}`;
  }).join("\n\n");
}
