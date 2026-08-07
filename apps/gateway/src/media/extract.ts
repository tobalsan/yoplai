import fs from "node:fs/promises";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import mammoth from "mammoth";
import { PDFParse, PasswordException } from "pdf-parse";
import XLSX from "xlsx";

const RAW_TEXT_MIME_TYPES = new Set([
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
} as const;
const MAX_PDF_BYTES = PDF_OCR_LIMITS.bytes;
const MAX_PDF_PAGES = PDF_OCR_LIMITS.pages;
const MAX_PDF_OUTPUT = PDF_OCR_LIMITS.outputChars;
const OCR_TIMEOUT_MS = PDF_OCR_LIMITS.executionMs;
const MAX_OCR_CONCURRENCY = PDF_OCR_LIMITS.concurrency;
let activeOcrWorkers = 0;
let admittedOcrBytes = 0;
const ocrWaiters: Array<{ bytes: number; resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }> = [];

export async function extractText(
  filePath: string,
  mimeType: string
): Promise<string | null> {
  if (RAW_TEXT_MIME_TYPES.has(mimeType)) {
    return fs.readFile(filePath, "utf8");
  }

  if (mimeType === "application/pdf") {
    return extractPdfText(filePath);
  }

  if (
    mimeType ===
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value;
  }

  if (SPREADSHEET_MIME_TYPES.has(mimeType)) {
    return extractSpreadsheetText(filePath);
  }

  return null;
}

async function extractPdfText(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  return extractPdfBuffer(buffer);
}

export async function extractPdfBuffer(buffer: Buffer): Promise<string> {
  if (buffer.length > MAX_PDF_BYTES) throw new Error("PDF exceeds the 25MB extraction limit");
  const parser = new PDFParse({ data: new Uint8Array(buffer) });

  try {
    const result = await parser.getText();
    if (result.total > MAX_PDF_PAGES) {
      throw new Error(`PDF has ${result.total} pages; limit is ${MAX_PDF_PAGES}`);
    }
    const sparsePages = result.pages
      .filter((page) => page.text.trim().length < 40)
      .map((page) => page.num);
    if (sparsePages.length === 0) {
      const text = result.text.trim();
      if (text.length > MAX_PDF_OUTPUT) throw new Error("PDF text exceeds output limit");
      return text;
    }
    const ocrPages = await runPdfOcr(buffer, sparsePages);
    const text = result.pages
      .map((page) => ocrPages.get(page.num) || page.text.trim())
      .filter(Boolean)
      .join("\n\n");
    if (text.length > MAX_PDF_OUTPUT) throw new Error("PDF text exceeds output limit");
    return text;
  } catch (error) {
    if (error instanceof PasswordException) {
      throw new Error("PDF is encrypted and cannot be extracted");
    }
    throw error;
  } finally {
    await parser.destroy();
  }
}

export function runPdfOcr(data: Buffer, pages: number[]): Promise<Map<number, string>> {
  return acquireOcrSlot(data.length).then(() => new Promise((resolve, reject) => {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      activeOcrWorkers -= 1;
      admittedOcrBytes -= data.length;
      ocrWaiters.shift()?.resolve();
    };
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
      child = fork(fileURLToPath(new URL("./pdf-ocr-worker.js", import.meta.url)), [], {
        serialization: "advanced",
        execArgv: ["--max-old-space-size=256"],
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
    } catch (error) {
      release();
      reject(error);
      return;
    }
    const timer = setTimeout(() => finish(new Error("PDF OCR timed out after 45 seconds")), OCR_TIMEOUT_MS);
    child.on("message", (message: { pages?: Array<{ number: number; text: string }>; error?: string; rss?: number }) => {
      if (message.rss && message.rss > PDF_OCR_LIMITS.childRssMb * 1024 * 1024) finish(new Error("PDF OCR exceeded the 512MB memory limit"));
      else if (message.error) finish(new Error(message.error));
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
    try {
      child.send({ data, pages, maxPages: MAX_PDF_PAGES, maxOutput: MAX_PDF_OUTPUT }, (error) => { if (error) finish(error); });
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  }));
}

function acquireOcrSlot(bytes: number): Promise<void> {
  if (admittedOcrBytes + bytes > PDF_OCR_LIMITS.aggregateInputBytes) return Promise.reject(new Error("PDF OCR input admission limit reached; try again shortly"));
  admittedOcrBytes += bytes;
  if (activeOcrWorkers < MAX_OCR_CONCURRENCY) {
    activeOcrWorkers += 1;
    return Promise.resolve();
  }
  if (ocrWaiters.length >= PDF_OCR_LIMITS.queue) { admittedOcrBytes -= bytes; return Promise.reject(new Error("PDF OCR queue is full; try again shortly")); }
  return new Promise((resolve, reject) => {
    const waiter = { bytes, resolve: () => { clearTimeout(waiter.timer); activeOcrWorkers += 1; resolve(); }, reject, timer: setTimeout(() => { const index = ocrWaiters.indexOf(waiter); if (index >= 0) ocrWaiters.splice(index, 1); admittedOcrBytes -= bytes; reject(new Error("PDF OCR queue timed out after 10 seconds")); }, PDF_OCR_LIMITS.queueWaitMs) };
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
