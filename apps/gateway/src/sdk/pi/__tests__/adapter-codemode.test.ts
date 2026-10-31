import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  AgentConfigSchema,
  GatewayConfigSchema,
  type ExtensionAgentTool,
  type HistoryEvent,
  type StreamEvent,
} from "@yoplai/shared";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { ExtensionRuntime } from "../../../extensions/runtime.js";
import { setLoadedConfig } from "../../../config/index.js";
import { piAdapter } from "../adapter.js";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { bufferHistoryEvent, createTurnBuffer, flushTurnBuffer, getFullHistory } from "../../../history/store.js";

// Approved by Thinh in ALG-506 comment 8fcf9742-a30b-45b2-bd18-5fb24d1cecda:
// piAdapter.run/abort/abortSignal with real Pi + faux catches declarations,
// execution, nested events, model-context isolation and recovery; misses UI/history.
const setup = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const previousHome = process.env.HOME;
  const home = fs.mkdtempSync(path.join(process.cwd(), ".pi-codemode-test-"));
  process.env.HOME = home;
  const { fauxProvider } = await import("@earendil-works/pi-ai/providers/faux");
  return {
    home,
    previousHome,
    faux: fauxProvider({ provider: "codemode-test" }),
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
  for (const name of ["AGENTS.md", "USER.md"]) {
    await fs.writeFile(path.join(workspace, name), "Codemode test workspace.");
  }
});

afterAll(async () => {
  if (setup.previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = setup.previousHome;
  await fs.rm(setup.home, { recursive: true, force: true });
});

function fixture(
  codemode: boolean | undefined,
  execute: ExtensionAgentTool["execute"] = async () => ({
    count: 3,
    sentinel: "RAW_CHILD_SENTINEL_506",
  }),
  extensionId = "fixture",
  outputSchema?: Record<string, unknown>,
  parameters: Record<string, unknown> = { type: "object", properties: {} }
) {
  const agent = AgentConfigSchema.parse({
    id: "codemode",
    name: "Codemode",
    workspace,
    sdk: "pi",
    codemode,
    model: { provider: "codemode-test", model: setup.faux.getModel().id },
    retryMaxAttempts: 1,
  });
  const config = GatewayConfigSchema.parse({ agents: [agent], extensions: {} });
  setLoadedConfig(config);
  const runtime = new ExtensionRuntime();
  runtime.load([
    {
      id: extensionId,
      displayName: "Fixture",
      description: "Deterministic fixture",
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
          name: "fixture_count",
          description: "Count deterministic records",
          parameters,
          ...(outputSchema ? { outputSchema } : {}),
          execute,
        },
      ],
    },
  ]);
  const events: StreamEvent[] = [];
  const history: HistoryEvent[] = [];
  const controller = new AbortController();
  return {
    events,
    history,
    controller,
    params: {
      agentId: agent.id,
      agent,
      sessionId: `codemode-${++sessionNumber}`,
      message: "Run the script",
      workspaceDir: workspace,
      extensionRuntime: runtime,
      onEvent: (event: StreamEvent) => {
        events.push(event);
      },
      onHistoryEvent: (event: HistoryEvent) => {
        history.push(event);
      },
      abortSignal: controller.signal,
    },
  };
}

