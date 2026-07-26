import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

describe("media metadata", () => {
  let tmpDir: string;
  let prevHomeDir: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-media-meta-"));
    prevHomeDir = process.env.YOPLAI_HOME;
    process.env.YOPLAI_HOME = tmpDir;
    vi.resetModules();
  });

  afterEach(async () => {
    if (prevHomeDir === undefined) delete process.env.YOPLAI_HOME;
    else process.env.YOPLAI_HOME = prevHomeDir;

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("registers inbound and outbound files", async () => {
    const {
      MEDIA_INBOUND_DIR,
      MEDIA_OUTBOUND_DIR,
      getMediaFileMetadata,
      registerMediaFile,
    } = await import("./metadata.js");

    const inbound = await registerMediaFile({
      direction: "inbound",
      fileId: "in-1",
      filename: "source.pdf",
      storedFilename: "in-1.pdf",
      path: path.join(MEDIA_INBOUND_DIR, "in-1.pdf"),
      mimeType: "application/pdf",
      size: 10,
      sessionId: "session-1",
    });
    const outbound = await registerMediaFile({
      direction: "outbound",
      fileId: "out-1",
      filename: "report.csv",
      storedFilename: "out-1.csv",
      path: path.join(MEDIA_OUTBOUND_DIR, "out-1.csv"),
      mimeType: "text/csv",
      size: 20,
      agentId: "agent-1",
    });

    await expect(fs.stat(MEDIA_OUTBOUND_DIR)).resolves.toBeTruthy();
    await expect(getMediaFileMetadata("in-1")).resolves.toMatchObject({
      fileId: inbound.fileId,
      direction: inbound.direction,
      filename: inbound.filename,
      storedFilename: inbound.storedFilename,
      path: inbound.path,
      mimeType: inbound.mimeType,
      size: inbound.size,
      createdAt: inbound.createdAt,
      sessionId: inbound.sessionId,
    });
    await expect(getMediaFileMetadata("out-1")).resolves.toMatchObject({
      fileId: outbound.fileId,
      direction: outbound.direction,
      filename: outbound.filename,
      storedFilename: outbound.storedFilename,
      path: outbound.path,
      mimeType: outbound.mimeType,
      size: outbound.size,
      createdAt: outbound.createdAt,
      agentId: outbound.agentId,
    });
  });

  it("keeps every entry when registrations run concurrently", async () => {
    const { MEDIA_OUTBOUND_DIR, readMediaMetadata, registerMediaFile } =
      await import("./metadata.js");

    // A multi-file send_file fires registrations concurrently. Without
    // serialization they collide on the temp file (ENOENT) and clobber each
    // other's entries.
    const count = 8;
    await Promise.all(
      Array.from({ length: count }, (_, i) =>
        registerMediaFile({
          direction: "outbound",
          fileId: `out-${i}`,
          filename: `f${i}.csv`,
          storedFilename: `out-${i}.csv`,
          path: path.join(MEDIA_OUTBOUND_DIR, `out-${i}.csv`),
          mimeType: "text/csv",
          size: i,
        })
      )
    );

    const store = await readMediaMetadata();
    expect(Object.keys(store).sort()).toEqual(
      Array.from({ length: count }, (_, i) => `out-${i}`).sort()
    );
  });

  it("quarantines a corrupt store and self-heals instead of throwing", async () => {
    const { MEDIA_METADATA_PATH, MEDIA_OUTBOUND_DIR, readMediaMetadata, registerMediaFile } =
      await import("./metadata.js");

    // Trailing junk after a valid object: a complete JSON value followed by
    // non-whitespace, which is exactly how the prod store got corrupted.
    await fs.mkdir(path.dirname(MEDIA_METADATA_PATH), { recursive: true });
    await fs.writeFile(MEDIA_METADATA_PATH, '{"old": 1}\n  }\n}\n');

    // Reading must not throw, and the bad file is quarantined.
    await expect(readMediaMetadata()).resolves.toEqual({});
    await expect(fs.stat(`${MEDIA_METADATA_PATH}.corrupt`)).resolves.toBeTruthy();

    // A subsequent registration rebuilds a valid store.
    const entry = await registerMediaFile({
      direction: "outbound",
      fileId: "out-2",
      filename: "fresh.csv",
      storedFilename: "out-2.csv",
      path: path.join(MEDIA_OUTBOUND_DIR, "out-2.csv"),
      mimeType: "text/csv",
      size: 5,
    });
    await expect(readMediaMetadata()).resolves.toMatchObject({
      "out-2": { fileId: entry.fileId },
    });
  });
});
