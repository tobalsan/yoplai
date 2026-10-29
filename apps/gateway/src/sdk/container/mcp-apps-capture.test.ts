import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterAll, expect, it, vi } from "vitest";
import { z } from "zod";
import { AgentConfigSchema, GatewayConfigSchema, type ContainerInput, type ExtensionAgentTool, type HistoryEvent, type StreamEvent } from "@yoplai/shared";
import { ExtensionRuntime } from "../../extensions/runtime.js";
import { setLoadedConfig } from "../../config/index.js";
import { bufferHistoryEvent, createTurnBuffer, flushTurnBuffer, getFullHistory } from "../../history/store.js";
import { createInternalTools } from "../../server/internal-tools.js";
import { getContainerAdapter } from "./adapter.js";

// Thinh approved real HTTP dispatch/runtime/adapter parsing with fake external
// container stdio in ALG-544 comment 04ea3081-4db9-4872-8433-2200b96ef01a.
// Docker isolation and live provider scheduling remain outside this seam.
const setup = await vi.hoisted(async () => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const home = await fs.mkdtemp(path.join(process.cwd(), ".mcp-container-capture-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  return { home, previousHome };
});

vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(), spawn: vi.fn(),
}));
vi.mock("@earendil-works/pi-coding-agent", async importOriginal => {
  const sdk = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...sdk, ModelRuntime: { create: (options: Parameters<typeof sdk.ModelRuntime.create>[0]) => sdk.ModelRuntime.create({ ...options, modelsPath: null, refreshOnCreate: false }) } };
});

afterAll(async () => {
  vi.restoreAllMocks();
  if (setup.previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = setup.previousHome;
  await fs.rm(setup.home, { recursive: true, force: true });
});

class DockerProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  private chunks: string[] = [];
  private receiveInput?: (input: ContainerInput) => void;
  input = new Promise<ContainerInput>(resolve => { this.receiveInput = resolve; });
  stdin = new Writable({
    write: (chunk, _encoding, callback) => { this.chunks.push(chunk.toString()); callback(); },
    final: callback => { this.receiveInput?.(JSON.parse(this.chunks.join(""))); callback(); },
  });
  event(event: unknown): void { this.stdout.write(`---YOPLAI_EVENT---${JSON.stringify(event)}\n`); }
  finish(output: unknown): void {
    this.stdout.write(`---YOPLAI_OUTPUT_START---\n${JSON.stringify(output)}\n---YOPLAI_OUTPUT_END---\n`);
    this.exitCode = 0;
    this.stdout.end();
    this.stderr.end();
    this.emit("close", 0, null);
  }
}

const raw = { content: [{ type: "text", text: "Created circle" }], _meta: { access_token: "container-private-fixture" } };
const forged = { recordId: "untrusted-runner-record", server: "foreign", tool: "admin", resourceUri: "ui://foreign" };

