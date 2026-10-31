import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { ExtensionRuntime } from "../extensions/runtime.js";
import type { AgentConfig, Extension, StreamEvent } from "@yoplai/shared";
import type { SdkRunParams } from "../sdk/types.js";

const { getAgent, getSdkAdapter, emitHistoryEvent } = vi.hoisted(() => ({
  getAgent: vi.fn(), getSdkAdapter: vi.fn(), emitHistoryEvent: vi.fn(),
}));

vi.mock("../config/index.js", () => ({
  CONFIG_DIR: "/tmp/yoplai-human-chat-test",
  getAgent,
  loadConfig: vi.fn(() => ({ agents: [], extensions: {}, sessions: {} })),
  resolveWorkspaceDir: (workspace: string) => workspace,
  resolveAgentEnv: () => ({}),
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
const review = vi.fn();
const done = vi.fn();
const begin = vi.fn();
const end = vi.fn();
let runtime: ExtensionRuntime;

const fakeExtension: Extension = {
  id: "short-replies", displayName: "Short replies", description: "Test reply reviewer",
  dependencies: [], routePrefixes: [], configSchema: z.object({}),
  validateConfig: () => ({ valid: true, errors: [] }), registerRoutes() {},
  async start() {}, async stop() {}, capabilities: () => [],
  reviewsReplies: (agent) => Boolean(agent.extensions?.["short-replies"]),
  getReplyReviewer(agent) {
    if (!agent.extensions?.["short-replies"]) return;
    return { nudge: "Reply on one topic.", begin, review, done, end };
  },
  getChatCommands: (agent) => agent.extensions?.["short-replies"]
    ? [{ command: "/status", run: () => "Ready." }] : [],
};

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
function scriptedAdapter(
  runs: Array<(p: SdkRunParams) => Promise<string> | string>,
  queueMessage?: (handle: unknown, message: string) => void
) {
  const run = vi.fn(async (p: SdkRunParams) => ({ text: await runs[run.mock.calls.length - 1](p) }));
  getSdkAdapter.mockReturnValue({
    id: "pi",
    displayName: "Pi",
    capabilities: { queueWhileStreaming: Boolean(queueMessage), interrupt: false, toolEvents: true, fullHistory: true },
    resolveDisplayModel: vi.fn(),
    run,
    ...(queueMessage ? { queueMessage } : {}),
  });
  return run;
}


function pause() {
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const arrived = new Promise<void>((resolve) => (reached = resolve));
  return { release, gate, arrived, reached };
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
    extensionRuntime: runtime,
    ...over,
    onEvent: (e: StreamEvent) => {
      events.push(e);
      tap?.(e);
    },
  });
  return { events, result, text: events.filter((e) => e.type === "text").map((e) => (e as { data: string }).data) };
}

beforeEach(async () => {
  vi.clearAllMocks();
  review.mockReset().mockImplementation((draft: string) => draft.includes("Six sentences")
    ? { ok: false, rewriteHint: "Shorten the reply." } : { ok: true });
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "reply-review-"));
  runtime = new ExtensionRuntime();
  runtime.load([fakeExtension]);
  getAgent.mockImplementation(() => agent({ "short-replies": {} }));
});

