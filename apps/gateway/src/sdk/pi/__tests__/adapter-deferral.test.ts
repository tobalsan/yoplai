import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  AgentConfigSchema,
  GatewayConfigSchema,
  type HistoryEvent,
  type StreamEvent,
} from "@yoplai/shared";
import { createToolDeferralFixture } from "@yoplai/shared/testing/tool-deferral-fixture";
import { getCurrentTools, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { ExtensionRuntime } from "../../../extensions/runtime.js";
import { setLoadedConfig } from "../../../config/index.js";
import { piAdapter } from "../adapter.js";

// Public runtime seam approved in ALG-493 comment a70f1a86-1365-4939-b563-0fea11128f5e.
// Real SDK/faux observes declarations and execution; vendor encoding and UI are separate seams.
const setup = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const previousHome = process.env.HOME;
  const home = fs.mkdtempSync(path.join(process.cwd(), ".pi-deferral-test-"));
  process.env.HOME = home;
  const { fauxProvider } = await import("@earendil-works/pi-ai/providers/faux");
  return {
    home,
    previousHome,
    faux: fauxProvider({ provider: "deferral-test" }),
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
              name: "Test",
              resolve: async () => ({ auth: { apiKey: "test-key" } }),
            },
          },
        });
        return runtime;
      },
    },
  };
});
const workspace = path.join(setup.home, "workspace");
let sessionNumber = 0;
beforeEach(async () => {
  await fs.mkdir(workspace, { recursive: true });
  for (const name of ["AGENTS.md", "SOUL.md", "USER.md"])
    await fs.writeFile(
      path.join(workspace, name),
      "Synthetic project context. ".repeat(300)
    );
});
afterAll(async () => {
  if (setup.previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = setup.previousHome;
  await fs.rm(setup.home, { recursive: true, force: true });
});
function fixture(
  toolDeferral?: {
    enabled?: boolean;
    alwaysOnTools?: string[];
    alwaysOnExtensions?: string[];
  },
  codemode = false
) {
  const catalog = createToolDeferralFixture();
  const agent = AgentConfigSchema.parse({
    id: "deferral",
    name: "Deferral",
    workspace,
    sdk: "pi",
    toolDeferral,
    codemode,
    model: { provider: "deferral-test", model: setup.faux.getModel().id },
    retryMaxAttempts: 1,
  });
  const config = GatewayConfigSchema.parse({ agents: [agent], extensions: {} });
  setLoadedConfig(config);
  const runtime = new ExtensionRuntime();
  runtime.load(
    [...new Set(catalog.tools.map((t) => t.extensionId))].map((id) => ({
      id,
      displayName: id,
      description: `${id} fixture capabilities`,
      dependencies: [],
      configSchema: z.object({}),
      routePrefixes: [],
      validateConfig: () => ({ valid: true, errors: [] }),
      registerRoutes: () => undefined,
      start: async () => undefined,
      stop: async () => undefined,
      capabilities: () => [],
      getAgentTools: async () =>
        catalog.tools.filter((t) => t.extensionId === id),
      getSystemPromptContributions: async () => [catalog.guidance],
    }))
  );
  const events: StreamEvent[] = [];
  const history: HistoryEvent[] = [];
  return {
    catalog,
    runtime,
    events,
    history,
    params: {
      agentId: agent.id,
      agent,
      sessionId: `deferral-${++sessionNumber}`,
      message: "Find the requested information",
      workspaceDir: workspace,
      extensionRuntime: runtime,
      onEvent: (event: StreamEvent) => {
        events.push(event);
      },
      onHistoryEvent: (event: HistoryEvent) => {
        history.push(event);
      },
      abortSignal: new AbortController().signal,
    },
  };
}
describe("Pi gateway deferred tools", () => {
  it("uses capability fallbacks for blank namespace descriptions and labels", async () => {
    const run = fixture();
    const original = run.catalog.tools.find(
      (tool) => tool.extensionId === "mcp"
    )!;
    run.catalog.tools.splice(0, run.catalog.tools.length, {
      ...original,
      name: "mcp__blank__query",
      namespace: {
        name: "blank",
        displayName: "Unused label",
        description: "  \n ",
      },
    });
    let summary = "";
    const capture = (context: TranscriptContext) => {
      summary = getCurrentSystemPrompt(context.messages);
      return fauxAssistantMessage("Checked");
    };
    setup.faux.setResponses([capture]);
    await piAdapter.run(run.params);
    expect(summary).toContain("blank: 1 tools, e.g. query");
    expect(summary).not.toContain("Unused label:");
    run.catalog.tools[0].namespace = {
      name: "blank",
      displayName: "  ",
      description: "  Search archived records  ",
    };
    setup.faux.setResponses([capture]);
    await piAdapter.run({ ...run.params, message: "Updated description" });
    expect(summary).toContain("blank: Search archived records");
  });
  it.each([
    { enabled: true, codemode: true },
    { enabled: false, codemode: true },
    { enabled: true, codemode: false },
    { enabled: false, codemode: false },
  ])(
    "keeps tools callable with deferral=$enabled and codemode=$codemode",
    async ({ enabled, codemode }) => {
      const run = fixture({ enabled }, codemode);
      const contexts: TranscriptContext[] = [];
      const execute = fauxAssistantMessage(
        fauxToolCall("mcp__claap__recording_042", {}, { id: "direct-042" }),
        { stopReason: "toolUse" }
      );
      const script = fauxAssistantMessage(
        fauxToolCall(
          "codemode",
          {
            code: 'text((await searchTools("mcp__claap__recording_042")).map(tool=>tool.name)); text(JSON.parse(await tools.mcp__claap__recording_042({})).value);',
          },
          { id: "script-042" }
        ),
        { stopReason: "toolUse" }
      );
      const first = codemode
        ? script
        : enabled
          ? fauxAssistantMessage(
              fauxToolCall("tool_search", {
                query: "mcp__claap__recording_042",
                limit: 1,
              }),
              { stopReason: "toolUse" }
            )
          : execute;
      setup.faux.setResponses([
        (context) => {
          contexts.push(structuredClone(context));
          return first;
        },
        ...(!codemode && enabled ? [execute] : []),
        (context) => {
          contexts.push(structuredClone(context));
          return fauxAssistantMessage("Executed");
        },
      ]);
      await expect(piAdapter.run(run.params)).resolves.toMatchObject({
        text: "Executed",
      });
      const names = getCurrentTools(contexts[0].messages).map((t) => t.name);
      expect(names.includes("codemode")).toBe(codemode);
      expect(names.includes("tool_search")).toBe(enabled);
      expect(names.includes("mcp__claap__recording_042")).toBe(!enabled);
      expect(run.history).toContainEqual(
        expect.objectContaining({
          type: "tool_result",
          name: "mcp__claap__recording_042",
          isError: false,
          content: expect.stringContaining(
            "fixture-result:mcp__claap__recording_042"
          ),
        })
      );
      if (codemode) {
        expect(
          getCurrentTools(contexts[1].messages)
            .map((t) => t.name)
            .includes("mcp__claap__recording_042")
        ).toBe(!enabled);
        expect(contexts[1].messages).toContainEqual(
          expect.objectContaining({
            role: "toolResult",
            toolName: "codemode",
            isError: false,
            content: expect.arrayContaining([
              expect.objectContaining({
                text: expect.stringContaining("mcp__claap__recording_042"),
              }),
            ]),
          })
        );
        expect(run.events).toContainEqual(
          expect.objectContaining({
            type: "tool_call",
            name: "mcp__claap__recording_042",
            parentToolCallId: "script-042",
          })
        );
      }
    }
  );
  it("uses the actual owning extension for project tool overrides", async () => {
    const run = fixture({ alwaysOnExtensions: ["gateway"] });
    let names: string[] = [];
    setup.faux.setResponses([
      (context) => {
        names = getCurrentTools(context.messages).map((t) => t.name);
        return fauxAssistantMessage("Project ready");
      },
    ]);
    await piAdapter.run({
      ...run.params,
      context: {
        kind: "web",
        project: {
          id: "synthetic-project",
          instructions: "Fixed synthetic project",
        },
      },
    });
    expect(names).toContain("project_references_add");
    expect(names).toContain("project_notes_append");
    expect(names).not.toContain("integration0_lookup_000");
  });
  it("keeps a bounded capability summary deterministic across reordered catalogs and replaces removed namespaces", async () => {
    const run = fixture();
    const described = run.catalog.tools.find(
      (t) => t.name === "mcp__claap__recording_001"
    )!;
    described.namespace = {
      name: "claap",
      displayName: "Meeting archive",
      description: "Find recordings and transcripts for customer meetings",
    };
    const misplaced = run.catalog.tools.find(
      (t) => t.name === "integration0.lookup_000"
    )!;
    misplaced.namespace = {
      name: "wrong_namespace",
      displayName: "Wrong group",
      description: "Business record lookup",
    };
    const contexts: TranscriptContext[] = [];
    const capture = (context: TranscriptContext) => {
      contexts.push(structuredClone(context));
      return fauxAssistantMessage("Summary checked");
    };
    setup.faux.setResponses([capture]);
    await piAdapter.run(run.params);
    const first = getCurrentSystemPrompt(contexts[0].messages);
    expect(first).toContain(
      "Meeting archive: Find recordings and transcripts for customer meetings"
    );
    expect(first).not.toContain("wrong_namespace");
    const registered: ReturnType<AgentSession["getAllTools"]> = [];
    run.catalog.tools.reverse();
    setup.faux.setResponses([capture]);
    await piAdapter.run({
      ...run.params,
      message: "Same catalog",
      onSessionHandle: (handle) =>
        registered.push(...(handle as AgentSession).getAllTools()),
    });
    expect(getCurrentSystemPrompt(contexts[1].messages)).toBe(first);
    expect(
      contexts[1].messages.filter(
        (m) =>
          m.role === "system" && m.sections?.["deferred-tools"] !== undefined
      )
    ).toHaveLength(1);
    expect(registered).toContainEqual(
      expect.objectContaining({
        name: "integration0_lookup_000",
        namespace: expect.objectContaining({ name: "integration0" }),
      })
    );
    for (const tool of [...run.catalog.tools])
      if (tool.extensionId === "mcp")
        run.catalog.tools.splice(run.catalog.tools.indexOf(tool), 1);
    setup.faux.setResponses([capture]);
    await piAdapter.run({ ...run.params, message: "Removed archive" });
    expect(getCurrentSystemPrompt(contexts[2].messages)).not.toContain(
      "Meeting archive:"
    );
    expect(
      contexts[2].messages.filter(
        (m) =>
          m.role === "system" && m.sections?.["deferred-tools"] !== undefined
      )
    ).toHaveLength(2);
    const sections = contexts[2].messages.flatMap((m) =>
      m.role === "system" && m.sections?.["deferred-tools"]
        ? [m.sections["deferred-tools"]]
        : []
    );
    for (const section of sections)
      for (const line of section.split("\n"))
        expect(line.length).toBeLessThanOrEqual(200);
  });
  it("restores activation from each fork point and drops removed tools while newly available stubs stay deferred", async () => {
    const run = fixture();
    const sessionDir = path.join(setup.home, ".yoplai", "sessions");
    setup.faux.setResponses([fauxAssistantMessage("Before load")]);
    await piAdapter.run(run.params);
    const filename = (await fs.readdir(sessionDir)).find((name) =>
      name.endsWith("_deferral-" + run.params.sessionId + ".jsonl")
    );
    if (!filename) throw new Error("Persisted gateway session missing");
    const file = path.join(sessionDir, filename);
    const before = SessionManager.open(file, sessionDir).getLeafId();
    if (!before) throw new Error("Pre-load branch leaf missing");
    setup.faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("tool_search", {
          query: "mcp__claap__recording_042",
          limit: 1,
        }),
        { stopReason: "toolUse" }
      ),
      fauxAssistantMessage("Loaded"),
    ]);
    await piAdapter.run({
      ...run.params,
      message: "Load the recording reader",
    });
    const after = SessionManager.open(file, sessionDir).getLeafId();
    if (!after) throw new Error("Post-load branch leaf missing");
    for (const [label, leaf, loaded] of [
      ["before", before, false],
      ["after", after, true],
    ] as const) {
      const fork = SessionManager.open(file, sessionDir).createBranchedSession(
        leaf
      );
      if (!fork) throw new Error("Fork not persisted");
      const sessionId = run.params.sessionId + "-fork-" + label;
      await fs.copyFile(
        fork,
        path.join(sessionDir, "deferral-" + sessionId + ".jsonl")
      );
      let names: string[] = [];
      setup.faux.setResponses([
        (context) => {
          names = getCurrentTools(context.messages).map((t) => t.name);
          return fauxAssistantMessage("Fork resumed");
        },
      ]);
      await piAdapter.run({
        ...run.params,
        sessionId,
        message: "Resume branch",
      });
      expect(names.includes("mcp__claap__recording_042")).toBe(loaded);
    }
    run.catalog.tools.splice(
      run.catalog.tools.findIndex(
        (t) => t.name === "mcp__claap__recording_042"
      ),
      1
    );
    run.catalog.tools.push({
      ...run.catalog.tools.find((t) => t.extensionId === "mcp")!,
      name: "mcp__newserver__not_connected",
      description: "Connect the disconnected archive",
      execute: async () => ({ value: "connect archive" }),
    });
    const contexts: TranscriptContext[] = [];
    setup.faux.setResponses([
      (context) => {
        contexts.push(structuredClone(context));
        return fauxAssistantMessage(
          fauxToolCall(
            "tool_search",
            { query: "zzzznomatchzzzz" },
            { id: "no-match" }
          ),
          { stopReason: "toolUse" }
        );
      },
      (context) => {
        contexts.push(structuredClone(context));
        return fauxAssistantMessage(
          fauxToolCall(
            "tool_search",
            { query: "mcp__newserver__not_connected", limit: 1 },
            { id: "find-stub" }
          ),
          { stopReason: "toolUse" }
        );
      },
      (context) => {
        contexts.push(structuredClone(context));
        return fauxAssistantMessage(
          fauxToolCall("mcp__newserver__not_connected", {}),
          { stopReason: "toolUse" }
        );
      },
      (context) => {
        contexts.push(structuredClone(context));
        return fauxAssistantMessage("Connection needed");
      },
    ]);
    await piAdapter.run({ ...run.params, message: "Use the updated catalog" });
    const names = getCurrentTools(contexts[0].messages).map((t) => t.name);
    expect(names).not.toContain("mcp__claap__recording_042");
    expect(names).not.toContain("mcp__newserver__not_connected");
    expect(contexts[1].messages).toContainEqual(
      expect.objectContaining({
        role: "toolResult",
        toolCallId: "no-match",
        details: { loaded: [] },
        isError: false,
      })
    );
    expect(contexts[2].messages).toContainEqual(
      expect.objectContaining({
        role: "toolResult",
        toolCallId: "find-stub",
        details: { loaded: ["mcp__newserver__not_connected"] },
      })
    );
    expect(run.history).toContainEqual(
      expect.objectContaining({
        type: "tool_result",
        name: "mcp__newserver__not_connected",
        isError: false,
        content: expect.stringContaining("connect archive"),
      })
    );
  });
  it("searches an unloaded fixture, executes it and retains the load on a second host invocation", async () => {
    const run = fixture();
    const contexts: TranscriptContext[] = [];
    const capture = (context: TranscriptContext) => {
      contexts.push(structuredClone(context));
      return fauxAssistantMessage("Done");
    };
    setup.faux.setResponses([
      (context) => {
        contexts.push(structuredClone(context));
        return fauxAssistantMessage(
          fauxToolCall(
            "tool_search",
            { query: "mcp__claap__recording_042", limit: 1 },
            { id: "search-042" }
          ),
          { stopReason: "toolUse" }
        );
      },
      (context) => {
        contexts.push(structuredClone(context));
        return fauxAssistantMessage(
          fauxToolCall("mcp__claap__recording_042", {}, { id: "execute-042" }),
          { stopReason: "toolUse" }
        );
      },
      capture,
    ]);
    await expect(piAdapter.run(run.params)).resolves.toMatchObject({
      text: "Done",
    });
    expect(
      getCurrentTools(contexts[0].messages).map((t) => t.name)
    ).not.toContain("mcp__claap__recording_042");
    expect(contexts[1].messages).toContainEqual(
      expect.objectContaining({
        role: "toolResult",
        toolName: "tool_search",
        details: { loaded: ["mcp__claap__recording_042"] },
      })
    );
    for (const context of contexts.slice(1))
      expect(getCurrentTools(context.messages).map((t) => t.name)).toContain(
        "mcp__claap__recording_042"
      );
    expect(run.history).toContainEqual(
      expect.objectContaining({
        type: "tool_result",
        name: "mcp__claap__recording_042",
        isError: false,
        content: expect.stringContaining(
          "fixture-result:mcp__claap__recording_042"
        ),
      })
    );
    // The tracer keeps the latest prompt event: it must match the last request.
    expect(
      run.history.filter((event) => event.type === "system_prompt").at(-1)
    ).toMatchObject({ text: getCurrentSystemPrompt(contexts[2].messages) });
    setup.faux.setResponses([capture]);
    await piAdapter.run({ ...run.params, message: "Check again" });
    expect(getCurrentTools(contexts[3].messages).map((t) => t.name)).toContain(
      "mcp__claap__recording_042"
    );
    expect(
      contexts[3].messages.filter(
        (m) =>
          m.role === "system" && m.sections?.["deferred-tools"] !== undefined
      )
    ).toHaveLength(1);
  });
  it("hints tool_search for an unloaded deferred tool and records the final prompt with codemode rules", async () => {
    const run = fixture(undefined, true);
    const contexts: TranscriptContext[] = [];
    setup.faux.setResponses([
      (context) => {
        contexts.push(structuredClone(context));
        return fauxAssistantMessage(
          fauxToolCall("mcp__claap__recording_042", {}, { id: "unloaded-042" }),
          { stopReason: "toolUse" }
        );
      },
      (context) => {
        contexts.push(structuredClone(context));
        return fauxAssistantMessage("Done");
      },
    ]);
    await expect(piAdapter.run(run.params)).resolves.toMatchObject({
      text: "Done",
    });
    expect(contexts[1].messages).toContainEqual(
      expect.objectContaining({
        role: "toolResult",
        toolName: "mcp__claap__recording_042",
        isError: true,
        content: [
          {
            type: "text",
            text: "Tool mcp__claap__recording_042 is not loaded. Call tool_search to load it, then call it again.",
          },
        ],
      })
    );
    const prompts = run.history.filter((event) => event.type === "system_prompt");
    // The tracer keeps the latest prompt: it must be the one the model got.
    const finalPrompt = prompts.at(-1);
    expect(finalPrompt).toMatchObject({
      text: getCurrentSystemPrompt(contexts[0].messages),
    });
    expect(finalPrompt).toMatchObject({
      text: expect.stringContaining("Do not use JSON.parse"),
    });
    expect((finalPrompt as { text: string }).text).not.toContain("describeTool");
    expect(finalPrompt).toMatchObject({
      text: expect.stringContaining("<deferred-tools>"),
    });
  });
  it("cuts frozen first-request schema bytes by at least 80 percent and honors canonical overrides", async () => {
    const measure = async (toolDeferral: {
      enabled?: boolean;
      alwaysOnTools?: string[];
      alwaysOnExtensions?: string[];
    }) => {
      const run = fixture(toolDeferral);
      let schemas = 0;
      let prompt = 0;
      let names: string[] = [];
      setup.faux.setResponses([
        (context) => {
          const declared = getCurrentTools(context.messages);
          names = declared.map((t) => t.name);
          schemas = Buffer.byteLength(JSON.stringify(declared), "utf8");
          prompt = Buffer.byteLength(JSON.stringify(context), "utf8");
          return fauxAssistantMessage("Measured");
        },
      ]);
      await piAdapter.run(run.params);
      return { schemas, prompt, names };
    };
    const before = await measure({ enabled: false });
    const after = await measure({});
    expect(before.names).toHaveLength(256);
    expect(before.names).not.toContain("tool_search");
    expect(after.names).toHaveLength(18);
    expect(after.schemas / before.schemas).toBeLessThanOrEqual(0.2);
    console.info(
      "ALG-493 gateway UTF-8 bytes",
      JSON.stringify({
        before: { declaredSchemas: before.schemas, fullPrompt: before.prompt },
        after: { declaredSchemas: after.schemas, fullPrompt: after.prompt },
      })
    );
    const overrides = await measure({
      alwaysOnTools: ["integration0.lookup_000", "absent.tool"],
      alwaysOnExtensions: ["integration1", "absentExtension"],
    });
    expect(overrides.names).toContain("integration0_lookup_000");
    expect(
      overrides.names.filter((n) => n.startsWith("integration1_"))
    ).toHaveLength(30);
    expect(overrides.names).not.toContain("integration0_lookup_001");
    expect(overrides.names).not.toContain("absent_tool");
    expect(overrides.names).toContain("task_adopt");
    expect(overrides.names).toContain("scheduler_list_jobs");
  });
  it("declares only core tools on the actual first request while retaining the permitted catalog", async () => {
    const run = fixture();
    let declared: string[] = [];
    let outgoing = "";
    let registered: ReturnType<AgentSession["getAllTools"]> = [];
    setup.faux.setResponses([
      (context) => {
        declared = getCurrentTools(context.messages).map((t) => t.name);
        outgoing = JSON.stringify(context);
        return fauxAssistantMessage("Ready");
      },
    ]);
    await expect(
      piAdapter.run({
        ...run.params,
        onSessionHandle: (handle) => {
          registered = (handle as AgentSession).getAllTools();
        },
      })
    ).resolves.toMatchObject({ text: "Ready" });
    expect(
      registered.filter((t) =>
        /^(mcp__|integration|task_|scheduler_)/.test(t.name)
      )
    ).toHaveLength(250);
    expect(registered).toContainEqual(
      expect.objectContaining({
        name: "mcp__claap__recording_042",
        exposure: "deferred",
      })
    );
    expect(declared.sort()).toEqual(
      [
        "read",
        "bash",
        "edit",
        "write",
        "send_file",
        "tool_search",
        ...["adopt", "get", "checkpoint", "pause", "resume", "complete"].map(
          (n) => `task_${n}`
        ),
        ...[
          "list_jobs",
          "create_job",
          "update_job",
          "delete_job",
          "run_job",
          "get_latest_output",
        ].map((n) => `scheduler_${n}`),
      ].sort()
    );
    expect(outgoing).not.toContain("UNLOADED_SCHEMA_mcp__claap");
    expect(outgoing).not.toContain("UNLOADED_SCHEMA_integration");
  });
});
