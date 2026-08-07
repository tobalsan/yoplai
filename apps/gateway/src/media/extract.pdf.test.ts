import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractPdfBuffer } from "./extract.js";

const corruptFixture = fileURLToPath(new URL("./__fixtures__/corrupt.pdf", import.meta.url));
// Source: https://github.com/ArturT/Test-PDF-Files/blob/master/encrypted.pdf
const encryptedFixture = fileURLToPath(new URL("./__fixtures__/encrypted.pdf", import.meta.url));

describe("extractPdfBuffer fixtures", () => {
  it("rejects a real corrupt-xref PDF without starting an agent run", async () => {
    await expect(extractPdfBuffer(await fs.readFile(corruptFixture))).rejects.toThrow(/xref|PDF|Invalid/i);
  });

  it("rejects a real encrypted PDF with an actionable error", async () => {
    await expect(extractPdfBuffer(await fs.readFile(encryptedFixture))).rejects.toThrow("PDF is encrypted and cannot be extracted");
  });
});
