import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import type { WsClientMessage, WsServerMessage } from "@yoplai/shared";
import { writeTestV3Config } from "../test-utils/v3-config.js";

// Thinh's ALG-742 Groom GO approved the real gateway WebSocket and HTTP seams.
// They cover authorization and delivery with dummy accounts; a stub adapter keeps model I/O out of the tests.
describe("live session ownership", () => {
  let home: string;
  let server: ReturnType<typeof import("./index.js").startServer>;
  let stopAuth: (() => Promise<void>) | undefined;
  let baseUrl: string;
  let admin: string;
  let alice: string;
  let aliceId: string;
  let bob: string;
  let bobId: string;

  async function signUp(name: string) {
    const response = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" },
      body: JSON.stringify({ name, email: `${name}@example.test`, password: "fixture-password-123" }),
    });
    expect(response.status).toBe(200);
    const { user } = await response.json() as { user: { id: string } };
    const cookie = response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    return { id: user.id, cookie };
  }

  beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-live-sessions-"));
    vi.stubEnv("YOPLAI_HOME", home);
    await writeTestV3Config(home, {
      agents: [{ id: "shared", extraYaml: "auth:\n  mode: oauth" }],
      extensions: { multiUser: { enabled: true, autoApprove: true, emailAndPassword: { enabled: true }, sessionSecret: "fixture-session-secret-for-local-tests" } },
    });
    vi.resetModules();
    const maintenance = await import("../maintenance/session-auto-title.js");
    vi.spyOn(maintenance, "maybeAutoTitleSession").mockImplementation(() => {});
    const { loadConfig } = await import("../config/index.js");
    const { getExtensionRuntime } = await import("../extensions/registry.js");
    const { createExtensionContext } = await import("../extensions/context.js");
    const { multiUserExtension } = await import("@yoplai/extension-multi-user");
    const runtime = getExtensionRuntime();
    runtime.load([multiUserExtension]);
    await multiUserExtension.start(createExtensionContext(loadConfig()));
    stopAuth = () => multiUserExtension.stop();
    const { api } = await import("./api.core.js");
    multiUserExtension.registerRoutes(api);
    const { startServer } = await import("./index.js");
    server = startServer(0, "127.0.0.1", runtime);
    if (!server.listening) await once(server, "listening");
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    ({ cookie: admin } = await signUp("admin"));
    ({ cookie: alice, id: aliceId } = await signUp("alice"));
    ({ cookie: bob, id: bobId } = await signUp("bob"));
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await stopAuth?.();
    vi.unstubAllEnvs();
    await fs.rm(home, { recursive: true, force: true, maxRetries: 3 });
  });

  async function connect(cookie: string) {
    const socket = new WebSocket(`${baseUrl.replace("http:", "ws:")}/ws`, { headers: { Cookie: cookie } });
    const events: WsServerMessage[] = [];
    socket.on("message", (raw) => events.push(JSON.parse(raw.toString()) as WsServerMessage));
    await once(socket, "open");
    return {
      events,
      send: (message: WsClientMessage) => socket.send(JSON.stringify(message)),
      flush: async () => {
        const pong = once(socket, "pong");
        socket.ping();
        await pong;
      },
      close: () => socket.terminate(),
    };
  }

  async function holdAdapter() {
    const registry = await import("../sdk/registry.js");
    const adapter = registry.getSdkAdapter("pi");
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const run = vi.fn<typeof adapter.run>(async (params) => {
      const text = params.message === "Next prompt" ? "Next answer" : "Example answer";
      params.onHistoryEvent({ type: "assistant_text", text, timestamp: 100 });
      params.onEvent({ type: "text", data: text });
      await Promise.race([held, once(params.abortSignal, "abort")]);
      return { text, aborted: params.abortSignal.aborted };
    });
    const mock = vi.spyOn(registry, "getSdkAdapter").mockReturnValue({ ...adapter, run });
    return { release, run, restore: () => mock.mockRestore() };
  }

  function sendHttp(cookie: string, message: string, target: { sessionId?: string; sessionKey?: string } = {}) {
    return fetch(`${baseUrl}/api/agents/shared/messages`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ message, ...target }),
    });
  }

  async function history(cookie: string, sessionId: string) {
    const response = await fetch(`${baseUrl}/api/agents/shared/history?sessionId=${sessionId}`, { headers: { Cookie: cookie } });
    expect(response.status).toBe(200);
    return response.json();
  }

  it("sends run status and completion details only to the owner's sockets", async () => {
    const sockets = await Promise.all([connect(alice), connect(alice), connect(bob)]);
    const [owner, secondTab, coUser] = sockets;
    const adapter = await holdAdapter();
    let running: Promise<Response> | undefined;
    try {
      for (const socket of sockets) socket.send({ type: "subscribeStatus" });
      await Promise.all(sockets.map((socket) => socket.flush()));
      running = sendHttp(alice, "Example prompt", { sessionId: "status-chat" });
      await vi.waitFor(() => expect(adapter.run).toHaveBeenCalledTimes(1));
      adapter.release();
      expect((await running).status).toBe(200);

      await vi.waitFor(() => {
        for (const socket of [owner, secondTab]) {
          expect(socket.events).toEqual([
            { type: "status", agentId: "shared", status: "streaming", sessionId: "status-chat", sessionStatus: "streaming" },
            { type: "status", agentId: "shared", status: "idle", sessionId: "status-chat", sessionStatus: "idle", completion: { id: expect.any(String), endedAt: expect.any(Number) } },
          ]);
        }
        expect(coUser.events).toEqual([
          { type: "status", agentId: "shared", status: "streaming" },
          { type: "status", agentId: "shared", status: "idle" },
        ]);
      });
    } finally {
      adapter.release();
      if (running) await (await running).text();
      adapter.restore();
      for (const socket of sockets) socket.close();
    }
  });

  it("serves active turn snapshots only to the owner of a streaming session", async () => {
    const sessionId = "snapshot-chat";
    const sockets = await Promise.all([connect(alice), connect(bob)]);
    const [secondTab, coUser] = sockets;
    const adapter = await holdAdapter();
    const running = sendHttp(alice, "Example prompt", { sessionId });
    const subscribe = { type: "subscribe", agentId: "shared", sessionKey: "main", sessionId } as const;
    try {
      await vi.waitFor(() => expect(adapter.run).toHaveBeenCalledTimes(1));
      secondTab.send(subscribe);
      coUser.send(subscribe);
      await vi.waitFor(() => {
        expect(secondTab.events).toEqual([expect.objectContaining({ type: "active_turn", sessionId, text: "Example answer" })]);
        expect(coUser.events).toEqual([{ type: "error", message: "Session not found" }]);
      });
      expect(await history(alice, sessionId)).toMatchObject({ isStreaming: true, activeTurn: { text: "Example answer" } });
      expect(await history(bob, sessionId)).toMatchObject({ isStreaming: false, activeTurn: null, messages: [] });

      adapter.release();
      expect((await running).status).toBe(200);
      await vi.waitFor(() => expect(secondTab.events.at(-1)).toEqual({ type: "history_updated", agentId: "shared", sessionId }));
      await coUser.flush();
      expect(coUser.events).toEqual([{ type: "error", message: "Session not found" }]);
    } finally {
      adapter.release();
      await (await running).text();
      adapter.restore();
      for (const socket of sockets) socket.close();
    }
  });

  it.each(["explicit", "default"] as const)("scopes web sends and stops to the owner of the %s session", async (kind) => {
    const { resolveSessionId } = await import("../sessions/index.js");
    const sessionKey = "shared-key";
    const sessionId = kind === "default" ? "default" : (await resolveSessionId({
      agentId: "shared", userId: bobId, sessionKey, message: "Example prompt",
    })).sessionId;
    const sockets = await Promise.all([connect(alice), connect(bob)]);
    const [owner, coUser] = sockets;
    const adapter = await holdAdapter();
    const running = sendHttp(alice, "Example prompt", { sessionId });
    const target = kind === "default" ? {} : { sessionId };
    const refusal = { type: "error", message: "Session not found" };
    try {
      await vi.waitFor(() => expect(adapter.run).toHaveBeenCalledTimes(1));
      owner.send({ type: "subscribe", agentId: "shared", sessionKey: "main", sessionId });
      await vi.waitFor(() => expect(owner.events).toHaveLength(1));

      const commands = [
        { message: "/stop", ...target },
        { message: "Example follow-up", ...target },
        { message: "/think", ...target },
        ...(kind === "explicit" ? [{ message: "Example follow-up", sessionKey }] : []),
      ];
      for (const [index, command] of commands.entries()) {
        coUser.send({ type: "send", agentId: "shared", ...command });
        await vi.waitFor(() => expect(coUser.events).toEqual(Array(index + 1).fill(refusal)));
        // An unqualified normal HTTP send opens the caller's own main chat.
        if (kind === "explicit" || command.message === "/stop") {
          const response = await sendHttp(bob, command.message, command);
          expect(await response.json()).toEqual({ error: "Session not found" });
        }
      }
      expect(await history(alice, sessionId)).toMatchObject({ isStreaming: true });
      await owner.flush();
      expect(owner.events.map((event) => event.type)).toEqual(["active_turn"]);

      const stopped = await sendHttp(alice, "/stop", target);
      expect(await stopped.json()).toMatchObject({ meta: { sessionId, aborted: true } });
      expect((await running).status).toBe(200);
      expect(adapter.run).toHaveBeenCalledTimes(1);
      expect(await history(alice, sessionId)).toMatchObject({ isStreaming: false });
    } finally {
      adapter.release();
      await (await running).text();
      adapter.restore();
      for (const socket of sockets) socket.close();
    }
  });

  it("scopes terminal events for a pre-existing subscription before a different owner reuses the id", async () => {
    const { resolveSessionId } = await import("../sessions/index.js");
    const sessionKey = "takeover";
    const { sessionId } = await resolveSessionId({ agentId: "shared", userId: aliceId, sessionKey, message: "Example prompt" });
    const [owner, coUser] = await Promise.all([connect(alice), connect(bob)]);
    const adapter = await holdAdapter();
    let running: Promise<Response> | undefined;
    try {
      // The first subscriber follows a key, so stream delivery awaits the key lookup.
      owner.send({ type: "subscribe", agentId: "shared", sessionKey });
      await owner.flush();
      coUser.send({ type: "subscribe", agentId: "shared", sessionKey, sessionId });
      await coUser.flush();

      running = sendHttp(alice, "Example prompt", { sessionKey });
      await vi.waitFor(() => expect(owner.events).toContainEqual(expect.objectContaining({ type: "text", data: "Example answer" })));
      const stopped = await sendHttp(alice, "/stop", { sessionId });
      expect(await stopped.json()).toMatchObject({ meta: { aborted: true } });
      expect((await running).status).toBe(200);
      await vi.waitFor(() => expect(owner.events).toContainEqual({ type: "history_updated", agentId: "shared", sessionId }));
      await coUser.flush();
      expect(coUser.events).toEqual([]);

      adapter.release();
      const next = await sendHttp(bob, "Next prompt", { sessionId });
      expect(await next.json()).toMatchObject({ payloads: [{ text: "Next answer" }], meta: { sessionId } });
      await vi.waitFor(() => expect(coUser.events.at(-1)).toEqual({ type: "history_updated", agentId: "shared", sessionId }));
      expect(coUser.events.filter((event) => event.type === "text")).toEqual([expect.objectContaining({ type: "text", data: "Next answer" })]);
      await owner.flush();
      expect(owner.events).not.toContainEqual(expect.objectContaining({ type: "text", data: "Next answer" }));
    } finally {
      adapter.release();
      if (running) await (await running).text();
      adapter.restore();
      owner.close();
      coUser.close();
    }
  });

  it("keeps the replacement run active when a timed-out adapter finishes", async () => {
    const sessionId = "timed-out-chat";
    const adapter = await holdAdapter();
    const [owner, nextOwner] = await Promise.all([connect(alice), connect(bob)]);
    let releaseOld!: () => void;
    const oldAdapterFinished = new Promise<void>((resolve) => { releaseOld = resolve; });
    adapter.run.mockImplementationOnce(async (params) => {
      await oldAdapterFinished;
      params.onHistoryEvent({ type: "assistant_text", text: "Previous answer", timestamp: 100 });
      params.onEvent({ type: "text", data: "Previous answer" });
      return { text: "Previous answer", aborted: true };
    });
    const first = sendHttp(alice, "Previous prompt", { sessionId });
    let second: Promise<Response> | undefined;
    try {
      await vi.waitFor(() => expect(adapter.run).toHaveBeenCalledTimes(1));
      owner.send({ type: "send", agentId: "shared", sessionId, message: "Previous follow-up" });
      await vi.waitFor(() => expect(owner.events).toEqual([{ type: "text", data: "Message queued for next run" }]));
      const stopped = await sendHttp(alice, "/stop", { sessionId });
      expect(await stopped.json()).toMatchObject({ meta: { aborted: true } });
      expect(await history(alice, sessionId)).toMatchObject({ isStreaming: false });

      second = sendHttp(bob, "Next prompt", { sessionId });
      await vi.waitFor(() => expect(adapter.run).toHaveBeenCalledTimes(2));
      nextOwner.send({ type: "subscribe", agentId: "shared", sessionKey: "main", sessionId });
      await vi.waitFor(() => expect(nextOwner.events).toEqual([
        expect.objectContaining({ type: "active_turn", sessionId, text: "Next answer" }),
      ]));
      await vi.waitFor(() => expect(owner.events.at(-1)).toEqual({ type: "done", meta: { durationMs: 0, aborted: true } }));
      releaseOld();
      expect((await first).status).toBe(200);
      expect(await history(bob, sessionId)).toMatchObject({ isStreaming: true, activeTurn: { text: "Next answer" } });
      await nextOwner.flush();
      expect(nextOwner.events.map((event) => event.type)).toEqual(["active_turn"]);
    } finally {
      releaseOld();
      adapter.release();
      await (await first).text();
      if (second) await (await second).text();
      adapter.restore();
      owner.close();
      nextOwner.close();
    }
  });

  it.each(["team", "owner"] as const)("uses the stored history owner for a %s scheduler run and impersonated reads", async (mode) => {
    const { runAgent } = await import("../agents/runner.js");
    const sessionId = `scheduled-${mode}`;
    const adapter = await holdAdapter();
    const impersonate = await fetch(`${baseUrl}/api/admin/impersonate/start`, {
      method: "POST",
      headers: { Cookie: admin, "Content-Type": "application/json" },
      body: JSON.stringify({ targetUserId: aliceId }),
    });
    expect(impersonate.status).toBe(204);
    const [support, coUser] = await Promise.all([connect(admin), connect(bob)]);
    const running = runAgent({
      agentId: "shared", sessionId, message: "Example prompt", source: "scheduler",
      userId: aliceId, sessionOwnerId: mode === "team" ? null : aliceId,
    });
    try {
      await vi.waitFor(() => expect(adapter.run).toHaveBeenCalledTimes(1));
      const subscribe = { type: "subscribe", agentId: "shared", sessionKey: "main", sessionId } as const;
      const snapshot = expect.objectContaining({ type: "active_turn", sessionId, text: "Example answer" });
      support.send(subscribe);
      coUser.send(subscribe);
      await vi.waitFor(() => {
        expect(support.events).toEqual([snapshot]);
        expect(coUser.events).toEqual([mode === "team" ? snapshot : { type: "error", message: "Session not found" }]);
      });
      expect(await history(admin, sessionId)).toMatchObject({ isStreaming: true, activeTurn: { text: "Example answer" } });
      support.send({ type: "send", agentId: "shared", sessionId, message: "/stop" });
      await vi.waitFor(() => expect(support.events.at(-1)).toMatchObject({ type: "error", code: "read_only_impersonation" }));
      expect(await history(alice, sessionId)).toMatchObject({ isStreaming: true });

      const stopped = await sendHttp(bob, "/stop", { sessionId });
      if (mode === "team") {
        expect(await stopped.json()).toMatchObject({ meta: { aborted: true } });
      } else {
        expect(await stopped.json()).toEqual({ error: "Session not found" });
      }
    } finally {
      adapter.release();
      await running;
      adapter.restore();
      support.close();
      coUser.close();
      const ended = await fetch(`${baseUrl}/api/admin/impersonate/end`, { method: "POST", headers: { Cookie: admin } });
      expect(ended.status).toBe(204);
    }
  });
});
