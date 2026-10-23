import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_UPLOAD_SIZE_BYTES,
  downloadSlackFile,
  extractSlackFilePreview,
  formatSlackFileError,
  getSlackFileMimeType,
  getSlackFileFilename,
  isSlackTextFile,
  isSupportedSlackFile,
  isSlackSnippet,
  uploadSlackFileToMedia,
  type SlackFile,
} from "./attachments.js";

describe("Slack attachment helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("allows the v1 Slack file MIME set", () => {
    const supported = [
      ["photo.jpg", "image/jpeg"],
      ["photo.png", "image/png"],
      ["photo.gif", "image/gif"],
      ["photo.webp", "image/webp"],
      ["doc.pdf", "application/pdf"],
      ["doc.doc", "application/msword"],
      [
        "doc.docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ],
      ["sheet.xls", "application/vnd.ms-excel"],
      [
        "sheet.xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ],
    ] satisfies Array<[string, string]>;

    for (const [name, mimetype] of supported) {
      expect(isSupportedSlackFile({ name, mimetype })).toBe(true);
    }
  });

  it("rejects unsupported binary files", () => {
    expect(
      isSupportedSlackFile({ name: "archive.zip", mimetype: "application/zip" })
    ).toBe(false);
    expect(
      isSupportedSlackFile({ name: "picture.svg", mimetype: "image/svg+xml" })
    ).toBe(false);
  });

  it("rejects supported extensions with unsupported or mismatched MIME types", () => {
    expect(
      isSupportedSlackFile({ name: "doc.pdf", mimetype: "text/plain" })
    ).toBe(false);
    expect(
      isSupportedSlackFile({
        name: "doc.pdf",
        mimetype:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      })
    ).toBe(false);
    expect(
      isSupportedSlackFile({
        name: "sheet.xlsx",
        mimetype: "application/pdf",
      })
    ).toBe(false);
  });

  it("keeps extension fallback when Slack omits MIME type", () => {
    expect(isSupportedSlackFile({ name: "sheet.xlsx" })).toBe(true);
  });

  it("marks failed text file previews as truncated", () => {
    const file: SlackFile = {
      name: "example.ts",
      mode: "snippet",
      mimetype: "text/plain",
      preview: "const x = 1;",
    };

    expect(isSlackSnippet(file)).toBe(true);
    expect(extractSlackFilePreview(file)).toBe("Snippet: example.ts (truncated preview; the full file could not be downloaded)\n```\nconst x = 1;\n```");
    expect(extractSlackFilePreview({ name: "notes.md", preview: "intro" })).toContain("truncated preview");
    expect(extractSlackFilePreview({ name: "notes.md", preview: "  " })).toBeNull();
    expect(extractSlackFilePreview({ name: "archive.zip", preview: "binary" })).toBeNull();
  });

  it("requires a real dotted suffix unless Slack marks the file as a snippet", () => {
    expect(isSlackTextFile({ name: "csv", mimetype: "text/csv" })).toBe(false);
    expect(isSupportedSlackFile({ name: "csv", mimetype: "text/csv" })).toBe(false);
    expect(isSlackTextFile({ name: "Untitled", subtype: "snippet", filetype: "python" })).toBe(true);
    expect(isSlackTextFile({ name: "script.py", mode: "snippet" })).toBe(true);
    expect(isSlackTextFile({ name: "script.py", mimetype: "text/plain" })).toBe(false);
    expect(isSlackTextFile({ name: "NOTES.MARKDOWN" })).toBe(true);
  });

  it.each([
    ["notes.md", "text/markdown", "notes.md"],
    ["notes.markdown", "text/markdown", "notes.markdown"],
    ["notes.txt", "text/plain", "notes.txt"],
    ["data.csv", "text/csv", "data.csv"],
    ["data.json", "application/json", "data.json"],
    ["script.py", "text/plain", "script.py.txt"],
    ["Untitled", "text/plain", "Untitled.txt"],
    ["my notes", "text/plain", "my notes.txt"],
  ])("maps %s to a gateway-compatible text attachment", (name, mimeType, filename) => {
    const file = { name, mode: "snippet", mimetype: "text/plain" };
    expect(isSupportedSlackFile(file)).toBe(true);
    expect(getSlackFileMimeType(file)).toBe(mimeType);
    expect(getSlackFileFilename(file)).toBe(filename);
  });

  it("downloads Slack files with bot-token auth", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await downloadSlackFile(
      {
        name: "screen.png",
        mimetype: "image/png",
        url_private_download: "https://files.slack.test/screen.png",
      },
      "xoxb-token"
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://files.slack.test/screen.png",
      { headers: { Authorization: "Bearer xoxb-token" } }
    );
    expect(result).toEqual({
      buffer: Buffer.from([1, 2, 3]),
      mimeType: "image/png",
      filename: "screen.png",
    });
  });

  it("rejects downloaded files over 25MB", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(new Uint8Array(MAX_UPLOAD_SIZE_BYTES + 1), {
          status: 200,
        })
      )
    );

    await expect(
      downloadSlackFile(
        {
          name: "large.pdf",
          mimetype: "application/pdf",
          url_private_download: "https://files.slack.test/large.pdf",
        },
        "xoxb-token"
      )
    ).rejects.toThrow("25MB");
  });

  it("maps extension-only files to the expected MIME type", () => {
    expect(getSlackFileMimeType({ name: "doc.doc" })).toBe("application/msword");
    expect(getSlackFileMimeType({ name: "sheet.xls" })).toBe(
      "application/vnd.ms-excel"
    );
    expect(getSlackFileMimeType({ name: "sheet.xlsx" })).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
  });

  it("uploads downloaded files through the media context", async () => {
    const saveMediaFile = vi.fn().mockResolvedValue({
      path: "/media/inbound/file.png",
      mimeType: "image/png",
      filename: "file.png",
      size: 3,
    });

    await expect(
      uploadSlackFileToMedia(
        {
          buffer: Buffer.from([1, 2, 3]),
          mimeType: "image/png",
          filename: "file.png",
        },
        saveMediaFile
      )
    ).resolves.toEqual({
      path: "/media/inbound/file.png",
      mimeType: "image/png",
      filename: "file.png",
      size: 3,
    });
    expect(saveMediaFile).toHaveBeenCalledWith(
      Buffer.from([1, 2, 3]),
      "image/png",
      "file.png"
    );
  });

  it("formats visible Slack file errors", () => {
    expect(formatSlackFileError({ name: "bad.zip" }, "Unsupported")).toBe(
      "Could not process bad.zip: Unsupported"
    );
  });
});
