import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PDFParse } from "pdf-parse";
import { describe, expect, it } from "vitest";
import { extractPdfBuffer } from "./extract.js";
import { ocrPdfPages } from "./pdf-ocr-worker.js";

const corruptFixture = fileURLToPath(new URL("./__fixtures__/corrupt.pdf", import.meta.url));
// Source: https://github.com/ArturT/Test-PDF-Files/blob/master/encrypted.pdf
const encryptedFixture = fileURLToPath(new URL("./__fixtures__/encrypted.pdf", import.meta.url));
const mixedFixture = fileURLToPath(new URL("./__fixtures__/mixed.pdf", import.meta.url));

describe("extractPdfBuffer fixtures", () => {
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
});
