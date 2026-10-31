import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getCurrentTools,
  getCurrentSystemPrompt,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  AgentConfigSchema,
  ContainerInputSchema,
  GatewayConfigSchema,
  ToolNamespaceSchema,
} from "@yoplai/shared";
import { afterAll, expect, it, vi } from "vitest";
import { ContainerInputBuilder } from "../../../apps/gateway/src/sdk/container/input-builder.js";
import { ExtensionRuntime } from "../../../apps/gateway/src/extensions/runtime.js";
import { runAgent, abortActiveAgent } from "../src/runner.js";

// Combined ContainerInputBuilder -> JSON/schema -> runAgent seam approved in
// ALG-493 comment a70f1a86-1365-4939-b563-0fea11128f5e. Real extension/runtime/SDK
// catch transport loss and execution; the loopback bridge misses Docker setup.
const isolated = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const previousHome = process.env.HOME;
  const home = fs.mkdtempSync(path.join(process.cwd(), ".runner-input-"));
  process.env.HOME = home;
  return { home, previousHome };
});

afterAll(async () => {
  abortActiveAgent();
  vi.restoreAllMocks();
  if (isolated.previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = isolated.previousHome;
  await fs.rm(isolated.home, { recursive: true, force: true });
});

it("runs real builder output with canonical overrides and a described deferred namespace intact", async () => {
  const workspaceDir = path.join(isolated.home, "workspace");
  await fs.mkdir(workspaceDir);
  const runtime = new ExtensionRuntime();
  runtime.load([
    {
      id: "mcp",
      displayName: "MCP",
      description: "Connected services",
      dependencies: [],
      configSchema: ToolNamespaceSchema.pick({}),
      routePrefixes: [],
      validateConfig: () => ({ valid: true, errors: [] }),
      registerRoutes: () => undefined,
      start: async () => undefined,
      stop: async () => undefined,
      capabilities: () => [],
      getAgentTools: async () =>
        ["find_recording", "status"].map((name) => ({
          name: `mcp__meetings__${name}`,
          description:
            name === "find_recording"
              ? "Find a meeting recording"
              : "Get archive status",
          namespace: {
            name: "meetings",
            displayName: "Meeting archive",
            description: "Search meeting recordings and transcripts",
          },
          parameters: { type: "object", properties: {} },
          execute: async () => ({ recording: "synthetic-493" }),
        })),
    },
  ]);
  const faux = fauxProvider();
  const createRuntime = ModelRuntime.create.bind(ModelRuntime);
  vi.spyOn(ModelRuntime, "create").mockImplementation(async (options) => {
    const modelRuntime = await createRuntime({
      ...options,
      modelsPath: null,
      refreshOnCreate: false,
    });
    modelRuntime.registerNativeProvider(faux.provider);
    return modelRuntime;
  });
  const agent = AgentConfigSchema.parse({
    id: "combined",
    name: "Combined",
    workspace: workspaceDir,
    model: { provider: "faux", model: "faux-1" },
    retryMaxAttempts: 1,
    toolDeferral: { alwaysOnTools: ["mcp__meetings__status"] },
  });
  const config = GatewayConfigSchema.parse({ agents: [agent], extensions: {} });
  const params = {
    agentId: agent.id,
    sessionId: "combined-session",
    message: "Find the recording",
    agent,
    workspaceDir,
    extensionRuntime: runtime,
    onEvent: () => undefined,
    abortSignal: new AbortController().signal,
  };
  const built = ContainerInputSchema.parse(
    JSON.parse(
      JSON.stringify(
        await new ContainerInputBuilder().build(params, config, "test-token")
      )
    )
  );
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const call = JSON.parse(body) as { tool: string; args: unknown };
    const result = await runtime.executeTool(
      agent,
      call.tool,
      call.args,
      config,
      built.sessionId
    );
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(result.result));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No bridge port");
  faux.setResponses([
    (context) => {
      expect(
        getCurrentTools(context.messages).map((tool) => tool.name)
      ).toContain("mcp__meetings__status");
      expect(
        getCurrentTools(context.messages).map((tool) => tool.name)
      ).not.toContain("mcp__meetings__find_recording");
      expect(getCurrentSystemPrompt(context.messages)).toContain(
        "Meeting archive: Search meeting recordings and transcripts"
      );
      return fauxAssistantMessage(
        fauxToolCall("tool_search", {
          query: "Find a meeting recording",
          limit: 1,
        }),
        { stopReason: "toolUse" }
      );
    },
    fauxAssistantMessage(fauxToolCall("mcp__meetings__find_recording", {}), {
      stopReason: "toolUse",
    }),
    (context) => {
      expect(JSON.stringify(context.messages)).toContain("synthetic-493");
      return fauxAssistantMessage("Recording found");
    },
  ]);
  try {
    await expect(
      runAgent({
        ...built,
        workspaceDir,
        sessionDir: path.join(isolated.home, "sessions"),
        ipcDir: path.join(isolated.home, "ipc"),
        gatewayUrl: `http://127.0.0.1:${address.port}`,
      })
    ).resolves.toMatchObject({ text: "Recording found" });
  } finally {
    abortActiveAgent();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});