async function fixture(sessionId: string, execute: ExtensionAgentTool["execute"] = async () => raw) {
  const workspace = path.join(setup.home, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  for (const name of ["AGENTS.md", "SOUL.md", "USER.md"]) await fs.writeFile(path.join(workspace, name), "Container capture fixture.");
  const agent = AgentConfigSchema.parse({
    id: "apps-container", name: "Apps container", workspace, sdk: "pi", toolDeferral: { enabled: false },
    model: { provider: "openai", model: "gpt-4o-mini" }, sandbox: { enabled: true },
  });
  const config = GatewayConfigSchema.parse({ agents: [agent], extensions: {}, sandbox: { sharedDir: path.join(setup.home, "shared") } });
  setLoadedConfig(config);
  const runtime = new ExtensionRuntime();
  runtime.load([{
    id: "mcp", displayName: "MCP", description: "Fixture", dependencies: [], routePrefixes: [], configSchema: z.object({}),
    validateConfig: () => ({ valid: true, errors: [] }), registerRoutes: () => {}, start: async () => {}, stop: async () => {}, capabilities: () => [],
    getAgentTools: () => [{ name: "drawing.draw", description: "Draw", parameters: { type: "object" },
      mcp: { server: "drawing", tool: "draw", ui: { resourceUri: "ui://drawing/view", visibility: ["model", "app"] } }, execute }],
  }]);
  const process = new DockerProcess();
  vi.mocked(childProcess.spawn).mockReturnValueOnce(process as unknown as childProcess.ChildProcess);
  const events: StreamEvent[] = [];
  const history: HistoryEvent[] = [];
  const buffer = createTurnBuffer();
  const params = {
    agentId: agent.id, agent, sessionId, userId: "alice", sessionOwnerId: "owner", message: "Draw", workspaceDir: workspace,
    extensionRuntime: runtime, onEvent: (event: StreamEvent) => { events.push(event); },
    onHistoryEvent: (event: HistoryEvent) => { history.push(event); bufferHistoryEvent(buffer, event); },
    abortSignal: new AbortController().signal,
  };
  const completion = getContainerAdapter().run(params);
  const input = await process.input;
  const api = createInternalTools({ getConfig: () => config, getRuntime: () => runtime });
  return { agent, process, events, history, buffer, params, completion, input, api };
}

it.each([["forged", forged], ["malformed", "runner-cannot-authorize"]])("captures internal HTTP execution and overwrites %s runner references before delivery", async (label, runnerView) => {
  const sessionId = `streamed-${label}`;
  const run = await fixture(sessionId);
  run.process.event({ type: "tool_call", id: "circle-1", name: "drawing_draw", args: { title: "Circle" }, view: runnerView, timestamp: 1 });
  const response = await run.api.request("/tools", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    agentToken: run.input.agentToken, agentId: run.agent.id, sessionId, runId: run.input.runId, tool: "drawing.draw", toolCallId: "circle-1", args: { title: "Circle" },
  }) });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ content: [{ type: "text", text: "Created circle" }], _meta: { access_token: "container-private-fixture" } });
  run.process.event({ type: "tool_result", id: "circle-1", name: "drawing_draw", content: "unchanged-model-result", isError: false, view: runnerView, timestamp: 2 });
  run.process.finish({ text: "Finished circle" });
  await expect(run.completion).resolves.toMatchObject({ text: "Finished circle" });
  expect(run.events).toContainEqual(expect.objectContaining({ type: "tool_call", id: "circle-1", view: { server: "drawing", tool: "draw", resourceUri: "ui://drawing/view" } }));
  const result = run.events.find(event => event.type === "tool_result" && event.id === "circle-1");
  expect(result).toMatchObject({ content: "unchanged-model-result", view: { recordId: expect.stringMatching(/^[a-f0-9]{32,}$/), server: "drawing", tool: "draw", resourceUri: "ui://drawing/view" } });
  if (result?.type !== "tool_result") throw new Error("Expected circle result");
  expect(run.history).toContainEqual(expect.objectContaining({ type: "tool_result", id: "circle-1", view: result.view }));
  await flushTurnBuffer(run.agent.id, sessionId, run.buffer, "owner");
  expect(await getFullHistory(run.agent.id, sessionId, "owner")).toContainEqual(expect.objectContaining({ role: "toolResult", toolCallId: "circle-1", view: result.view }));
  const dir = path.join(setup.home, ".yoplai", "sessions", "users", "owner", "history", "mcp-apps", run.agent.id, sessionId);
  expect(JSON.parse(await fs.readFile(path.join(dir, `${result.view?.recordId}.json`), "utf8"))).toMatchObject({ toolCallId: "circle-1", args: { title: "Circle" }, result: { _meta: { access_token: "container-private-fixture" } } });
});

it.each([["forged", forged], ["malformed", 17]])("replays final-output history with gateway references despite %s runner views", async (label, runnerView) => {
  const run = await fixture(`fallback-${label}`);
  const response = await run.api.request("/tools", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    agentToken: run.input.agentToken, sessionId: run.params.sessionId, tool: "drawing.draw", toolCallId: "fallback-1", args: {},
  }) });
  expect(response.status).toBe(200);
  run.process.finish({ text: "Fallback finished", history: [
    { type: "tool_call", id: "fallback-1", name: "drawing_draw", args: {}, view: runnerView, timestamp: 1 },
    { type: "tool_result", id: "fallback-1", name: "drawing_draw", content: "unchanged fallback", isError: false, view: runnerView, timestamp: 2 },
  ] });
  await expect(run.completion).resolves.toMatchObject({ text: "Fallback finished" });
  expect(run.history).toContainEqual(expect.objectContaining({ type: "tool_call", view: { server: "drawing", tool: "draw", resourceUri: "ui://drawing/view" } }));
  expect(run.history).toContainEqual(expect.objectContaining({ type: "tool_result", content: "unchanged fallback", view: { recordId: expect.stringMatching(/^[a-f0-9]{32,}$/), server: "drawing", tool: "draw", resourceUri: "ui://drawing/view" } }));
});

