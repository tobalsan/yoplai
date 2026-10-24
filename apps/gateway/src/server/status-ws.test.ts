import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import os from "node:os";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { writeTestV3Config } from "../test-utils/v3-config.js";

describe("gateway status websocket", () => {
  let tmpDir: string;
  let prevHomeDir: string | undefined;
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;
  let server: ReturnType<typeof import("./index.js").startServer>;
  let port: number;
  let startServer: typeof import("./index.js").startServer;
  let setSessionStreaming: (
    agentId: string,
    sessionId: string,
    streaming: boolean
  ) => void;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-status-ws-"));

    prevHomeDir = process.env.YOPLAI_HOME;
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    process.env.YOPLAI_HOME = path.join(tmpDir, ".yoplai");
    process.env.HOME = tmpDir;
    process.env.USERPROFILE = tmpDir;

    await writeTestV3Config(path.join(tmpDir, ".yoplai"), {
      agents: [
        {
          id: "status-agent",
          name: "Status Agent",
          model: { provider: "anthropic", model: "claude-3-5-sonnet-20241022" },
        },
      ],
    });

    vi.resetModules();
    const serverMod = await import("./index.js");
    const sessionsMod = await import("../agents/sessions.js");
    startServer = serverMod.startServer;
    setSessionStreaming = sessionsMod.setSessionStreaming;

    server = startServer(0, "127.0.0.1");
    await new Promise<void>((resolve) => {
      if (server.listening) return resolve();
      server.once("listening", () => resolve());
    });

    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    if (prevHomeDir === undefined) delete process.env.YOPLAI_HOME;
    else process.env.YOPLAI_HOME = prevHomeDir;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("broadcasts status updates to subscribers", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);

    const received: Array<{ type: string; agentId: string; status: string }> =
      [];
    const receivePromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timeout")), 2000);
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as {
          type?: string;
          agentId?: string;
          status?: string;
        };
        if (msg.type === "status") {
          received.push({
            type: msg.type,
            agentId: msg.agentId ?? "",
            status: msg.status ?? "",
          });
          if (received.length === 2) {
            clearTimeout(timeout);
            resolve();
          }
        }
      });
    });

    await new Promise<void>((resolve) => ws.once("open", () => resolve()));
    ws.send(JSON.stringify({ type: "subscribeStatus" }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const sessionId = `ws-${Date.now()}`;
    setSessionStreaming("status-agent", sessionId, true);
    setSessionStreaming("status-agent", sessionId, false);

    await receivePromise;

    const closePromise = new Promise<void>((resolve) =>
      ws.once("close", () => resolve())
    );
    ws.close();
    await closePromise;

    expect(received).toEqual([
      { type: "status", agentId: "status-agent", status: "streaming" },
      { type: "status", agentId: "status-agent", status: "idle" },
    ]);
  });

  it("reconnects with view markers and result references through HTTP and WebSocket", async () => {
    const store = await import("../history/store.js");
    const sessions = await import("../agents/sessions.js");
    const sessionId = "apps-reconnect";
    const marker = { server: "drawing", tool: "draw", resourceUri: "ui://drawing/view" };
    const view = { ...marker, recordId: "00112233445566778899aabbccddeeff" };
    const turn = store.createTurnBuffer();
    store.bufferHistoryEvent(turn, { type: "tool_call", id: "call-1", name: "drawing_draw", args: {}, view: marker, timestamp: 1 });
    store.bufferHistoryEvent(turn, { type: "tool_result", id: "call-1", name: "drawing_draw", content: "unchanged", isError: false, view, timestamp: 2 });
    sessions.setSessionStreaming("status-agent", sessionId, true);
    sessions.setSessionCurrentTurn("status-agent", sessionId, turn);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      });
      const response = await fetch(`http://127.0.0.1:${port}/api/agents/status-agent/history?sessionId=${sessionId}&view=full`);
      const history = await response.json();
      expect(history.activeTurn.toolCalls[0]).toHaveProperty("view", marker);
      expect(history.activeTurn.toolResults[0]).toHaveProperty("view", view);
      const snapshot = new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("No active turn snapshot")), 2000);
        ws.on("message", raw => {
          const event = JSON.parse(raw.toString());
          if (event.type === "active_turn") { clearTimeout(timer); resolve(event); }
        });
      });
      ws.send(JSON.stringify({ type: "subscribe", agentId: "status-agent", sessionKey: "main", sessionId }));
      await expect(snapshot).resolves.toMatchObject({
        toolCalls: [{ id: "call-1", view: marker }], toolResults: [{ id: "call-1", view }],
      });
    } finally {
      sessions.setSessionStreaming("status-agent", sessionId, false);
      sessions.setSessionCurrentTurn("status-agent", sessionId, null);
      ws.terminate();
    }
  });

  it("delivers the same completed web-run marker over status WS and the sessions API", async () => {
    const registry = await import("../sdk/registry.js");
    const sdk = vi.spyOn(registry, "getSdkAdapter").mockReturnValue({
      id: "openclaw", displayName: "Test",
      capabilities: { queueWhileStreaming: false, interrupt: false, toolEvents: true, fullHistory: true },
      resolveDisplayModel: () => ({}),
      run: async (params) => {
        params.onHistoryEvent({ type: "assistant_text", text: "transport answer", timestamp: Date.now() });
        return { text: "transport answer" };
      },
    });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const statuses: unknown[] = [];
    let resolveIdle!: () => void;
    const idle = new Promise<void>((resolve) => { resolveIdle = resolve; });
    ws.on("message", (raw) => {
      const event = JSON.parse(raw.toString());
      if (event.type === "status" && event.sessionId === "web-transport") {
        statuses.push(event);
        if (event.sessionStatus === "idle") resolveIdle();
      }
    });
    try {
      await new Promise<void>((resolve) => ws.once("open", resolve));
      ws.send(JSON.stringify({ type: "subscribeStatus" }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      const { runAgent } = await import("../agents/runner.js");
      await runAgent({ agentId: "status-agent", sessionId: "web-transport", source: "web", message: "transport question" });
      await Promise.race([idle, new Promise((_, reject) => setTimeout(() => reject(new Error("status timeout")), 2000))]);
      const response = await fetch(`http://127.0.0.1:${port}/api/agents/sessions`);
      expect(response.status).toBe(200);
      const body = await response.json();
      const summary = body.items.find((item: { sessionId: string }) => item.sessionId === "web-transport");
      expect(summary).toMatchObject({ lastWebCompletion: { id: expect.any(String), endedAt: expect.any(Number) } });
      expect(statuses).toEqual([
        { type: "status", agentId: "status-agent", sessionId: "web-transport", status: "streaming", sessionStatus: "streaming" },
        { type: "status", agentId: "status-agent", sessionId: "web-transport", status: "idle", sessionStatus: "idle", completion: summary.lastWebCompletion },
      ]);
    } finally {
      sdk.mockRestore();
      const closed = new Promise<void>((resolve) => ws.once("close", resolve));
      ws.close();
      await closed;
    }
  });

  it("aborts and settles a deleted chat before removing history, without a completion or resurrection", async () => {
    let release!: () => void;
    let entered!: () => void;
    let cancelled!: () => void;
    const runningAdapter = new Promise<void>((resolve) => { entered = resolve; });
    const finish = new Promise<void>((resolve) => { release = resolve; });
    const aborted = new Promise<void>((resolve) => { cancelled = resolve; });
    let signal: AbortSignal | undefined;
    const registry = await import("../sdk/registry.js");
    const sdk = vi.spyOn(registry, "getSdkAdapter").mockReturnValue({
      id: "pi", displayName: "Test",
      capabilities: { queueWhileStreaming: false, interrupt: false, toolEvents: true, fullHistory: true },
      resolveDisplayModel: () => ({}),
      run: async (params) => {
        signal = params.abortSignal;
        signal.addEventListener("abort", cancelled, { once: true });
        entered();
        await finish;
        params.onHistoryEvent({ type: "assistant_text", text: "late answer", timestamp: Date.now() });
        return { text: "late answer" };
      },
    });
    const { agentEventBus, runAgent } = await import("../agents/index.js");
    const completions: unknown[] = [];
    const unsubscribe = agentEventBus.onStatusChange((event) => {
      if (event.sessionId === "deleted-running" && event.completion) completions.push(event);
    });
    const running = runAgent({ agentId: "status-agent", sessionId: "deleted-running", source: "web", message: "delete this run" });
    try {
      await runningAdapter;
      const deleting = fetch(`http://127.0.0.1:${port}/api/agents/status-agent/sessions/deleted-running`, { method: "DELETE" });
      await Promise.race([aborted, deleting]);
      const wasAborted = signal?.aborted;
      release();
      await running;
      expect((await deleting).status).toBe(200);
      expect(wasAborted).toBe(true);
      expect(completions).toEqual([]);
      const list = await (await fetch(`http://127.0.0.1:${port}/api/agents/sessions`)).json();
      expect(list.items.some((item: { sessionId: string }) => item.sessionId === "deleted-running")).toBe(false);
    } finally { release(); await running; unsubscribe(); sdk.mockRestore(); }
  });

  it("returns a bounded conflict for a deletion whose adapter hangs, retaining history for retry", async () => {
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const finish = new Promise<void>((resolve) => { release = resolve; });
    const registry = await import("../sdk/registry.js");
    const sdk = vi.spyOn(registry, "getSdkAdapter").mockReturnValue({
      id: "pi", displayName: "Test",
      capabilities: { queueWhileStreaming: false, interrupt: false, toolEvents: true, fullHistory: true },
      resolveDisplayModel: () => ({}),
      run: async () => { entered(); await finish; return { text: "late result" }; },
    });
    const { runAgent } = await import("../agents/runner.js");
    const running = runAgent({ agentId: "status-agent", sessionId: "delete-hanging", source: "web", message: "still running" });
    const url = `http://127.0.0.1:${port}/api/agents/status-agent/sessions/delete-hanging`;
    const list = async () => (await (await fetch(`http://127.0.0.1:${port}/api/agents/sessions`)).json()).items as Array<{ sessionId: string; lastWebCompletion?: unknown }>;
    try {
      await ready;
      const response = await fetch(url, { method: "DELETE" });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "Session is still stopping; retry deletion once the active turn ends." });
      expect((await list()).find((item) => item.sessionId === "delete-hanging")).not.toHaveProperty("lastWebCompletion");
      release();
      await running;
      expect((await fetch(url, { method: "DELETE" })).status).toBe(200);
      expect((await list()).some((item) => item.sessionId === "delete-hanging")).toBe(false);
    } finally { release(); await running; sdk.mockRestore(); }
  });

  it("does not abort another owner's active chat when deleting a separately owned chat with the same explicit id", async () => {
    let release!: () => void;
    let entered!: () => void;
    let cancelled!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const finish = new Promise<void>((resolve) => { release = resolve; });
    const aborted = new Promise<void>((resolve) => { cancelled = resolve; });
    let signal: AbortSignal | undefined;
    const registry = await import("../sdk/registry.js");
    const sdk = vi.spyOn(registry, "getSdkAdapter").mockReturnValue({
      id: "pi", displayName: "Test",
      capabilities: { queueWhileStreaming: false, interrupt: false, toolEvents: true, fullHistory: true },
      resolveDisplayModel: () => ({}),
      run: async (params) => {
        if (params.userId === "other-owner") {
          signal = params.abortSignal;
          signal.addEventListener("abort", cancelled, { once: true });
          entered();
          await finish;
        }
        params.onHistoryEvent({ type: "assistant_text", text: "owned answer", timestamp: Date.now() });
        return { text: "owned answer" };
      },
    });
    const { runAgent } = await import("../agents/runner.js");
    const base = { agentId: "status-agent", sessionId: "same-explicit-id", source: "web" as const, message: "owned question" };
    await runAgent({ ...base, source: "cli" });
    const otherRun = runAgent({ ...base, userId: "other-owner" });
    try {
      await ready;
      const deleting = fetch(`http://127.0.0.1:${port}/api/agents/status-agent/sessions/same-explicit-id`, { method: "DELETE" });
      await Promise.race([aborted, deleting]);
      const wasAborted = signal?.aborted;
      release();
      await otherRun;
      expect((await deleting).status).toBe(409);
      expect(wasAborted).toBe(false);
      const { listAllSessionSummaries } = await import("../history/sessions.js");
      expect(await listAllSessionSummaries("other-owner", ["status-agent"])).toEqual([
        expect.objectContaining({ sessionId: "same-explicit-id", lastWebCompletion: { id: expect.any(String), endedAt: expect.any(Number) } }),
      ]);
      const own = await (await fetch(`http://127.0.0.1:${port}/api/agents/sessions`)).json();
      expect(own.items.some((item: { sessionId: string }) => item.sessionId === "same-explicit-id")).toBe(true);
    } finally { release(); await otherRun; sdk.mockRestore(); }
  });

  it("client receives events after reconnecting", async () => {
    const ws1 = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((resolve) => ws1.once("open", () => resolve()));
    ws1.send(JSON.stringify({ type: "subscribeStatus" }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const close1 = new Promise<void>((resolve) =>
      ws1.once("close", () => resolve())
    );
    ws1.close();
    await close1;

    const ws2 = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const received: Array<{ type: string; agentId: string; status: string }> =
      [];
    const receivePromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timeout")), 2000);
      ws2.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as {
          type?: string;
          agentId?: string;
          status?: string;
        };
        if (msg.type === "status") {
          received.push({
            type: msg.type,
            agentId: msg.agentId ?? "",
            status: msg.status ?? "",
          });
          if (received.length === 1) {
            clearTimeout(timeout);
            resolve();
          }
        }
      });
    });

    await new Promise<void>((resolve) => ws2.once("open", () => resolve()));
    ws2.send(JSON.stringify({ type: "subscribeStatus" }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const sessionId = `reconnect-${Date.now()}`;
    setSessionStreaming("status-agent", sessionId, true);

    await receivePromise;

    const close2 = new Promise<void>((resolve) =>
      ws2.once("close", () => resolve())
    );
    ws2.close();
    await close2;

    expect(received).toEqual([
      { type: "status", agentId: "status-agent", status: "streaming" },
    ]);

    setSessionStreaming("status-agent", sessionId, false);
  });

  it("broadcasts project and subagent events to connected clients", async () => {
    const { agentEventBus } = await import("../agents/events.js");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const received: Array<{ type: string; projectId?: string; runId?: string }> =
      [];
    const receivePromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timeout")), 2000);
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as {
          type?: string;
          projectId?: string;
          runId?: string;
        };
        if (
          msg.type === "file_changed" ||
          msg.type === "agent_changed" ||
          msg.type === "subagent_changed" ||
          msg.type === "orchestrator.run.finished"
        ) {
          received.push({
            type: msg.type,
            projectId: msg.projectId,
            runId: msg.runId,
          });
          if (received.length === 4) {
            clearTimeout(timeout);
            resolve();
          }
        }
      });
    });

    await new Promise<void>((resolve) => ws.once("open", () => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 50));

    agentEventBus.emitFileChanged({
      type: "file_changed",
      projectId: "PRO-1",
      file: "README.md",
    });
    agentEventBus.emitAgentChanged({
      type: "agent_changed",
      projectId: "PRO-1",
    });
    agentEventBus.emit("subagent.changed", {
      type: "subagent_changed",
      runId: "run-1",
      status: "running",
    });
    agentEventBus.emit("orchestrator.run.finished", {
      type: "orchestrator.run.finished",
      projectId: "PRO-1",
      runId: "run-2",
      outcome: "completed",
    });

    await receivePromise;
    ws.close();

    expect(received).toEqual([
      { type: "file_changed", projectId: "PRO-1", runId: undefined },
      { type: "agent_changed", projectId: "PRO-1", runId: undefined },
      { type: "subagent_changed", projectId: undefined, runId: "run-1" },
      { type: "orchestrator.run.finished", projectId: "PRO-1", runId: "run-2" },
    ]);
  });
});

