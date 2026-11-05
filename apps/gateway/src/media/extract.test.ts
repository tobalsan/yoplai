import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import XLSX from "xlsx";
import { PasswordException } from "pdf-parse";

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

const { extractPdfBuffer, extractPdfBufferDetails, ExtractionError, extractText, extractTextDetails, runPdfOcr } = await import("./extract.js");

const XLS_MIME = "application/vnd.ms-excel";
const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

describe("extractText", () => {
  it("extracts complete JSON as raw UTF-8 without parsing or truncating", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-json-"));
    const filePath = path.join(dir, "data.json");
    const content = '{\n  "message": "café",\n  "tail": "' + "x".repeat(12_000) + '"\n}\n';
    try {
      await fs.writeFile(filePath, content);
      expect(await extractText(filePath, "application/json")).toBe(content);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

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

  it("reports a password-protected PDF with its original failure as cause", async () => {
    const original = new PasswordException("password required", 1);
    getPdfText.mockRejectedValueOnce(original);
    const extraction = extractTextDetails(path.join(import.meta.dirname, "__fixtures__/encrypted.pdf"), "application/pdf");
    await expect(extraction).rejects.toBeInstanceOf(ExtractionError);
    await expect(extraction).rejects.toMatchObject({ message: "PDF is password-protected", cause: original });
  });

  it("rejects oversized PDFs before parsing or OCR", async () => {
    const extraction = extractPdfBuffer(Buffer.alloc(25 * 1024 * 1024 + 1));
    await expect(extraction).rejects.toBeInstanceOf(ExtractionError);
    await expect(extraction).rejects.toThrow("File too large for text extraction (max 25 MB)");
    expect(getPdfText).not.toHaveBeenCalled();
    expect(children).toHaveLength(0);
  });

  it("extracts every text-layer page of a long PDF without OCR", async () => {
    const text = "Invented specification page with enough text to need no OCR.";
    getPdfText.mockResolvedValueOnce({ total: 35, text, pages: Array.from({ length: 35 }, (_, index) => ({ num: index + 1, text })) });
    await expect(extractPdfBuffer(Buffer.from("fixture"))).resolves.toBe(text);
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

  it("keeps text layers and the first 30 scanned pages with a partial note", async () => {
    const first = "First text-layer page contains enough invented specification text.";
    const last = "Last text-layer page also contains enough invented specification text.";
    getPdfText.mockResolvedValueOnce({
      total: 47, text: first,
      pages: [{ num: 1, text: first }, ...Array.from({ length: 45 }, (_, index) => ({ num: index + 2, text: index === 44 ? "skipped fragment" : "" })), { num: 47, text: last }],
    });
    const extraction = extractPdfBufferDetails(Buffer.from("fixture"));
    await vi.waitFor(() => expect(children).toHaveLength(1));
    expect(children[0].send).toHaveBeenCalledWith(
      expect.objectContaining({ pages: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31] }),
      expect.any(Function)
    );
    children[0].emit("message", { pages: [{ number: 2, text: "First scanned page" }, { number: 31, text: "Thirtieth scanned page" }] });
    children[0].emit("exit", 0);
    await expect(extraction).resolves.toEqual({
      text: first + "\n\nFirst scanned page\n\nThirtieth scanned page\n\n" + last,
      note: "Partial text: 30 of 45 scanned pages read",
    });
  });

  it("reports the OCR cap when skipped scanned pages leave no readable text", async () => {
    getPdfText.mockResolvedValueOnce({ total: 45, text: "", pages: Array.from({ length: 45 }, (_, index) => ({ num: index + 1, text: "" })) });
    const extraction = extractPdfBufferDetails(Buffer.from("fixture"));
    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0].emit("message", { pages: [] });
    children[0].emit("exit", 0);
    await expect(extraction).rejects.toBeInstanceOf(ExtractionError);
    await expect(extraction).rejects.toThrow("Too many pages to OCR (45 scanned pages, max 30)");
  });

  it("rejects OCR output beyond the configured limit", async () => {
    getPdfText.mockResolvedValueOnce({ total: 1, text: "", pages: [{ num: 1, text: "" }] });
    const extraction = extractPdfBuffer(Buffer.from("fixture"));
    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0].emit("message", { pages: [{ number: 1, text: "x".repeat(250_001) }] });
    children[0].emit("exit", 0);
    await expect(extraction).rejects.toBeInstanceOf(ExtractionError);
    await expect(extraction).rejects.toThrow("Text too long (over 250,000 characters)");
  });

  it("maps the worker output limit to the short reason and retains its cause", async () => {
    const extraction = runPdfOcr(Buffer.from("fixture"), [1]);
    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0].emit("message", { error: "PDF text exceeds output limit" });
    children[0].emit("exit", 0);
    await expect(extraction).rejects.toBeInstanceOf(ExtractionError);
    await expect(extraction).rejects.toMatchObject({ message: "Text too long (over 250,000 characters)", cause: expect.objectContaining({ message: "PDF text exceeds output limit" }) });
  });

  it("maps the worker password failure to the short reason and retains its cause", async () => {
    const extraction = runPdfOcr(Buffer.from("fixture"), [1]);
    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0].emit("message", { error: "PDF is encrypted and cannot be extracted" });
    children[0].emit("exit", 0);
    await expect(extraction).rejects.toBeInstanceOf(ExtractionError);
    await expect(extraction).rejects.toMatchObject({ message: "PDF is password-protected", cause: expect.objectContaining({ message: "PDF is encrypted and cannot be extracted" }) });
  });

  it("rejects text-layer output beyond 250,000 characters", async () => {
    const text = "x".repeat(250_001);
    getPdfText.mockResolvedValueOnce({ total: 1, text, pages: [{ num: 1, text }] });
    const extraction = extractPdfBuffer(Buffer.from("fixture"));
    await expect(extraction).rejects.toBeInstanceOf(ExtractionError);
    await expect(extraction).rejects.toThrow("Text too long (over 250,000 characters)");
    expect(children).toHaveLength(0);
  });

  it("terminates an OCR child that exceeds the RSS limit", async () => {
    const extraction = runPdfOcr(Buffer.alloc(1), [1]);
    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0].emit("message", { rss: 512 * 1024 * 1024 + 1 });
    expect(children[0].kill).toHaveBeenCalled();
    children[0].emit("exit", 0);
    await expect(extraction).rejects.toBeInstanceOf(ExtractionError);
    await expect(extraction).rejects.toMatchObject({ message: "OCR exceeded resource limits", cause: expect.objectContaining({ message: "PDF OCR exceeded the 512MB memory limit" }) });
  });

  it("terminates an OCR child that exceeds the CPU limit", async () => {
    const extraction = runPdfOcr(Buffer.alloc(1), [1]);
    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0].emit("message", { pages: [{ number: 1, text: "late result" }], cpuMs: 40_001 });
    expect(children[0].kill).toHaveBeenCalled();
    children[0].emit("exit", 0);
    await expect(extraction).rejects.toBeInstanceOf(ExtractionError);
    await expect(extraction).rejects.toMatchObject({ message: "OCR exceeded resource limits", cause: expect.objectContaining({ message: "PDF OCR exceeded the 40 second CPU limit" }) });
  });

  it("rejects pre-aborted OCR work before admitting bytes or spawning a child", async () => {
    const controller = new AbortController();
    controller.abort(new Error("run cancelled"));
    expect(() => runPdfOcr(Buffer.alloc(25 * 1024 * 1024), [1], controller.signal)).toThrow("run cancelled");
    expect(children).toHaveLength(0);
    const input = Buffer.alloc(25 * 1024 * 1024);
    const first = runPdfOcr(input, [1]);
    const second = runPdfOcr(input, [1]);
    const firstFailure = expect(first).rejects.toThrow("exited before completing");
    const secondFailure = expect(second).rejects.toThrow("exited before completing");
    await vi.waitFor(() => expect(children).toHaveLength(2));
    children[0].emit("exit", 0);
    children[1].emit("exit", 0);
    await Promise.all([firstFailure, secondFailure]);
  });

  it("kills an aborted OCR child and ignores its late successful output", async () => {
    const controller = new AbortController();
    const pending = runPdfOcr(Buffer.from("fixture"), [1], controller.signal);
    const rejected = expect(pending).rejects.toThrow("run cancelled");
    await vi.waitFor(() => expect(children).toHaveLength(1));
    controller.abort(new Error("run cancelled"));
    expect(children[0].kill).toHaveBeenCalledTimes(1);
    children[0].emit("message", { pages: [{ number: 1, text: "late success" }] });
    children[0].emit("exit", 0);
    await rejected;
  });

  it("removes cancelled queued work and frees its byte admission for another job", async () => {
    const first = runPdfOcr(Buffer.alloc(1), [1]);
    const second = runPdfOcr(Buffer.alloc(1), [1]);
    const firstFailure = expect(first).rejects.toThrow("exited before completing");
    const secondFailure = expect(second).rejects.toThrow("exited before completing");
    const controller = new AbortController();
    const queued = runPdfOcr(Buffer.alloc(25 * 1024 * 1024), [1], controller.signal);
    const queuedFailure = expect(queued).rejects.toThrow("queued call cancelled");
    controller.abort(new Error("queued call cancelled"));
    await queuedFailure;
    const replacement = runPdfOcr(Buffer.alloc(25 * 1024 * 1024), [1]);
    const replacementTwo = runPdfOcr(Buffer.alloc(25 * 1024 * 1024 - 2), [1]);
    const replacementFailure = expect(replacement).rejects.toThrow("exited before completing");
    const replacementTwoFailure = expect(replacementTwo).rejects.toThrow("exited before completing");
    await vi.waitFor(() => expect(children).toHaveLength(2));
    children[0].emit("exit", 0);
    children[1].emit("exit", 0);
    await vi.waitFor(() => expect(children).toHaveLength(4));
    children[2].emit("exit", 0);
    children[3].emit("exit", 0);
    await Promise.all([firstFailure, secondFailure, replacementFailure, replacementTwoFailure]);
  });

  it("does not spawn queued work aborted between slot release and its continuation", async () => {
    const first = runPdfOcr(Buffer.alloc(1), [1]);
    const second = runPdfOcr(Buffer.alloc(1), [1]);
    const firstFailure = expect(first).rejects.toThrow("exited before completing");
    const secondFailure = expect(second).rejects.toThrow("exited before completing");
    const controller = new AbortController();
    const queued = runPdfOcr(Buffer.alloc(1), [1], controller.signal);
    const queuedFailure = expect(queued).rejects.toThrow("run cancelled");
    await vi.waitFor(() => expect(children).toHaveLength(2));
    children[0].emit("exit", 0);
    controller.abort(new Error("run cancelled"));
    await queuedFailure;
    expect(children).toHaveLength(2);
    children[1].emit("exit", 0);
    await Promise.all([firstFailure, secondFailure]);
    const next = runPdfOcr(Buffer.alloc(1), [1]);
    const nextFailure = expect(next).rejects.toThrow("exited before completing");
    await vi.waitFor(() => expect(children).toHaveLength(3));
    children[2].emit("exit", 0);
    await nextFailure;
  });

  it("rejects OCR work beyond the 50MiB aggregate admission limit", async () => {
    const input = Buffer.alloc(25 * 1024 * 1024);
    const first = runPdfOcr(input, [1]);
    const second = runPdfOcr(input, [1]);
    await expect(runPdfOcr(Buffer.alloc(1), [1])).rejects.toMatchObject({ message: "OCR busy, try again shortly", cause: expect.objectContaining({ message: "PDF OCR input admission limit reached; try again shortly" }) });
    for (const child of children.splice(0)) child.emit("exit", 0);
    await expect(first).rejects.toThrow("exited before completing");
    await expect(second).rejects.toThrow("exited before completing");
  });

  it("caps OCR concurrency at two workers and rejects a full queue", async () => {
    vi.useFakeTimers();
    try {
      const jobs = Array.from({ length: 10 }, () => runPdfOcr(Buffer.alloc(1), [1]));
      await vi.waitFor(() => expect(children).toHaveLength(2));
      await expect(runPdfOcr(Buffer.alloc(1), [1])).rejects.toMatchObject({ message: "OCR busy, try again shortly", cause: expect.objectContaining({ message: "PDF OCR queue is full; try again shortly" }) });
      const queued = jobs.slice(2).map((job) => expect(job).rejects.toThrow("OCR busy, try again shortly"));
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
    const rejected = expect(pending).rejects.toMatchObject({ message: "OCR timed out", cause: expect.objectContaining({ message: "PDF OCR timed out after 45 seconds" }) });
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
