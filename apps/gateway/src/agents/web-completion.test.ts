import fs from "node:fs/promises";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig, AgentStatusChangeEvent } from "@yoplai/shared";
import type { SdkAdapter, SdkRunParams } from "../sdk/types.js";

const tmpHome = vi.hoisted(() => `/tmp/yoplai-web-completion-${process.pid}-${Math.random().toString(36).slice(2)}`);
const getSdkAdapter = vi.hoisted(() => vi.fn());
const agent = {
  id: "alpha", name: "Alpha", workspace: tmpHome, sdk: "pi",
  model: { provider: "anthropic", model: "claude" }, queueMode: "queue",
} as AgentConfig;

vi.mock("../config/index.js", () => ({
  CONFIG_DIR: tmpHome,
  getAgent: (id: string) => id === "alpha" ? agent : undefined,
  loadConfig: () => ({ agents: [], extensions: {}, sessions: {} }),
  resolveWorkspaceDir: (workspace: string) => workspace,
}));
vi.mock("../sdk/registry.js", () => ({ getSdkAdapter, getDefaultSdkId: () => "pi" }));
vi.mock("../sdk/container/adapter.js", () => ({ getContainerAdapter: vi.fn() }));
vi.mock("../sessions/index.js", () => ({
  resolveSessionId: vi.fn(), getSessionEntry: vi.fn(), isAbortTrigger: (message: string) => message === "/abort" || message === "/stop",
}));
vi.mock("../tasks/store.js", () => ({ getTask: async () => undefined, pauseTaskForControlCommand: vi.fn() }));
vi.mock("../extensions/registry.js", () => ({ getExtensionRuntime: () => undefined }));
vi.mock("../maintenance/session-auto-title.js", () => ({ maybeAutoTitleSession: vi.fn() }));

import { runAgent } from "./runner.js";
import { agentEventBus } from "./events.js";
import { appendSessionMeta, getSimpleHistory } from "../history/store.js";
import { listAllSessionSummaries } from "../history/sessions.js";
import { abortSession, deleteSession, setSessionStreaming } from "./sessions.js";

function adapter(run: SdkAdapter["run"]): SdkAdapter {
  return {
    id: "pi", displayName: "Test",
    capabilities: { queueWhileStreaming: false, interrupt: false, toolEvents: true, fullHistory: true },
    resolveDisplayModel: () => ({}), run,
  };
}

function request(sessionId: string) {
  return { agentId: "alpha", sessionId, source: "web" as const, message: "hello", resolvedSession: { sessionId, message: "hello", isNew: false } };
}

