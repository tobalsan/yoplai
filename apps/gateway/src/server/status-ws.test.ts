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
