import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentConfig, StreamEvent } from "@yoplai/shared";
import type { SdkRunParams } from "../sdk/types.js";

const getAgent = vi.fn();
const getSdkAdapter = vi.fn();
const emitHistoryEvent = vi.fn();

vi.mock("../config/index.js", () => ({
  CONFIG_DIR: "/tmp/yoplai-chat-shape-test",
  getAgent,
  loadConfig: vi.fn(() => ({ agents: [], extensions: {}, sessions: {} })),
  resolveWorkspaceDir: (workspace: string) => workspace,
}));
vi.mock("./quota-notification.js", () => ({ notifyProviderQuota: vi.fn() }));
vi.mock("../sdk/registry.js", () => ({ getSdkAdapter, getDefaultSdkId: () => "pi" }));
vi.mock("../sdk/container/adapter.js", () => ({ getContainerAdapter: vi.fn() }));
vi.mock("../sessions/index.js", () => ({
  resolveSessionId: vi.fn(),
  getSessionEntry: vi.fn(),
  isAbortTrigger: () => false,
}));
vi.mock("../tasks/store.js", () => ({ getTask: vi.fn(), pauseTaskForControlCommand: vi.fn() }));
vi.mock("../sessions/store.js", () => ({ DEFAULT_MAIN_KEY: "main", setSessionThinkLevel: vi.fn() }));
vi.mock("../history/store.js", () => ({
  appendSessionMeta: vi.fn(),
  appendRunFailureNotice: vi.fn(),
  backfillFromPiSession: vi.fn(async () => false),
  bufferHistoryEvent: vi.fn(),
  createTurnBuffer: vi.fn(() => ({})),
  flushTurnBuffer: vi.fn(),
  flushUserMessage: vi.fn(),
  getFullHistory: vi.fn(),
  getSimpleHistory: vi.fn(),
  hasCanonicalHistory: vi.fn(),
  invalidateResolvedHistoryFile: vi.fn(),
  readPiSessionHistory: vi.fn(),
}));
vi.mock("../maintenance/session-auto-title.js", () => ({ maybeAutoTitleSession: vi.fn() }));
vi.mock("../chat-projects/context-resolver.js", () => ({
  ProjectContextResolver: class { resolve = vi.fn(async () => undefined); },
}));
vi.mock("./events.js", () => ({
  agentEventBus: { emitStreamEvent: vi.fn(), emitHistoryEvent, emitStatusChange: vi.fn() },
}));

const LONG = "One. Two. Three. Four. Five. Six sentences in total.";
const SHORT = "Here is the short answer.";

let dir: string;
let log: string;

function agent(extensions?: Record<string, unknown>): AgentConfig {
  return {
    id: "alpha",
    name: "Alpha",
    workspace: dir,
    sdk: "pi",
    model: { provider: "anthropic", model: "claude" },
    queueMode: "queue",
    extensions,
  } as AgentConfig;
}

/** Adapter whose runs play scripted steps: text deltas, history events, or a custom action. */
function scriptedAdapter(runs: Array<(p: SdkRunParams) => Promise<string> | string>) {
  const run = vi.fn(async (p: SdkRunParams) => ({ text: await runs[run.mock.calls.length - 1](p) }));
  getSdkAdapter.mockReturnValue({
    id: "pi",
    displayName: "Pi",
    capabilities: { queueWhileStreaming: false, interrupt: false, toolEvents: true, fullHistory: true },
    resolveDisplayModel: vi.fn(),
    run,
  });
  return run;
}

const says = (text: string) => (p: SdkRunParams) => {
  p.onEvent({ type: "text", data: text.slice(0, 5) });
  p.onEvent({ type: "text", data: text.slice(5) });
  p.onHistoryEvent({ type: "assistant_text", text, timestamp: 1 });
  return text;
};

async function turn(over: Record<string, unknown> = {}, tap?: (e: StreamEvent) => void) {
  const events: StreamEvent[] = [];
  const { runAgent } = await import("./runner.js");
  const result = await runAgent({
    agentId: "alpha",
    message: "hi",
    sessionId: "s1",
    source: "web",
    ...over,
    onEvent: (e: StreamEvent) => {
      events.push(e);
      tap?.(e);
    },
  });
  return { events, result, text: events.filter((e) => e.type === "text").map((e) => (e as { data: string }).data) };
}

const readLog = async () =>
  (await fs.readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean).map((l) => JSON.parse(l));

beforeEach(async () => {
  vi.clearAllMocks();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "chat-shape-"));
  log = path.join(dir, "long.jsonl");
  getAgent.mockImplementation(() => agent({ "chat-shape": { log } }));
});

