import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { SdkRunParams } from "../sdk/types.js";
import { stubDesktopTestEnv } from "../test-utils/desktop-test-env.js";

const { run, queueMessage } = vi.hoisted(() => ({ run: vi.fn(), queueMessage: vi.fn() }));
vi.mock("../sdk/registry.js", async (load) => ({
  ...await load<typeof import("../sdk/registry.js")>(),
  getSdkAdapter: () => ({
    id: "pi", displayName: "Test", run, queueMessage,
    capabilities: { queueWhileStreaming: true, interrupt: false, toolEvents: true, fullHistory: true },
    resolveDisplayModel: () => ({}),
  }),
}));
vi.mock("../maintenance/session-auto-title.js", () => ({ maybeAutoTitleSession: vi.fn() }));

let root: string;
let home: string;
const stops: (() => Promise<void>)[] = [];
const sockets = new Set<WebSocket>();

beforeEach(async () => {
  vi.resetModules();
  run.mockReset();
  queueMessage.mockReset();
  root = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-turns-"));
  home = path.join(root, "yoplai");
  stubDesktopTestEnv(root, home);
  await fs.mkdir(path.join(home, "agents", "alpha"), { recursive: true });
  await fs.writeFile(path.join(home, "yoplai.json"), '{"version":3,"agents":["agents/*"]}');
  await fs.writeFile(path.join(home, "agents", "alpha", "agent.yaml"), "id: alpha\nname: Alpha\nmodel:\n  provider: openai\n  model: gpt-4.1-mini\nauth:\n  mode: oauth\n");
});

async function stop() {
  for (const ws of sockets) ws.terminate();
  sockets.clear();
  for (const close of stops.splice(0).reverse()) await close();
}

afterEach(async () => {
  await stop();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

async function boot() {
  const { app } = await import("../server/index.js");
  const { WsBroker } = await import("../server/ws-broker.js");
  const { configureRelay, setGatewayListener } = await import("../relay/state.js");
  const { startUiListener } = await import("../server/ui-listener.js");
  const { getExtensionRuntime } = await import("../extensions/registry.js");
  const gateway = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }) as Server;
  const broker = new WsBroker();
  broker.attach(gateway, {
    isMultiUserEnabled: () => false,
    validateWebSocketRequest: async () => null,
    canAccessAgent: async () => true,
    getExtensionRuntime,
  });
  stops.push(async () => {
    broker.close();
    await new Promise<void>((resolve) => { gateway.close(() => resolve()); gateway.closeAllConnections(); });
  });
  await new Promise<void>((resolve) => gateway.once("listening", resolve));
  const gatewayPort = (gateway.address() as AddressInfo).port;
  configureRelay("127.0.0.1", false);
  setGatewayListener({ address: "127.0.0.1", port: gatewayPort });
  const ui = startUiListener({ webDist: home, host: "127.0.0.1", port: 0, gatewayHost: "127.0.0.1", gatewayPort, onError: (error) => { throw error; } });
  stops.push(async () => {
    await new Promise<void>((resolve) => { ui.close(() => resolve()); ui.closeAllConnections(); });
  });
  await new Promise<void>((resolve) => ui.once("listening", resolve));
  const uiPort = (ui.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${uiPort}`;
  vi.stubEnv("YOPLAI_UI_PORT", String(uiPort));
  return {
    state: async (sessionId: string, turnId: string) => (await fetch(`${origin}/api/desktop-setup/turns/alpha/${sessionId}/${turnId}`)).json(),
    history: async (sessionId: string) => (await fetch(`${origin}/api/agents/alpha/history?sessionId=${sessionId}`)).json(),
    send: (payload: object, socketOrigin = origin) => new Promise<{ type: string; code?: string; message?: string }>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${uiPort}/ws`, { origin: socketOrigin });
      sockets.add(ws);
      ws.once("close", () => sockets.delete(ws));
      ws.once("error", reject);
      ws.once("open", () => ws.send(JSON.stringify({ type: "send", agentId: "alpha", message: "Hello", ...payload })));
      ws.on("message", (raw) => {
        const event = JSON.parse(raw.toString());
        if (event.type === "turn_exists" || event.type === "error" || event.type === "done" && !event.meta?.queued) {
          resolve(event);
          ws.close();
        }
      });
    }),
  };
}

it("starts one run for parallel sends and refuses the same ID after a restart", async () => {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  run.mockImplementation(async (params: SdkRunParams) => {
    await wait;
    params.onHistoryEvent({ type: "assistant_text", text: "Ready", timestamp: Date.now() });
    return { text: "Ready" };
  });
  const sessionId = "first";
  const turnId = randomUUID();
  let app = await boot();
  expect(await app.state(sessionId, turnId)).toEqual({ state: "none" });
  const message = "/tmp/report.txt";
  const first = app.send({ sessionId, turnId, message });
  const second = app.send({ sessionId, turnId: turnId.toUpperCase(), message });
  try {
    expect(await Promise.race([first, second])).toMatchObject({ type: "turn_exists" });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(await app.state(sessionId, turnId)).toEqual({ state: "running" });
  } finally {
    release();
  }
  expect(await Promise.all([first, second])).toEqual(expect.arrayContaining([expect.objectContaining({ type: "done" })]));
  expect(await app.send({ sessionId, turnId })).toMatchObject({ type: "turn_exists" });
  expect(await app.state(sessionId, turnId)).toEqual({ state: "answered" });
  await stop();
  vi.resetModules();
  app = await boot();
  expect(await app.send({ sessionId, turnId })).toMatchObject({ type: "turn_exists" });
  expect(await app.state(sessionId, turnId)).toEqual({ state: "answered" });
  expect(await app.history(sessionId)).toMatchObject({ messages: [{ role: "user", content: message }, { role: "assistant", content: "Ready" }] });
  expect(run).toHaveBeenCalledTimes(1);
});

it("reports a failed turn and refuses invalid or untrusted sends", async () => {
  run.mockRejectedValue(new Error("Fake private diagnostic."));
  const app = await boot();
  const sessionId = "failed";
  const turnId = randomUUID();
  expect(await app.send({ sessionId, turnId }, "http://localhost:9999")).toMatchObject({ code: "invalid_turn" });
  expect(await app.send({ turnId })).toMatchObject({ message: "Supply a valid session ID with the turn ID." });
  expect(await app.send({ sessionId, turnId: "invalid" })).toMatchObject({ message: "Check the chat request. The turn ID must be a UUID." });
  for (const message of ["/think", "  /abort", "/new"]) {
    expect(await app.send({ sessionId, turnId, message })).toMatchObject({
      type: "error", code: "invalid_turn", message: "Send a message without a slash command when you use a turn ID.",
    });
  }
  expect(await app.state(sessionId, turnId)).toEqual({ state: "none" });
  expect(run).not.toHaveBeenCalled();
  expect(await app.send({ sessionId, turnId })).toMatchObject({ type: "error", message: "Something went wrong, please try again." });
  expect(await app.state(sessionId, turnId)).toEqual({ state: "failed" });
  expect(await app.send({ sessionId, turnId })).toMatchObject({ type: "turn_exists" });
  expect(run).toHaveBeenCalledTimes(1);
});
