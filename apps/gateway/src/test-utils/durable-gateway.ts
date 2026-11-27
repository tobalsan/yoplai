import type { EntryDraft } from "@earendil-works/pi-durable";
import type { DurableHostOptions } from "../durable/host.js";
import type { DurableModelsFactory } from "../durable/models.js";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { Extension, ExtensionContext, ExtensionReplyReviewer, ModelSource, WsClientMessage, WsSendMessage, WsServerMessage } from "@yoplai/shared";
import { vi } from "vitest";
import { z } from "zod";
import { WebSocket } from "ws";
import { writeTestAgent, writeTestV3Config } from "./v3-config.js";

type TestUser = "local" | "alice" | "bob" | "carol";
type SendOptions = Pick<WsSendMessage, "clientSendId" | "sessionKey" | "sessionId" | "projectId" | "turnId" | "attachments">;
type CustomModel = { provider: string; model: string; baseUrl: string; apiKey: string; headers?: Record<string, string> };

type ModelLimits = Partial<{ contextWindow: number; maxTokens: number }>;
export type RealTestModel = { provider: string; model: string; limits?: ModelLimits; apiKey?: string };

export async function startDurableTestGateway({
  multiUser = false, additionalAgents = [], afterRoomCommit, extraYaml = "", enableDurableMode = true, reviewer, legacyAnswer, tokensPerSecond, fixtureExtensions = [], modelFixture, customModel, extraConfig, appViews = false, feedSendComplete, recheckMs, fixture, startChannels, deliveryFixture, keeper, realModel, fauxLimits, fauxApi, wrapModels, afterThreadArchive, afterThreadNote, now, threadSweepIntervalMs, afterChildSettlement,
}: { multiUser?: boolean; additionalAgents?: Parameters<typeof writeTestAgent>[1][]; afterRoomCommit?: DurableHostOptions["afterRoomCommit"]; extraYaml?: string; enableDurableMode?: boolean; reviewer?: ExtensionReplyReviewer | (() => ExtensionReplyReviewer); legacyAnswer?: string; tokensPerSecond?: number; fixtureExtensions?: Extension[] | (() => Promise<Extension[]>); modelFixture?: { provider: string; model: string; observeKey: (key?: string) => void }; customModel?: CustomModel; extraConfig?: Record<string, unknown>; appViews?: boolean; feedSendComplete?: () => Promise<void>; recheckMs?: number; fixture?: DurableHostOptions["fixture"]; startChannels?: (ctx: ExtensionContext, home: string) => (() => void | Promise<void>) | void | Promise<(() => void | Promise<void>) | void>; deliveryFixture?: DurableHostOptions["deliveryFixture"]; keeper?: DurableHostOptions["keeper"]; realModel?: RealTestModel; fauxLimits?: ModelLimits; fauxApi?: string; wrapModels?: (factory: DurableModelsFactory) => DurableModelsFactory; afterThreadArchive?: DurableHostOptions["afterThreadArchive"]; afterThreadNote?: DurableHostOptions["afterThreadNote"]; now?: DurableHostOptions["now"]; threadSweepIntervalMs?: number; afterChildSettlement?: DurableHostOptions["afterChildSettlement"] } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-durable-"));
  const sockets = new Set<WebSocket>();
  const users = new Map<TestUser, { id: string; cookie: string }>([["local", { id: "local", cookie: "" }]]);
  let fault = false;
  let base = "";
  let server: ReturnType<typeof import("../server/index.js").startServer>;
  let startAuth: (() => Promise<void>) | undefined;
  let stopAuth: (() => Promise<void>) | undefined;
  let restoreLegacy: (() => void) | undefined;
  let stopChannels: (() => void | Promise<void>) | void;

  let appsPort: number | undefined;
  if (appViews) {
    const probe = createServer().listen(0, "127.0.0.1");
    await once(probe, "listening");
    appsPort = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  }
  vi.stubEnv("YOPLAI_HOME", home);
  await writeTestV3Config(home, {
    extraConfig: { oauth: { encryptionKey: "fixture-encryption-key-durable" }, ...extraConfig, ...(appsPort ? { apps: { port: appsPort, origin: "http://127.0.0.1:" + appsPort } } : {}) },
    agents: [{ id: "pilot", model: realModel ? { provider: realModel.provider, model: realModel.model } : customModel ?? modelFixture ?? { provider: "faux", model: "fixture" }, extraYaml }, ...additionalAgents],
    extensions: multiUser ? {
      multiUser: {
        enabled: true, autoApprove: true, emailAndPassword: { enabled: true },
        sessionSecret: "fixture-session-secret-for-durable-tests",
      },
    } : undefined,
  });
  async function configureCustomModel({ provider, model, baseUrl, apiKey, headers }: CustomModel) {
    await fs.writeFile(path.join(home, "models.json"), JSON.stringify({ providers: {
      [provider]: { api: "openai-completions", baseUrl, apiKey, headers, models: [{ id: model, contextWindow: 128000 }] },
    } }));
  }
  async function seedModelKeys(keys: Record<string, string>) {
    await fs.writeFile(path.join(home, "auth.json"), JSON.stringify(Object.fromEntries(
      Object.entries(keys).map(([provider, key]) => [provider, { type: "api_key", key }]),
    )), { mode: 0o600 });
  }
  if (customModel) await configureCustomModel(customModel);
  if (realModel?.limits) await fs.writeFile(path.join(home, "models.json"), JSON.stringify({ providers: {
    [realModel.provider]: { modelOverrides: { [realModel.model]: realModel.limits } },
  } }));
  if (realModel?.apiKey) await seedModelKeys({ [realModel.provider]: realModel.apiKey });
  vi.resetModules();
  const { startServer } = await import("../server/index.js");
  const { loadConfig, reloadConfig, setSingleAgentMode } = await import("../config/index.js");
  const { getExtensionRuntime } = await import("../extensions/registry.js");
  const { createExtensionContext } = await import("../extensions/context.js");
  const { createDurableFaux } = await import("../durable/faux.js");
  const faux = createDurableFaux(tokensPerSecond, modelFixture, undefined, fauxLimits, fauxApi);
  const { createDurableModels } = await import("../durable/models.js");
  const modelFactory = realModel || customModel ? createDurableModels : faux.createModels;
  faux.script("The seedlings are ready.");
  const runtime = getExtensionRuntime();

  const extensions: Extension[] = [...(typeof fixtureExtensions === "function" ? await fixtureExtensions() : fixtureExtensions)];
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
    const channels = startChannels && createExtensionContext(loadConfig());
    if (channels) stopChannels = await startChannels?.(channels, home);
    server = startServer(0, "127.0.0.1", runtime, {
      createModels: wrapModels?.(modelFactory) ?? modelFactory,
      fixture,
      deliveryFixture,
      keeper,
      channelContext: channels,
      afterThreadArchive,
      afterThreadNote,
      now,
      threadSweepIntervalMs,
      afterChildSettlement,
      afterRoomCommit,
      afterMainCommit() {
        if (!fault) return;
        fault = false;
        throw new Error("Fixture stopped between Main creation and admission.");
      },
    }, { feedSendComplete, recheckMs });
    if (!server.listening) await once(server, "listening");
    base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  }

  async function stop() {
    for (const socket of sockets) socket.terminate();
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    await server?.durableWeb.close();
    await stopChannels?.();
    stopChannels = undefined;
  }

  function cookie(user: TestUser) {
    const account = users.get(user);
    if (!account) throw new Error("Unknown test user: " + user);
    return account.cookie;
  }

  async function setDurableMode(user: TestUser, enabled: boolean) {
    const response = await fetch(base + "/api/me/durable-mode", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie(user) },
      body: JSON.stringify({ enabled }),
    });
    if (!response.ok) throw new Error("Setting Durable mode returned " + response.status);
  }

  async function socket(user: TestUser = "local") {
    const ws = new WebSocket(base.replace("http:", "ws:") + "/ws", { headers: { Cookie: cookie(user) } });
    sockets.add(ws);
    let closedCode: number | undefined;
    ws.once("close", (code) => {
      closedCode = code;
      sockets.delete(ws);
    });
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
      closedCode: () => closedCode,
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
      for (const user of ["alice", "bob", "carol"] as const) {
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
    if (enableDurableMode) {
      for (const user of multiUser ? ["alice", "bob"] as const : ["local"] as const) {
        await setDurableMode(user, true);
      }
    }
  } catch (error) {
    await cleanUp();
    throw error;
  }

  async function connectDevice(user: TestUser) {
    const { DEVICE_PROTOCOL_VERSION } = await import("@yoplai/shared");
    const ws = new WebSocket(base.replace("http:", "ws:") + "/ws/device", { headers: { Cookie: cookie(user) } });
    sockets.add(ws);
    ws.once("close", () => sockets.delete(ws));
    await once(ws, "open");
    const hello = once(ws, "message");
    ws.send(JSON.stringify({ type: "hello", protocolVersion: DEVICE_PROTOCOL_VERSION }));
    await hello;
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
    connectDevice,
    setDurableMode,
    setSingleAgentMode,
    configureCustomModel,
    script: faux.script,
    callCount: faux.callCount,
    requests: faux.requests,
    cacheRetentions: faux.cacheRetentions,
    offeredTools: faux.offeredTools,
    prompt: faux.prompt,
    request: (user: TestUser, pathname: string, init?: RequestInit) => fetch(base + pathname, {
      ...init, headers: { ...init?.headers, Cookie: cookie(user) },
    }),
    async seedConversationFile(user: TestUser, name: string, content: string) {
      const { getConversationFiles } = await import("../media/conversation-files.js");
      const { DURABLE_MAIN_SESSION_ID } = await import("@yoplai/shared");
      const folder = getConversationFiles("pilot", DURABLE_MAIN_SESSION_ID, user === "local" ? undefined : users.get(user)!.id);
      const filename = path.join(folder.hostPath, name);
      await fs.writeFile(filename, content);
      return filename;
    },
    accountId: (user: TestUser) => users.get(user)!.id,
    async seedPersonalToken(user: TestUser, extension: string, apiToken: string) {
      const { storePersonalExtensionTokens } = await import("../credentials/extension-tokens.js");
      const { CredentialStore } = await import("../credentials/store.js");
      storePersonalExtensionTokens(new CredentialStore(), users.get(user)!.id, extension, { apiToken });
    },
    close: cleanUp,
    failBetweenCommits() { fault = true; },
    home,
    seedModelKeys,
    async configure(model: string, yaml = extraYaml, source?: ModelSource) {
      await writeTestAgent(home, { id: "pilot", model: { provider: realModel?.provider ?? modelFixture?.provider ?? "faux", model, source }, extraYaml: yaml });
      reloadConfig();
    },
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
    appendRoomDigest(roomId: string, threadId: string, generation: number, text: string) {
      return server.rooms.append(roomId, `thread-note:${threadId}:${generation}`, { id: threadId, name: "Thread digest" }, text, { kind: "digest" });
    },
    async writePassiveEntry(user: TestUser, entry: EntryDraft) {
      const agent = loadConfig().agents.find((agent) => agent.id === "pilot")!;
      await (await server.durableWeb.host(agent)).writePassiveEntry(users.get(user)!.id, entry);
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
