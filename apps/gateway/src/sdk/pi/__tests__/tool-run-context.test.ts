import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { z } from "zod";
import { AgentConfigSchema, GatewayConfigSchema, type ExtensionAgentToolContext, type HistoryEvent, type StreamEvent } from "@yoplai/shared";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ExtensionRuntime } from "../../../extensions/runtime.js";
import { setLoadedConfig } from "../../../config/index.js";
import { piAdapter } from "../adapter.js";

const setup = await vi.hoisted(async () => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const home = await fs.mkdtemp(path.join(process.cwd(), ".tool-run-context-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const { fauxProvider } = await import("@earendil-works/pi-ai/providers/faux");
  return { home, previousHome, faux: fauxProvider({ provider: "run-context" }) };
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

async function runWith(runFields: { source?: string; background?: boolean; requiresDevice?: boolean }) {
  const workspace = path.join(setup.home, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  for (const name of ["AGENTS.md", "SOUL.md", "USER.md"]) await fs.writeFile(path.join(workspace, name), "Fixture.");
  const agent = AgentConfigSchema.parse({
    id: "context-pi", name: "Context Pi", workspace, sdk: "pi", toolDeferral: { enabled: false }, retryMaxAttempts: 1,
    model: { provider: "run-context", model: setup.faux.getModel().id },
  });
  setLoadedConfig(GatewayConfigSchema.parse({ agents: [agent], extensions: {} }));
  let seen: ExtensionAgentToolContext | undefined;
  const runtime = new ExtensionRuntime();
  runtime.load([{
    id: "probe", displayName: "Probe", description: "Fixture", dependencies: [], routePrefixes: [], configSchema: z.object({}),
    validateConfig: () => ({ valid: true, errors: [] }), registerRoutes: () => {}, start: async () => {}, stop: async () => {}, capabilities: () => [],
    getAgentTools: () => [{ name: "probe", description: "Probe", parameters: { type: "object", properties: {} }, execute: (_args, context) => { seen = context; return "ok"; } }],
  }]);
  const events: StreamEvent[] = [];
  setup.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("probe", {}, { id: "probe-call-1" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Done"),
  ]);
  await piAdapter.run({
    agentId: agent.id, agent, sessionId: "ctx", userId: "alice", message: "Probe", workspaceDir: workspace,
    extensionRuntime: runtime, ...runFields,
    onEvent: (event: StreamEvent) => { events.push(event); },
    onHistoryEvent: (_event: HistoryEvent) => {},
    abortSignal: new AbortController().signal,
  });
  return { seen, events };
}

it("gives the tool the run origin and the ID of the tool_call stream event", async () => {
  const scheduled = await runWith({ source: "scheduler" });
  expect(scheduled.seen?.run).toMatchObject({ source: "scheduler" });
  expect(scheduled.events).toContainEqual(expect.objectContaining({ type: "tool_call", id: "probe-call-1" }));
  expect(scheduled.seen?.toolCallId).toBe("probe-call-1");

  const web = await runWith({ source: "web" });
  expect(web.seen?.run).toMatchObject({ source: "web" });
  expect((await runWith({ source: "web", background: true })).seen?.run).toMatchObject({ background: true });
});

it("gives the tool the requiresDevice flag of a background run", async () => {
  expect((await runWith({ source: "scheduler", requiresDevice: true })).seen?.run).toMatchObject({ requiresDevice: true });
  expect((await runWith({ source: "scheduler" })).seen?.run?.requiresDevice).toBeUndefined();
});
