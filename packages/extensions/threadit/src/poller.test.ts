import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ExtensionContext,
  RunAgentParams,
  RunAgentResult,
  StreamEvent,
} from "@yoplai/shared";
import { ThreaditPoller, type PollerOptions } from "./poller.js";

const ME = { id: 7, username: "bot", account_type: "agent" };

type Call = { method: string; path: string; body: Record<string, unknown>; auth: string };

function message(id: number, extra: Partial<Record<string, unknown>> = {}) {
  return {
    id,
    thread_id: 40,
    author: { id: 1, username: "ann", account_type: "human" },
    body: "@bot hi",
    created_at: `2026-01-01T00:00:0${id % 10}Z`,
    attachments: [],
    agent_sessions: [],
    ...extra,
  };
}

function session(extra: Record<string, unknown> = {}) {
  return { agent: { id: ME.id }, stop_requested: null, state: "working", reply_id: null, ...extra };
}

type Board = {
  me: Response | (() => Response);
  unacknowledged: unknown[];
  processing: unknown[];
  getMessage: (id: number) => unknown;
  onActivity: (body: Record<string, unknown>, n: number) => Response;
  onReply: (body: Record<string, unknown>, n: number) => Response;
  calls: Call[];
  onContext?: () => Promise<void>;
  beforeReply?: (n: number) => Promise<void>;
  beforeActivity?: (body: Record<string, unknown>) => Promise<void>;
  onReaction?: (n: number) => Promise<Response | undefined>;
  onAttention?: (status: string, offset: number) => Response | undefined;
};

function makeBoard(overrides: Partial<Board> = {}): Board {
  let activities = 0;
  let replies = 0;
  const board: Board = {
    me: () => Response.json(ME),
    unacknowledged: [],
    processing: [],
    getMessage: (id) => message(id),
    onActivity: () => Response.json(session()),
    onReply: () => Response.json({ id: 900 }),
    calls: [],
    ...overrides,
  };
  const original = { a: board.onActivity, r: board.onReply };
  board.onActivity = (body) => original.a(body, ++activities);
  board.onReply = (body) => original.r(body, ++replies);
  return board;
}

function fetchFor(board: Board) {
  let replyCount = 0;
  return async (url: string, init?: RequestInit): Promise<Response> => {
    const parsed = new URL(url);
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    board.calls.push({
      method,
      path: parsed.pathname,
      body,
      auth: new Headers(init?.headers).get("authorization") ?? "",
    });
    const p = parsed.pathname;
    if (p === "/api/me") return typeof board.me === "function" ? board.me() : board.me;
    if (p === "/api/attention") {
      const status = parsed.searchParams.get("status");
      const custom = board.onAttention?.(status ?? "", Number(parsed.searchParams.get("offset")));
      if (custom) return custom;
      const items = status === "processing" ? board.processing : board.unacknowledged;
      return Response.json({ items, has_more: false });
    }
    let m = /^\/api\/messages\/(\d+)\/context$/.exec(p);
    if (m) {
      const id = Number(m[1]);
      await board.onContext?.();
      return Response.json({
        area: { name: "Ops", description: "Be brief" },
        thread: { title: "Deploy" },
        target_id: id,
        top_level: [message(1)],
        chain: [message(id)],
      });
    }
    m = /^\/api\/messages\/(\d+)$/.exec(p);
    if (m && method === "GET") return Response.json(board.getMessage(Number(m[1])));
    if (/\/reactions$/.test(p)) {
      const custom = await board.onReaction?.(board.calls.filter((c) => c.path === p).length);
      return custom ?? Response.json({});
    }
    if (/\/agent-activities$/.test(p)) await board.beforeActivity?.(body);
    if (/\/agent-activities$/.test(p)) return board.onActivity(body, 0);
    if (/^\/api\/threads\/\d+\/messages$/.test(p)) await board.beforeReply?.(++replyCount);
    if (/^\/api\/threads\/\d+\/messages$/.test(p)) return board.onReply(body, 0);
    return new Response("{}", { status: 404 });
  };
}

const reactions = (b: Board) =>
  b.calls.filter((c) => c.path.endsWith("/reactions")).map((c) => c.body.emoji);
const activities = (b: Board) =>
  b.calls.filter((c) => c.path.endsWith("/agent-activities")).map((c) => c.body);
const replies = (b: Board) =>
  b.calls.filter((c) => c.path.startsWith("/api/threads/")).map((c) => c.body);

const okResult = (text: string, meta: Partial<RunAgentResult["meta"]> = {}): RunAgentResult => ({
  payloads: [{ text }],
  meta: { durationMs: 1, sessionId: "s", ...meta },
});

let dataDir: string;
let pollers: ThreaditPoller[] = [];

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "threadit-"));
});
afterEach(async () => {
  await Promise.all(pollers.map((p) => p.stop()));
  pollers = [];
  vi.restoreAllMocks();
  await rm(dataDir, { recursive: true, force: true });
});

type Setup = {
  board: Board;
  runAgent: ReturnType<typeof vi.fn>;
  poller: ThreaditPoller;
};

function setup(
  boardOverrides: Partial<Board>,
  run: (params: RunAgentParams) => Promise<RunAgentResult>,
  timing: {
    heartbeatMs?: number;
    turnTimeoutMs?: number;
    stopWaitMs?: number;
    token?: string | undefined;
    readConfig?: PollerOptions["readConfig"];
    activity?: "safe" | "detailed";
  } = {}
): Setup {
  const { token = "secret-token", activity = "safe", ...rest } =
    "token" in timing ? timing : { ...timing };
  const board = makeBoard(boardOverrides);
  const runAgent = vi.fn(run);
  const ctx = {
    getDataDir: () => dataDir,
    runAgent,
    isAgentActive: () => true,
  } as unknown as ExtensionContext;
  const poller = new ThreaditPoller({
    ctx,
    agentId: "main",
    config: {
      baseUrl: "http://board",
      token,
      pollIntervalMs: 10,
      turnTimeoutMinutes: 60,
      activity,
    },
    fetchFn: fetchFor(board),
    stopWaitMs: 500,
    ...rest,
  });
  pollers.push(poller);
  return { board, runAgent, poller };
}

const markerPath = (id: number) => path.join(dataDir, "threadit", "main", "delivering", String(id));
const exists = (p: string) => stat(p).then(() => true, () => false);
const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = (fn: () => void) => vi.waitFor(fn, { timeout: 3000, interval: 5 });

