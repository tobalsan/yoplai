import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractPdfBuffer } from "./extract.js";

const corruptFixture = fileURLToPath(new URL("./__fixtures__/corrupt.pdf", import.meta.url));

describe("extractPdfBuffer fixtures", () => {
  it("rejects a real corrupt-xref PDF without starting an agent run", async () => {
    await expect(extractPdfBuffer(await fs.readFile(corruptFixture))).rejects.toThrow(/xref|PDF|Invalid/i);
  });
});
