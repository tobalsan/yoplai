import fs from "node:fs";
import fsPromises from "node:fs/promises";
import * as metadata from "../../media/metadata.js";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ContainerFileOutputAdapter,
  isFileOutputRejectedError,
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

  it.each(["report.csv", "sub/dir/report.csv"])(
    "registers legacy outbound media %s and emits history plus stream events",
    async (source) => {
      const root = tempDir();
      process.env.YOPLAI_HOME = root;
      const hostDataDir = path.join(root, "agents", "cloud", "data");
      fs.mkdirSync(hostDataDir, { recursive: true });
      fs.mkdirSync(path.dirname(path.join(hostDataDir, source)), {
        recursive: true,
      });
      fs.writeFileSync(path.join(hostDataDir, source), "a,b\n");
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
          path: `/workspace/data/${source}`,
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
    }
  );

  it.each(["sub/dir/report.csv", "sub/dir/../dir/report.csv"])(
    "sends nested conversation file %s with its basename and original bytes",
    async (source) => {
      const root = tempDir();
      process.env.YOPLAI_HOME = root;
      const data = path.join(root, "files");
      fs.mkdirSync(path.join(data, "sub", "dir"), { recursive: true });
      fs.writeFileSync(path.join(data, "sub", "dir", "report.csv"), "a,b\n");
      const params = {
        agentId: "cloud",
        sessionId: "session-1",
        onHistoryEvent: vi.fn(),
        onEvent: vi.fn(),
      } as unknown as SdkRunParams;

      await new ContainerFileOutputAdapter().handle(
        params,
        { type: "file_output", path: `/conversation/files/${source}` },
        undefined,
        undefined,
        { hostPath: data, runtimePath: "/conversation/files" }
      );

      expect(params.onHistoryEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "assistant_file",
          filename: "report.csv",
          size: 4,
        })
      );
      expect(params.onEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "file_output",
          filename: "report.csv",
          size: 4,
        })
      );
      const event = vi.mocked(params.onEvent).mock.calls[0][0];
      if (event.type !== "file_output") throw new Error("Expected file output");
      const stored = await metadata.getMediaFileMetadata(event.fileId);
      expect(stored).not.toBeNull();
      expect(
        await fsPromises.readFile(
          await metadata.resolveMediaFilePath(stored!),
          "utf8"
        )
      ).toBe("a,b\n");
    }
  );
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
      const error = await new ContainerFileOutputAdapter()
        .handle(
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
        .catch((error: unknown) => error);
      expect(isFileOutputRejectedError(error)).toBe(true);
      expect(params.onHistoryEvent).not.toHaveBeenCalled();
      expect(params.onEvent).not.toHaveBeenCalled();
    }
  );

  it.each([
    "missing.csv",
    "missing/report.csv",
    "directory",
    "symlink",
    "file/report.csv",
    "../../outside.csv",
  ])(
    "classifies invalid nested conversation file %s as rejected output",
    async (source) => {
      const root = tempDir();
      const data = path.join(root, "files");
      fs.mkdirSync(path.join(data, "sub"), { recursive: true });
      fs.mkdirSync(path.join(data, "sub", "directory"));
      fs.writeFileSync(path.join(data, "sub", "file"), "a,b\n");
      fs.symlinkSync(
        path.join(data, "sub", "file"),
        path.join(data, "sub", "symlink")
      );
      const params = {
        agentId: "cloud",
        sessionId: "session-1",
        onHistoryEvent: vi.fn(),
        onEvent: vi.fn(),
      } as unknown as SdkRunParams;

      const error = await new ContainerFileOutputAdapter()
        .handle(
          params,
          { type: "file_output", path: `/conversation/files/sub/${source}` },
          undefined,
          undefined,
          { hostPath: data, runtimePath: "/conversation/files" }
        )
        .catch((error: unknown) => error);

      expect(isFileOutputRejectedError(error)).toBe(true);
      expect(params.onHistoryEvent).not.toHaveBeenCalled();
      expect(params.onEvent).not.toHaveBeenCalled();
    }
  );

  it.each(["inside", "outside"])(
    "rejects a conversation directory symlink pointing %s the root",
    async (kind) => {
      const root = tempDir();
      process.env.YOPLAI_HOME = root;
      const data = path.join(root, "files");
      const destination = path.join(kind === "inside" ? data : root, "real");
      fs.mkdirSync(destination, { recursive: true });
      fs.mkdirSync(data, { recursive: true });
      fs.writeFileSync(path.join(destination, "report.csv"), "a,b\n");
      fs.symlinkSync(destination, path.join(data, "linked"));
      const params = {
        agentId: "cloud",
        sessionId: "session-1",
        onHistoryEvent: vi.fn(),
        onEvent: vi.fn(),
      } as unknown as SdkRunParams;

      const error = await new ContainerFileOutputAdapter()
        .handle(
          params,
          {
            type: "file_output",
            path: "/conversation/files/linked/report.csv",
          },
          undefined,
          undefined,
          { hostPath: data, runtimePath: "/conversation/files" }
        )
        .catch((error: unknown) => error);

      expect(isFileOutputRejectedError(error)).toBe(true);
      expect(params.onHistoryEvent).not.toHaveBeenCalled();
      expect(params.onEvent).not.toHaveBeenCalled();
    }
  );

  it("classifies an unavailable conversation files directory as rejected output", async () => {
    const params = {
      agentId: "cloud",
      sessionId: "session-1",
      onHistoryEvent: vi.fn(),
      onEvent: vi.fn(),
    } as unknown as SdkRunParams;
    const error = await new ContainerFileOutputAdapter()
      .handle(
        params,
        { type: "file_output", path: "/conversation/files/report.csv" },
        undefined
      )
      .catch((error: unknown) => error);
    expect(isFileOutputRejectedError(error)).toBe(true);
    expect(error).toHaveProperty(
      "message",
      "File path must be under the conversation files directory"
    );
    expect(params.onHistoryEvent).not.toHaveBeenCalled();
    expect(params.onEvent).not.toHaveBeenCalled();
  });

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
      const error = await new ContainerFileOutputAdapter()
        .handle(
          params,
          { type: "file_output", path: "/workspace/data/report.csv" },
          data
        )
        .catch((error: unknown) => error);
      expect(error).toBe(failure);
      expect(isFileOutputRejectedError(error)).toBe(false);
      if (kind !== "card") expect(params.onEvent).not.toHaveBeenCalled();
    }
  );
});