function script(code: string, id = "script-506") {
  return fauxAssistantMessage(fauxToolCall("codemode", { code }, { id }), {
    stopReason: "toolUse",
  });
}

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Codemode did not settle within 3 seconds")),
          3_000
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe("Pi adapter codemode", () => {
  // ALG-566 Testing Decisions approve observing the real Pi model request:
  // this catches prompt delivery with/without deferral, not container limits.
  it.each([
    [true, true],
    [true, false],
    [false, false],
    [undefined, false],
  ])("includes long-job guidance only with codemode %s (deferral %s), without host caps", async (codemode, deferral) => {
    const run = fixture(codemode);
    run.params.agent.toolDeferral = { enabled: deferral };
    run.params.agent.codemodeLimits = { maxToolCalls: 17, maxConcurrentToolCalls: 2 };
    let prompt = "";
    setup.faux.setResponses([(context) => {
      prompt = getCurrentSystemPrompt(context.messages);
      return fauxAssistantMessage("done");
    }]);
    await expect(piAdapter.run(run.params)).resolves.toMatchObject({ text: "done" });
    for (const rule of [
      "Run one small batch first. Measure the latency, then estimate the full job before you run it.",
      "Split a long job into codemode calls that each fit the timeout. Save progress to a file and resume from it.",
      "Stop the loop on a 409, or after 3 failures in a row. Do not hide errors with an empty `.catch()`.",
      "Before a job that takes more than about 1 minute, tell the user the plan, the call count, and the time.",
    ]) {
      expect(prompt.includes(rule)).toBe(codemode === true);
    }
    expect(prompt).not.toContain("17 tool calls");
    expect(prompt).not.toContain("2 concurrent");
    expect(prompt).not.toContain("200 tool calls");
    expect(prompt).not.toContain("10 concurrent");
  });

  it("appends the tool signature to the codemode result when a script hides a validation error", async () => {
    const run = fixture(true, async () => ({ count: 1 }), "fixture", undefined, {
      type: "object",
      properties: { record_id: { type: "number" } },
      required: ["record_id"],
    });
    let nextRequest = "";
    setup.faux.setResponses([
      script("try { await tools.fixture_count({ id: 1 }); } catch (e) { text(e.message.slice(0, 5)); }"),
      context => { nextRequest = JSON.stringify(context.messages); return fauxAssistantMessage("Hinted"); },
    ]);
    await expect(piAdapter.run(run.params)).resolves.toMatchObject({ text: "Hinted" });
    expect(nextRequest).toContain("fixture_count(");
    expect(nextRequest).toContain("record_id");
  });

  // ALG-507 seam 4 approved by Thinh (c404cd21): real Pi/faux and public
  // callbacks catch script values/declarations/history; live UI is separate.
  it("reads nested structured results before discovery and retains the same direct text and details", async () => {
    const run = fixture(true, async () => ({ deal: { org_id: 37 }, optional: undefined }), "fixture", {
      type: "object", properties: { deal: { type: "object", properties: { org_id: { type: "number" } }, required: ["org_id"] } }, required: ["deal"],
    });
    let nextRequest = "";
    let session: AgentSession | undefined;
    setup.faux.setResponses([
      script("const result = await tools.fixture_count({}); text(`organization=${result.deal.org_id};optional=${typeof result.optional};declared=${(await describeTool('fixture_count')).includes('org_id')}`);"),
      context => { nextRequest = JSON.stringify(context.messages); return fauxAssistantMessage(fauxToolCall("tool_search", { query: "fixture_count" }, { id: "load" }), { stopReason: "toolUse" }); },
      fauxAssistantMessage(fauxToolCall("fixture_count", {}, { id: "direct" }), { stopReason: "toolUse" }),
      script("text(`after-load=${(await tools.fixture_count({})).deal.org_id};declared=${(await describeTool('fixture_count')).includes('org_id')}`);", "script-after-load"),
      fauxAssistantMessage("Joined"),
    ]);
    await expect(piAdapter.run({ ...run.params, onSessionHandle: handle => { session = handle as AgentSession; } })).resolves.toMatchObject({ text: "Joined" });
    expect(nextRequest).toContain("organization=37;optional=undefined;declared=true");
    expect(run.events).toContainEqual(expect.objectContaining({ type: "tool_result", id: "script-after-load", isError: false, content: expect.stringContaining("after-load=37;declared=true") }));
    expect(run.history).toContainEqual(expect.objectContaining({
      type: "tool_result", name: "fixture_count", parentToolCallId: "script-506",
      content: '{"deal":{"org_id":37}}', isError: false,
    }));
    expect(session?.sessionManager.getEntries()).toContainEqual(expect.objectContaining({
      type: "message", message: expect.objectContaining({
        role: "toolResult", toolName: "fixture_count",
        content: [{ type: "text", text: '{"deal":{"org_id":37}}' }],
        details: { deal: { org_id: 37 }, optional: undefined },
      }),
    }));
  });

  // Same approved real Pi seam: returned error data, exact flag, thrown rejection
  // and subsequent work; external account/OAuth behavior is a separate test.
  it("keeps returned error data, rejects thrown failures and continues later script work", async () => {
    let call = 0;
    const run = fixture(true, async () => {
      switch (++call) {
        case 1: return { isError: true, reason: { code: "connect_account" } };
        case 2: return { ok: false, error: "existing failure" };
        case 3: return { isError: "true", count: 2 };
        case 4: throw new Error("Fixture unavailable");
        default: return { count: 7 };
      }
    }, "fixture", { type: "object", properties: { count: { type: "number" } }, required: ["count"] });
    setup.faux.setResponses([
      script('const lines = []; const refusal = await tools.fixture_count({}); lines.push(refusal.reason.code); const oldFailure = await tools.fixture_count({}); lines.push(oldFailure.error); lines.push((await tools.fixture_count({})).count); try { await tools.fixture_count({}); } catch (error) { lines.push(error.message); } lines.push(`later=${(await tools.fixture_count({})).count}`); text(lines.join("|"));'),
      fauxAssistantMessage("Recovered"),
    ]);
    await expect(piAdapter.run(run.params)).resolves.toMatchObject({ text: "Recovered" });
    expect(run.events).toContainEqual(expect.objectContaining({ type: "tool_result", id: "script-506/1", isError: true, content: '{"isError":true,"reason":{"code":"connect_account"}}' }));
    expect(run.events).toContainEqual(expect.objectContaining({ type: "tool_result", id: "script-506/2", isError: false, content: '{"ok":false,"error":"existing failure"}' }));
    expect(run.events).toContainEqual(expect.objectContaining({ type: "tool_result", id: "script-506/3", isError: false }));
    expect(run.events).toContainEqual(expect.objectContaining({ type: "tool_result", id: "script-506/4", isError: true, content: "Fixture unavailable" }));
    expect(run.events).toContainEqual(expect.objectContaining({ type: "tool_result", id: "script-506", isError: false, content: expect.stringContaining("connect_account|existing failure|2|Fixture unavailable|later=7") }));
  });

  // ALG-507 seams 4 and 6 approved by Thinh (c404cd21): real Pi callbacks
  // through canonical flush/read catch legacy text/flags and caller isolation;
  // browser rendering and live provider remain separate validation.
  it("keeps schema-less returned error flags as text and preserves isolated canonical nested history", async () => {
    const sessionId = `legacy-callers-${++sessionNumber}`;
    for (const userId of ["alice", "bob"]) {
      const run = fixture(true, async (_args, context) => ({ isError: true, caller: context.userId }));
      const buffer = createTurnBuffer();
      setup.faux.setResponses([
        script('const value = await tools.fixture_count({}); text(`${typeof value}:${value}`);'),
        fauxAssistantMessage("Legacy done"),
      ]);
      await piAdapter.run({ ...run.params, sessionId, userId, onHistoryEvent: event => { run.history.push(event); bufferHistoryEvent(buffer, event); } });
      expect(run.events).toContainEqual(expect.objectContaining({ type: "tool_result", name: "fixture_count", isError: false, content: `{"isError":true,"caller":"${userId}"}` }));
      expect(run.events).toContainEqual(expect.objectContaining({ type: "tool_result", name: "codemode", isError: false, content: expect.stringContaining(`string:{"isError":true,"caller":"${userId}"}`) }));
      await flushTurnBuffer(run.params.agentId, sessionId, buffer, userId);
    }
    for (const [userId, other] of [["alice", "bob"], ["bob", "alice"]]) {
      const history = await getFullHistory("codemode", sessionId, userId);
      expect(history).toContainEqual(expect.objectContaining({ role: "toolResult", toolCallId: "script-506/1", toolName: "fixture_count", parentToolCallId: "script-506", content: [{ type: "text", text: `{"isError":true,"caller":"${userId}"}` }], isError: false }));
      expect(JSON.stringify(history)).not.toContain(`\\"caller\\":\\"${other}\\"`);
    }
  });

  it.each([undefined, false])(
    "does not declare codemode when its agent flag is %s",
    async (enabled) => {
      const run = fixture(enabled);
      let tools: string[] = [];
      setup.faux.setResponses([
        (context) => {
          tools = context.messages.flatMap((message) =>
            message.role === "system"
              ? (message.toolsAdded?.map((tool) => tool.name) ?? [])
              : []
          );
          return fauxAssistantMessage("Codemode disabled");
        },
      ]);
      await expect(piAdapter.run(run.params)).resolves.toMatchObject({
        text: "Codemode disabled",
      });
      expect(tools).not.toContain("fixture_count");
      expect(tools).toContain("tool_search");
      expect(tools).not.toContain("codemode");
    }
  );

  it("runs text-returning extension tools while exposing only script output to the next model request", async () => {
    const run = fixture(true);
    let tools: string[] = [];
    let nextRequest = "";
    const first: FauxResponseFactory = (context) => {
      tools = context.messages.flatMap((message) =>
        message.role === "system"
          ? (message.toolsAdded?.map((tool) => tool.name) ?? [])
          : []
      );
      return script(
        "const result = JSON.parse(await tools.fixture_count({})); text(`count=${result.count};models=${typeof models}`);"
      );
    };
    const next: FauxResponseFactory = (context) => {
      nextRequest = JSON.stringify(context.messages);
      return fauxAssistantMessage("Three records");
    };
    setup.faux.setResponses([first, next]);
    await expect(piAdapter.run(run.params)).resolves.toMatchObject({
      text: "Three records",
    });
    expect(tools).toContain("codemode");
    expect(nextRequest).toContain("count=3;models=undefined");
    expect(nextRequest).not.toContain("RAW_CHILD_SENTINEL_506");
    expect(run.history).toContainEqual(
      expect.objectContaining({
        type: "tool_result",
        name: "fixture_count",
        content: expect.stringContaining("RAW_CHILD_SENTINEL_506"),
      })
    );
  });

  it("identifies nested extension calls and results under their codemode parent in stream and history events", async () => {
    const run = fixture(true);
    setup.faux.setResponses([
      script("text(JSON.parse(await tools.fixture_count({})).count);"),
      fauxAssistantMessage("Done"),
    ]);
    await piAdapter.run(run.params);
    for (const events of [run.events, run.history]) {
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "tool_call",
          id: "script-506/1",
          name: "fixture_count",
          parentToolCallId: "script-506",
        })
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "tool_result",
          id: "script-506/1",
          name: "fixture_count",
          parentToolCallId: "script-506",
        })
      );
    }
  });

  it("reports an uncaught child rejection as a codemode error and allows a later script", async () => {
    const run = fixture(true, async () => {
      throw new Error("Fixture unavailable");
    });
    setup.faux.setResponses([
      script("await tools.fixture_count({});"),
      fauxAssistantMessage("Child failed"),
    ]);
    await piAdapter.run(run.params);
    expect(run.events).toContainEqual(
      expect.objectContaining({
        type: "tool_result",
        id: "script-506",
        name: "codemode",
        isError: true,
        content: expect.stringContaining("Fixture unavailable"),
      })
    );

    const later = fixture(true);
    setup.faux.setResponses([
      script("text(JSON.parse(await tools.fixture_count({})).count);"),
      fauxAssistantMessage("Recovered"),
    ]);
    await expect(piAdapter.run(later.params)).resolves.toMatchObject({
      text: "Recovered",
    });
    expect(later.events).toContainEqual(
      expect.objectContaining({
        type: "tool_result",
        name: "codemode",
        isError: false,
        content: expect.stringContaining("3"),
      })
    );
  });

  it("aborts an active script and its blocking child through the adapter, then runs another script", async () => {
    const entered = deferred();
    const childAborted = deferred();
    const cleanup = deferred();
    const run = fixture(true, async (_args, context) => {
      entered.resolve();
      const onAbort = () => {
        childAborted.resolve();
      };
      context.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        await Promise.race([childAborted.promise, cleanup.promise]);
        if (context.signal?.aborted) throw new Error("Fixture aborted");
        return { count: 0 };
      } finally {
        context.signal?.removeEventListener("abort", onAbort);
      }
    });
    let handle: unknown;
    setup.faux.setResponses([script("await tools.fixture_count({});")]);
    const pending = piAdapter.run({
      ...run.params,
      onSessionHandle: (session) => {
        handle = session;
      },
    });
    const settled = pending.then(
      (result) => ({ result }),
      (error: unknown) => ({ error })
    );
    try {
      await bounded(entered.promise);
      expect(handle).toBeDefined();
      piAdapter.abort?.(handle);
      await bounded(childAborted.promise);
      await bounded(settled);
      expect(run.events).toContainEqual(
        expect.objectContaining({
          type: "tool_result",
          id: "script-506",
          name: "codemode",
          isError: true,
        })
      );
    } finally {
      cleanup.resolve();
      run.controller.abort();
      await bounded(settled);
    }

    const later = fixture(true);
    setup.faux.setResponses([
      script("text(JSON.parse(await tools.fixture_count({})).count);"),
      fauxAssistantMessage("Recovered"),
    ]);
    await expect(bounded(piAdapter.run(later.params))).resolves.toMatchObject({
      text: "Recovered",
    });
    expect(later.events).toContainEqual(
      expect.objectContaining({
        type: "tool_result",
        name: "codemode",
        isError: false,
      })
    );
  });

  it("rejects a third live worker across sessions and runs again after a worker exits", async () => {
    // Same-module worker-cap seam approved in ALG-506 comment
    // 8fcf9742-a30b-45b2-bd18-5fb24d1cecda: real concurrent SDK sessions,
    // host-controlled tool barriers; catches shared capacity/recovery, misses other processes.
    const firstEntered = deferred();
    const secondEntered = deferred();
    const release = deferred();
    const first = fixture(true, async () => {
      firstEntered.resolve();
      await release.promise;
      return { count: 1 };
    });
    const second = fixture(true, async () => {
      secondEntered.resolve();
      await release.promise;
      return { count: 2 };
    });
    const respond: FauxResponseFactory = (context) =>
      context.messages.some((message) => message.role === "toolResult")
        ? fauxAssistantMessage("Done")
        : script("text(JSON.parse(await tools.fixture_count({})).count);");
    setup.faux.setResponses(Array.from({ length: 30 }, () => respond));
    const holders: Promise<unknown>[] = [];
    try {
      const firstPending = piAdapter.run(first.params);
      holders.push(firstPending);
      void firstPending.catch(() => {});
      await bounded(firstEntered.promise);
      const secondPending = piAdapter.run(second.params);
      holders.push(secondPending);
      void secondPending.catch(() => {});
      await bounded(secondEntered.promise);

      const third = fixture(true);
      await bounded(piAdapter.run(third.params));
      expect(third.events).toContainEqual(
        expect.objectContaining({
          type: "tool_result",
          name: "codemode",
          isError: true,
          content: expect.stringContaining(
            "Codemode worker limit reached (2 workers are still running or shutting down). Retry after they exit."
          ),
        })
      );
    } finally {
      release.resolve();
      await bounded(Promise.allSettled(holders));
      first.controller.abort();
      second.controller.abort();
    }

    let recovered = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      const later = fixture(true);
      await bounded(piAdapter.run(later.params));
      const result = later.events.find(
        (event) => event.type === "tool_result" && event.name === "codemode"
      );
      if (!result || result.type !== "tool_result")
        throw new Error("Missing codemode result");
      if (result.isError) {
        expect(result.content).toContain(
          "Codemode worker limit reached (2 workers are still running or shutting down). Retry after they exit."
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
        continue;
      }
      expect(result.content).toContain("3");
      recovered = true;
      break;
    }
    expect(recovered).toBe(true);
  });

  it("executes invisible lifecycle children while keeping them out of stream and display history", async () => {
    const run = fixture(true, async () => ({ count: 7 }), "taskLifecycle");
    setup.faux.setResponses([
      script("text(JSON.parse(await tools.fixture_count({})).count);"),
      fauxAssistantMessage("Seven records"),
    ]);
    await expect(piAdapter.run(run.params)).resolves.toMatchObject({
      text: "Seven records",
    });
    for (const events of [run.events, run.history]) {
      const calls = events.filter(
        (event) => event.type === "tool_call" || event.type === "tool_result"
      );
      expect(calls).toHaveLength(2);
      expect(calls).toContainEqual(
        expect.objectContaining({
          type: "tool_call",
          name: "codemode",
          id: "script-506",
        })
      );
      expect(calls).toContainEqual(
        expect.objectContaining({
          type: "tool_result",
          name: "codemode",
          id: "script-506",
          isError: false,
          content: expect.stringContaining("7"),
        })
      );
      expect(calls).not.toContainEqual(
        expect.objectContaining({ name: "fixture_count" })
      );
    }
  });
});
