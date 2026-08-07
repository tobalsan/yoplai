import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PDFParse } from "pdf-parse";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { fork } = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock("node:child_process", () => ({ fork }));

import { extractPdfBuffer } from "./extract.js";
import { assertRenderPixels, ocrPdfPages } from "./pdf-ocr-worker.js";

const corruptFixture = fileURLToPath(new URL("./__fixtures__/corrupt.pdf", import.meta.url));
// Source: https://github.com/ArturT/Test-PDF-Files/blob/master/encrypted.pdf
const encryptedFixture = fileURLToPath(new URL("./__fixtures__/encrypted.pdf", import.meta.url));
const mixedFixture = fileURLToPath(new URL("./__fixtures__/mixed.pdf", import.meta.url));
const scannedEnglishFixture = fileURLToPath(new URL("./__fixtures__/scanned-english.pdf", import.meta.url));
const scannedFrenchFixture = fileURLToPath(new URL("./__fixtures__/scanned-french.pdf", import.meta.url));
const textLayerFixture = fileURLToPath(new URL("./__fixtures__/text-layer.pdf", import.meta.url));

describe("extractPdfBuffer fixtures", () => {
  beforeEach(() => {
    fork.mockReset();
    fork.mockImplementation(() => { throw new Error("Invalid PDF"); });
  });

  it("rejects pages above the render-pixel limit before rasterization", () => {
    expect(() => assertRenderPixels([0, 0, 2_001, 2_000])).toThrow("PDF page exceeds render pixel limit");
  });

  it("keeps a real text-layer PDF on the extraction fast path", async () => {
    await expect(extractPdfBuffer(await fs.readFile(textLayerFixture))).resolves.toContain("TEXT LAYER FIXTURE WITH ENOUGH CONTENT TO SKIP OCR");
    expect(fork).not.toHaveBeenCalled();
  });

  it("rejects a real corrupt-xref PDF without starting an agent run", async () => {
    await expect(extractPdfBuffer(await fs.readFile(corruptFixture))).rejects.toThrow(/xref|PDF|Invalid/i);
  });

  it("rejects a real encrypted PDF with an actionable error", async () => {
    await expect(extractPdfBuffer(await fs.readFile(encryptedFixture))).rejects.toThrow("PDF is encrypted and cannot be extracted");
  });

  it("contains a text-layer page followed by an image-only page", async () => {
    const parser = new PDFParse({ data: new Uint8Array(await fs.readFile(mixedFixture)) });
    try {
      const result = await parser.getText();
      expect(result.pages).toHaveLength(2);
      expect(result.pages[0].text).toContain("MIXED PDF TEXT LAYER CONTENT");
      expect(result.pages[1].text.trim()).toBe("");
    } finally {
      await parser.destroy();
    }
  });

  it("OCRs the image-only page in the mixed fixture", async () => {
    const pages = await ocrPdfPages({
      data: new Uint8Array(await fs.readFile(mixedFixture)),
      pages: [2],
      maxPages: 30,
      maxOutput: 250_000,
    });
    expect(pages).toEqual([{ number: 2, text: "HELLO OCR ENGLISH" }]);
  });

  it("OCRs the image-only English fixture", async () => {
    const pages = await ocrPdfPages({
      data: new Uint8Array(await fs.readFile(scannedEnglishFixture)), pages: [1], maxPages: 30, maxOutput: 250_000,
    });
    expect(pages[0]?.text).toContain("HELLO OCR ENGLISH");
  });

  it("OCRs the image-only French fixture", async () => {
    const pages = await ocrPdfPages({
      data: new Uint8Array(await fs.readFile(scannedFrenchFixture)), pages: [1], maxPages: 30, maxOutput: 250_000,
    });
    expect(pages[0]?.text.normalize("NFD").replace(/\p{Diacritic}/gu, "")).toContain("BONJOUR ELEVE FRANCAIS");
  });
});
