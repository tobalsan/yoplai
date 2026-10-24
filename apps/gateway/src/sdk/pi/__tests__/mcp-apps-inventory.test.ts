import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { AgentConfigSchema, GatewayConfigSchema, type ExtensionAgentTool, type HistoryEvent } from "@yoplai/shared";
import { getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { ExtensionRuntime } from "../../../extensions/runtime.js";
import { setLoadedConfig } from "../../../config/index.js";
import { ContainerInputBuilder } from "../../container/input-builder.js";
import { piAdapter } from "../adapter.js";

// Thinh approved the discovery/inventories seam in ALG-544 comment
// 04ea3081-4db9-4872-8433-2200b96ef01a. Real SDK/faux observes declarations,
// search and codemode; the extension fixture models slice 1a's filtered catalog.
const setup = await vi.hoisted(async () => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const home = await fs.mkdtemp(path.join(process.cwd(), ".mcp-inventory-test-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const { fauxProvider } = await import("@earendil-works/pi-ai/providers/faux");
  return { home, previousHome, faux: fauxProvider({ provider: "mcp-inventory-test" }) };
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
          auth: { apiKey: { name: "Test", resolve: async () => ({ auth: { apiKey: "test-key" } }) } },
        });
        return runtime;
      },
    },
  };
});

const workspace = path.join(setup.home, "workspace");
beforeEach(async () => {
  await fs.mkdir(workspace, { recursive: true });
  for (const name of ["AGENTS.md", "SOUL.md", "USER.md"]) await fs.writeFile(path.join(workspace, name), "Synthetic MCP inventory fixture.");
});
afterAll(async () => {
  if (setup.previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = setup.previousHome;
  await fs.rm(setup.home, { recursive: true, force: true });
});

it.each([
  { deferred: false, codemode: false },
  { deferred: true, codemode: false },
  { deferred: false, codemode: true },
  { deferred: true, codemode: true },
])("keeps app-only tools out of host and container model inventories with deferral=$deferred and codemode=$codemode", async ({ deferred, codemode }) => {
  const agent = AgentConfigSchema.parse({
    id: "apps-inventory", name: "Apps inventory", workspace, sdk: "pi", codemode,
    toolDeferral: { enabled: deferred }, retryMaxAttempts: 1,
    model: { provider: "mcp-inventory-test", model: setup.faux.getModel().id },
  });
  const config = GatewayConfigSchema.parse({ agents: [agent], extensions: {} });
  setLoadedConfig(config);
  // Slice 1a filters edit_in_view before returning getAgentTools.
  const tools = ["draw", "model_report"].map<ExtensionAgentTool>((name) => ({
    name: `mcp__drawing__${name}`, description: `Drawing fixture ${name}`, parameters: { type: "object" },
    namespace: { name: "drawing", description: "Synthetic drawing tools" },
    mcp: { server: "drawing", tool: name, ...(name === "draw" ? { ui: { resourceUri: "ui://drawing/view", visibility: ["model", "app"] } } : {}) },
    execute: async () => ({ content: [{ type: "text", text: "Fixture model result" }] }),
  }));
  const runtime = new ExtensionRuntime();
  runtime.load([{
    id: "mcp", displayName: "MCP", description: "Drawing fixture", dependencies: [], routePrefixes: [], configSchema: z.object({}),
    validateConfig: () => ({ valid: true, errors: [] }), registerRoutes: () => {}, start: async () => {}, stop: async () => {}, capabilities: () => [],
    getAgentTools: () => tools,
  }]);
  const contexts: TranscriptContext[] = [];
  const history: HistoryEvent[] = [];
  let registered: string[] = [];
  const capture = (context: TranscriptContext) => {
    contexts.push(structuredClone(context));
    return fauxAssistantMessage("Inventory inspected");
  };
  const search = codemode
    ? fauxAssistantMessage(fauxToolCall("codemode", { code: 'text((await searchTools("mcp__drawing__")).map(tool => tool.name));' }), { stopReason: "toolUse" })
    : fauxAssistantMessage(fauxToolCall("tool_search", { query: "mcp__drawing__", limit: 10 }), { stopReason: "toolUse" });
  setup.faux.setResponses([
    (context) => {
      contexts.push(structuredClone(context));
      return deferred || codemode ? search : fauxAssistantMessage("Inventory inspected");
    },
    ...(deferred || codemode ? [capture] : []),
  ]);
  const params = {
    agentId: agent.id, agent, sessionId: `inventory-${deferred}-${codemode}`, message: "Inspect the drawing catalog", workspaceDir: workspace,
    extensionRuntime: runtime, onHistoryEvent: (event: HistoryEvent) => { history.push(event); },
    onEvent: () => {},
    onSessionHandle: (handle: unknown) => { registered = (handle as AgentSession).getAllTools().map((tool) => tool.name); },
    abortSignal: new AbortController().signal,
  };
  await expect(piAdapter.run(params)).resolves.toMatchObject({ text: "Inventory inspected" });
  expect(registered.filter((name) => name.startsWith("mcp__drawing__")).sort()).toEqual(["mcp__drawing__draw", "mcp__drawing__model_report"]);
  expect(getCurrentTools(contexts[0].messages).map((tool) => tool.name).includes("mcp__drawing__draw")).toBe(!deferred);
  expect(JSON.stringify(contexts)).not.toContain("edit_in_view");
  if (deferred || codemode) {
    const result = history.find((event) => event.type === "tool_result" && event.name === (codemode ? "codemode" : "tool_search"));
    expect(result).toMatchObject({ isError: false, content: expect.stringContaining("mcp__drawing__draw") });
  }
  const input = await new ContainerInputBuilder().build(params, config, "fixture-token");
  expect(input.extensionTools?.filter((tool) => tool.extensionId === "mcp").map((tool) => tool.name).sort()).toEqual(["mcp__drawing__draw", "mcp__drawing__model_report"]);
  expect(JSON.stringify(input.extensionTools)).not.toContain("edit_in_view");
});
