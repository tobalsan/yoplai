import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runFailureMessage, type AgentConfig, type RunFailureKind } from "@yoplai/shared";
import type { SdkAdapter, SdkRunParams } from "../sdk/types.js";

// Real canonical history store + real lifecycle against an isolated temp
// home: proves the user message survives runs that fail before the model
// starts (the mocked suites cannot, they stub the disk layer).
const tmpHome = vi.hoisted(() =>
  `/tmp/yoplai-failed-run-${process.pid}-${Math.random().toString(36).slice(2)}`
);

const getAgent = vi.fn();
const resolveWorkspaceDir = vi.fn((workspace: string) => workspace);
const getSdkAdapter = vi.fn();
const resolveSessionId = vi.fn();

vi.mock("../config/index.js", () => ({
  CONFIG_DIR: tmpHome,
  getAgent,
  loadConfig: vi.fn(() => ({ agents: [], extensions: {}, sessions: {} })),
  resolveWorkspaceDir,
}));

vi.mock("../sdk/registry.js", () => ({
  getSdkAdapter,
  getDefaultSdkId: vi.fn(() => "pi"),
}));

vi.mock("../sdk/container/adapter.js", () => ({
  getContainerAdapter: vi.fn(),
}));

vi.mock("../sessions/index.js", () => ({
  resolveSessionId,
  getSessionEntry: vi.fn(),
  isAbortTrigger: vi.fn(() => false),
}));

vi.mock("../tasks/store.js", () => ({
  getTask: vi.fn(async () => undefined),
  pauseTaskForControlCommand: vi.fn(),
}));

vi.mock("../extensions/registry.js", () => ({
  getExtensionRuntime: vi.fn(() => undefined),
}));

function createAdapter(run: SdkAdapter["run"]): SdkAdapter {
  return {
    id: "pi",
    displayName: "Test",
    capabilities: {
      queueWhileStreaming: false,
      interrupt: false,
      toolEvents: true,
      fullHistory: true,
    },
    resolveDisplayModel: () => ({}),
    run,
  } satisfies SdkAdapter;
}

function createAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "alpha",
    name: "Alpha",
    workspace: "/tmp/alpha",
    sdk: "pi",
    model: { provider: "anthropic", model: "claude" },
    queueMode: "queue",
    ...overrides,
  } as AgentConfig;
}