describe("chat-shape adapter in runAgent", () => {
  it("off: streams deltas as before and adds no nudge", async () => {
    getAgent.mockImplementation(() => agent());
    const seen: number[] = [];
    const run = scriptedAdapter([
      (p) => {
        p.onEvent({ type: "text", data: "Hello" });
        seen.push(emitted.length);
        return says(LONG)(p);
      },
    ]);
    const emitted: StreamEvent[] = [];
    const { text } = await turn({}, (e) => emitted.push(e));
    expect(seen[0]).toBe(1); // delta reached the channel while the run was active
    expect(text.length).toBeGreaterThan(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0].nudge).toBeUndefined();
  });

  it("on + pass: no deltas before turn end, one text event, nudge sent", async () => {
    const emitted: StreamEvent[] = [];
    let before = -1;
    const run = scriptedAdapter([
      (p) => {
        says(SHORT)(p);
        before = emitted.filter((e) => e.type === "text").length;
        return SHORT;
      },
    ]);
    const { text, result } = await turn({}, (e) => emitted.push(e));
    expect(before).toBe(0);
    expect(text).toEqual([SHORT]);
    expect(result.payloads).toEqual([{ text: SHORT }]);
    expect(run.mock.calls[0][0].nudge).toContain("Reply on one topic");
    expect(await readLog()).toEqual([]);
  });

  it("fail: one hidden rewrite; user sees only the rewrite; history drops the draft", async () => {
    const run = scriptedAdapter([says(LONG), says(SHORT)]);
    const { text, result } = await turn();
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1][0].message).toMatch(/^\[chat-shape\] /);
    expect(run.mock.calls[1][0].nudge).toBeUndefined();
    expect(text).toEqual([SHORT]);
    expect(result.payloads).toEqual([{ text: SHORT }]);
    const history = JSON.stringify(emitHistoryEvent.mock.calls);
    expect(history).not.toContain("Six sentences");
    expect(history).toContain(SHORT);
  });

  it("fail twice: sends the rewrite, logs rewrite_failed, rewrites once", async () => {
    const run = scriptedAdapter([says(LONG), says(`${LONG} Again.`)]);
    const { text } = await turn();
    expect(run).toHaveBeenCalledTimes(2);
    expect(text).toEqual([`${LONG} Again.`]);
    const [line] = await readLog();
    expect(line).toMatchObject({ agent: "alpha", session: "s1", event: "rewrite_failed", rules: ["too_many_sentences"] });
  });

  it("long mode via reply_mode tool: passes and logs without reply text", async () => {
    const { chatShapeExtension } = await import("../chat-shape/index.js");
    const run = scriptedAdapter([
      async (p) => {
        const [tool] = await chatShapeExtension.getAgentTools!(agent({ "chat-shape": {} }));
        await tool.execute(
          { mode: "long", type: "steps", note: "install steps for user" },
          { agent: agent(), config: {}, sessionId: "s1" } as never
        );
        return says(LONG)(p);
      },
    ]);
    const { text } = await turn();
    expect(run).toHaveBeenCalledTimes(1);
    expect(text).toEqual([LONG]);
    const [line] = await readLog();
    expect(line).toMatchObject({ agent: "alpha", session: "s1", type: "steps", note: "install steps for user" });
    expect(typeof line.words).toBe("number");
    expect(JSON.stringify(line)).not.toContain("Six sentences");
  });

  it.each([
    ["scheduler source", { source: "scheduler" }],
    ["agent sender", { sender: { kind: "agent", agentId: "beta" } }],
    ["background", { background: true }],
    ["no source", { source: undefined }],
    ["compaction session", { sessionId: "compact:1" }],
  ])("skips: %s", async (_name, over) => {
    const run = scriptedAdapter([says(LONG)]);
    const { text } = await turn(over);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0].nudge).toBeUndefined();
    expect(text.length).toBeGreaterThan(1);
  });

  it("NO_REPLY is never linted or rewritten", async () => {
    const run = scriptedAdapter([() => "NO_REPLY"]);
    const { text } = await turn();
    expect(run).toHaveBeenCalledTimes(1);
    expect(text).toEqual([]);
  });

  it("/topics lists open topics without a model call", async () => {
    await fs.mkdir(path.join(dir, "topics"));
    await fs.writeFile(
      path.join(dir, "topics", "plan.md"),
      `---\ntitle: Delivery\nupdated: ${new Date().toISOString()}\n---\n\n## [ ] First\nx\n\n## [ ] Second\ny\n\n## [x] Done\nz\n`
    );
    const run = scriptedAdapter([]);
    const { text } = await turn({ message: "/topics" });
    expect(run).not.toHaveBeenCalled();
    expect(text).toEqual(["Delivery\n> First\n  Second"]);
  });

  it("/topics with no plans", async () => {
    scriptedAdapter([]);
    expect((await turn({ message: "/topics" })).text).toEqual(["No open topics."]);
  });
});

describe("chat-shape extension", () => {
  it("is off without agent config: no tool, no rules", async () => {
    const { chatShapeExtension } = await import("../chat-shape/index.js");
    expect(await chatShapeExtension.getAgentTools!(agent())).toEqual([]);
    expect(await chatShapeExtension.getSystemPromptContributions!(agent())).toBeUndefined();
    expect(await chatShapeExtension.getAgentTools!(agent({ "chat-shape": { enabled: false } }))).toEqual([]);
  });

  it("on: adds the rules and reply_mode; bad type lists the valid types", async () => {
    const { chatShapeExtension } = await import("../chat-shape/index.js");
    const on = agent({ "chat-shape": {} });
    expect(await chatShapeExtension.getSystemPromptContributions!(on)).toContain("## Chat replies");
    const [tool] = await chatShapeExtension.getAgentTools!(on);
    const ctx = { agent: on, config: {}, sessionId: "s9" } as never;
    expect(await tool.execute({ mode: "long", type: "reference", note: "a b c" }, ctx)).toBe("Long mode on for this reply.");
    expect(() => tool.execute({ mode: "long", type: "bogus", note: "a b c" }, ctx)).toThrow(/user_asked, comparison/);
  });
});
