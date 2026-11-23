import { once } from "node:events";
import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { Extension, ExtensionReplyReviewer, WsClientMessage, WsSendMessage, WsServerMessage } from "@yoplai/shared";
import { vi } from "vitest";
import { z } from "zod";
import { WebSocket } from "ws";
import { writeTestAgent, writeTestV3Config } from "./v3-config.js";

type TestUser = "local" | "alice" | "bob";
type SendOptions = Pick<WsSendMessage, "clientSendId" | "sessionKey" | "sessionId" | "projectId" | "turnId" | "attachments">;

export async function startDurableTestGateway({
  multiUser = false, extraYaml = "durable: true", reviewer, legacyAnswer, tokensPerSecond,
}: { multiUser?: boolean; extraYaml?: string; reviewer?: ExtensionReplyReviewer | (() => ExtensionReplyReviewer); legacyAnswer?: string; tokensPerSecond?: number } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-durable-"));
  const sockets = new Set<WebSocket>();
  const users = new Map<TestUser, { id: string; cookie: string }>([["local", { id: "local", cookie: "" }]]);
  let fault = false;
  let base = "";
  let server: ReturnType<typeof import("../server/index.js").startServer>;
  let startAuth: (() => Promise<void>) | undefined;
  let stopAuth: (() => Promise<void>) | undefined;
  let restoreLegacy: (() => void) | undefined;

  vi.stubEnv("YOPLAI_HOME", home);
  await writeTestV3Config(home, {
    agents: [{ id: "pilot", model: { provider: "faux", model: "fixture" }, extraYaml }],
    extensions: multiUser ? {
      multiUser: {
        enabled: true, autoApprove: true, emailAndPassword: { enabled: true },
        sessionSecret: "fixture-session-secret-for-durable-tests",
      },
    } : undefined,
  });
  vi.resetModules();
  const { startServer } = await import("../server/index.js");
  const { loadConfig, reloadConfig } = await import("../config/index.js");
  const { getExtensionRuntime } = await import("../extensions/registry.js");
  const { createDurableFaux } = await import("../durable/faux.js");
  const faux = createDurableFaux(tokensPerSecond);
  faux.script("The seedlings are ready.");
  const runtime = getExtensionRuntime();

  const extensions: Extension[] = [];
  if (reviewer) {
    extensions.push({
      id: "fixture-reviewer", displayName: "Fixture Reviewer", description: "", dependencies: [], routePrefixes: [],
      configSchema: z.object({}), validateConfig: () => ({ valid: true, errors: [] }), registerRoutes() {},
      async start() {}, async stop() {}, capabilities: () => [],
      reviewsReplies: () => true,
      getReplyReviewer: () => typeof reviewer === "function" ? reviewer() : reviewer,
    });
  }

  if (multiUser) {
    const { multiUserExtension } = await import("@yoplai/extension-multi-user");
    const { createExtensionContext } = await import("../extensions/context.js");
    const { api } = await import("../server/api.core.js");
    extensions.push(multiUserExtension);
    multiUserExtension.registerRoutes(api);
    stopAuth = () => multiUserExtension.stop();
    startAuth = () => multiUserExtension.start(createExtensionContext(loadConfig()));
  }

  runtime.load(extensions);
  if (legacyAnswer !== undefined) {
    const registry = await import("../sdk/registry.js");
    const adapter = registry.getSdkAdapter("pi");
    const mock = vi.spyOn(registry, "getSdkAdapter").mockReturnValue({
      ...adapter,
      async run(params) {
        params.onHistoryEvent({ type: "assistant_text", text: legacyAnswer, timestamp: Date.now() });
        params.onEvent({ type: "text", data: legacyAnswer });
        return { text: legacyAnswer, aborted: false };
      },
    });
    restoreLegacy = () => mock.mockRestore();
  }

  async function open() {
    server = startServer(0, "127.0.0.1", runtime, {
      createModels: faux.createModels,
      afterMainCommit() {
        if (!fault) return;
        fault = false;
        throw new Error("Fixture stopped between Main creation and admission.");
      },
    });
    if (!server.listening) await once(server, "listening");
    base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  }

  async function stop() {
    for (const socket of sockets) socket.terminate();
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    await server?.durableWeb.close();
  }

  function cookie(user: TestUser) {
    const account = users.get(user);
    if (!account) throw new Error("Unknown test user: " + user);
    return account.cookie;
  }

  async function socket(user: TestUser = "local") {
    const ws = new WebSocket(base.replace("http:", "ws:") + "/ws", { headers: { Cookie: cookie(user) } });
    sockets.add(ws);
    ws.once("close", () => sockets.delete(ws));
    const events: WsServerMessage[] = [];
    ws.on("message", (raw) => events.push(JSON.parse(raw.toString()) as WsServerMessage));
    await once(ws, "open");
    return {
      events,
      async flush() {
        const pong = once(ws, "pong");
        ws.ping();
        await pong;
      },
      send: (message: WsClientMessage) => ws.send(JSON.stringify(message)),
      close: () => ws.terminate(),
    };
  }

  async function cleanUp() {
    try {
      await stop();
      await stopAuth?.();
    } finally {
      restoreLegacy?.();
      vi.unstubAllEnvs();
      await fs.rm(home, { recursive: true, force: true, maxRetries: 3 });
    }
  }

  try {
    await startAuth?.();
    await open();
    if (multiUser) {
      for (const user of ["alice", "bob"] as const) {
        const response = await fetch(base + "/api/auth/sign-up/email", {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" },
          body: JSON.stringify({ name: user, email: user + "@example.test", password: "fixture-password-123" }),
        });
        if (!response.ok) throw new Error("Fixture sign-up returned " + response.status);
        const { user: account } = await response.json() as { user: { id: string } };
        users.set(user, {
          id: account.id,
          cookie: response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; "),
        });
      }
    }
  } catch (error) {
    await cleanUp();
    throw error;
  }

  function send(user: TestUser, message: string, options?: SendOptions, transport?: "http"): Promise<Response>;
  function send(user: TestUser, message: string, options: SendOptions, transport: "ws"): ReturnType<typeof socket>;
  async function send(user: TestUser, message: string, options: SendOptions = {}, transport: "http" | "ws" = "http") {
    if (transport === "ws") {
      const sender = await socket(user);
      sender.send({ type: "send", agentId: "pilot", message, ...options });
      return sender;
    }
    return fetch(base + "/api/agents/pilot/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie(user) },
      body: JSON.stringify({ message, ...options }),
    });
  }

  return {
    socket,
    script: faux.script,
    callCount: faux.callCount,
    requests: faux.requests,
    close: cleanUp,
    failBetweenCommits() { fault = true; },
    async restart(model?: string) {
      await stop();
      await stopAuth?.();
      if (model) {
        await writeTestAgent(home, { id: "pilot", model: { provider: "faux", model }, extraYaml });
        reloadConfig();
      }
      await startAuth?.();
      await open();
    },
    async mainConversationId(user: TestUser) {
      const agent = loadConfig().agents.find((agent) => agent.id === "pilot")!;
      return (await server.durableWeb.host(agent)).conversationIdFor(users.get(user)!.id);
    },
    async subscribe(user: TestUser, selector: Pick<SendOptions, "sessionKey" | "sessionId"> = {}) {
      const observer = await socket(user);
      observer.send({ type: "subscribe", agentId: "pilot", sessionKey: "main", ...selector });
      return observer;
    },
    send,
    async history(user: TestUser, query = "") {
      const response = await fetch(base + "/api/agents/pilot/history" + query, { headers: { Cookie: cookie(user) } });
      if (!response.ok) throw new Error("History returned " + response.status);
      return response.json();
    },
  };
}