describe("failed-run user message persistence (real store)", () => {
  // Imported lazily: the vi.mock factories above must initialize first.
  let SID = "int-1";
  let runAgent: typeof import("./runner.js").runAgent;
  let getSimpleHistory: typeof import("../history/store.js").getSimpleHistory;
  let getFullHistory: typeof import("../history/store.js").getFullHistory;

  beforeEach(async () => {
    ({ runAgent } = await import("./runner.js"));
    ({ getSimpleHistory, getFullHistory } = await import("../history/store.js"));
    resolveSessionId.mockImplementation(async () => ({
      sessionId: SID,
      message: "",
      isNew: false,
    }));
  });

  it("persists the user message when the adapter throws before any event", async () => {
    SID = "int-1";
    getAgent.mockReturnValue(createAgent());
    getSdkAdapter.mockReturnValue(
      createAdapter(async () => {
        throw new Error("Model not found: fake/provider");
      })
    );

    await expect(
      runAgent({ agentId: "alpha", message: "repro-msg", sessionId: SID })
    ).rejects.toThrow("Model not found");

    const simple = await getSimpleHistory("alpha", SID);
    expect(simple).toHaveLength(2);
    expect(simple[0]).toMatchObject({ role: "user", content: "repro-msg" });

    const full = await getFullHistory("alpha", SID);
    expect(full).toHaveLength(2);
    expect(full[0]).toMatchObject({ role: "user" });

    // Sidebar eligibility: the canonical history file exists on disk.
    const historyDir = path.join(tmpHome, "history");
    expect(fs.readdirSync(historyDir).filter((f) => f.includes(`alpha-${SID}`))).toHaveLength(1);
  });

  it("does not duplicate the user entry when the adapter emits its echo", async () => {
    SID = "int-2";
    getAgent.mockReturnValue(createAgent());
    getSdkAdapter.mockReturnValue(
      createAdapter(async (params: SdkRunParams) => {
        params.onHistoryEvent({
          type: "user",
          text: "echo-msg",
          timestamp: Date.now(),
        });
        params.onHistoryEvent({
          type: "assistant_text",
          text: "assistant reply",
          timestamp: Date.now(),
        });
        return { text: "assistant reply" };
      })
    );

    await runAgent({ agentId: "alpha", message: "echo-msg", sessionId: SID });

    const simple = await getSimpleHistory("alpha", SID);
    expect(simple).toHaveLength(2);
    expect(simple[0]).toMatchObject({ role: "user", content: "echo-msg" });
    expect(simple[1]).toMatchObject({ role: "assistant", content: "assistant reply" });
  });

  it("sanitizes the pre-accepted message before persisting", async () => {
    SID = "int-3";
    getAgent.mockReturnValue(createAgent());
    getSdkAdapter.mockReturnValue(
      createAdapter(async () => {
        throw new Error("Model not found: fake/provider");
      })
    );

    await expect(
      runAgent({
        agentId: "alpha",
        message: "my token=supersecret value",
        sessionId: SID,
      })
    ).rejects.toThrow("Model not found");

    const simple = await getSimpleHistory("alpha", SID);
    expect(simple[0]?.content).toBe("my token=[REDACTED] value");
  });

  it("appends the retry message after a failed run, no duplicates", async () => {
    SID = "int-4";
    getAgent.mockReturnValue(createAgent());

    getSdkAdapter.mockReturnValue(
      createAdapter(async () => {
        throw new Error("Model not found: fake/provider");
      })
    );
    await expect(
      runAgent({ agentId: "alpha", message: "first try", sessionId: SID })
    ).rejects.toThrow("Model not found");

    getSdkAdapter.mockReturnValue(
      createAdapter(async (params: SdkRunParams) => {
        params.onHistoryEvent({
          type: "user",
          text: "second try",
          timestamp: Date.now(),
        });
        params.onHistoryEvent({
          type: "assistant_text",
          text: "ok now",
          timestamp: Date.now(),
        });
        return { text: "ok now" };
      })
    );
    await runAgent({ agentId: "alpha", message: "second try", sessionId: SID });

    const simple = await getSimpleHistory("alpha", SID);
    expect(simple.map((m) => `${m.role}:${m.content}`)).toEqual([
      "user:first try",
      "assistant:Something went wrong, please try again.",
      "user:second try",
      "assistant:ok now",
    ]);
  });

  it("single user entry across a real thinking-level fallback retry (OpenClaw shape)", async () => {
    SID = "int-6";
    getAgent.mockReturnValue(createAgent({ reasoning: "high" }));
    let attempt = 0;
    getSdkAdapter.mockReturnValue(
      createAdapter(async (params: SdkRunParams) => {
        attempt += 1;
        params.onHistoryEvent({
          type: "user",
          text: "fallback msg",
          timestamp: Date.now(),
        });
        if (attempt === 1) {
          // OpenClaw ends the turn before rejecting thinking-level errors.
          params.onHistoryEvent({ type: "turn_end", timestamp: Date.now() });
          throw new Error("thinking level not supported by model");
        }
        params.onHistoryEvent({
          type: "assistant_text",
          text: "recovered",
          timestamp: Date.now(),
        });
        return { text: "recovered" };
      })
    );

    await runAgent({
      agentId: "alpha",
      message: "fallback msg",
      sessionId: SID,
    });

    expect(attempt).toBe(2);
    const simple = await getSimpleHistory("alpha", SID);
    expect(simple.map((m) => `${m.role}:${m.content}`)).toEqual([
      "user:fallback msg",
      "assistant:recovered",
    ]);
  });

  it("system-context-first success reuses the accepted turn without duplicating the user", async () => {
    SID = "int-7";
    getAgent.mockReturnValue(createAgent());
    getSdkAdapter.mockReturnValue(
      createAdapter(async (params: SdkRunParams) => {
        // Pi emits its system context before the initial user event.
        params.onHistoryEvent({
          type: "system_context",
          rendered: "You are helpful.",
          context: {} as never,
          timestamp: Date.now(),
        });
        params.onHistoryEvent({
          type: "user",
          text: "with system",
          timestamp: Date.now(),
        });
        params.onHistoryEvent({
          type: "assistant_text",
          text: "sure",
          timestamp: Date.now(),
        });
        return { text: "sure" };
      })
    );

    await runAgent({
      agentId: "alpha",
      message: "with system",
      sessionId: SID,
    });

    const simple = await getSimpleHistory("alpha", SID);
    expect(simple.map((m) => `${m.role}:${m.content}`)).toEqual([
      "user:with system",
      "assistant:sure",
    ]);
    const full = await getFullHistory("alpha", SID);
    expect(full.filter((m) => m.role === "system")).toHaveLength(1);
  });

  it("backfills a legacy Pi-only session before appending", async () => {
    SID = "int-5";
    getAgent.mockReturnValue(createAgent());

    // Legacy Pi session file (pre-canonical era), no canonical history yet.
    fs.mkdirSync(path.join(tmpHome, "sessions"), { recursive: true });
    const piLines = [
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "legacy question" }],
          timestamp: 1000,
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "legacy answer" }],
          timestamp: 1001,
        },
      }),
    ];
    fs.writeFileSync(
      path.join(tmpHome, "sessions", `alpha-${SID}.jsonl`),
      piLines.join("\n") + "\n"
    );

    getSdkAdapter.mockReturnValue(
      createAdapter(async () => {
        throw new Error("Model not found: fake/provider");
      })
    );
    await expect(
      runAgent({ agentId: "alpha", message: "new after legacy", sessionId: SID })
    ).rejects.toThrow("Model not found");

    const simple = await getSimpleHistory("alpha", SID);
    expect(simple.map((m) => `${m.role}:${m.content}`)).toEqual([
      "user:legacy question",
      "assistant:legacy answer",
      "user:new after legacy",
      "assistant:Something went wrong, please try again.",
    ]);
  });
  it.each<RunFailureKind>([
    "rate_limit", "quota", "overloaded", "tool_deadline", "max_run_time", "idle_timeout", "generic",
  ])("persists one localized %s notice after partial output despite adapter error events", async (kind) => {
    const sessionId = `failure-${kind}`;
    getAgent.mockReturnValue(createAgent({ language: "fr" }));
    getSdkAdapter.mockReturnValue(createAdapter(async (params) => {
      params.onHistoryEvent({ type: "user", text: "request", timestamp: Date.now() });
      params.onHistoryEvent({ type: "assistant_text", text: "partial", timestamp: Date.now() });
      params.onEvent({ type: "error", message: "unsafe provider request-id" });
      throw Object.assign(new Error("unsafe provider request-id"), { kind });
    }));
    const onEvent = vi.fn();
    await expect(runAgent({ agentId: "alpha", message: "request", sessionId, onEvent })).rejects.toThrow("unsafe");
    const full = await getFullHistory("alpha", sessionId);
    expect(full.map((entry) => entry.role)).toEqual(["user", "assistant", "assistant"]);
    expect(full[1]).toMatchObject({ content: [{ type: "text", text: "partial" }] });
    expect(full[2]).toMatchObject({
      content: [{ type: "text", text: runFailureMessage(kind, "fr") }],
      meta: { stopReason: "error", failure: { kind } },
    });
    const simple = await getSimpleHistory("alpha", sessionId);
    expect(simple[2]).toMatchObject({ meta: { failure: { kind } } });
    expect(onEvent.mock.calls.map(([event]) => event)).toEqual([
      { type: "error", message: "unsafe provider request-id", kind, userMessage: runFailureMessage(kind, "fr") },
    ]);
  });

  // ALG-690 seam (issue spec, Testing Decisions): a safety refusal is the
  // explicit exception to keeping the user message.
  it("drops a safety-refused turn and keeps the session usable", async () => {
    const sessionId = "refusal-1";
    getAgent.mockReturnValue(createAgent());
    const { readSessionMeta, appendSessionMeta } = await import("../history/store.js");
    const answer = (reply: string) => createAdapter(async (params) => {
      params.onHistoryEvent({ type: "user", text: params.message, timestamp: Date.now() });
      params.onHistoryEvent({ type: "assistant_text", text: reply, timestamp: Date.now() });
      return { text: reply };
    });
    getSdkAdapter.mockReturnValue(answer("earlier answer"));
    await runAgent({ agentId: "alpha", message: "earlier question", sessionId });

    getSdkAdapter.mockReturnValue(createAdapter(async (params) => {
      params.onHistoryEvent({ type: "user", text: "flagged payload", timestamp: Date.now() });
      params.onHistoryEvent({ type: "tool_call", id: "t1", name: "bash", args: { command: "flagged tool call" }, timestamp: Date.now() });
      params.onHistoryEvent({ type: "tool_result", id: "t1", name: "bash", content: "flagged tool output", isError: false, timestamp: Date.now() });
      params.onHistoryEvent({ type: "turn_end", timestamp: Date.now() });
      await appendSessionMeta("alpha", sessionId, "thinkingLevel", "high");
      throw new Error("Agent error: Cyber safeguards flagged this message.");
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const onEvent = vi.fn();
    try {
      await expect(
        runAgent({ agentId: "alpha", message: "flagged payload", sessionId, onEvent })
      ).rejects.toThrow("Cyber safeguards flagged");
      const messages = (spy: typeof warn) =>
        spy.mock.calls.map(([line]) => (JSON.parse(String(line)) as { msg: string }).msg);
      expect(messages(warn)).toContain("[agent] run failed");
      expect(messages(error)).not.toContain("[agent] run failed");
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }

    const notice =
      "The AI provider's safety filter blocked this message, so it was not kept. You can rephrase or carry on.";
    expect(onEvent.mock.calls.map(([event]) => event).filter((event) => event.type === "error")).toEqual([
      { type: "error", message: "Agent error: Cyber safeguards flagged this message.", kind: "safety_refusal", userMessage: notice },
    ]);
    const full = await getFullHistory("alpha", sessionId);
    expect(JSON.stringify(full)).not.toMatch(/flagged (payload|tool call|tool output)/);
    expect(full.map((entry) => entry.role)).toEqual(["user", "assistant", "assistant"]);
    expect(full[2]).toMatchObject({
      content: [{ type: "text", text: notice }],
      meta: { failure: { kind: "safety_refusal" } },
    });
    await expect(readSessionMeta("alpha", sessionId, "thinkingLevel")).resolves.toBe("high");

    getSdkAdapter.mockReturnValue(answer("hello back"));
    const next = await runAgent({ agentId: "alpha", message: "hello ?", sessionId });
    expect(next.payloads).toEqual([{ text: "hello back" }]);
    const simple = await getSimpleHistory("alpha", sessionId);
    expect(simple.map((m) => `${m.role}:${m.content}`)).toEqual([
      "user:earlier question",
      "assistant:earlier answer",
      `assistant:${notice}`,
      "user:hello ?",
      "assistant:hello back",
    ]);
  });

  it.each(["resolved", "rejected", "signal"])("manual abort (%s) persists partial output without a failure notice", async (mode) => {
    const sessionId = `abort-${mode}`;
    getAgent.mockReturnValue(createAgent());
    const controller = new AbortController();
    getSdkAdapter.mockReturnValue(createAdapter(async (params) => {
      params.onHistoryEvent({ type: "assistant_text", text: "partial", timestamp: Date.now() });
      if (mode === "resolved") return { text: "partial", aborted: true };
      if (mode === "signal") controller.abort();
      throw Object.assign(new Error("stopped"), { name: mode === "rejected" ? "AbortError" : "Error" });
    }));
    const onEvent = vi.fn();
    const run = runAgent({ agentId: "alpha", message: "request", sessionId, onEvent, signal: controller.signal });
    if (mode === "resolved") await run;
    else await expect(run).rejects.toThrow("stopped");
    const full = await getFullHistory("alpha", sessionId);
    expect(full).toHaveLength(2);
    expect(full.some((entry) => entry.role === "assistant" && entry.meta?.failure)).toBe(false);
    expect(onEvent.mock.calls.some(([event]) => event.type === "error")).toBe(false);
  });
});