function abortable(params: RunAgentParams, aborted: RunAgentResult["meta"] = { durationMs: 1, sessionId: "s", aborted: true }) {
  return new Promise<RunAgentResult>((resolve) => {
    params.signal?.addEventListener("abort", () => resolve({ payloads: [], meta: aborted }));
  });
}

describe("ThreaditPoller", () => {
  it("answers, maps tools to activities, replies and adds the done reaction", async () => {
    const { board, runAgent, poller } = setup({ unacknowledged: [message(3)] }, async (params) => {
      const call = (name: string): StreamEvent => ({ type: "tool_call", id: name, name, arguments: { secret: "x" } });
      params.onEvent?.(call("read"));
      params.onEvent?.(call("read"));
      params.onEvent?.({ type: "progress", label: "do /etc/passwd" });
      params.onEvent?.({ type: "text", data: "private" });
      params.onEvent?.(call("task.checkpoint"));
      params.onEvent?.(call("bash"));
      return okResult("Hello");
    });
    poller.start();
    await waitFor(() => expect(reactions(board)).toEqual(["👀", "✅"]));
    expect(activities(board)).toEqual([
      { kind: "thought", body: "Started" },
      { kind: "action", body: "Reading files", ephemeral: true },
      { kind: "action", body: "Running commands", ephemeral: true },
    ]);
    expect(replies(board)).toEqual([{ body: "Hello", parent_id: 3 }]);
    expect(runAgent).toHaveBeenCalledTimes(1);
    const params = runAgent.mock.calls[0]![0] as RunAgentParams;
    expect(params).toMatchObject({
      agentId: "main",
      sessionKey: "threadit:thread-40",
      source: "threadit",
      sessionOwnerId: null,
    });
    expect(params.context).toBeUndefined();
    expect(params.sender).toBeUndefined();
    expect(params.message).toContain("You are @bot on this board");
    await waitFor(async () => expect(await exists(markerPath(3))).toBe(false));
    expect(JSON.stringify(board.calls)).not.toContain("private");
  });

  it("passes an agent sender for agent-authored items", async () => {
    const item = message(3, { author: { id: 2, username: "other", account_type: "agent" } });
    const { board, runAgent, poller } = setup({ unacknowledged: [item] }, async () => okResult("ok"));
    poller.start();
    await waitFor(() => expect(reactions(board)).toEqual(["👀", "✅"]));
    expect((runAgent.mock.calls[0]![0] as RunAgentParams).sender).toEqual({
      kind: "agent",
      agentId: "threadit:other",
    });
  });

  it("joins payload texts and splits long replies", async () => {
    const { board, poller } = setup({ unacknowledged: [message(3)] }, async () => ({
      payloads: [{ text: "a".repeat(19_500) }, { text: "" }, { text: "b" }],
      meta: { durationMs: 1, sessionId: "s" },
    }));
    poller.start();
    await waitFor(() => expect(reactions(board)).toEqual(["👀", "✅"]));
    const bodies = replies(board).map((r) => String(r.body));
    expect(bodies.length).toBe(2);
    expect(bodies.every((b) => b.length <= 19_000)).toBe(true);
  });

  it.each([
    ["NO_REPLY text", { payloads: [{ text: "NO_REPLY" }], meta: { durationMs: 1, sessionId: "s" } }],
    ["silent meta", { payloads: [{ text: "hidden" }], meta: { durationMs: 1, sessionId: "s", silent: true } }],
    ["empty text", { payloads: [], meta: { durationMs: 1, sessionId: "s" } }],
  ])("a silent turn (%s) only adds the done reaction", async (_name, result) => {
    const { board, poller } = setup({ unacknowledged: [message(3)] }, async () => result as RunAgentResult);
    poller.start();
    await waitFor(() => expect(reactions(board)).toEqual(["👀", "✅"]));
    expect(replies(board)).toEqual([]);
  });

  it("runs a failed item again after a board retry in the same thread session", async () => {
    let releaseError: () => void = () => {};
    const errorResponse = new Promise<void>((resolve) => (releaseError = resolve));
    let runs = 0;
    const { board, runAgent, poller } = setup(
      {
        unacknowledged: [message(3)],
        onReaction: async () => {
          board.unacknowledged = [];
          return undefined;
        },
        beforeActivity: (body) => body.kind === "error" ? errorResponse : Promise.resolve(),
      },
      async () => {
        if (++runs === 1) throw new Error("first run failed");
        return okResult("Retry answered");
      }
    );
    poller.start();
    await waitFor(() => expect(activities(board)).toContainEqual({ kind: "error", body: "Run failed" }));
    expect(replies(board)).toEqual([]);
    releaseError();
    await waitFor(() => expect(replies(board)).toEqual([
      { body: "I could not finish this request.", parent_id: 3 },
    ]));
    expect(reactions(board)).toEqual(["👀"]);

    // Retry clears the failure reply and returns the item without an own-session reply_id.
    board.unacknowledged = [message(3)];
    await waitFor(() => expect(reactions(board)).toEqual(["👀", "👀", "✅"]));
    await settle();
    expect(runAgent).toHaveBeenCalledTimes(2);
    for (const [params] of runAgent.mock.calls) {
      expect(params).toMatchObject({ sessionKey: "threadit:thread-40" });
    }
    expect(activities(board)).toEqual([
      { kind: "thought", body: "Started" },
      { kind: "error", body: "Run failed" },
      { kind: "thought", body: "Started" },
    ]);
    expect(replies(board)).toEqual([
      { body: "I could not finish this request.", parent_id: 3 },
      { body: "Retry answered", parent_id: 3 },
    ]);
  });

  it.each([400, 500, 409])("keeps a failed item blocked when its failure reply returns HTTP %i", async (status) => {
    const { board, runAgent, poller } = setup(
      {
        unacknowledged: [message(3)],
        onReply: () => Response.json({ error: { code: "thread_closed" } }, { status }),
      },
      async () => { throw new Error("run failed"); }
    );
    poller.start();
    await waitFor(() => expect(replies(board).length).toBeGreaterThan(0));
    const polls = board.calls.filter((c) => c.path === "/api/attention").length;
    await waitFor(() => expect(board.calls.filter((c) => c.path === "/api/attention").length).toBeGreaterThan(polls + 2));
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(replies(board)).toEqual([{ body: "I could not finish this request.", parent_id: 3 }]);
    expect(reactions(board)).toEqual(["👀"]);
  });

  it("keeps the working reaction after a failed run", async () => {
    const { board, poller } = setup({ unacknowledged: [message(3)] }, async () => {
      throw new Error("provider said secret-token");
    });
    board.onReply = () => {
      board.unacknowledged = []; // At 👀, the real board no longer lists the item here.
      return Response.json({ id: 900 });
    };
    poller.start();
    await waitFor(() => expect(replies(board)).toHaveLength(1));
    expect(replies(board)[0]).toEqual({ body: "I could not finish this request.", parent_id: 3 });
    expect(activities(board)).toContainEqual({ kind: "error", body: "Run failed" });
    expect(reactions(board)).toEqual(["👀"]);
    expect(JSON.stringify(board.calls)).not.toContain("provider said");
    await waitFor(async () => expect(await exists(markerPath(3))).toBe(false));
  });

  it("an aborted run without a stop request fails", async () => {
    const { board, poller } = setup({ unacknowledged: [message(3)] }, async () =>
      okResult("", { aborted: true })
    );
    board.onReply = () => {
      board.unacknowledged = []; // At 👀, the real board no longer lists the item here.
      return Response.json({ id: 900 });
    };
    poller.start();
    await waitFor(() => expect(replies(board)).toHaveLength(1));
    expect(reactions(board)).toEqual(["👀"]);
  });

  it("a stop request in the Started response replies and skips the run", async () => {
    const { board, runAgent, poller } = setup(
      {
        unacknowledged: [message(3)],
        onActivity: () => Response.json(session({ stop_requested: { at: "now" } })),
      },
      async () => okResult("never")
    );
    poller.start();
    await waitFor(() => expect(reactions(board)).toEqual(["👀", "✅"]));
    expect(replies(board)).toEqual([{ body: "Stopped on request.", parent_id: 3 }]);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("a stop request seen by polling aborts the run", async () => {
    const stopped = { agent_sessions: [session({ stop_requested: { at: "now" } })] };
    const { board, runAgent, poller } = setup(
      { unacknowledged: [message(3)], getMessage: (id) => message(id, stopped) },
      (params) => abortable(params)
    );
    poller.start();
    await waitFor(() => expect(reactions(board)).toEqual(["👀", "✅"]));
    expect(replies(board)).toEqual([{ body: "Stopped on request.", parent_id: 3 }]);
    expect((runAgent.mock.calls[0]![0] as RunAgentParams).signal?.aborted).toBe(true);
  });

  it("a stop request in a tool activity response aborts the run", async () => {
    const { board, poller } = setup(
      {
        unacknowledged: [message(3)],
        onActivity: (_body, n) =>
          Response.json(session(n >= 2 ? { stop_requested: { at: "now" } } : {})),
      },
      async (params) => {
        params.onEvent?.({ type: "tool_call", id: "1", name: "read", arguments: {} });
        return abortable(params);
      }
    );
    poller.start();
    await waitFor(() => expect(reactions(board)).toEqual(["👀", "✅"]));
    expect(replies(board)).toEqual([{ body: "Stopped on request.", parent_id: 3 }]);
  });

  it("an item whose own session has a stop request gets the done reaction only", async () => {
    const item = message(3, { agent_sessions: [session({ stop_requested: { at: "now" } })] });
    const { board, runAgent, poller } = setup({ unacknowledged: [item] }, async () => okResult("x"));
    poller.start();
    await waitFor(() => expect(reactions(board)).toEqual(["✅"]));
    expect(runAgent).not.toHaveBeenCalled();
    expect(activities(board)).toEqual([]);
  });

  it("a closed thread stops all writes for the item", async () => {
    const closed = () => Response.json({ error: { code: "thread_closed" } }, { status: 409 });
    const first = setup({ unacknowledged: [message(3)], onActivity: closed }, async () => okResult("x"));
    first.poller.start();
    await waitFor(() => expect(activities(first.board)).toHaveLength(1));
    await settle();
    expect(first.runAgent).not.toHaveBeenCalled();
    expect(replies(first.board)).toEqual([]);
    expect(reactions(first.board)).toEqual(["👀"]);

    const second = setup(
      {
        unacknowledged: [message(4)],
        onActivity: (_b, n) => (n >= 2 ? closed() : Response.json(session())),
      },
      async (params) => {
        params.onEvent?.({ type: "tool_call", id: "1", name: "read", arguments: {} });
        return abortable(params);
      }
    );
    second.poller.start();
    await waitFor(() => expect(activities(second.board)).toHaveLength(2));
    await settle();
    expect(replies(second.board)).toEqual([]);
    expect(reactions(second.board)).toEqual(["👀"]);
  });

  it("posts a heartbeat after a quiet period", async () => {
    const { board, poller } = setup(
      { unacknowledged: [message(3)] },
      async () => {
        await settle(120);
        return okResult("done");
      },
      { heartbeatMs: 30 }
    );
    poller.start();
    await waitFor(() => expect(reactions(board)).toEqual(["👀", "✅"]));
    expect(activities(board)).toContainEqual({ kind: "thought", body: "Still working", ephemeral: true });
  });

  it("a resumed item posts Resumed after restart first", async () => {
    const item = message(3, { agent_sessions: [session({ state: "stale" })] });
    const { board, runAgent, poller } = setup({ processing: [item] }, async () => okResult("back"));
    poller.start();
    await waitFor(() => expect(reactions(board)).toEqual(["👀", "✅"]));
    expect(activities(board)[0]).toEqual({ kind: "thought", body: "Resumed after restart" });
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("resume handles stopping, replied, and skipped states", async () => {
    const stopping = message(3, { agent_sessions: [session({ state: "stopping" })] });
    const replied = message(4, { agent_sessions: [session({ reply_id: 9 })] });
    const needsInput = message(5, { agent_sessions: [session({ state: "needs_input" })] });
    const errored = message(6, { agent_sessions: [session({ state: "error" })] });
    const { board, runAgent, poller } = setup(
      { processing: [stopping, replied, needsInput, errored] },
      async () => okResult("x")
    );
    poller.start();
    await waitFor(() => expect(reactions(board)).toEqual(["✅", "✅"]));
    expect(replies(board)).toEqual([{ body: "Stopped on request.", parent_id: 3 }]);
    expect(runAgent).not.toHaveBeenCalled();
    const doneIds = board.calls
      .filter((c) => c.path.endsWith("/reactions"))
      .map((c) => c.path);
    expect(doneIds).toEqual(["/api/messages/3/reactions", "/api/messages/4/reactions"]);
  });

  it("resume with a delivery marker never runs or replies", async () => {
    await mkdir(path.dirname(markerPath(3)), { recursive: true });
    await writeFile(markerPath(3), "");
    await writeFile(markerPath(4), "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const unconfirmed = message(3, { agent_sessions: [session()] });
    const confirmed = message(4, { agent_sessions: [session({ reply_id: 11 })] });
    const { board, runAgent, poller } = setup(
      { processing: [unconfirmed, confirmed] },
      async () => okResult("x")
    );
    poller.start();
    await waitFor(() => expect(reactions(board)).toEqual(["✅"]));
    await settle();
    expect(runAgent).not.toHaveBeenCalled();
    expect(replies(board)).toEqual([]);
    expect(warn).toHaveBeenCalled();
    expect(await exists(markerPath(3))).toBe(true);
    expect(await exists(markerPath(4))).toBe(false);
  });

  it("an uncertain reply is never sent again and needs reply_id for the done reaction", async () => {
    const fail = () => Response.json({}, { status: 500 });
    const unconfirmed = setup(
      { unacknowledged: [message(3)], onReply: fail },
      async () => okResult("answer")
    );
    unconfirmed.poller.start();
    await waitFor(() =>
      expect(unconfirmed.board.calls.some((c) => c.method === "GET" && c.path === "/api/messages/3")).toBe(true)
    );
    await settle();
    expect(replies(unconfirmed.board)).toHaveLength(1);
    expect(reactions(unconfirmed.board)).toEqual(["👀"]);
    expect(await exists(markerPath(3))).toBe(true);

    const confirmed = setup(
      {
        unacknowledged: [message(4)],
        onReply: fail,
        getMessage: (id) => message(id, { agent_sessions: [session({ reply_id: 5 })] }),
      },
      async () => okResult("answer")
    );
    confirmed.poller.start();
    await waitFor(() => expect(reactions(confirmed.board)).toEqual(["👀", "✅"]));
    expect(replies(confirmed.board)).toHaveLength(1);
  });

  it("skips items already handled in this process", async () => {
    const { board, runAgent, poller } = setup({ unacknowledged: [message(3)] }, async () => okResult("x"));
    poller.start();
    await waitFor(() => expect(reactions(board)).toEqual(["👀", "✅"]));
    const attentionCalls = () =>
      board.calls.filter((c) => c.path === "/api/attention").length;
    const before = attentionCalls();
    await waitFor(() => expect(attentionCalls()).toBeGreaterThan(before + 2));
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("handles items oldest first", async () => {
    const { board, poller } = setup(
      { unacknowledged: [message(5), message(2)] },
      async () => okResult("x")
    );
    poller.start();
    await waitFor(() => expect(reactions(board)).toHaveLength(4));
    const order = board.calls
      .filter((c) => c.path.endsWith("/reactions") && c.body.emoji === "👀")
      .map((c) => c.path);
    expect(order).toEqual(["/api/messages/2/reactions", "/api/messages/5/reactions"]);
  });

  it("does not start when the token is rejected or the account is not an agent", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const rejected = setup(
      { me: () => Response.json({}, { status: 401 }), unacknowledged: [message(3)] },
      async () => okResult("x")
    );
    rejected.poller.start();
    await waitFor(() => expect(error).toHaveBeenCalledWith("[threadit] main: token rejected"));
    await settle();
    expect(rejected.board.calls.map((c) => c.path)).toEqual(["/api/me"]);
    expect(rejected.runAgent).not.toHaveBeenCalled();

    const human = setup(
      { me: () => Response.json({ ...ME, account_type: "human" }), unacknowledged: [message(3)] },
      async () => okResult("x")
    );
    human.poller.start();
    await waitFor(() => expect(error).toHaveBeenCalledWith("[threadit] main: not an agent account"));
    await settle();
    expect(human.runAgent).not.toHaveBeenCalled();
    expect(JSON.stringify(error.mock.calls)).not.toContain("secret-token");
  });

  it("retries the account check after a network error", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let n = 0;
    const { board, poller } = setup(
      {
        me: () => {
          if (++n === 1) throw new Error("down");
          return Response.json(ME);
        },
        unacknowledged: [message(3)],
      },
      async () => okResult("x")
    );
    poller.start();
    await waitFor(() => expect(reactions(board)).toEqual(["👀", "✅"]));
  });

  it("aborts and fails a turn that exceeds the timeout", async () => {
    const { board, runAgent, poller } = setup(
      { unacknowledged: [message(3)] },
      (params) => abortable(params),
      { turnTimeoutMs: 60 }
    );
    board.onReply = () => {
      board.unacknowledged = []; // At 👀, the real board no longer lists the item here.
      return Response.json({ id: 900 });
    };
    poller.start();
    await waitFor(() => expect(replies(board)).toHaveLength(1));
    expect((runAgent.mock.calls[0]![0] as RunAgentParams).signal?.aborted).toBe(true);
    expect(activities(board)).toContainEqual({ kind: "error", body: "Run failed" });
    expect(reactions(board)).toEqual(["👀"]);
  });

  it("uses the deferred result of a queued run", async () => {
    let deferred: ((o: { result: RunAgentResult } | { error: unknown }) => void) | undefined;
    const { board, poller } = setup({ unacknowledged: [message(3)] }, async (params) => {
      deferred = params.onDeferredResult as typeof deferred;
      return { payloads: [], meta: { durationMs: 0, sessionId: "s", queued: true } };
    });
    poller.start();
    await waitFor(() => expect(deferred).toBeDefined());
    await settle();
    expect(replies(board)).toEqual([]);
    deferred?.({ result: okResult("late answer") });
    await waitFor(() => expect(reactions(board)).toEqual(["👀", "✅"]));
    expect(replies(board)).toEqual([{ body: "late answer", parent_id: 3 }]);
  });

  it("treats a deferred error as a failure", async () => {
    const { board, poller } = setup({ unacknowledged: [message(3)] }, async (params) => {
      setTimeout(() => void params.onDeferredResult?.({ error: new Error("nope") }), 20);
      return { payloads: [], meta: { durationMs: 0, sessionId: "s", queued: true } };
    });
    board.onReply = () => {
      board.unacknowledged = []; // At 👀, the real board no longer lists the item here.
      return Response.json({ id: 900 });
    };
    poller.start();
    await waitFor(() => expect(replies(board)).toHaveLength(1));
    expect(replies(board)[0]!.body).toBe("I could not finish this request.");
    expect(reactions(board)).toEqual(["👀"]);
  });

  it("stop() aborts an in-flight run and posts no reply", async () => {
    const { board, runAgent, poller } = setup({ unacknowledged: [message(3)] }, (params) => abortable(params));
    poller.start();
    await waitFor(() => expect(runAgent).toHaveBeenCalled());
    await poller.stop();
    expect((runAgent.mock.calls[0]![0] as RunAgentParams).signal?.aborted).toBe(true);
    expect(replies(board)).toEqual([]);
    expect(reactions(board)).toEqual(["👀"]);
  });

  it("stop() during the context read does not start a turn", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { board, runAgent, poller } = setup(
      { unacknowledged: [message(3)], onContext: () => gate },
      async () => okResult("late")
    );
    poller.start();
    await waitFor(() => expect(board.calls.some((c) => c.path.endsWith("/context"))).toBe(true));
    const stopping = poller.stop();
    release();
    await stopping;
    await settle();
    expect(runAgent).not.toHaveBeenCalled();
    expect(replies(board)).toEqual([]);
    expect(reactions(board)).toEqual(["👀"]);
  });

  it("stop() during a multipart reply sends no more parts or reaction", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { board, poller } = setup(
      { unacknowledged: [message(3)], beforeReply: (n) => (n === 1 ? gate : Promise.resolve()) },
      async () => okResult("a".repeat(19_500) + "b")
    );
    poller.start();
    await waitFor(() => expect(board.calls.some((c) => c.path.startsWith("/api/threads/"))).toBe(true));
    const stopping = poller.stop();
    release();
    await stopping;
    await settle();
    expect(replies(board)).toHaveLength(1);
    expect(reactions(board)).toEqual(["👀"]);
  });

  const slowActions = (body: Record<string, unknown>) =>
    body.kind === "action" ? new Promise<void>((r) => setTimeout(r, 1500)) : Promise.resolve();
  const twoTools = async (params: RunAgentParams) => {
    params.onEvent?.({ type: "tool_call", id: "1", name: "read", arguments: {} });
    params.onEvent?.({ type: "tool_call", id: "2", name: "bash", arguments: {} });
    return abortable(params);
  };

  it("slow activity backlog does not delay the deadline", async () => {
    const { board, poller } = setup(
      { unacknowledged: [message(3)], beforeActivity: slowActions },
      twoTools,
      { turnTimeoutMs: 100 }
    );
    const began = Date.now();
    board.onReply = () => {
      board.unacknowledged = []; // At 👀, the real board no longer lists the item here.
      return Response.json({ id: 900 });
    };
    poller.start();
    await waitFor(() => expect(replies(board)).toHaveLength(1));
    expect(Date.now() - began).toBeLessThan(1000);
    expect(replies(board)[0]).toEqual({ body: "I could not finish this request.", parent_id: 3 });
  });

  it("slow activity backlog does not delay seeing a stop request", async () => {
    const stopped = { agent_sessions: [session({ stop_requested: { at: "now" } })] };
    const { board, poller } = setup(
      { unacknowledged: [message(3)], getMessage: (id) => message(id, stopped), beforeActivity: slowActions },
      twoTools
    );
    const began = Date.now();
    poller.start();
    await waitFor(() => expect(replies(board)).toHaveLength(1));
    expect(Date.now() - began).toBeLessThan(1000);
    expect(replies(board)[0]).toEqual({ body: "Stopped on request.", parent_id: 3 });
  });

  it.each([0, 1])("retries incomplete startup recovery (failing page %i)", async (failAt) => {
    let failed = false;
    const lateItem = message(5, { agent_sessions: [session()] });
    const earlyItem = message(4, { agent_sessions: [session({ reply_id: 1 })] });
    const { board, runAgent, poller } = setup(
      {
        processing: failAt === 0 ? [lateItem] : [],
        onAttention: (status, offset) => {
          if (status !== "processing") return undefined;
          if (failAt === 1 && offset === 0) {
            return Response.json({ items: [earlyItem], has_more: true });
          }
          if (offset === failAt && !failed) {
            failed = true;
            return new Response("{}", { status: 503 });
          }
          if (failAt === 1) return Response.json({ items: [lateItem], has_more: false });
          return undefined;
        },
      },
      async () => okResult("recovered")
    );
    poller.start();
    await waitFor(() => expect(replies(board)).toEqual([{ body: "recovered", parent_id: 5 }]));
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(failed).toBe(true);
  });

  it("finishes startup recovery after a resumed run fails", async () => {
    let processingLists = 0;
    const { board, runAgent, poller } = setup(
      {
        processing: [message(5, { agent_sessions: [session()] })],
        onAttention: (status) => {
          if (status === "processing") processingLists++;
          return undefined;
        },
      },
      async () => { throw new Error("resumed run failed"); }
    );
    poller.start();
    await waitFor(() => expect(replies(board)).toHaveLength(1));
    await settle();
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(processingLists).toBe(1);
    expect(activities(board)).toEqual([
      { kind: "thought", body: "Resumed after restart" },
      { kind: "error", body: "Run failed" },
    ]);
    expect(replies(board)).toEqual([{ body: "I could not finish this request.", parent_id: 5 }]);
    expect(reactions(board)).toEqual(["👀"]);
    expect(board.calls.filter((c) => c.path === "/api/attention").length).toBeGreaterThan(2);
  });

  it("retries a processing item whose first working reaction fails", async () => {
    const item = message(5, { agent_sessions: [session()] });
    const { board, runAgent, poller } = setup(
      {
        processing: [item],
        onReaction: async (n) => (n === 1 ? new Response("{}", { status: 503 }) : undefined),
      },
      async () => okResult("recovered")
    );
    poller.start();
    await waitFor(() => expect(replies(board)).toEqual([{ body: "recovered", parent_id: 5 }]));
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("an uncertain working reaction on a new item is retried through recovery", async () => {
    const item = message(6);
    let moved = false;
    const { board, runAgent, poller } = setup(
      {
        unacknowledged: [item],
        onReaction: async () => {
          if (moved) return undefined;
          // The server stores the reaction, then the response is lost.
          moved = true;
          board.unacknowledged = [];
          board.processing = [message(6, { agent_sessions: [session()] })];
          throw new TypeError("fetch failed");
        },
      },
      async () => okResult("once")
    );
    poller.start();
    await waitFor(() => expect(replies(board)).toEqual([{ body: "once", parent_id: 6 }]));
    await settle();
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(replies(board)).toHaveLength(1);
    expect(activities(board)[0]).toEqual({ kind: "thought", body: "Started" });
  });

  it("reads every unacknowledged page so skipped items cannot hide newer ones", async () => {
    const stopped = { agent_sessions: [session({ stop_requested: { at: "t" } })] };
    const blocked = Array.from({ length: 50 }, (_, i) => message(100 + i, stopped));
    const { board, runAgent, poller } = setup(
      {
        // The done reaction fails, so the stopped items stay unacknowledged.
        onReaction: async () => new Response("{}", { status: 503 }),
        onAttention: (status, offset) => {
          if (status !== "unacknowledged") return undefined;
          return offset === 0
            ? Response.json({ items: blocked, has_more: true })
            : Response.json({ items: [message(200)], has_more: false });
        },
      },
      async () => okResult("late")
    );
    poller.start();
    await waitFor(() =>
      expect(board.calls.some((c) => c.path === "/api/messages/200/reactions")).toBe(true)
    );
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("a permanent working reaction failure does not block new items", async () => {
    let failed = false;
    const item = message(5, { agent_sessions: [session()] });
    const { board, runAgent, poller } = setup(
      {
        processing: [item],
        unacknowledged: [message(6)],
        onReaction: async () => {
          if (failed) return undefined;
          failed = true;
          return new Response("{}", { status: 404 });
        },
      },
      async () => okResult("fresh")
    );
    poller.start();
    await waitFor(() => expect(replies(board)).toEqual([{ body: "fresh", parent_id: 6 }]));
    expect(runAgent).toHaveBeenCalledTimes(1);
  });

  it("a stop request arriving during the final activity drain wins over the answer", async () => {
    let stopNow = false;
    const stopped = { agent_sessions: [session({ stop_requested: { at: "now" } })] };
    const { board, poller } = setup(
      {
        unacknowledged: [message(3)],
        getMessage: (id) => message(id, stopNow ? stopped : {}),
        beforeActivity: async (body) => {
          if (body.kind !== "action") return;
          stopNow = true;
          await new Promise((r) => setTimeout(r, 300));
        },
      },
      async (params) => {
        params.onEvent?.({ type: "tool_call", id: "1", name: "read", arguments: {} });
        return okResult("answer");
      }
    );
    poller.start();
    await waitFor(() => expect(replies(board)).toHaveLength(1));
    expect(replies(board)[0]).toEqual({ body: "Stopped on request.", parent_id: 3 });
  });

  it("stop() during the working reaction posts no activity", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { board, runAgent, poller } = setup(
      { unacknowledged: [message(3)], onReaction: async () => (await gate, undefined) },
      async () => okResult("late")
    );
    poller.start();
    await waitFor(() => expect(reactions(board)).toEqual(["👀"]));
    const stopping = poller.stop();
    release();
    await stopping;
    await settle();
    expect(activities(board)).toEqual([]);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("stop() during a failing context read posts no failure and no reply", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { board, poller } = setup(
      {
        unacknowledged: [message(3)],
        onContext: async () => {
          await gate;
          throw new Error("boom");
        },
      },
      async () => okResult("late")
    );
    poller.start();
    await waitFor(() => expect(board.calls.some((c) => c.path.endsWith("/context"))).toBe(true));
    const stopping = poller.stop();
    release();
    await stopping;
    await settle();
    expect(activities(board).map((a) => a.body)).toEqual(["Started"]);
    expect(replies(board)).toEqual([]);
  });

  describe("token at run time", () => {
    const config = (
      token: string | undefined,
      activity: "safe" | "detailed" = "safe"
    ) => ({
      baseUrl: "http://board",
      token,
      pollIntervalMs: 10,
      turnTimeoutMinutes: 60,
      activity,
    });
    const pending = () =>
      Response.json(
        { error: { code: "account_pending", message: "wait" } },
        { status: 403 }
      );

    it("idles without a token and starts once a token appears", async () => {
      let latest = config(undefined);
      const { board, runAgent, poller } = setup(
        { unacknowledged: [message(3)] },
        async () => okResult("Hello"),
        { token: undefined, readConfig: () => latest }
      );
      poller.start();
      await settle(80);
      expect(board.calls).toEqual([]);
      latest = config("new-token");
      await waitFor(() => expect(reactions(board)).toEqual(["👀", "✅"]));
      expect(runAgent).toHaveBeenCalledTimes(1);
      expect(new Set(board.calls.map((c) => c.auth))).toEqual(new Set(["Bearer new-token"]));
    });

    it("does not log a token change on each idle cycle without a token", async () => {
      const info = vi.spyOn(console, "info").mockImplementation(() => {});
      const { poller } = setup({}, async () => okResult("x"), {
        token: undefined,
        readConfig: () => config(undefined),
      });
      poller.start();
      await settle(80);
      await poller.stop();
      // setup() starts with a token, so the switch to no token logs once.
      const changes = info.mock.calls.flat().filter((m) => String(m).includes("token changed"));
      expect(changes).toHaveLength(1);
      info.mockRestore();
    });

    it("drops the old token when the live config disappears", async () => {
      let latest: ReturnType<typeof config> | undefined = config("old-token");
      const { board, poller } = setup({}, async () => okResult("x"), {
        token: "old-token",
        readConfig: () => latest,
      });
      poller.start();
      await waitFor(() => expect(board.calls.length).toBeGreaterThan(0));
      latest = undefined;
      await settle(60);
      board.calls.length = 0;
      await settle(80);
      expect(board.calls).toEqual([]);
      latest = config("new-token");
      await waitFor(() =>
        expect(new Set(board.calls.map((c) => c.auth))).toEqual(new Set(["Bearer new-token"]))
      );
    });

    it("finishes the active turn after disable, idles, and resumes without duplicates", async () => {
      let latest: ReturnType<typeof config> | undefined = config("tok");
      let finish: (() => void) | undefined;
      const { board, runAgent, poller } = setup(
        { unacknowledged: [message(3)] },
        () =>
          new Promise<RunAgentResult>((resolve) => {
            finish = () => resolve(okResult("Hello"));
          }),
        { token: "tok", readConfig: () => latest }
      );
      poller.start();
      await waitFor(() => expect(runAgent).toHaveBeenCalledTimes(1));
      latest = undefined;
      await settle(40);
      finish?.();
      await waitFor(() => expect(replies(board).length).toBe(1));
      board.unacknowledged.length = 0; // The real board acknowledges the item.
      await settle(40);
      board.calls.length = 0;
      await settle(80);
      expect(board.calls).toEqual([]);
      latest = config("tok");
      await waitFor(() => expect(board.calls.length).toBeGreaterThan(0));
      await settle(80);
      expect(runAgent).toHaveBeenCalledTimes(1);
      expect(replies(board)).toEqual([]);
    });

    it.each(["unacknowledged", "processing"] as const)(
      "discards the rest of a %s batch when disabled during item 1",
      async (status) => {
        let latest: ReturnType<typeof config> | undefined = config("tok");
        let finish: (() => void) | undefined;
        const items =
          status === "processing"
            ? [message(3, { agent_sessions: [session()] }), message(4, { agent_sessions: [session()] })]
            : [message(3), message(4)];
        const { runAgent, poller } = setup(
          { [status]: items },
          () =>
            new Promise<RunAgentResult>((resolve) => {
              finish = () => resolve(okResult("Hello"));
            }),
          { token: "tok", readConfig: () => latest }
        );
        poller.start();
        await waitFor(() => expect(runAgent).toHaveBeenCalledTimes(1));
        latest = undefined;
        finish?.();
        await settle(120);
        expect(runAgent).toHaveBeenCalledTimes(1);
      }
    );

    it("runs once across disable and re-enable, and recovers with the rebuilt client", async () => {
      let latest: ReturnType<typeof config> | undefined = config("tok");
      let finish: (() => void) | undefined;
      const { board, runAgent, poller } = setup(
        { unacknowledged: [message(3)] },
        () =>
          new Promise<RunAgentResult>((resolve) => {
            finish = () => resolve(okResult("Hello"));
          }),
        { token: "tok", readConfig: () => latest }
      );
      poller.start();
      await waitFor(() => expect(runAgent).toHaveBeenCalledTimes(1));
      latest = undefined;
      finish?.();
      await waitFor(() => expect(replies(board).length).toBe(1));
      board.unacknowledged.length = 0;
      await settle(60);
      latest = config("tok");
      board.calls.length = 0;
      board.processing = [message(5, { agent_sessions: [session()] })];
      await waitFor(() => expect(runAgent).toHaveBeenCalledTimes(2));
      expect(board.calls.length).toBeGreaterThan(0);
      expect(new Set(board.calls.map((c) => c.auth))).toEqual(new Set(["Bearer tok"]));
    });

    it("aborts a turn that started before disable when the poller shuts down", async () => {
      let latest: ReturnType<typeof config> | undefined = config("tok");
      let signal: AbortSignal | undefined;
      const { runAgent, poller } = setup(
        { unacknowledged: [message(3)] },
        (params) => {
          signal = params.signal;
          return abortable(params);
        },
        { token: "tok", readConfig: () => latest }
      );
      poller.start();
      await waitFor(() => expect(runAgent).toHaveBeenCalledTimes(1));
      latest = undefined;
      await settle(40);
      expect(signal?.aborted).toBe(false);
      await poller.stop();
      expect(signal?.aborted).toBe(true);
    });

    it("stops after disable", async () => {
      let latest: ReturnType<typeof config> | undefined = config("tok");
      const { board, poller } = setup({}, async () => okResult("x"), {
        token: "tok",
        readConfig: () => latest,
      });
      poller.start();
      await waitFor(() => expect(board.calls.length).toBeGreaterThan(0));
      latest = undefined;
      await settle(40);
      await poller.stop();
      latest = config("tok");
      board.calls.length = 0;
      await settle(80);
      expect(board.calls).toEqual([]);
    });

    it("waits while the account is pending, then works after approval", async () => {
      const info = vi.spyOn(console, "info").mockImplementation(() => {});
      let approved = false;
      const { board, runAgent, poller } = setup(
        {
          me: () => (approved ? Response.json(ME) : pending()),
          unacknowledged: [message(3)],
        },
        async () => okResult("Hello")
      );
      poller.start();
      await waitFor(() =>
        expect(board.calls.filter((c) => c.path === "/api/me").length).toBeGreaterThan(2)
      );
      expect(runAgent).not.toHaveBeenCalled();
      expect(info.mock.calls.filter((c) => String(c[0]).includes("waits for approval"))).toHaveLength(1);
      approved = true;
      await waitFor(() => expect(reactions(board)).toEqual(["👀", "✅"]));
      expect(runAgent).toHaveBeenCalledTimes(1);
    });

    it("applies a new token between turns without aborting the running turn", async () => {
      let latest = config("old-token");
      let signal: AbortSignal | undefined;
      let finish: (() => void) | undefined;
      const { board, runAgent, poller } = setup(
        { unacknowledged: [message(3)] },
        (params) => {
          signal = params.signal;
          return new Promise<RunAgentResult>((resolve) => {
            finish = () => resolve(okResult("Hello"));
          });
        },
        { token: "old-token", readConfig: () => latest }
      );
      poller.start();
      await waitFor(() => expect(runAgent).toHaveBeenCalledTimes(1));
      latest = config("new-token");
      await settle(80);
      expect(signal?.aborted).toBe(false);
      finish?.();
      await waitFor(() => expect(reactions(board)).toEqual(["👀", "✅"]));
      const turnAuth = board.calls
        .filter((c) => c.path !== "/api/me" && c.path !== "/api/attention")
        .map((c) => c.auth);
      expect(new Set(turnAuth)).toEqual(new Set(["Bearer old-token"]));
      await waitFor(() =>
        expect(board.calls.some((c) => c.auth === "Bearer new-token" && c.path === "/api/me")).toBe(true)
      );
    });

    it("retries after a rejected token once a new token arrives", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      let latest = config("bad");
      const { board, poller } = setup(
        {
          me: () => Response.json({}, { status: 401 }),
          unacknowledged: [],
        },
        async () => okResult("x"),
        { token: "bad", readConfig: () => latest }
      );
      poller.start();
      await settle(80);
      expect(board.calls.filter((c) => c.path === "/api/me")).toHaveLength(1);
      latest = config("good");
      await waitFor(() =>
        expect(board.calls.filter((c) => c.path === "/api/me")).toHaveLength(2)
      );
      expect(board.calls.at(-1)?.auth).toBe("Bearer good");
    });
  });

  describe("detailed activity", () => {
    it("posts checkpoints and redacted tool targets, never results or text", async () => {
      const { board, poller } = setup(
        { unacknowledged: [message(3)] },
        async (params) => {
          const call = (name: string, args: unknown): StreamEvent => ({
            type: "tool_call",
            id: name,
            name,
            arguments: args,
          });
          params.onEvent?.({ type: "progress", label: "Checked the deploy" });
          params.onEvent?.({ type: "progress", label: "Checked the deploy" });
          params.onEvent?.({ type: "progress", label: "  " });
          params.onEvent?.(call("read", { path: "/home/a/b/c/memory.md" }));
          params.onEvent?.({ type: "text", data: "private-text" });
          params.onEvent?.({ type: "thinking", data: "private-think" } as StreamEvent);
          params.onEvent?.({
            type: "tool_result",
            id: "read",
            name: "read",
            result: "private-result",
          } as unknown as StreamEvent);
          params.onEvent?.(call("task.checkpoint", { label: "x" }));
          params.onEvent?.({ type: "progress", label: "token=ghp_abcdefghijklmnop done" });
          return okResult("Hello");
        },
        { activity: "detailed" }
      );
      poller.start();
      await waitFor(() => expect(reactions(board)).toEqual(["👀", "✅"]));
      const posted = activities(board);
      expect(posted[0]).toEqual({ kind: "thought", body: "Started" });
      expect(posted[1]).toEqual({ kind: "thought", body: "Checked the deploy" });
      expect(posted).toContainEqual({ kind: "thought", body: "token=••• done" });
      const json = JSON.stringify(board.calls);
      for (const secret of ["private", "ghp_", "task.checkpoint"]) {
        expect(json).not.toContain(secret);
      }
      expect(posted).toEqual([
        { kind: "thought", body: "Started" },
        { kind: "thought", body: "Checked the deploy" },
        { kind: "action", body: "Reading …/b/c/memory.md", ephemeral: true },
        { kind: "thought", body: "token=••• done" },
      ]);
    });

    it("coalesces queued actions but keeps every thought", async () => {
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const { board, poller } = setup(
        {
          unacknowledged: [message(3)],
          beforeActivity: (body) => (body.body === "Step one" ? gate : Promise.resolve()),
        },
        async (params) => {
          params.onEvent?.({ type: "progress", label: "Step one" });
          for (const p of ["a.ts", "b.ts", "c.ts"]) {
            params.onEvent?.({ type: "tool_call", id: p, name: "read", arguments: { path: p } });
          }
          params.onEvent?.({ type: "progress", label: "Step two" });
          params.onEvent?.({ type: "tool_call", id: "d", name: "edit", arguments: { path: "d.ts" } });
          params.onEvent?.({ type: "tool_call", id: "e", name: "bash", arguments: { command: "ls -la\nrm x" } });
          release();
          return okResult("ok");
        },
        { activity: "detailed" }
      );
      poller.start();
      await waitFor(() => expect(reactions(board)).toEqual(["👀", "✅"]));
      expect(activities(board)).toEqual([
        { kind: "thought", body: "Started" },
        { kind: "thought", body: "Step one" },
        { kind: "thought", body: "Step two" },
        { kind: "action", body: "Running: ls -la", ephemeral: true },
      ]);
    });

    it("safe mode posts nothing when a tool event is followed by an immediate stop", async () => {
      const { board, poller } = setup({ unacknowledged: [message(3)] }, async (params) => {
        params.onEvent?.({ type: "tool_call", id: "1", name: "read", arguments: {} });
        void poller.stop();
        return { payloads: [], meta: { durationMs: 1, sessionId: "s", aborted: true } };
      });
      poller.start();
      await waitFor(() => expect(activities(board)).toHaveLength(1));
      await settle();
      expect(activities(board)).toEqual([{ kind: "thought", body: "Started" }]);
    });

    it("safe mode drops checkpoints and arguments", async () => {
      const { board, poller } = setup({ unacknowledged: [message(3)] }, async (params) => {
        params.onEvent?.({ type: "progress", label: "Step one" });
        params.onEvent?.({ type: "tool_call", id: "1", name: "read", arguments: { path: "a.ts" } });
        return okResult("ok");
      });
      poller.start();
      await waitFor(() => expect(reactions(board)).toEqual(["👀", "✅"]));
      expect(activities(board)).toEqual([
        { kind: "thought", body: "Started" },
        { kind: "action", body: "Reading files", ephemeral: true },
      ]);
    });

    it("picks up the activity mode from live config per turn", async () => {
      const latest: PollerOptions["config"] = {
        baseUrl: "http://board",
        token: "secret-token",
        pollIntervalMs: 10,
        turnTimeoutMinutes: 60,
        activity: "detailed",
      };
      const { board, poller } = setup(
        { unacknowledged: [message(3)] },
        async (params) => {
          params.onEvent?.({ type: "progress", label: "Live step" });
          return okResult("ok");
        },
        { readConfig: () => latest }
      );
      poller.start();
      await waitFor(() => expect(reactions(board)).toEqual(["👀", "✅"]));
      expect(activities(board)).toContainEqual({ kind: "thought", body: "Live step" });
    });

    it.each([
      ["detailed", "safe"],
      ["safe", "detailed"],
    ] as const)("switches %s -> %s between items of one batch", async (first, second) => {
      let latest: PollerOptions["config"] = {
        baseUrl: "http://board",
        token: "secret-token",
        pollIntervalMs: 10,
        turnTimeoutMinutes: 60,
        activity: first,
      };
      const { board, poller } = setup(
        { unacknowledged: [message(3), message(4)] },
        async (params) => {
          params.onEvent?.({ type: "progress", label: "Step" });
          params.onEvent?.({ type: "tool_call", id: "1", name: "read", arguments: { path: "a.ts" } });
          latest = { ...latest, activity: second };
          return okResult("ok");
        },
        { readConfig: () => latest }
      );
      poller.start();
      await waitFor(() => expect(reactions(board)).toEqual(["👀", "✅", "👀", "✅"]));
      const of = (id: number) =>
        board.calls
          .filter((c) => c.path === `/api/messages/${id}/agent-activities`)
          .map((c) => c.body);
      const expected = (mode: string) =>
        mode === "detailed"
          ? [
              { kind: "thought", body: "Started" },
              { kind: "thought", body: "Step" },
              { kind: "action", body: "Reading a.ts", ephemeral: true },
            ]
          : [
              { kind: "thought", body: "Started" },
              { kind: "action", body: "Reading files", ephemeral: true },
            ];
      expect(of(3)).toEqual(expected(first));
      expect(of(4)).toEqual(expected(second));
    });
  });
});
