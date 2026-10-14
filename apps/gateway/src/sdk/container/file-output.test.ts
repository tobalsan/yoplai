import fs from "node:fs";
import fsPromises from "node:fs/promises";
import * as metadata from "../../media/metadata.js";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ContainerFileOutputAdapter,
  resolveContainerDataFile,
} from "./file-output.js";
import type { SdkRunParams } from "../types.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yoplai-file-output-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.YOPLAI_HOME;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("container file output adapter", () => {
  it("resolves only files under the container data directory", () => {
    expect(
      resolveContainerDataFile("/host/data", "/workspace/data/a/b.txt")
    ).toBe(path.join("/host/data", "a", "b.txt"));
    expect(() =>
      resolveContainerDataFile("/host/data", "/workspace/other/b.txt")
    ).toThrow("file_output path must be under /workspace/data");
  });

  it("registers outbound media and emits history plus stream events", async () => {
    const root = tempDir();
    process.env.YOPLAI_HOME = root;
    const hostDataDir = path.join(root, "agents", "cloud", "data");
    fs.mkdirSync(hostDataDir, { recursive: true });
    fs.writeFileSync(path.join(hostDataDir, "report.csv"), "a,b\n");
    const params = {
      agentId: "cloud",
      sessionId: "session-1",
      onHistoryEvent: vi.fn(),
      onEvent: vi.fn(),
    } as unknown as SdkRunParams;

    await new ContainerFileOutputAdapter().handle(
      params,
      {
        type: "file_output",
        path: "/workspace/data/report.csv",
        filename: "report.csv",
        mimeType: "text/csv",
      },
      hostDataDir
    );

    expect(params.onHistoryEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "assistant_file",
        filename: "report.csv",
        mimeType: "text/csv",
        size: 4,
      })
    );
    expect(params.onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "file_output",
        filename: "report.csv",
        mimeType: "text/csv",
        size: 4,
      })
    );
  });
  it.each(["missing", "directory", "symlink", "outside"])(
    "rejects %s sources without emitting a card",
    async (kind) => {
      const root = tempDir();
      const data = path.join(root, "data");
      fs.mkdirSync(data);
      fs.mkdirSync(path.join(data, "directory"));
      fs.writeFileSync(path.join(root, "outside"), "private");
      fs.symlinkSync(path.join(root, "outside"), path.join(data, "symlink"));
      const params = {
        agentId: "cloud",
        sessionId: "session-1",
        onHistoryEvent: vi.fn(),
        onEvent: vi.fn(),
      } as unknown as SdkRunParams;
      await expect(
        new ContainerFileOutputAdapter().handle(
          params,
          {
            type: "file_output",
            path:
              kind === "outside"
                ? "/workspace/data/../outside"
                : `/workspace/data/${kind}`,
          },
          data
        )
      ).rejects.toThrow();
      expect(params.onHistoryEvent).not.toHaveBeenCalled();
      expect(params.onEvent).not.toHaveBeenCalled();
    }
  );

  it.each(["copy", "registration", "history", "card"])(
    "propagates %s failures",
    async (kind) => {
      const root = tempDir();
      process.env.YOPLAI_HOME = root;
      const data = path.join(root, "data");
      fs.mkdirSync(data);
      fs.writeFileSync(path.join(data, "report.csv"), "a,b\n");
      const failure = new Error(`${kind} failed`);
      const params = {
        agentId: "cloud",
        sessionId: "session-1",
        onHistoryEvent: vi.fn(),
        onEvent: vi.fn(),
      } as unknown as SdkRunParams;
      if (kind === "copy")
        vi.spyOn(fsPromises, "copyFile").mockRejectedValueOnce(failure);
      if (kind === "registration")
        vi.spyOn(metadata, "registerMediaFile").mockRejectedValueOnce(failure);
      if (kind === "history")
        vi.mocked(params.onHistoryEvent).mockImplementationOnce(() => {
          throw failure;
        });
      if (kind === "card")
        vi.mocked(params.onEvent).mockImplementationOnce(() => {
          throw failure;
        });
      await expect(
        new ContainerFileOutputAdapter().handle(
          params,
          { type: "file_output", path: "/workspace/data/report.csv" },
          data
        )
      ).rejects.toThrow(`${kind} failed`);
      if (kind !== "card") expect(params.onEvent).not.toHaveBeenCalled();
    }
  );

});
