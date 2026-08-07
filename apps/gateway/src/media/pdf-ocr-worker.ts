import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import mupdf from "mupdf";
import { createWorker } from "tesseract.js";

const require = createRequire(import.meta.url);
const eng = require("@tesseract.js-data/eng") as { langPath: string; gzip: boolean };
const fra = require("@tesseract.js-data/fra") as { langPath: string; gzip: boolean };

type Input = { data: Uint8Array; pages: number[]; maxPages: number; maxOutput: number };
export const MAX_RENDER_PIXELS = 16_000_000;
const tessdataDir = path.join(os.tmpdir(), "yoplai-tessdata-v1");
const tessdataLock = `${tessdataDir}.lock`;

async function ensureTessdata(): Promise<string> {
  if (await hasTessdata()) return tessdataDir;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await fs.mkdir(tessdataLock);
      try {
        await fs.writeFile(path.join(tessdataLock, "pid"), String(process.pid));
        if (!await hasTessdata()) await copyTessdata();
        return tessdataDir;
      } finally {
        await fs.rm(tessdataLock, { recursive: true, force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await recoverStaleLock()) continue;
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (await hasTessdata()) return tessdataDir;
    }
  }
  throw new Error("Timed out preparing OCR language data");
}

async function recoverStaleLock(): Promise<boolean> {
  try {
    const pid = Number.parseInt(await fs.readFile(path.join(tessdataLock, "pid"), "utf8"), 10);
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        await fs.rm(tessdataLock, { recursive: true, force: true });
        return true;
      }
    }
    const { mtimeMs } = await fs.stat(tessdataLock);
    if (Date.now() - mtimeMs > 10_000) {
      await fs.rm(tessdataLock, { recursive: true, force: true });
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

async function hasTessdata(): Promise<boolean> {
  try {
    await Promise.all([
      fs.access(path.join(tessdataDir, "eng.traineddata.gz")),
      fs.access(path.join(tessdataDir, "fra.traineddata.gz")),
    ]);
    return true;
  } catch {
    return false;
  }
}

async function copyTessdata(): Promise<void> {
  await fs.mkdir(tessdataDir, { recursive: true });
  await Promise.all(["eng", "fra"].map(async (language) => {
    const source = language === "eng" ? eng.langPath : fra.langPath;
    const target = path.join(tessdataDir, `${language}.traineddata.gz`);
    const temporary = `${target}.${process.pid}.tmp`;
    await fs.copyFile(path.join(source, `${language}.traineddata.gz`), temporary);
    await fs.rename(temporary, target);
  }));
}

export function assertRenderPixels(bounds: number[]): void {
  const pixels = Math.abs(bounds[2] - bounds[0]) * 2 * Math.abs(bounds[3] - bounds[1]) * 2;
  if (pixels > MAX_RENDER_PIXELS) throw new Error("PDF page exceeds render pixel limit");
}

export async function ocrPdfPages(input: Input): Promise<Array<{ number: number; text: string }>> {
  const document = mupdf.Document.openDocument(input.data, "application/pdf");
  if (document.needsPassword()) throw new Error("PDF is encrypted and cannot be extracted");
  const pages = document.countPages();
  if (pages > input.maxPages) throw new Error(`PDF has ${pages} pages; limit is ${input.maxPages}`);
  let worker: Awaited<ReturnType<typeof createWorker>> | undefined;
  try {
    worker = await createWorker("eng+fra", 1, { langPath: await ensureTessdata(), gzip: eng.gzip, cacheMethod: "none" });
    const result: Array<{ number: number; text: string }> = [];
    for (const number of input.pages) {
      const page = document.loadPage(number - 1);
      const bounds = page.getBounds() as unknown as number[];
      assertRenderPixels(bounds);
      const pixmap = page.toPixmap(mupdf.Matrix.scale(2, 2), mupdf.ColorSpace.DeviceRGB, false);
      const image = Buffer.from(pixmap.asPNG());
      const text = (await worker.recognize(image)).data.text.trim();
      if (text) result.push({ number, text });
      if (result.reduce((total, item) => total + item.text.length, 0) > input.maxOutput) throw new Error("PDF text exceeds output limit");
    }
    return result;
  } finally {
    await worker?.terminate();
  }
}

if (process.send && process.env.YOPLAI_PDF_OCR_WORKER === "1") {
  setInterval(() => process.send?.({ rss: process.memoryUsage().rss }), 250).unref();
  process.once("message", (input: Input) => {
    void ocrPdfPages(input).then(
      (pages) => process.send?.({ pages }),
      (error: unknown) => process.send?.({ error: error instanceof Error ? error.message : String(error) })
    );
  });
}
