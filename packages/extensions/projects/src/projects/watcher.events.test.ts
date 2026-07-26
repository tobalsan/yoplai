import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayConfig } from "@yoplai/shared";
import { clearProjectsContext, setProjectsContext } from "../context.js";

type MockWatcher = {
  on: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  emitAll: (event: string, changedPath: string) => void;
};

const mockWatchers: MockWatcher[] = [];

vi.mock("chokidar", () => ({
  default: {
    watch: vi.fn(() => {
      const handlers = new Map<string, (event: string, path: string) => void>();
      const watcher: MockWatcher = {
        on: vi.fn(
          (event: string, handler: (event: string, path: string) => void) => {
            handlers.set(event, handler);
            return watcher;
          }
        ),
        close: vi.fn(async () => {}),
        emitAll: (event: string, changedPath: string) => {
          handlers.get("all")?.(event, changedPath);
        },
      };
      mockWatchers.push(watcher);
      return watcher;
    }),
  },
}));

vi.mock("@yoplai/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@yoplai/shared")>();
  return {
    ...actual,
    agentEventBus: {
      emitFileChanged: vi.fn(),
      emitAgentChanged: vi.fn(),
    },
  };
});

import { agentEventBus } from "@yoplai/shared";
import { startProjectWatcher } from "./watcher.js";

describe("project watcher file debounce", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setProjectsContext({
      getConfig: () => ({ version: 2, agents: [], extensions: {} }),
      getDataDir: () => "/tmp",
      getAgents: () => [],
      getAgent: () => undefined,
      isAgentActive: () => true,
      isAgentStreaming: () => false,
      resolveWorkspaceDir: () => "/tmp",
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
        if (event === "file.changed") {
          (agentEventBus.emitFileChanged as (arg: unknown) => void)(payload);
          return;
        }
        if (event === "agent.changed") {
          (agentEventBus.emitAgentChanged as (arg: unknown) => void)(payload);
        }
      },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    } as never);
  });

  afterEach(() => {
    clearProjectsContext();
    vi.useRealTimers();
    vi.clearAllMocks();
    mockWatchers.length = 0;
  });

  it("emits every changed file for a project within debounce window", async () => {
    const watcher = startProjectWatcher({
      projects: { root: "/tmp/projects" },
    } as GatewayConfig);

    const markdownWatcher = mockWatchers[0];
    expect(markdownWatcher).toBeDefined();

    markdownWatcher.emitAll(
      "change",
      "/tmp/projects/PRO-153_make_ui_update_in_real_time/README.md"
    );
    markdownWatcher.emitAll(
      "change",
      "/tmp/projects/PRO-153_make_ui_update_in_real_time/SPECS.md"
    );

    vi.advanceTimersByTime(300);

    expect(agentEventBus.emitFileChanged).toHaveBeenCalledTimes(2);
    expect(agentEventBus.emitFileChanged).toHaveBeenCalledWith({
      type: "file_changed",
      projectId: "PRO-153",
      file: "PRO-153_make_ui_update_in_real_time/README.md",
    });
    expect(agentEventBus.emitFileChanged).toHaveBeenCalledWith({
      type: "file_changed",
      projectId: "PRO-153",
      file: "PRO-153_make_ui_update_in_real_time/SPECS.md",
    });

    await watcher.close();
  });

  it("emits file changes for projects in .done", async () => {
    const watcher = startProjectWatcher({
      projects: { root: "/tmp/projects" },
    } as GatewayConfig);

    const markdownWatcher = mockWatchers[0];
    expect(markdownWatcher).toBeDefined();

    markdownWatcher.emitAll(
      "change",
      "/tmp/projects/.done/PRO-233_done_project/README.md"
    );

    vi.advanceTimersByTime(300);

    expect(agentEventBus.emitFileChanged).toHaveBeenCalledWith({
      type: "file_changed",
      projectId: "PRO-233",
      file: ".done/PRO-233_done_project/README.md",
    });

    await watcher.close();
  });
});

describe("project watcher agent_changed events", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setProjectsContext({
      getConfig: () => ({ version: 2, agents: [], extensions: {} }),
      getDataDir: () => "/tmp",
      getAgents: () => [],
      getAgent: () => undefined,
      isAgentActive: () => true,
      isAgentStreaming: () => false,
      resolveWorkspaceDir: () => "/tmp",
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
        if (event === "file.changed") {
          (agentEventBus.emitFileChanged as (arg: unknown) => void)(payload);
          return;
        }
        if (event === "agent.changed") {
          (agentEventBus.emitAgentChanged as (arg: unknown) => void)(payload);
        }
      },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    } as never);
  });

  afterEach(() => {
    clearProjectsContext();
    vi.useRealTimers();
    vi.clearAllMocks();
    mockWatchers.length = 0;
  });

  it("emits agent_changed when state.json changes in sessions dir", async () => {
    const watcher = startProjectWatcher({
      projects: { root: "/tmp/projects" },
    } as GatewayConfig);

    const sessionsWatcher = mockWatchers[1];
    expect(sessionsWatcher).toBeDefined();

    sessionsWatcher.emitAll(
      "change",
      "/tmp/projects/PRO-200_test/sessions/worker-a/state.json"
    );

    vi.advanceTimersByTime(300);

    expect(agentEventBus.emitAgentChanged).toHaveBeenCalledTimes(1);
    expect(agentEventBus.emitAgentChanged).toHaveBeenCalledWith({
      type: "agent_changed",
      projectId: "PRO-200",
    });

    await watcher.close();
  });

  it("emits agent_changed for projects in .done", async () => {
    const watcher = startProjectWatcher({
      projects: { root: "/tmp/projects" },
    } as GatewayConfig);

    const sessionsWatcher = mockWatchers[1];
    expect(sessionsWatcher).toBeDefined();

    sessionsWatcher.emitAll(
      "change",
      "/tmp/projects/.done/PRO-233_done_project/sessions/worker-a/state.json"
    );

    vi.advanceTimersByTime(300);

    expect(agentEventBus.emitAgentChanged).toHaveBeenCalledTimes(1);
    expect(agentEventBus.emitAgentChanged).toHaveBeenCalledWith({
      type: "agent_changed",
      projectId: "PRO-233",
    });

    await watcher.close();
  });

  it("debounces rapid state.json changes for same project", async () => {
    const watcher = startProjectWatcher({
      projects: { root: "/tmp/projects" },
    } as GatewayConfig);

    const sessionsWatcher = mockWatchers[1];
    expect(sessionsWatcher).toBeDefined();

    sessionsWatcher.emitAll(
      "change",
      "/tmp/projects/PRO-200_test/sessions/worker-a/state.json"
    );
    sessionsWatcher.emitAll(
      "change",
      "/tmp/projects/PRO-200_test/sessions/worker-b/state.json"
    );

    vi.advanceTimersByTime(300);

    expect(agentEventBus.emitAgentChanged).toHaveBeenCalledTimes(1);
    expect(agentEventBus.emitAgentChanged).toHaveBeenCalledWith({
      type: "agent_changed",
      projectId: "PRO-200",
    });

    await watcher.close();
  });
});
