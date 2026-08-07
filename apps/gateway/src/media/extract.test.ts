import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import XLSX from "xlsx";

const children: EventEmitter[] = [];
vi.mock("node:child_process", () => ({
  fork: vi.fn(() => {
    const child = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> };
    child.kill = vi.fn();
    child.send = vi.fn();
    children.push(child);
    return child;
  }),
}));

const { extractText, runPdfOcr } = await import("./extract.js");

const XLS_MIME = "application/vnd.ms-excel";
const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

describe("extractText", () => {
  it("rejects OCR work beyond the 50MiB aggregate admission limit", async () => {
    const input = Buffer.alloc(25 * 1024 * 1024);
    const first = runPdfOcr(input, [1]);
    const second = runPdfOcr(input, [1]);
    await expect(runPdfOcr(Buffer.alloc(1), [1])).rejects.toThrow("admission limit");
    for (const child of children.splice(0)) child.emit("exit", 0);
    await expect(first).rejects.toThrow("exited before completing");
    await expect(second).rejects.toThrow("exited before completing");
  });

  it("releases a timed-out OCR slot when a child never exits", async () => {
    vi.useFakeTimers();
    const pending = runPdfOcr(Buffer.alloc(1), [1]);
    const rejected = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(47_000);
    await rejected;
    vi.useRealTimers();
  });
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
