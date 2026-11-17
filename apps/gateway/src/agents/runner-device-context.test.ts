import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { AgentConfigSchema, GatewayConfigSchema } from "@yoplai/shared";
import type { SdkAdapter, SdkRunParams, SdkRunResult } from "../sdk/types.js";

const fixture = vi.hoisted(() => {
  const home = `/tmp/yoplai-device-context-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  return { home, previousHome, getAdapter: vi.fn() };
});
vi.mock("../sdk/registry.js", () => ({ getSdkAdapter: fixture.getAdapter, getDefaultSdkId: () => "pi" }));
vi.mock("../sdk/container/adapter.js", () => ({ getContainerAdapter: fixture.getAdapter }));

import { setLoadedConfig } from "../config/index.js";
import { appendSessionMeta } from "../history/store.js";
import { runAgent } from "./runner.js";
import { DeviceExecutor } from "../relay/device-exec.js";
import { DeviceApprovals } from "../relay/device-approvals.js";
import { DeviceTurns } from "../relay/device-turns.js";
import { createFileDeviceSettingsStore, deviceChatKey } from "../relay/device-settings.js";


const REMOTE = { name: "remote", generation: "remote-link-1" };
const agent = AgentConfigSchema.parse({ id: "context", name: "Context", sdk: "pi", workspace: path.join(fixture.home, "workspace"), model: { provider: "anthropic", model: "claude" }, queueMode: "queue" });
const captured: SdkRunParams[] = [];
let script: (params: SdkRunParams) => Promise<SdkRunResult>;
let sessionId = "";
let sequence = 0;
beforeEach(async () => {
  sessionId = `context-${++sequence}`;
  captured.length = 0;
  await fs.mkdir(agent.workspace, { recursive: true });
  setLoadedConfig(GatewayConfigSchema.parse({ agents: [agent], extensions: {} }));
  await appendSessionMeta(agent.id, sessionId, "title", "Context test");
  script = async (params) => {
    params.onEvent({ type: "text", data: "Done" });
    params.onHistoryEvent({ type: "assistant_text", text: "Done", timestamp: 1700000000000 });
    return { text: "Done" };
  };
  const adapter: SdkAdapter = {
    id: "pi", displayName: "Scripted model", capabilities: { queueWhileStreaming: false, interrupt: false, toolEvents: true, fullHistory: true }, resolveDisplayModel: () => ({}),
    run: async (params) => { captured.push(params); return script(params); },
  };
  fixture.getAdapter.mockReturnValue(adapter);
});
afterAll(async () => {
  if (fixture.previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = fixture.previousHome;
  await fs.rm(fixture.home, { recursive: true, force: true });
});

function send(message: string, extra: Partial<Parameters<typeof runAgent>[0]> = {}) {
  return runAgent({ agentId: agent.id, sessionId, message, ...extra });
}

it.each(["native", "buffered"])("keeps the Ask token separate from a Full run during %s delivery", async (delivery) => {
  const turns = new DeviceTurns();
  const settings = createFileDeviceSettingsStore(path.join(fixture.home, "device-settings.json"));
  const approvals = new DeviceApprovals();
  const asked: string[] = [];
  approvals.subscribe(event => { if (event.kind === "request") { asked.push(event.message.chat); approvals.answer(event.message.approvalId, false); } });
  const executor = new DeviceExecutor({ settings, approvals, turns });
  const fullChat = "key:web-original";
  const askChat = `session:${sessionId}`;
  settings.setChat(deviceChatKey(REMOTE, "context@remote", fullChat), { full: true });
  settings.setChat(deviceChatKey(REMOTE, "context@remote", askChat), { full: false });
  const fullToken = turns.issue({ gateway: REMOTE.name, generation: REMOTE.generation, agentId: agent.id, chat: fullChat, page: {} });
  const askToken = turns.issue({ gateway: REMOTE.name, generation: REMOTE.generation, agentId: agent.id, chat: askChat, page: {} });
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(r => { enter = r; });
  const released = new Promise<void>(r => { release = r; });
  const adapter = fixture.getAdapter() as SdkAdapter;
  adapter.capabilities.queueWhileStreaming = true;
  const joined: string[] = [];
  adapter.queueMessage = async (_handle, message) => { joined.push(message); };
  const target = path.join(fixture.home, "joined-ask-output.txt");
  script = async params => {
    if (delivery === "native") params.onSessionHandle?.({});
    enter();
    await released;
    params.onSessionHandle?.({});
    const call = executor.execute({ type: "call", callId: "fixture", agentId: agent.id,
      toolCallId: "fixture", tool: "device_write", arguments: { path: target, content: "synthetic" },
      turnToken: params.deviceTurnToken }, REMOTE, new AbortController().signal);
    if (params.deviceTurnToken === askToken) await expect(call).rejects.toThrow(/refused/);
    else await call;
    return { text: "Done" };
  };
  const askEvents: unknown[] = [];
  const running = send("hold", { source: "web", deviceTurnToken: fullToken });
  try {
    await entered;
    expect(await send("write the synthetic file", { source: "web", deviceTurnToken: askToken, onEvent: event => askEvents.push(event) })).toMatchObject({ meta: { queued: true } });
    expect(joined).toEqual([]);
    expect(captured).toHaveLength(1);
    expect(captured[0].deviceTurnToken).toBe(fullToken);
  } finally { release(); await running; }
  expect(await fs.readFile(target, "utf8")).toBe("synthetic");
  expect(asked).toEqual([askChat]);
  expect(captured.map(params => params.deviceTurnToken)).toEqual([fullToken, askToken]);
  expect(askEvents).toContainEqual(expect.objectContaining({ type: "done", meta: expect.not.objectContaining({ queued: true }) }));
  expect(JSON.stringify(askEvents)).not.toContain(askToken);
  turns.end(fullToken);
  turns.end(askToken);
});


it("sends one terminal error when a deferred device turn fails before activation", async () => {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const adapter = fixture.getAdapter() as SdkAdapter;
  adapter.capabilities.queueWhileStreaming = true;
  adapter.queueMessage = vi.fn();
  script = async params => {
    params.onSessionHandle?.({});
    enter();
    await released;
    return { text: "Done" };
  };
  const events: Array<{ type: string }> = [];
  const active = send("hold", { deviceTurnToken: "synthetic-full" });
  try {
    await entered;
    await send("deferred", { deviceTurnToken: "synthetic-ask", onEvent: event => events.push(event) });
    setLoadedConfig(GatewayConfigSchema.parse({ agents: [], extensions: {} }));
  } finally { release(); await active; }
  expect(events.filter(event => event.type === "error" || event.type === "done")).toEqual([
    { type: "error", message: "Agent not found: context" },
  ]);
});
