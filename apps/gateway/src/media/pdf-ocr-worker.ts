import { parentPort, workerData } from "node:worker_threads";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import mupdf from "mupdf";
import { createWorker } from "tesseract.js";

const require = createRequire(import.meta.url);
const eng = require("@tesseract.js-data/eng") as { langPath: string; gzip: boolean };
const fra = require("@tesseract.js-data/fra") as { langPath: string; gzip: boolean };

const input = workerData as { data: Uint8Array; pages: number[]; maxPages: number; maxOutput: number };
const MAX_RENDER_PIXELS = 16_000_000;

async function main(): Promise<Array<{ number: number; text: string }>> {
  const document = mupdf.Document.openDocument(input.data, "application/pdf");
  if (document.needsPassword()) throw new Error("PDF is encrypted and cannot be extracted");
  const pages = document.countPages();
  if (pages > input.maxPages) throw new Error(`PDF has ${pages} pages; limit is ${input.maxPages}`);
  const langDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-tessdata-"));
  let worker: Awaited<ReturnType<typeof createWorker>> | undefined;
  try {
    await Promise.all([
      fs.copyFile(path.join(eng.langPath, "eng.traineddata.gz"), path.join(langDir, "eng.traineddata.gz")),
      fs.copyFile(path.join(fra.langPath, "fra.traineddata.gz"), path.join(langDir, "fra.traineddata.gz")),
    ]);
    worker = await createWorker("eng+fra", 1, { langPath: langDir, gzip: eng.gzip, cacheMethod: "none" });
    const result: Array<{ number: number; text: string }> = [];
    for (const number of input.pages) {
      const page = document.loadPage(number - 1);
      const bounds = page.getBounds() as unknown as number[];
      const pixels = Math.abs(bounds[2] - bounds[0]) * 2 * Math.abs(bounds[3] - bounds[1]) * 2;
      if (pixels > MAX_RENDER_PIXELS) throw new Error("PDF page exceeds render pixel limit");
      const pixmap = page.toPixmap(mupdf.Matrix.scale(2, 2), mupdf.ColorSpace.DeviceRGB, false);
      const text = (await worker.recognize(Buffer.from(pixmap.asPNG()))).data.text.trim();
      if (text) result.push({ number, text });
      if (result.reduce((total, item) => total + item.text.length, 0) > input.maxOutput) throw new Error("PDF text exceeds output limit");
    }
    return result;
  } finally {
    await worker?.terminate();
    await fs.rm(langDir, { recursive: true, force: true });
  }
}

void main().then(
  (pages) => parentPort?.postMessage({ pages }),
  (error: unknown) => parentPort?.postMessage({ error: error instanceof Error ? error.message : String(error) })
);
