import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "@yoplai/shared";
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
    expect(simple).toHaveLength(1);
    expect(simple[0]).toMatchObject({ role: "user", content: "repro-msg" });

    const full = await getFullHistory("alpha", SID);
    expect(full).toHaveLength(1);
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
    ]);
  });
});
