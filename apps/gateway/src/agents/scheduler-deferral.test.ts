import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getCurrentTools } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  AgentConfigSchema,
  GatewayConfigSchema,
  agentEventBus,
} from "@yoplai/shared";
import {
  SchedulerService,
  clearSchedulerContext,
  setSchedulerContext,
} from "../../../../packages/extensions/scheduler/src/service.js";
import {
  LangfuseTracer,
  type LangfuseTracerConfig,
} from "../../../../packages/extensions/langfuse/src/tracer.js";
import { setLoadedConfig } from "../config/index.js";
import { createExtensionContext } from "../extensions/context.js";
import { ExtensionRuntime } from "../extensions/runtime.js";
import { appendSessionMeta } from "../history/store.js";
import { getFullSessionHistory, runAgent } from "./runner.js";

// Approved seam: ALG-493 comment a70f1a86-1365-4939-b563-0fea11128f5e.
// Scheduler dispatch + real runAgent/Pi/history + public tracer exporter catches
// discovery, execution and persisted/exported observations; misses live providers/UI.
const setup = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const previousHome = process.env.HOME;
  const home = fs.mkdtempSync(path.join(process.cwd(), ".scheduler-deferral-"));
  process.env.HOME = home;
  const { fauxProvider } = await import("@earendil-works/pi-ai/providers/faux");
  return {
    home,
    previousHome,
    faux: fauxProvider({ provider: "scheduler-deferral" }),
  };
});

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const sdk =
    await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...sdk,
    ModelRuntime: {
      create: async (
        options: Parameters<typeof sdk.ModelRuntime.create>[0]
      ) => {
        const runtime = await sdk.ModelRuntime.create({
          ...options,
          modelsPath: null,
          refreshOnCreate: false,
        });
        runtime.registerNativeProvider({
          ...setup.faux.provider,
          auth: {
            apiKey: {
              name: "Offline fixture",
              resolve: async () => ({ auth: { apiKey: "fixture-key" } }),
            },
          },
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

describe("scheduled Pi tool discovery", () => {
  it("searches and executes a deferred integration while preserving history and Langfuse tool observations", async () => {
    const workspace = path.join(setup.home, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    for (const name of ["AGENTS.md", "USER.md"]) {
      await fs.writeFile(
        path.join(workspace, name),
        "Offline scheduled integration fixture."
      );
    }
    const agent = AgentConfigSchema.parse({
      id: "scheduled-deferral",
      name: "Scheduled deferral",
      workspace,
      sdk: "pi",
      model: {
        provider: "scheduler-deferral",
        model: setup.faux.getModel().id,
      },
      retryMaxAttempts: 1,
    });
    const config = GatewayConfigSchema.parse({
      agents: [agent],
      extensions: {},
    });
    setLoadedConfig(config);
    const runtime = new ExtensionRuntime();
    const executed: unknown[] = [];
    runtime.load([
      {
        id: "nebula",
        displayName: "Nebula",
        description: "Search invoice ledgers",
        dependencies: [],
        configSchema: z.object({}),
        routePrefixes: [],
        validateConfig: () => ({ valid: true, errors: [] }),
        registerRoutes: () => undefined,
        start: async () => undefined,
        stop: async () => undefined,
        capabilities: () => [],
        getAgentTools: async () => [
          {
            name: "nebula.lookup",
            description: "Search the Nebula invoice ledger",
            parameters: {
              type: "object",
              properties: { account: { type: "string" } },
              required: ["account"],
            },
            execute: async (args) => {
              executed.push(args);
              return { openInvoices: 3, total: 240 };
            },
          },
        ],
      },
    ]);
    const context = createExtensionContext(config);
    setSchedulerContext({
      ...context,
      runAgent: (params) => runAgent({ ...params, extensionRuntime: runtime }),
    });
    const scheduler = new SchedulerService();
    type Exporter = NonNullable<LangfuseTracerConfig["exporter"]>;
    const spans: Parameters<Exporter["export"]>[0][number][] = [];
    const exporter: Exporter = {
      export(batch, done) {
        spans.push(...batch);
        done({ code: 0 });
      },
      shutdown: async () => undefined,
    };
    const tracer = new LangfuseTracer({
      publicKey: "pk-fixture",
      secretKey: "sk-fixture",
      exporter,
    });
    tracer.start();
    const tracing: Promise<void>[] = [];
    const unsubscribeStream = agentEventBus.onStreamEvent((event) => {
      if (event.agentId === agent.id)
        tracing.push(tracer.handleStreamEvent(event));
    });
    const unsubscribeHistory = agentEventBus.onHistoryEvent((event) => {
      if (event.agentId === agent.id) tracer.handleHistoryEvent(event);
    });
    const sessionId = "scheduled-discovery-493";
    await appendSessionMeta(agent.id, sessionId, "title", "Invoice digest");
    setup.faux.setResponses([
      (request) => {
        expect(
          getCurrentTools(request.messages).map((tool) => tool.name)
        ).not.toContain("nebula_lookup");
        expect(
          getCurrentTools(request.messages).map((tool) => tool.name)
        ).toContain("tool_search");
        return fauxAssistantMessage(
          fauxToolCall(
            "tool_search",
            { query: "Nebula invoice ledger", limit: 1 },
            { id: "discover-493" }
          ),
          { stopReason: "toolUse" }
        );
      },
      (request) => {
        expect(request.messages).toContainEqual(
          expect.objectContaining({
            role: "toolResult",
            toolName: "tool_search",
            details: { loaded: ["nebula_lookup"] },
          })
        );
        expect(
          getCurrentTools(request.messages).map((tool) => tool.name)
        ).toContain("nebula_lookup");
        return fauxAssistantMessage(
          fauxToolCall(
            "nebula_lookup",
            { account: "acme" },
            { id: "lookup-493" }
          ),
          { stopReason: "toolUse" }
        );
      },
      fauxAssistantMessage("3 open invoices; total 240."),
    ]);
    try {
      const job = await scheduler.add(agent.id, {
        name: "Invoice digest",
        schedule: { cron: "0 8 * * *", tz: "UTC" },
        payload: { message: "Check open invoices for acme", sessionId },
      });
      const result = await scheduler.runNow(agent.id, job.id);
      expect(result).toMatchObject({ status: "ok" });
      expect(executed).toEqual([{ account: "acme" }]);
      const history = await getFullSessionHistory(agent.id, sessionId);
      expect(JSON.stringify(history)).toContain("3 open invoices; total 240.");
      expect(history).toContainEqual(
        expect.objectContaining({
          role: "assistant",
          content: expect.arrayContaining([
            expect.objectContaining({
              type: "toolCall",
              id: "discover-493",
              name: "tool_search",
            }),
          ]),
        })
      );
      expect(history).toContainEqual(
        expect.objectContaining({ role: "toolResult", toolName: "tool_search" })
      );
      expect(history).toContainEqual(
        expect.objectContaining({
          role: "toolResult",
          toolName: "nebula_lookup",
        })
      );
      await Promise.all(tracing);
      await tracer.stop();
      expect(
        spans
          .filter(
            (span) => span.attributes["langfuse.observation.type"] === "tool"
          )
          .map((span) => span.name)
          .sort()
      ).toEqual(["nebula_lookup", "tool_search"]);
      expect(
        spans.filter((span) => span.name === "tool_search")
      ).toContainEqual(
        expect.objectContaining({
          attributes: expect.objectContaining({
            "langfuse.observation.output":
              expect.stringContaining("nebula_lookup"),
          }),
        })
      );
      expect(
        spans.some(
          (span) =>
            span.attributes["session.id"] ===
            `yoplai:scheduler:${agent.id}:${sessionId}`
        )
      ).toBe(true);
    } finally {
      unsubscribeStream();
      unsubscribeHistory();
      await scheduler.stop();
      clearSchedulerContext();
      await tracer.stop();
    }
  });
});
