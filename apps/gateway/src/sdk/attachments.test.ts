import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDocumentAttachmentContext } from "./attachments.js";

describe("document attachment context", () => {
  let home: string;
  let inbound: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-attachment-context-"));
    vi.stubEnv("YOPLAI_HOME", home);
    inbound = path.join(home, "media", "inbound");
    await fs.mkdir(inbound, { recursive: true });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(home, { recursive: true, force: true });
  });

  it("offers the validated absolute path of unextracted documents only when requested", async () => {
    const filePath = path.join(inbound, "slides.pptx");
    await fs.writeFile(filePath, "unparsed presentation bytes");
    const attachment = {
      path: path.relative(process.cwd(), filePath), filename: "slides.pptx",
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", size: 27,
    };
    const enabled = await buildDocumentAttachmentContext([attachment], { includeUnextractedPath: true });
    expect(enabled).toContain(`Path: ${await fs.realpath(filePath)}`);
    expect(enabled).toContain("Content: not extracted");
    expect(await buildDocumentAttachmentContext([attachment])).not.toContain("Path:");
    expect(await buildDocumentAttachmentContext([attachment], { includeUnextractedPath: false })).not.toContain("Path:");
  });

  it.each([
    ["notes.md", "text/markdown"],
    ["notes.txt", "text/plain"],
    ["notes.csv", "text/csv"],
    ["notes.json", "application/json"],
  ])("preserves complete raw UTF-8 text from %s with only outer whitespace removed", async (filename, mimeType) => {
    const content = `  début\n\n${"  padded,raw\tvalue\n".repeat(2000)}END-OF-FILE  `;
    const filePath = path.join(inbound, filename);
    await fs.writeFile(filePath, content);
    const context = await buildDocumentAttachmentContext([
      { path: filePath, filename, mimeType, size: Buffer.byteLength(content) },
    ], { includeUnextractedPath: true });
    expect(context).toBe(`Attached document text:\n\nFile: ${filename}\nMIME type: ${mimeType}\ndébut\n\n${"  padded,raw\tvalue\n".repeat(2000)}END-OF-FILE`);
  });

  // ALG-700: seam approved in the issue spec (Testing Decisions).
  it("does not inline extracted text over 250,000 characters and points the agent to the file", async () => {
    const filename = "subnets.json";
    const content = `[${"\"10.0.0.0/24\",".repeat(18_000)}"END-OF-FILE"]`; // 252,015 chars
    const filePath = path.join(inbound, filename);
    await fs.writeFile(filePath, content);
    const attachment = { path: filePath, filename, mimeType: "application/json", size: content.length };

    const context = await buildDocumentAttachmentContext([attachment]);
    expect(context).toBe(
      "Attached document text:\n\nFile: subnets.json\nMIME type: application/json\n" +
      "Content: not inlined: 252,015 characters, over the 250,000-character limit; read the file at its path with bash/python."
    );

    const withPath = await buildDocumentAttachmentContext([attachment], { includeUnextractedPath: true });
    expect(withPath).toContain(`Path: ${await fs.realpath(filePath)}`);
    expect(withPath).not.toContain("END-OF-FILE");
  });

  it("still inlines text of exactly 250,000 characters", async () => {
    const content = `${"x".repeat(249_989)}END-OF-FILE`;
    const filePath = path.join(inbound, "big.txt");
    await fs.writeFile(filePath, content);
    const context = await buildDocumentAttachmentContext([
      { path: filePath, filename: "big.txt", mimeType: "text/plain", size: content.length },
    ]);
    expect(context).toBe(`Attached document text:\n\nFile: big.txt\nMIME type: text/plain\n${content}`);
  });

  it.each(["outside", "missing", "symlink"])("excludes content and paths for %s inbound attachments", async (kind) => {
    const outside = path.join(home, "private.txt");
    await fs.writeFile(outside, "PRIVATE-CONTENT");
    const link = path.join(inbound, "linked.txt");
    await fs.symlink(outside, link);
    const filePath = kind === "outside" ? outside : kind === "symlink" ? link : path.join(inbound, "missing.txt");
    const context = await buildDocumentAttachmentContext([
      { path: filePath, filename: "document.txt", mimeType: "text/plain", size: 15 },
    ], { includeUnextractedPath: true });
    expect(context).toBe("Attached document text:\n\nFile: document.txt\nMIME type: text/plain\nContent: not extracted; inspect the attached file path if available.");
  });
});
