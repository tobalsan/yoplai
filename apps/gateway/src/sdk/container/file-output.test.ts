import fs from "node:fs";
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
});
