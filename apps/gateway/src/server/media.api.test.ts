import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import os from "node:os";

describe("media upload API", () => {
  let tmpDir: string;
  let api: {
    request: (
      input: RequestInfo,
      init?: RequestInit
    ) => Response | Promise<Response>;
  };
  let mediaMetadata: typeof import("../media/metadata.js");
  let prevHomeDir: string | undefined;
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-media-"));

    prevHomeDir = process.env.YOPLAI_HOME;
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    process.env.YOPLAI_HOME = path.join(tmpDir, ".yoplai");
    process.env.HOME = tmpDir;
    process.env.USERPROFILE = tmpDir;

    vi.resetModules();
    const mod = await import("../server/api.core.js");
    api = mod.api;
    mediaMetadata = await import("../media/metadata.js");
  });

  afterAll(async () => {
    if (prevHomeDir === undefined) delete process.env.YOPLAI_HOME;
    else process.env.YOPLAI_HOME = prevHomeDir;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("uploads allowed image files", async () => {
    const data = new Uint8Array([1, 2, 3, 4]);
    const file = new File([data], "test.png", { type: "image/png" });
    const formData = new FormData();
    formData.set("file", file);

    const res = await Promise.resolve(
      api.request("/media/upload", {
        method: "POST",
        body: formData,
      })
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.mimeType).toBe("image/png");
    expect(json.size).toBe(data.length);
    expect(json.path).toContain(path.join(".yoplai", "media", "inbound"));

    const saved = await fs.readFile(json.path);
    expect(saved.length).toBe(data.length);
  });

  it("uploads allowed document files", async () => {
    const files = [
      ["test.pdf", "application/pdf"],
      ["test.txt", "text/plain"],
      ["test.md", "text/markdown"],
      ["test.csv", "text/csv"],
      ["test.doc", "application/msword"],
      [
        "test.docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ],
      ["test.xls", "application/vnd.ms-excel"],
      [
        "test.xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ],
    ];

    for (const [filename, mimeType] of files) {
      const file = new File([new Uint8Array([1])], filename, {
        type: mimeType,
      });
      const formData = new FormData();
      formData.set("file", file);

      const res = await Promise.resolve(
        api.request("/media/upload", {
          method: "POST",
          body: formData,
        })
      );

      expect(res.status).toBe(200);
    }
  });

  it("rejects mismatched upload extensions", async () => {
    const file = new File([new Uint8Array([1])], "test.pdf", {
      type: "image/png",
    });
    const formData = new FormData();
    formData.set("file", file);

    const res = await Promise.resolve(
      api.request("/media/upload", {
        method: "POST",
        body: formData,
      })
    );

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("does not match");
  });

  it("accepts allowed extensions when browser MIME is blank", async () => {
    const file = new File([new Uint8Array([1])], "notes.md", { type: "" });
    const formData = new FormData();
    formData.set("file", file);

    const res = await Promise.resolve(
      api.request("/media/upload", {
        method: "POST",
        body: formData,
      })
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.mimeType).toBe("text/markdown");
  });

  it("rejects files larger than 25MB", async () => {
    const file = new File([new Uint8Array(25 * 1024 * 1024 + 1)], "big.txt", {
      type: "text/plain",
    });
    const formData = new FormData();
    formData.set("file", file);

    const res = await Promise.resolve(
      api.request("/media/upload", {
        method: "POST",
        body: formData,
      })
    );

    expect(res.status).toBe(413);
    const json = await res.json();
    expect(json.error).toContain("25MB");
  });

  it("rejects unsupported file types", async () => {
    const file = new File([new Uint8Array([9])], "test.bin", {
      type: "application/x-foo",
    });
    const formData = new FormData();
    formData.set("file", file);

    const res = await Promise.resolve(
      api.request("/media/upload", {
        method: "POST",
        body: formData,
      })
    );

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("Unsupported file");
    expect(Array.isArray(json.allowedTypes)).toBe(true);
  });

  it("downloads registered inbound files", async () => {
    const file = new File([new Uint8Array([5, 6, 7])], "report.csv", {
      type: "text/csv",
    });
    const formData = new FormData();
    formData.set("file", file);

    const uploadRes = await Promise.resolve(
      api.request("/media/upload", {
        method: "POST",
        body: formData,
      })
    );
    const upload = await uploadRes.json();
    const fileId = path.basename(
      upload.filename,
      path.extname(upload.filename)
    );

    const res = await Promise.resolve(api.request(`/media/download/${fileId}`));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="report.csv"'
    );
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(
      new Uint8Array([5, 6, 7])
    );
  });

  it("downloads registered outbound files", async () => {
    await mediaMetadata.ensureMediaDirectories();
    const fileId = "11111111-1111-4111-8111-111111111111";
    const storedFilename = `${fileId}.txt`;
    const filePath = path.join(
      mediaMetadata.MEDIA_OUTBOUND_DIR,
      storedFilename
    );
    await fs.writeFile(filePath, "outbound");
    await mediaMetadata.registerMediaFile({
      direction: "outbound",
      fileId,
      filename: "answer.txt",
      storedFilename,
      path: filePath,
      mimeType: "text/plain",
      size: 8,
    });

    const res = await Promise.resolve(api.request(`/media/download/${fileId}`));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="answer.txt"'
    );
    expect(await res.text()).toBe("outbound");
  });

  it("returns 404 for invalid or unsafe download ids", async () => {
    const invalid = await Promise.resolve(api.request("/media/download/nope"));
    expect(invalid.status).toBe(404);

    await mediaMetadata.ensureMediaDirectories();
    const fileId = "22222222-2222-4222-8222-222222222222";
    await mediaMetadata.registerMediaFile({
      direction: "outbound",
      fileId,
      filename: "evil.txt",
      storedFilename: "../evil.txt",
      path: path.join(tmpDir, "evil.txt"),
      mimeType: "text/plain",
      size: 4,
    });

    const unsafe = await Promise.resolve(
      api.request(`/media/download/${fileId}`)
    );
    expect(unsafe.status).toBe(404);
  });
});
