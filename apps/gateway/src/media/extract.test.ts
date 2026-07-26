import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import XLSX from "xlsx";
import { extractText } from "./extract.js";

const XLS_MIME = "application/vnd.ms-excel";
const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

describe("extractText", () => {
  it.each([
    ["xlsx", XLSX_MIME],
    ["xls", XLS_MIME],
  ])("extracts %s sheets as CSV text", async (extension, mimeType) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-sheet-"));
    const filePath = path.join(dir, `sheet.${extension}`);
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([
      ["date", "message"],
      ["2020-01-01", "hello"],
    ]);
    XLSX.utils.book_append_sheet(workbook, sheet, "Sheet1");
    XLSX.writeFile(workbook, filePath);

    const text = await extractText(filePath, mimeType);

    expect(text).toContain("# Sheet1");
    expect(text).toContain("date,message");
    expect(text).toContain("2020-01-01,hello");

    await fs.rm(dir, { recursive: true, force: true });
  });
});
