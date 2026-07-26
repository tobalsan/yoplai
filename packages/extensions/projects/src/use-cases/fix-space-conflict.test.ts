import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GatewayConfig } from "@yoplai/shared";
import {
  fixSpaceQueueConflict,
  fixSpaceRebaseConflict,
} from "./fix-space-conflict.js";

let tmpDir: string | undefined;

afterEach(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

function makeConfig(root: string): GatewayConfig {
  return {
    agents: [],
    extensions: { projects: { enabled: true, root } },
    projects: { root },
  } as unknown as GatewayConfig;
}

describe("fix space conflict use cases", () => {
  it("maps missing project space for rebase fixer to a not-found result", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-space-fix-"));
    const result = await fixSpaceRebaseConflict(makeConfig(tmpDir), "PRO-1");

    expect(result).toEqual({
      ok: false,
      error: "Project not found: PRO-1",
      status: 404,
    });
  });

  it("maps missing conflict entries to a not-found result", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-space-fix-"));
    const result = await fixSpaceQueueConflict(
      makeConfig(tmpDir),
      "PRO-1",
      "entry-1"
    );

    expect(result).toEqual({
      ok: false,
      error: "Project not found: PRO-1",
      status: 404,
    });
  });
});