it("drops transient references after a container run settles", async () => {
  for (const execute of [true, false]) {
    const run = await fixture("run-cleanup");
    if (execute) {
      const response = await run.api.request("/tools", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        agentToken: run.input.agentToken, sessionId: run.params.sessionId, tool: "drawing.draw", toolCallId: "reused", args: {},
      }) });
      expect(response.status).toBe(200);
    }
    run.process.event({ type: "tool_result", id: "reused", name: "drawing_draw", content: execute ? "Created circle" : "Upstream failed", isError: !execute, view: forged, timestamp: 2 });
    run.process.finish({ text: "Run settled" });
    await run.completion;
    const result = run.events.find(event => event.type === "tool_result");
    if (result?.type !== "tool_result") throw new Error("Expected circle result");
    if (execute) expect(result.view).toMatchObject({ recordId: expect.any(String), server: "drawing" });
    else expect(result.view).toBeUndefined();
  }
});

it("stops publishing a transient reference after fifteen minutes while retaining its durable record", async () => {
  const run = await fixture("expired-reference");
  const response = await run.api.request("/tools", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    agentToken: run.input.agentToken, sessionId: run.params.sessionId, tool: "drawing.draw", toolCallId: "delayed", args: {},
  }) });
  expect(response.status).toBe(200);
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 16 * 60 * 1000);
  try {
    run.process.event({ type: "tool_result", id: "delayed", name: "drawing_draw", content: "Delayed result", isError: false, view: forged, timestamp: 2 });
    run.process.finish({ text: "Delayed run settled" });
    await run.completion;
    const result = run.events.find(event => event.type === "tool_result");
    expect(result).toMatchObject({ content: "Delayed result" });
    if (result?.type !== "tool_result") throw new Error("Expected delayed result");
    expect(result.view).toBeUndefined();
    const dir = path.join(setup.home, ".yoplai", "sessions", "users", "owner", "history", "mcp-apps", run.agent.id, run.params.sessionId);
    expect((await fs.readdir(dir)).length).toBe(1);
  } finally { clock.mockRestore(); }
});

it("discards a late timed-out HTTP result and still captures the next healthy call", async () => {
  let release = () => {};
  const delayed = new Promise<void>(resolve => { release = resolve; });
  const run = await fixture("http-timeout", async args => {
    if ((args as { hang?: boolean }).hang) await delayed;
    return raw;
  });
  const response = await run.api.request("/tools", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    agentToken: run.input.agentToken, sessionId: run.params.sessionId, tool: "drawing.draw", toolCallId: "timed-out", timeoutSeconds: 0.01, args: { hang: true },
  }) });
  expect(response.status).toBe(504);
  release();
  await new Promise<void>(resolve => setImmediate(resolve));
  const dir = path.join(setup.home, ".yoplai", "sessions", "users", "owner", "history", "mcp-apps", run.agent.id, run.params.sessionId);
  expect((await fs.readdir(dir).catch(() => [])).length).toBe(0);
  const healthy = await run.api.request("/tools", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    agentToken: run.input.agentToken, sessionId: run.params.sessionId, tool: "drawing.draw", toolCallId: "healthy", args: {},
  }) });
  expect(healthy.status).toBe(200);
  run.process.event({ type: "tool_result", id: "timed-out", name: "drawing_draw", content: "Tool timed out", isError: true, view: forged, timestamp: 1 });
  run.process.event({ type: "tool_result", id: "healthy", name: "drawing_draw", content: "Created circle", isError: false, timestamp: 2 });
  run.process.finish({ text: "Recovered" });
  await expect(run.completion).resolves.toMatchObject({ text: "Recovered" });
  const results = run.events.filter(event => event.type === "tool_result");
  expect(results[0]?.view).toBeUndefined();
  expect(results[1]?.view).toMatchObject({ server: "drawing", recordId: expect.any(String) });
  expect((await fs.readdir(dir)).length).toBe(1);
});
