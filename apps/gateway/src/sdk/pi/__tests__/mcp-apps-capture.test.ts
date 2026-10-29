import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { z } from "zod";
import { AgentConfigSchema, GatewayConfigSchema, type ExtensionAgentTool, type HistoryEvent, type StreamEvent } from "@yoplai/shared";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ExtensionRuntime } from "../../../extensions/runtime.js";
import { setLoadedConfig } from "../../../config/index.js";
import { bufferHistoryEvent, createTurnBuffer, getFullHistory } from "../../../history/store.js";
import { SessionRunLifecycle } from "../../../agents/run-lifecycle.js";
import { agentEventBus, type AgentHistoryEvent } from "../../../agents/events.js";
import { piAdapter } from "../adapter.js";

// ALG-544's real Pi/external provider seam was approved by Thinh in comment
// 04ea3081-4db9-4872-8433-2200b96ef01a. This observes declarations, execution,
// events, model text and persisted replay; it does not prove browser isolation.
const setup = await vi.hoisted(async () => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const home = await fs.mkdtemp(path.join(process.cwd(), ".mcp-pi-capture-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const { fauxProvider } = await import("@earendil-works/pi-ai/providers/faux");
  return { home, previousHome, faux: fauxProvider({ provider: "apps-capture" }) };
});

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const sdk = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...sdk,
    ModelRuntime: {
      create: async (options: Parameters<typeof sdk.ModelRuntime.create>[0]) => {
        const runtime = await sdk.ModelRuntime.create({ ...options, modelsPath: null, refreshOnCreate: false });
        runtime.registerNativeProvider({
          ...setup.faux.provider,
          auth: { apiKey: { name: "Fixture", resolve: async () => ({ auth: { apiKey: "fixture-key" } }) } },
        });
        return runtime;
      },
    },
  };
});

