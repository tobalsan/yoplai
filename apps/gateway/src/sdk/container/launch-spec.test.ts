import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  prepareContainerUploads,
  remapAttachmentsToContainer,
  sanitizeFilename,
} from "./launch-spec.js";

const tempDirs: string[] = [];

const mockGetMediaInboundDir = vi.hoisted(() => vi.fn());

vi.mock("../../media/metadata.js", () => ({
  getMediaInboundDir: mockGetMediaInboundDir,
}));

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yoplai-launch-spec-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("container launch spec", () => {
  it("sanitizes names and remaps attachments to container upload paths", () => {
    expect(sanitizeFilename("../bad\rname.txt", "fallback")).toBe(
      "bad_name.txt"
    );
    expect(
      remapAttachmentsToContainer([
        {
          path: "/host/inbound/a.txt",
          filename: "../a.txt",
          mimeType: "text/plain",
          size: 1,
        },
      ])
    ).toEqual([
      {
        path: "/workspace/uploads/1-a.txt",
        filename: "../a.txt",
        mimeType: "text/plain",
        size: 1,
      },
    ]);
  });

  it("copies only inbound media files into the upload dir", () => {
    const root = tempDir();
    const inbound = path.join(root, "inbound");
    const uploads = path.join(root, "uploads");
    fs.mkdirSync(inbound, { recursive: true });
    const source = path.join(inbound, "note.txt");
    fs.writeFileSync(source, "hello");
    mockGetMediaInboundDir.mockReturnValue(inbound);

    prepareContainerUploads(
      [{ path: source, filename: "note.txt", mimeType: "text/plain", size: 5 }],
      uploads
    );

    expect(fs.readFileSync(path.join(uploads, "1-note.txt"), "utf8")).toBe(
      "hello"
    );
  });
});
