import fs from "node:fs/promises";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
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

const MAX_PDF_BYTES = 25 * 1024 * 1024;
const MAX_PDF_PAGES = 30;
const MAX_PDF_OUTPUT = 250_000;
const OCR_TIMEOUT_MS = 45_000;
const MAX_OCR_CONCURRENCY = 2;
let activeOcrWorkers = 0;
const ocrWaiters: Array<() => void> = [];

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
  } finally {
    await parser.destroy();
  }
}

function runPdfOcr(data: Buffer, pages: number[]): Promise<Map<number, string>> {
  return acquireOcrSlot().then(() => new Promise((resolve, reject) => {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      activeOcrWorkers -= 1;
      ocrWaiters.shift()?.();
    };
    let worker: Worker;
    try {
      worker = new Worker(fileURLToPath(new URL("./pdf-ocr-worker.js", import.meta.url)), {
        workerData: { data, pages, maxPages: MAX_PDF_PAGES, maxOutput: MAX_PDF_OUTPUT },
      });
    } catch (error) {
      release();
      reject(error);
      return;
    }
    const timer = setTimeout(() => void worker.terminate().then(() => { release(); reject(new Error("PDF OCR timed out after 45 seconds")); }), OCR_TIMEOUT_MS);
    worker.once("message", (message: { pages?: Array<{ number: number; text: string }>; error?: string }) => {
      clearTimeout(timer);
      release();
      if (message.error) reject(new Error(message.error));
      else resolve(new Map(message.pages?.map((page) => [page.number, page.text])));
    });
    worker.once("error", (error) => { clearTimeout(timer); release(); reject(error); });
    worker.once("exit", (code) => { if (code !== 0) { clearTimeout(timer); release(); reject(new Error(`PDF OCR worker exited with code ${code}`)); } });
  }));
}

function acquireOcrSlot(): Promise<void> {
  if (activeOcrWorkers < MAX_OCR_CONCURRENCY) {
    activeOcrWorkers += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => ocrWaiters.push(() => { activeOcrWorkers += 1; resolve(); }));
}

function extractSpreadsheetText(filePath: string): string {
  const workbook = XLSX.readFile(filePath);

  return workbook.SheetNames.map((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    const csv = XLSX.utils.sheet_to_csv(sheet);
    return `# ${sheetName}\n${csv}`;
  }).join("\n\n");
}