describe("extension reply review in runAgent", () => {
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
    expect(review).toHaveBeenCalledWith(SHORT);
    expect(done).toHaveBeenCalledWith({ ok: true }, { rewritten: false });
  });

  it("fail: one hidden rewrite; user sees only the rewrite; history drops the draft", async () => {
    const run = scriptedAdapter([says(LONG), says(SHORT)]);
    const { text, result } = await turn();
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1][0].message).toMatch(/^\[short-replies\] /);
    expect(run.mock.calls[1][0].nudge).toBeUndefined();
    expect(text).toEqual([SHORT]);
    expect(result.payloads).toEqual([{ text: SHORT }]);
    const history = JSON.stringify(emitHistoryEvent.mock.calls);
    expect(history).not.toContain("Six sentences");
    expect(history).toContain(SHORT);
  });

  it("fail twice: sends the rewrite, reports the verdict, rewrites once", async () => {
    const run = scriptedAdapter([says(LONG), says(`${LONG} Again.`)]);
    const { text } = await turn();
    expect(run).toHaveBeenCalledTimes(2);
    expect(text).toEqual([`${LONG} Again.`]);
    expect(done).toHaveBeenCalledWith({ ok: false, rewriteHint: "Shorten the reply." }, { rewritten: true });
  });

  it("NO_REPLY is never linted or rewritten", async () => {
    const run = scriptedAdapter([() => "NO_REPLY"]);
    const { text } = await turn();
    expect(run).toHaveBeenCalledTimes(1);
    expect(text).toEqual([]);
    expect(review).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
  });

  it("reviews a silent rewrite but does not report it as delivered", async () => {
    const run = scriptedAdapter([says(LONG), says("NO_REPLY")]);
    const { text, result } = await turn();
    expect(run).toHaveBeenCalledTimes(2);
    expect(review.mock.calls).toEqual([[LONG], [""]]);
    expect(done).not.toHaveBeenCalled();
    expect(text).toEqual([]);
    expect(result.meta.silent).toBe(true);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("ends review and releases held text/history when the adapter fails", async () => {
    const emitted: StreamEvent[] = [];
    scriptedAdapter([(params) => { says(SHORT)(params); throw new Error("provider failed"); }]);
    await expect(turn({}, (event) => emitted.push(event))).rejects.toThrow("provider failed");
    expect(end).toHaveBeenCalledTimes(1);
    expect(review).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
    expect(emitted).toContainEqual({ type: "text", data: SHORT });
    expect(JSON.stringify(emitHistoryEvent.mock.calls)).toContain(SHORT);
  });

  it("ends review without reviewing or logging an aborted result", async () => {
    const run = scriptedAdapter([]);
    run.mockImplementationOnce(async (params) => ({ text: says(SHORT)(params), aborted: true }));
    const { result } = await turn();
    expect(result.meta.aborted).toBe(true);
    expect(begin).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
    expect(review).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
  });

  it("releases the session and review state when begin fails", async () => {
    begin.mockImplementationOnce(() => { throw new Error("review setup failed"); });
    const run = scriptedAdapter([says(SHORT)]);
    await expect(turn()).rejects.toThrow("review setup failed");
    expect(end).toHaveBeenCalledTimes(1);
    const next = await turn();
    expect(next.result.meta.queued).not.toBe(true);
    expect(next.text).toEqual([SHORT]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("settles every begun reviewer and the session when end fails", async () => {
    const secondEnd = vi.fn();
    runtime.load([fakeExtension, {
      ...fakeExtension, id: "second-reviewer",
      getReplyReviewer: () => ({ begin() {}, review: () => ({ ok: true }), end: secondEnd }),
    }]);
    end.mockImplementationOnce(() => { throw new Error("review cleanup failed"); });
    scriptedAdapter([says(SHORT), says(SHORT)]);
    const first = await turn();
    expect(first.text).toEqual([SHORT]);
    expect(secondEnd).toHaveBeenCalledTimes(1);
    const next = await turn();
    expect(next.result.meta.queued).not.toBe(true);
    expect(next.text).toEqual([SHORT]);
    expect(secondEnd).toHaveBeenCalledTimes(2);
  });

  it("runs every reviewer, joins failing hints, and still rewrites only once", async () => {
    const secondReview = vi.fn().mockReturnValue({ ok: false, rewriteHint: "Use plain words." });
    const secondDone = vi.fn();
    const secondEnd = vi.fn();
    runtime.load([fakeExtension, {
      ...fakeExtension, id: "plain-words",
      getReplyReviewer: () => ({ nudge: "Use familiar words.", begin() {}, review: secondReview, done: secondDone, end: secondEnd }),
    }]);
    const run = scriptedAdapter([says(LONG), says(SHORT)]);
    const { text } = await turn();
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0][0].nudge).toBe("Reply on one topic.\n\nUse familiar words.");
    expect(run.mock.calls[1][0].message).toBe("[short-replies] Shorten the reply.\n\n[plain-words] Use plain words.");
    expect(review.mock.calls).toEqual([[LONG], [SHORT]]);
    expect(secondReview.mock.calls).toEqual([[LONG], [SHORT]]);
    expect(done).toHaveBeenCalledWith({ ok: true }, { rewritten: true });
    expect(secondDone).toHaveBeenCalledWith({ ok: false, rewriteHint: "Use plain words." }, { rewritten: true });
    expect(secondEnd).toHaveBeenCalledTimes(1);
    expect(text).toEqual([SHORT]);
  });

  it("a chat command answers without a model call or a begun reviewer", async () => {
    const run = scriptedAdapter([]);
    const { text, events, result } = await turn({ message: "  /status  " });
    expect(run).not.toHaveBeenCalled();
    expect(text).toEqual(["Ready."]);
    expect(events.map((event) => event.type)).toEqual(["text", "done"]);
    expect(result).toEqual({ payloads: [{ text: "Ready." }], meta: { durationMs: 0, sessionId: "s1" } });
    expect(begin).not.toHaveBeenCalled();
    expect(end).not.toHaveBeenCalled();
  });
});

describe("reviewed turn isolation", () => {
  it("passes the run source, sender, and background flag to the adapter", async () => {
    const run = scriptedAdapter([says(SHORT)]);
    await turn({ source: "web", background: false });
    expect(run.mock.calls[0][0]).toMatchObject({ source: "web", background: false });
    const skipped = scriptedAdapter([says(SHORT)]);
    await turn({ source: "scheduler", sender: { kind: "agent", agentId: "b" } });
    expect(skipped.mock.calls[0][0]).toMatchObject({ source: "scheduler", sender: { kind: "agent" } });
  });

  it("does not show the rejected draft in full history while the rewrite runs", async () => {
    const store = await import("../history/store.js");
    const user = { role: "user", content: "hi" };
    vi.mocked(store.hasCanonicalHistory).mockResolvedValue(true);
    vi.mocked(store.getFullHistory).mockResolvedValue([user] as never);
    vi.mocked(store.readPiSessionHistory).mockResolvedValue([user, { role: "assistant", content: LONG }] as never);
    const p = pause();
    scriptedAdapter([says(LONG), async (run) => { p.reached(); await p.gate; return says(SHORT)(run); }]);
    const running = turn();
    await p.arrived;
    const { getFullSessionHistory } = await import("./runner.js");
    const during = await getFullSessionHistory("alpha", "s1");
    p.release();
    await running;
    expect(JSON.stringify(during)).not.toContain("Six sentences");
  });

  it("does not send a follow-up to the disposed session while the rewrite runs", async () => {
    const queueMessage = vi.fn();
    const old = { name: "old handle" };
    const p = pause();
    const run = scriptedAdapter(
      [
        (r) => { r.onSessionHandle?.(old); return says(LONG)(r); },
        async (r) => { p.reached(); await p.gate; return says(SHORT)(r); },
        says(SHORT),
      ],
      queueMessage
    );
    const running = turn();
    await p.arrived;
    const second = await turn({ message: "second" });
    p.release();
    await running;
    expect(second.result.meta.queued).toBe(true);
    expect(queueMessage).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(3);
    expect(run.mock.calls[2][0].message).toBe("second");
  });

  it("gives a queued message its own turn: nudge, review, own rewrite", async () => {
    review.mockReturnValueOnce({ ok: true });
    const queueMessage = vi.fn();
    const p = pause();
    const run = scriptedAdapter(
      [
        async (r) => {
          r.onSessionHandle?.({ name: "live handle" });
          p.reached();
          await p.gate;
          return says(LONG)(r);
        },
        says(LONG),
        says(SHORT),
      ],
      queueMessage
    );
    const running = turn();
    await p.arrived;
    const second = await turn({ message: "second" }, undefined);
    p.release();
    await running;
    expect(queueMessage).not.toHaveBeenCalled();
    expect(second.result.meta.queued).toBe(true);
    expect(run).toHaveBeenCalledTimes(3);
    expect(run.mock.calls[1][0].message).toBe("second");
    expect(run.mock.calls[1][0].nudge).toContain("Reply on one topic");
    expect(run.mock.calls[2][0].message).toMatch(/^\[short-replies\] /);
  });
});