describe("gateway status websocket in multi-user mode", () => {
  let tmpDir: string;
  let prevHomeDir: string | undefined;
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;
  let server: ReturnType<typeof import("./index.js").startServer>;
  let port: number;
  let startServer: typeof import("./index.js").startServer;
  let setSessionStreaming: (
    agentId: string,
    sessionId: string,
    streaming: boolean
  ) => void;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-status-ws-mu-"));

    prevHomeDir = process.env.YOPLAI_HOME;
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    process.env.YOPLAI_HOME = path.join(tmpDir, ".yoplai");
    process.env.HOME = tmpDir;
    process.env.USERPROFILE = tmpDir;

    await writeTestV3Config(path.join(tmpDir, ".yoplai"), {
      agents: [
        {
          id: "allowed-agent",
          name: "Allowed Agent",
          model: { provider: "anthropic", model: "claude-3-5-sonnet-20241022" },
        },
        {
          id: "blocked-agent",
          name: "Blocked Agent",
          model: { provider: "anthropic", model: "claude-3-5-sonnet-20241022" },
        },
      ],
    });

    vi.resetModules();
    vi.doMock("../extensions/registry.js", async () => {
      const actual = await vi.importActual<
        typeof import("../extensions/registry.js")
      >("../extensions/registry.js");
      return {
        ...actual,
        getLoadedExtensions: () => [{ id: "multiUser" }],
        isMultiUserLoaded: () => true,
        isExtensionLoaded: (extensionId: string) => extensionId === "multiUser",
        getExtensionRuntime: () => ({
          isEnabled: (extensionId: string) => extensionId === "multiUser",
          getRouteMatchers: () => [],
        }),
      };
    });
    vi.doMock("@yoplai/extension-multi-user", () => ({
      createAuthMiddleware:
        () => async (_c: unknown, next: () => Promise<void>) => {
          await next();
        },
      getRequestAuthContext: () => null,
      forwardAuthContextToRequest: (request: Request) => request,
      requireAgentAccess:
        () => async (_c: unknown, next: () => Promise<void>) => {
          await next();
        },
      hasAgentAccess: async (
        authContext: {
          user?: { role?: string };
          session?: { userId?: string };
        } | null,
        agentId: string
      ) => authContext?.user?.role === "admin" || agentId === "allowed-agent",
      validateWebSocketRequest: async (request: Request) => {
        const cookie = request.headers.get("cookie");
        if (cookie !== "session=allowed") return null;
        return {
          user: {
            id: "user-1",
            role: "user",
            approved: true,
          },
          session: {
            id: "session-1",
            userId: "user-1",
          },
        };
      },
    }));

    const serverMod = await import("./index.js");
    const sessionsMod = await import("../agents/sessions.js");
    startServer = serverMod.startServer;
    setSessionStreaming = sessionsMod.setSessionStreaming;

    server = startServer(0, "127.0.0.1");
    await new Promise<void>((resolve) => {
      if (server.listening) return resolve();
      server.once("listening", () => resolve());
    });

    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    if (prevHomeDir === undefined) delete process.env.YOPLAI_HOME;
    else process.env.YOPLAI_HOME = prevHomeDir;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("filters status updates to assigned agents", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { cookie: "session=allowed" },
    });

    const received: Array<{ type: string; agentId: string; status: string }> =
      [];
    const receivePromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        clearTimeout(timeout);
        resolve();
      }, 400);
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as {
          type?: string;
          agentId?: string;
          status?: string;
        };
        if (msg.type === "status") {
          received.push({
            type: msg.type,
            agentId: msg.agentId ?? "",
            status: msg.status ?? "",
          });
        }
      });
      ws.on("error", reject);
    });

    await new Promise<void>((resolve) => ws.once("open", () => resolve()));
    ws.send(JSON.stringify({ type: "subscribeStatus" }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const allowedSessionId = `allowed-${Date.now()}`;
    setSessionStreaming("allowed-agent", allowedSessionId, true);
    setSessionStreaming("allowed-agent", allowedSessionId, false);

    const blockedSessionId = `blocked-${Date.now()}`;
    setSessionStreaming("blocked-agent", blockedSessionId, true);
    setSessionStreaming("blocked-agent", blockedSessionId, false);

    await receivePromise;

    const closePromise = new Promise<void>((resolve) =>
      ws.once("close", () => resolve())
    );
    ws.close();
    await closePromise;

    expect(received).toEqual([
      { type: "status", agentId: "allowed-agent", status: "streaming" },
      { type: "status", agentId: "allowed-agent", status: "idle" },
    ]);
  });

  async function firstMessage(
    subscribeMsg: Record<string, unknown>
  ): Promise<{ type?: string; message?: string }> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { cookie: "session=allowed" },
    });
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });
      const received = new Promise<{ type?: string; message?: string }>(
        (resolve) => {
          const timeout = setTimeout(
            () => resolve({ type: undefined }),
            300
          );
          ws.on("message", (raw) => {
            clearTimeout(timeout);
            resolve(
              JSON.parse(raw.toString()) as { type?: string; message?: string }
            );
          });
        }
      );
      ws.send(JSON.stringify(subscribeMsg));
      return await received;
    } finally {
      ws.close();
    }
  }

  it("rejects subscribe to an agent the user cannot access", async () => {
    const msg = await firstMessage({
      type: "subscribe",
      agentId: "blocked-agent",
      sessionKey: "main",
    });
    expect(msg.type).toBe("error");
    expect(msg.message).toBe("Forbidden");
  });

  it("allows subscribe to an agent the user can access", async () => {
    // An authorized subscribe produces no immediate error frame (idle session).
    const msg = await firstMessage({
      type: "subscribe",
      agentId: "allowed-agent",
      sessionKey: "main",
    });
    expect(msg.type).not.toBe("error");
  });

  it("rejects send to an agent the user cannot access", async () => {
    const msg = await firstMessage({
      type: "send",
      agentId: "blocked-agent",
      sessionKey: "main",
      message: "hi",
    });
    expect(msg.type).toBe("error");
    expect(msg.message).toBe("Forbidden");
  });
});