describe("web run completion (real lifecycle and history)", () => {
  beforeEach(() => {
    getSdkAdapter.mockReturnValue(adapter(async (params: SdkRunParams) => {
      params.onHistoryEvent({ type: "assistant_text", text: "ready", timestamp: Date.now() });
      return { text: "ready" };
    }));
  });
  afterAll(async () => { await fs.rm(tmpHome, { recursive: true, force: true }); });

  it("persists one successful web completion after the answer and publishes that marker", async () => {
    const events: unknown[] = [];
    const snapshots: Promise<unknown>[] = [];
    const unsubscribe = agentEventBus.onStatusChange((event) => {
      if (event.sessionId !== "web-success") return;
      events.push(event);
      if (event.sessionStatus === "idle") snapshots.push(listAllSessionSummaries(undefined, ["alpha"]));
    });
    const started = Date.now();
    try { await runAgent(request("web-success")); } finally { unsubscribe(); }
    const summaries = await listAllSessionSummaries(undefined, ["alpha"]);
    const summary = summaries.find((item) => item.sessionId === "web-success");
    expect(summary).toMatchObject({ lastWebCompletion: { id: expect.stringMatching(/^[0-9a-f-]{36}$/), endedAt: expect.any(Number) } });
    const completion = summary!.lastWebCompletion!;
    expect(completion.endedAt).toBeGreaterThanOrEqual(started);
    expect(events).toEqual([
      { agentId: "alpha", sessionId: "web-success", status: "streaming", sessionStatus: "streaming" },
      { agentId: "alpha", sessionId: "web-success", status: "idle", sessionStatus: "idle", completion },
    ]);
    expect((await Promise.all(snapshots))[0]).toEqual(expect.arrayContaining([expect.objectContaining({ sessionId: "web-success", lastWebCompletion: completion })]));
    expect((await getSimpleHistory("alpha", "web-success")).map((entry) => entry.content)).toEqual(["hello", "ready"]);
  });

  it("marks an errored web run only after its failure notice is persisted", async () => {
    getSdkAdapter.mockReturnValue(adapter(async () => { throw new Error("provider failed"); }));
    const events: unknown[] = [];
    const unsubscribe = agentEventBus.onStatusChange((event) => { if (event.sessionId === "web-error") events.push(event); });
    try { await expect(runAgent(request("web-error"))).rejects.toThrow("provider failed"); } finally { unsubscribe(); }
    const summary = (await listAllSessionSummaries(undefined, ["alpha"])).find((item) => item.sessionId === "web-error");
    expect(summary).toMatchObject({ lastWebCompletion: { id: expect.any(String), endedAt: expect.any(Number) } });
    expect(events).toContainEqual({ agentId: "alpha", sessionId: "web-error", status: "idle", sessionStatus: "idle", completion: summary!.lastWebCompletion });
    expect((await getSimpleHistory("alpha", "web-error")).map((entry) => entry.content)).toEqual(["hello", "Something went wrong, please try again."]);
  });

  it("leaves aborted, deleted, force-cleaned and non-web runs without completion markers", async () => {
    for (const mode of ["result", "controller", "AbortError", "delete", "cleanup", "scheduler", "slack"] as const) {
      const sessionId = `excluded-${mode}`;
      const events: unknown[] = [];
      const unsubscribe = agentEventBus.onStatusChange((event) => { if (event.sessionId === sessionId) events.push(event); });
      getSdkAdapter.mockReturnValue(adapter(async () => {
        if (mode === "controller" || mode === "cleanup") abortSession("alpha", sessionId);
        if (mode === "delete") deleteSession("alpha", sessionId);
        if (mode === "cleanup") setSessionStreaming("alpha", sessionId, false);
        if (mode === "AbortError") throw new DOMException("stopped", "AbortError");
        return { text: "partial", aborted: mode === "result" };
      }));
      try {
        const running = runAgent({ ...request(sessionId), source: mode === "scheduler" || mode === "slack" ? mode : "web" });
        if (mode === "AbortError") await expect(running).rejects.toThrow("stopped");
        else await running;
      } finally { unsubscribe(); }
      const summary = (await listAllSessionSummaries(undefined, ["alpha"])).find((item) => item.sessionId === sessionId);
      expect(summary).not.toHaveProperty("lastWebCompletion");
      expect(events.every((event) => !("completion" in (event as object)))).toBe(true);
    }
  });

  it("releases the run after a marker write fails, without publishing a completion", async () => {
    const appendFile = fs.appendFile.bind(fs);
    const write = vi.spyOn(fs, "appendFile").mockImplementation(async (...args) => {
      if (String(args[1]).includes('"key":"lastWebCompletion"')) throw new Error("disk unavailable");
      return appendFile(...args);
    });
    const events: unknown[] = [];
    const unsubscribe = agentEventBus.onStatusChange((event) => { if (event.sessionId === "write-failed") events.push(event); });
    try { await expect(runAgent(request("write-failed"))).resolves.toMatchObject({ payloads: [{ text: "ready" }] }); }
    finally { write.mockRestore(); unsubscribe(); }
    expect(events).toContainEqual({ agentId: "alpha", sessionId: "write-failed", status: "idle", sessionStatus: "idle" });
    expect(events.every((event) => !("completion" in (event as object)))).toBe(true);
    await expect(runAgent(request("write-failed"))).resolves.toMatchObject({ payloads: [{ text: "ready" }] });
    expect((await listAllSessionSummaries(undefined, ["alpha"])).find((item) => item.sessionId === "write-failed")).toHaveProperty("lastWebCompletion");
  });

  it("reads the latest valid persisted marker without changing session activity or history", async () => {
    await runAgent({ ...request("metadata"), source: "cli" });
    const before = (await listAllSessionSummaries(undefined, ["alpha"])).find((item) => item.sessionId === "metadata")!;
    await appendSessionMeta("alpha", "metadata", "lastWebCompletion", { id: "older", endedAt: 1000 });
    await appendSessionMeta("alpha", "metadata", "lastWebCompletion", { id: "newer", endedAt: 2000 });
    for (const value of [null, { id: "", endedAt: 3000 }, { id: "invalid", endedAt: "later" }]) {
      await appendSessionMeta("alpha", "metadata", "lastWebCompletion", value);
    }
    expect((await listAllSessionSummaries(undefined, ["alpha"])).find((item) => item.sessionId === "metadata")).toMatchObject({
      lastActivity: before.lastActivity, messageCount: 2, lastWebCompletion: { id: "newer", endedAt: 2000 },
    });
    expect((await getSimpleHistory("alpha", "metadata")).map((entry) => entry.content)).toEqual(["hello", "ready"]);
  });

  it("shares one initiating-run completion with injected follow-ups, without marking their acknowledgement", async () => {
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const finish = new Promise<void>((resolve) => { release = resolve; });
    const sdk = adapter(async (params) => {
      params.onSessionHandle?.({});
      entered();
      await finish;
      params.onHistoryEvent({ type: "assistant_text", text: "combined answer", timestamp: Date.now() });
      return { text: "combined answer" };
    });
    sdk.capabilities.queueWhileStreaming = true;
    sdk.queueMessage = async () => {};
    getSdkAdapter.mockReturnValue(sdk);
    const events: AgentStatusChangeEvent[] = [];
    const unsubscribe = agentEventBus.onStatusChange((event) => { if (event.sessionId === "injected") events.push(event); });
    try {
      const running = runAgent(request("injected"));
      await ready;
      await expect(runAgent({ ...request("injected"), message: "follow-up" })).resolves.toMatchObject({ meta: { queued: true } });
      expect(events.filter((event) => event.completion)).toEqual([]);
      expect((await listAllSessionSummaries(undefined, ["alpha"])).find((item) => item.sessionId === "injected")).not.toHaveProperty("lastWebCompletion");
      release();
      await running;
      expect(events.filter((event) => event.completion)).toHaveLength(1);
    } finally { release(); unsubscribe(); }
  });

  it("uses a deferred run's own source instead of its initiating scheduler run", async () => {
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const finish = new Promise<void>((resolve) => { release = resolve; });
    let runs = 0;
    getSdkAdapter.mockReturnValue(adapter(async () => {
      runs += 1;
      if (runs === 1) { entered(); await finish; }
      return { text: "done" };
    }));
    const events: AgentStatusChangeEvent[] = [];
    const unsubscribe = agentEventBus.onStatusChange((event) => { if (event.sessionId === "deferred") events.push(event); });
    try {
      const running = runAgent({ ...request("deferred"), source: "scheduler" });
      await ready;
      await expect(runAgent({ ...request("deferred"), message: "web follow-up" })).resolves.toMatchObject({ meta: { queued: true } });
      expect(events.filter((event) => event.completion)).toEqual([]);
      release();
      await running;
      expect(runs).toBe(2);
      expect(events.map((event) => [event.sessionStatus, !!event.completion])).toEqual([
        ["streaming", false], ["idle", false], ["streaming", false], ["idle", true],
      ]);
    } finally { release(); unsubscribe(); }
  });

  it("publishes a persisted completion even when streaming was already cleared", async () => {
    const events: AgentStatusChangeEvent[] = [];
    const unsubscribe = agentEventBus.onStatusChange((event) => { if (event.sessionId === "already-idle") events.push(event); });
    getSdkAdapter.mockReturnValue(adapter(async () => {
      setSessionStreaming("alpha", "already-idle", false);
      return { text: "done" };
    }));
    try { await runAgent(request("already-idle")); } finally { unsubscribe(); }
    expect(events.map((event) => [event.sessionStatus, !!event.completion])).toEqual([
      ["streaming", false], ["idle", false], ["idle", true],
    ]);
  });

  it("persists completion with the session storage owner rather than requester credentials", async () => {
    await runAgent({ ...request("owned"), userId: "requester", sessionOwnerId: "history-owner" });
    expect(await listAllSessionSummaries("history-owner", ["alpha"])).toEqual([
      expect.objectContaining({ sessionId: "owned", lastWebCompletion: { id: expect.any(String), endedAt: expect.any(Number) } }),
    ]);
    expect(await listAllSessionSummaries("requester", ["alpha"])).toEqual([]);
  });

  it("rejects Stop and external cancellation once the persisted answer has claimed completion", async () => {
    let release!: () => void;
    let entered!: () => void;
    const writing = new Promise<void>((resolve) => { entered = resolve; });
    const finishWrite = new Promise<void>((resolve) => { release = resolve; });
    const appendFile = fs.appendFile.bind(fs);
    const write = vi.spyOn(fs, "appendFile").mockImplementation(async (...args) => {
      if (String(args[1]).includes('"key":"lastWebCompletion"')) { entered(); await finishWrite; }
      return appendFile(...args);
    });
    const external = new AbortController();
    let signal: AbortSignal | undefined;
    getSdkAdapter.mockReturnValue(adapter(async (params) => {
      signal = params.abortSignal;
      params.onHistoryEvent({ type: "assistant_text", text: "ready before Stop", timestamp: Date.now() });
      return { text: "ready before Stop" };
    }));
    const running = runAgent({ ...request("completion-race"), signal: external.signal });
    let stopped: Awaited<ReturnType<typeof runAgent>> | undefined;
    try {
      await writing;
      stopped = await runAgent({ ...request("completion-race"), message: "/abort" });
      external.abort();
    } finally { release(); await running; write.mockRestore(); }
    expect(stopped).toMatchObject({ meta: { aborted: false }, payloads: [{ text: "No active run." }] });
    expect(signal?.aborted).toBe(false);
    expect((await listAllSessionSummaries(undefined, ["alpha"])).find((item) => item.sessionId === "completion-race")).toHaveProperty("lastWebCompletion");
  });
});
