import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import type { GatewayConfig } from "@yoplai/shared";

describe("createExtensionContext media helpers", () => {
  let tmpDir: string;
  let prevHomeDir: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-context-"));
    prevHomeDir = process.env.YOPLAI_HOME;
    process.env.YOPLAI_HOME = tmpDir;
    vi.resetModules();
  });

  afterEach(async () => {
    if (prevHomeDir === undefined) delete process.env.YOPLAI_HOME;
    else process.env.YOPLAI_HOME = prevHomeDir;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("rejects tampered media metadata paths outside the media directory", async () => {
    const outsidePath = path.join(tmpDir, "outside.txt");
    await fs.writeFile(outsidePath, "secret", "utf8");

    const { registerMediaFile } = await import("../media/metadata.js");
    const metadata = await registerMediaFile({
      direction: "inbound",
      filename: "outside.txt",
      storedFilename: "../outside.txt",
      path: outsidePath,
      mimeType: "text/plain",
      size: 6,
    });

    const { createExtensionContext } = await import("./context.js");
    const ctx = createExtensionContext({
      version: 2,
      agents: [],
    } as unknown as GatewayConfig);

    await expect(ctx.readMediaFile?.(metadata.fileId)).rejects.toThrow(
      "Media file not found"
    );
  });

  it("rejects media metadata path traversal even with a valid stored filename", async () => {
    const { getMediaInboundDir, registerMediaFile } = await import(
      "../media/metadata.js"
    );
    const inboundDir = getMediaInboundDir();
    await fs.mkdir(inboundDir, { recursive: true });

    const storedFilename = `${randomUUID()}.txt`;
    const storedPath = path.join(inboundDir, storedFilename);
    const outsidePath = path.join(tmpDir, "outside.txt");
    await fs.writeFile(storedPath, "safe", "utf8");
    await fs.writeFile(outsidePath, "secret", "utf8");

    const metadata = await registerMediaFile({
      direction: "inbound",
      filename: "safe.txt",
      storedFilename,
      path: outsidePath,
      mimeType: "text/plain",
      size: 4,
    });

    const { createExtensionContext } = await import("./context.js");
    const ctx = createExtensionContext({
      version: 2,
      agents: [],
    } as unknown as GatewayConfig);

    await expect(ctx.readMediaFile?.(metadata.fileId)).rejects.toThrow(
      "Media file not found"
    );
  });

  it("rejects media files whose stored filename symlink escapes the media directory", async () => {
    const { getMediaInboundDir, registerMediaFile } = await import(
      "../media/metadata.js"
    );
    const inboundDir = getMediaInboundDir();
    await fs.mkdir(inboundDir, { recursive: true });

    const outsidePath = path.join(tmpDir, "outside.txt");
    const storedFilename = `${randomUUID()}.txt`;
    const symlinkPath = path.join(inboundDir, storedFilename);
    await fs.writeFile(outsidePath, "secret", "utf8");
    await fs.symlink(outsidePath, symlinkPath);

    const metadata = await registerMediaFile({
      direction: "inbound",
      filename: "safe.txt",
      storedFilename,
      path: symlinkPath,
      mimeType: "text/plain",
      size: 6,
    });

    const { createExtensionContext } = await import("./context.js");
    const ctx = createExtensionContext({
      version: 2,
      agents: [],
    } as unknown as GatewayConfig);

    await expect(ctx.readMediaFile?.(metadata.fileId)).rejects.toThrow(
      "Media file not found"
    );
  });

  it("rejects stored media filenames containing a null byte", async () => {
    const { registerMediaFile } = await import("../media/metadata.js");
    const metadata = await registerMediaFile({
      direction: "inbound",
      filename: "passwd",
      storedFilename: "foo\0../etc/passwd",
      path: path.join(tmpDir, "media", "inbound", "foo\0../etc/passwd"),
      mimeType: "text/plain",
      size: 0,
    });

    const { createExtensionContext } = await import("./context.js");
    const ctx = createExtensionContext({
      version: 2,
      agents: [],
    } as unknown as GatewayConfig);

    await expect(ctx.readMediaFile?.(metadata.fileId)).rejects.toThrow(
      "Media file not found"
    );
  });
});
