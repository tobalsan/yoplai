import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GatewayConfig } from "@yoplai/shared";
import { agentEventBus } from "@yoplai/shared";
import { clearProjectsContext, setProjectsContext } from "../context.js";
import { startProjectWatcher } from "./watcher.js";

async function waitFor<T>(
  read: () => T | undefined,
  timeoutMs: number
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return read();
}

describe("project watcher filesystem events", () => {
  let root = "";

  beforeEach(() => {
    setProjectsContext({
      getConfig: () => ({ version: 2, agents: [], extensions: {} }),
      getDataDir: () => os.tmpdir(),
      getAgents: () => [],
      getAgent: () => undefined,
      isAgentActive: () => true,
      isAgentStreaming: () => false,
      resolveWorkspaceDir: () => os.tmpdir(),
      runAgent: async () => ({ ok: true as const, data: {} }),
      getSubagentTemplates: () => [],
      resolveSessionId: async () => undefined,
      getSessionEntry: async () => undefined,
      clearSessionEntry: async () => undefined,
      restoreSessionUpdatedAt: () => {},
      deleteSession: () => {},
      invalidateHistoryCache: async () => {},
      getSessionHistory: async () => [],
      subscribe: () => () => {},
      emit: (event: string, payload: unknown) => {
        if (event === "agent.changed") {
          agentEventBus.emitAgentChanged(payload as never);
          return;
        }
        if (event === "file.changed") {
          agentEventBus.emitFileChanged(payload as never);
        }
      },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    } as never);
  });

  afterEach(async () => {
    clearProjectsContext();
    if (root) {
      await fs.rm(root, { recursive: true, force: true });
      root = "";
    }
  });

  it("emits agent_changed when a nested session state.json changes", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-watcher-"));
    const sessionDir = path.join(root, "PRO-200_test", "sessions", "worker-a");
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, "state.json"),
      JSON.stringify({ supervisor_pid: 0 }),
      "utf8"
    );

    const received: string[] = [];
    const offEvent = agentEventBus.onAgentChanged((event) => {
      received.push(event.projectId);
    });
    const watcher = startProjectWatcher({
      projects: { root },
    } as GatewayConfig);

    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      await fs.writeFile(
        path.join(sessionDir, "state.json"),
        JSON.stringify({ supervisor_pid: process.pid }),
        "utf8"
      );

      const projectId = await waitFor(() => received[0], 2_000);
      expect(projectId).toBe("PRO-200");
    } finally {
      offEvent();
      await watcher.close();
    }
  });

  it("emits file_changed for markdown under a hidden YOPLAI_HOME root", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), ".yoplai-watcher-"));
    const readmePath = path.join(
      root,
      "projects",
      "PRO-201_test",
      "slices",
      "PRO-201-S01",
      "README.md"
    );
    await fs.mkdir(path.dirname(readmePath), { recursive: true });
    await fs.writeFile(readmePath, "before\n", "utf8");

    const received: Array<{ projectId: string; file: string }> = [];
    const offEvent = agentEventBus.onFileChanged((event) => {
      received.push({ projectId: event.projectId, file: event.file });
    });
    const watcher = startProjectWatcher({
      projects: { root: path.join(root, "projects") },
    } as GatewayConfig);

    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      await fs.writeFile(readmePath, "after\n", "utf8");

      const event = await waitFor(() => received[0], 2_000);
      expect(event).toEqual({
        projectId: "PRO-201",
        file: "PRO-201_test/slices/PRO-201-S01/README.md",
      });
    } finally {
      offEvent();
      await watcher.close();
    }
  });
});