afterAll(async () => {
  if (setup.previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = setup.previousHome;
  await fs.rm(setup.home, { recursive: true, force: true });
});

const raw = { content: [{ type: "text", text: "Created drawing 7" }], _meta: { access_token: "fixture-raw-private" } };
const modelText = '{"content":[{"type":"text","text":"Created drawing 7"}],"_meta":{"access_token":"fixture-raw-private"}}';

async function fixture(execute: ExtensionAgentTool["execute"] = async () => raw) {
  const workspace = path.join(setup.home, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  for (const name of ["AGENTS.md", "SOUL.md", "USER.md"]) await fs.writeFile(path.join(workspace, name), "MCP Apps fixture.");
  const agent = AgentConfigSchema.parse({
    id: "apps-pi", name: "Apps Pi", workspace, sdk: "pi", toolDeferral: { enabled: false }, retryMaxAttempts: 1,
    model: { provider: "apps-capture", model: setup.faux.getModel().id },
  });
  setLoadedConfig(GatewayConfigSchema.parse({ agents: [agent], extensions: {} }));
  const runtime = new ExtensionRuntime();
  runtime.load([{
    id: "mcp", displayName: "MCP", description: "Fixture", dependencies: [], routePrefixes: [], configSchema: z.object({}),
    validateConfig: () => ({ valid: true, errors: [] }), registerRoutes: () => {}, start: async () => {}, stop: async () => {}, capabilities: () => [],
    getAgentTools: () => [{ name: "drawing.draw", description: "Draw", parameters: { type: "object", properties: { title: { type: "string" } } },
      mcp: { server: "drawing", tool: "draw", ui: { resourceUri: "ui://drawing/view", visibility: ["model", "app"] } }, execute }],
  }]);
  const events: StreamEvent[] = [];
  const history: HistoryEvent[] = [];
  const buffer = createTurnBuffer();
  return { events, history, buffer, params: {
    agentId: agent.id, agent, sessionId: "replay", userId: "alice", sessionOwnerId: "owner", message: "Draw a square", workspaceDir: workspace,
    extensionRuntime: runtime, onEvent: (event: StreamEvent) => { events.push(event); },
    onHistoryEvent: (event: HistoryEvent) => { history.push(event); bufferHistoryEvent(buffer, event); },
    abortSignal: new AbortController().signal,
  } };
}

it("carries one private replay reference through a real Pi call, stream and canonical history without changing model text", async () => {
  const run = await fixture();
  const lifecycle = new SessionRunLifecycle({ agentId: run.params.agentId, sessionId: run.params.sessionId, userId: "owner" });
  const traced: AgentHistoryEvent[] = [];
  const unsubscribe = agentEventBus.onHistoryEvent(event => {
    if (event.agentId === run.params.agentId && event.sessionId === run.params.sessionId) traced.push(event);
  });
  let receivedModelText: unknown;
  setup.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("drawing_draw", { title: "Square" }, { id: "draw-7" }), { stopReason: "toolUse" }),
    context => {
      const result = context.messages.filter(message => message.role === "toolResult").at(-1);
      receivedModelText = result && "content" in result ? result.content : undefined;
      return fauxAssistantMessage("Finished drawing");
    },
  ]);
  try {
    await expect(piAdapter.run({
      ...run.params,
      onHistoryEvent: event => { run.params.onHistoryEvent(event); lifecycle.acceptHistoryEvent(event); },
    })).resolves.toMatchObject({ text: "Finished drawing" });
    await lifecycle.flushTurns();
  } finally { unsubscribe(); }
  expect(receivedModelText).toEqual([{ type: "text", text: modelText }]);
  expect(run.events).toContainEqual(expect.objectContaining({ type: "tool_call", id: "draw-7", name: "drawing_draw", view: { server: "drawing", tool: "draw", resourceUri: "ui://drawing/view" } }));
  const result = run.events.find(event => event.type === "tool_result" && event.id === "draw-7");
  expect(result).toMatchObject({ view: { recordId: expect.stringMatching(/^[a-f0-9]{32,}$/), server: "drawing", tool: "draw", resourceUri: "ui://drawing/view" } });
  if (result?.type !== "tool_result") throw new Error("Expected drawing result");
  expect(run.history).toContainEqual(expect.objectContaining({ type: "tool_result", id: "draw-7", view: result.view }));
  expect(traced.filter(event => event.type === "tool_result")).toEqual([{
    type: "tool_result", id: "draw-7", name: "drawing_draw", agentId: "apps-pi", sessionId: "replay",
    // Existing model text is unchanged; capture adds only the replay reference.
    content: modelText,
    isError: false, view: result.view, timestamp: expect.any(Number),
  }]);
  const history = await getFullHistory(run.params.agentId, run.params.sessionId, "owner");
  expect(history).toContainEqual(expect.objectContaining({ role: "toolResult", toolCallId: "draw-7", view: result.view }));
  const file = path.join(setup.home, ".yoplai", "sessions", "users", "owner", "history", "mcp-apps", "apps-pi", "replay", `${result.view?.recordId}.json`);
  expect(JSON.parse(await fs.readFile(file, "utf8"))).toMatchObject({ args: { title: "Square" }, result: { content: [{ type: "text", text: "Created drawing 7" }], _meta: { access_token: "fixture-raw-private" } } });
});

it("does not attach a completed run's reference to a later failed call with the same identity", async () => {
  for (const fail of [false, true]) {
    const run = await fixture(async () => {
      if (fail) throw new Error("Drawing unavailable");
      return raw;
    });
    setup.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("drawing_draw", { title: "Retry" }, { id: "reused-id" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Still usable"),
    ]);
    await expect(piAdapter.run(run.params)).resolves.toMatchObject({ text: "Still usable" });
    const result = run.events.find(event => event.type === "tool_result" && event.id === "reused-id");
    if (result?.type !== "tool_result") throw new Error("Expected drawing result");
    if (fail) {
      expect(result.content).toBe("Drawing unavailable");
      expect(result.view).toBeUndefined();
    } else {
      expect(result.view).toMatchObject({ recordId: expect.any(String), server: "drawing" });
    }
  }
});
