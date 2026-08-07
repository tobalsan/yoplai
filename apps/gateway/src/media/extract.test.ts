import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import XLSX from "xlsx";

type MockChild = EventEmitter & {
  kill: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
};

const children: MockChild[] = [];
const getPdfText = vi.fn();
vi.mock("node:child_process", () => ({
  fork: vi.fn(() => {
    const child = new EventEmitter() as MockChild;
    child.kill = vi.fn();
    child.send = vi.fn();
    children.push(child);
    return child;
  }),
}));
vi.mock("pdf-parse", () => ({
  PasswordException: class extends Error {},
  PDFParse: class {
    getText = getPdfText;
    destroy = vi.fn();
  },
}));

const { extractPdfBuffer, extractText, runPdfOcr } = await import("./extract.js");

const XLS_MIME = "application/vnd.ms-excel";
const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

describe("extractText", () => {
  beforeEach(() => {
    children.length = 0;
    getPdfText.mockReset();
  });

  it("keeps usable text-layer pages on the no-OCR fast path", async () => {
    getPdfText.mockResolvedValueOnce({
      total: 1,
      text: "Gateway text layer with enough content to skip OCR extraction.",
      pages: [{ num: 1, text: "Gateway text layer with enough content to skip OCR extraction." }],
    });
    await expect(extractPdfBuffer(Buffer.from("fixture"))).resolves.toBe("Gateway text layer with enough content to skip OCR extraction.");
    expect(children).toHaveLength(0);
  });

  it("rejects oversized PDFs before parsing or OCR", async () => {
    await expect(extractPdfBuffer(Buffer.alloc(25 * 1024 * 1024 + 1))).rejects.toThrow("25MB extraction limit");
    expect(getPdfText).not.toHaveBeenCalled();
    expect(children).toHaveLength(0);
  });

  it("rejects PDFs over the page limit before OCR", async () => {
    getPdfText.mockResolvedValueOnce({ total: 31, text: "", pages: [] });
    await expect(extractPdfBuffer(Buffer.from("fixture"))).rejects.toThrow("31 pages; limit is 30");
    expect(children).toHaveLength(0);
  });

  it("keeps text-layer pages in order while OCRing only sparse pages", async () => {
    const textLayer = "first page has enough text to keep from the PDF text layer";
    getPdfText.mockResolvedValueOnce({
      total: 2,
      text: `${textLayer}\n`,
      pages: [{ num: 1, text: textLayer }, { num: 2, text: "" }],
    });

    const extraction = extractPdfBuffer(Buffer.from("fixture"));
    await vi.waitFor(() => expect(children).toHaveLength(1));
    expect(children[0].send).toHaveBeenCalledWith(
      expect.objectContaining({ pages: [2] }),
      expect.any(Function)
    );
    children[0].emit("message", { pages: [{ number: 2, text: "OCR second page" }] });
    children[0].emit("exit", 0);

    await expect(extraction).resolves.toBe(`${textLayer}\n\nOCR second page`);
  });

  it("rejects OCR output beyond the configured limit", async () => {
    getPdfText.mockResolvedValueOnce({ total: 1, text: "", pages: [{ num: 1, text: "" }] });
    const extraction = extractPdfBuffer(Buffer.from("fixture"));
    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0].emit("message", { pages: [{ number: 1, text: "x".repeat(250_001) }] });
    children[0].emit("exit", 0);
    await expect(extraction).rejects.toThrow("PDF text exceeds output limit");
  });

  it("terminates an OCR child that exceeds the RSS limit", async () => {
    const extraction = runPdfOcr(Buffer.alloc(1), [1]);
    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0].emit("message", { rss: 512 * 1024 * 1024 + 1 });
    expect(children[0].kill).toHaveBeenCalled();
    children[0].emit("exit", 0);
    await expect(extraction).rejects.toThrow("512MB memory limit");
  });

  it("terminates an OCR child that exceeds the CPU limit", async () => {
    const extraction = runPdfOcr(Buffer.alloc(1), [1]);
    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0].emit("message", { pages: [{ number: 1, text: "late result" }], cpuMs: 40_001 });
    expect(children[0].kill).toHaveBeenCalled();
    children[0].emit("exit", 0);
    await expect(extraction).rejects.toThrow("40 second CPU limit");
  });

  it("rejects OCR work beyond the 50MiB aggregate admission limit", async () => {
    const input = Buffer.alloc(25 * 1024 * 1024);
    const first = runPdfOcr(input, [1]);
    const second = runPdfOcr(input, [1]);
    await expect(runPdfOcr(Buffer.alloc(1), [1])).rejects.toThrow("admission limit");
    for (const child of children.splice(0)) child.emit("exit", 0);
    await expect(first).rejects.toThrow("exited before completing");
    await expect(second).rejects.toThrow("exited before completing");
  });

  it("caps OCR concurrency at two workers and rejects a full queue", async () => {
    vi.useFakeTimers();
    try {
      const jobs = Array.from({ length: 10 }, () => runPdfOcr(Buffer.alloc(1), [1]));
      await vi.waitFor(() => expect(children).toHaveLength(2));
      await expect(runPdfOcr(Buffer.alloc(1), [1])).rejects.toThrow("queue is full");
      const queued = jobs.slice(2).map((job) => expect(job).rejects.toThrow("queue timed out"));
      await vi.advanceTimersByTimeAsync(10_000);
      await Promise.all(queued);
      children[0].emit("exit", 0);
      children[1].emit("exit", 0);
      await expect(jobs[0]).rejects.toThrow("exited before completing");
      await expect(jobs[1]).rejects.toThrow("exited before completing");
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts one queued OCR job when a worker slot is released", async () => {
    const first = runPdfOcr(Buffer.alloc(1), [1]);
    const second = runPdfOcr(Buffer.alloc(1), [1]);
    const queued = runPdfOcr(Buffer.alloc(1), [1]);
    const firstFailure = expect(first).rejects.toThrow("exited before completing");
    const secondFailure = expect(second).rejects.toThrow("exited before completing");
    await vi.waitFor(() => expect(children).toHaveLength(2));
    children[0].emit("exit", 0);
    await vi.waitFor(() => expect(children).toHaveLength(3));
    children[2].emit("message", { pages: [{ number: 1, text: "queued OCR" }] });
    children[2].emit("exit", 0);
    children[1].emit("exit", 0);
    await firstFailure;
    await secondFailure;
    await expect(queued).resolves.toEqual(new Map([[1, "queued OCR"]]));
  });

  it("releases a timed-out OCR slot when a child never exits", async () => {
    vi.useFakeTimers();
    const pending = runPdfOcr(Buffer.alloc(1), [1]);
    const rejected = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(47_000);
    await rejected;
    vi.useRealTimers();
    const next = runPdfOcr(Buffer.alloc(1), [1]);
    const nextTwo = runPdfOcr(Buffer.alloc(1), [1]);
    await vi.waitFor(() => expect(children).toHaveLength(3));
    children[1].emit("exit", 0);
    children[2].emit("exit", 0);
    await expect(next).rejects.toThrow("exited before completing");
    await expect(nextTwo).rejects.toThrow("exited before completing");
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
