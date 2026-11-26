import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { FeedWindow, WsServerMessage } from "@yoplai/shared";
import { expect, it, vi } from "vitest";
import { WebSocket } from "ws";

const feed = "/api/agents/pilot/feed";
const history = "/api/agents/pilot/history?view=full";
const metrics = "/api/ops/metrics";
const warning = "A tool was interrupted by a restart and may have partly run. Check its effects.";
const entry = fileURLToPath(new URL("../test-utils/durable-crash-child.ts", import.meta.url));

async function crashFixture(multiUser = false) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-durable-crash-"));
  const children = new Map<ChildProcess, Promise<unknown[]>>();

  async function kill(child: ChildProcess) {
    const exit = children.get(child);
    children.delete(child);
    if (!exit) throw new Error("Unknown gateway child.");
    child.kill("SIGKILL");
    return exit;
  }

  return {
    async start(phase: "stream" | "tool" | "stop" | "tool-pair" | "resume" | "settled", activeAgent?: string) {
      const args = ["--import", "tsx", "--conditions=development", entry, phase, multiUser ? "multi-user" : "single-user"];
      if (activeAgent) args.push(activeAgent);
      const child = spawn(process.execPath, args, {
        env: { ...process.env, YOPLAI_HOME: home },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      const exit = once(child, "exit");
      children.set(child, exit);
      let stderr = "";
      child.stderr?.setEncoding("utf8").on("data", (text: string) => { stderr += text; });
      const [port] = await Promise.race([
        once(child, "message", { signal: AbortSignal.timeout(15_000) }),
        exit.then(([code, signal]) => { throw new Error("Gateway child exited (" + (signal ?? code) + "): " + stderr); }),
      ]);
      if (typeof port !== "number") throw new Error("Gateway child did not report its port.");
      const base = "http://127.0.0.1:" + port;
      return {
        request: (route: string, init?: RequestInit) => fetch(base + route, { signal: AbortSignal.timeout(5000), ...init }),
        base,
        kill: () => kill(child),
      };
    },
    read: (name: string) => fs.readFile(path.join(home, name), "utf8"),
    exists: (name: string) => fs.stat(path.join(home, name)).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    }),
    async close() {
      await Promise.all([...children.keys()].map(kill));
      await fs.rm(home, { recursive: true, force: true });
    },
  };
}

async function json<T>(response: Response): Promise<T> {
  expect(response.status).toBe(200);
  return response.json() as Promise<T>;
}

type Gateway = Awaited<ReturnType<Awaited<ReturnType<typeof crashFixture>>["start"]>>;

function post(method: "PUT" | "POST", data: unknown, cookie = ""): RequestInit {
  return { method, headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify(data) };
}

async function signUp(gateway: Gateway, name: string) {
  const response = await gateway.request("/api/auth/sign-up/email", post("POST", {
    email: name + "@example.test", name, password: "fixture-password-123",
  }));
  expect(response.ok).toBe(true);
  const cookie = response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  expect(cookie).not.toBe("");
  return cookie;
}

function enableDurable(gateway: Gateway, cookie = "") {
  return gateway.request("/api/me/durable-mode", post("PUT", { enabled: true }, cookie)).then(json);
}

function send(gateway: Gateway, message: string, clientSendId: string, cookie = "") {
  return gateway.request("/api/agents/pilot/messages", post("POST", { message, clientSendId }, cookie))
    .catch((error: unknown) => error);
}

it("starts the kept input after restarting during a marked abort", async () => {
  const fixture = await crashFixture();
  try {
    const original = await fixture.start("stop");
    await enableDurable(original);
    const sending = send(original, "Record the basil seedlings.", "stop-crash");
    await vi.waitFor(async () => expect(await fixture.read("tool-ready.txt")).toBe("ready"), { timeout: 5000 });
    const live = (await json<FeedWindow>(await original.request(feed))).live;
    expect(live?.runId).toEqual(expect.any(String));

    const observer = new WebSocket(original.base.replace("http:", "ws:") + "/ws");
    const events: WsServerMessage[] = [];
    observer.on("message", (raw) => events.push(JSON.parse(String(raw))));
    await once(observer, "open");
    observer.send(JSON.stringify({ type: "subscribe", agentId: "pilot", sessionKey: "main" }));
    const activeTurn = expect.objectContaining({ type: "active_turn", runId: live?.runId });
    await vi.waitFor(() => expect(events).toContainEqual(activeTurn));
    events.length = 0;
    const kept = send(original, "Check the mint after stopping.", "stop-crash-kept");
    await vi.waitFor(() => expect(events).toContainEqual(activeTurn));
    const stopping = original.request("/api/agents/pilot/stop", post("POST", { runId: live?.runId }))
      .catch((error: unknown) => error);
    await vi.waitFor(async () => expect(await fixture.read("abort-ready.txt")).toBe("ready"));
    expect(await original.kill()).toEqual([null, "SIGKILL"]);
    expect(await Promise.all([sending, kept, stopping])).toEqual([expect.any(Error), expect.any(Error), expect.any(Error)]);

    const recovered = await fixture.start("resume");
    await vi.waitFor(async () => {
      expect(await fixture.read("model-resume.jsonl")).toContain("[from Local user via web]\\nCheck the mint after stopping.");
    }, { timeout: 5000 });
    await vi.waitFor(async () => {
      const window = await json<FeedWindow>(await recovered.request(feed));
      expect(window.live).toBeNull();
      expect(window.items.at(-1)).toMatchObject({ role: "assistant", text: "The greenhouse is accounted for." });
    });
    expect(await fixture.read("tool-executions.txt")).toBe("Recorded seedlings.\n");
  } finally {
    await fixture.close();
  }
}, 45_000);

it.each([false, true])("resumes a killed model stream before receiving a request (multi-user: %s)", async (multiUser) => {
  const fixture = await crashFixture(multiUser);
  try {
    const original = await fixture.start("stream");
    const alice = multiUser ? await signUp(original, "alice") : "";
    if (multiUser) await signUp(original, "bob");
    const owner = { headers: { Cookie: alice } };
    await enableDurable(original, alice);
    const sending = send(original, "Account for the greenhouse.", "stream-crash", alice);
    await vi.waitFor(async () => {
      expect(await json(await original.request(history, owner))).toMatchObject({
        isStreaming: true, activeTurn: { text: expect.stringContaining("An unfinished") },
      });
    }, { timeout: 5000 });
    expect(await original.kill()).toEqual([null, "SIGKILL"]);
    expect(await sending).toBeInstanceOf(Error);

    if (!multiUser) {
      const inactive = await fixture.start("settled", "spare");
      expect(await json(await inactive.request("/api/agents/spare/feed", owner))).toMatchObject({ items: [] });
      // The active host is open. Give any background request time to reach the model sink.
      await setTimeout(1200);
      expect(await fixture.exists("model-settled.jsonl")).toBe(false);
      expect(await inactive.kill()).toEqual([null, "SIGKILL"]);
    }

    const recovered = await fixture.start("resume");
    await vi.waitFor(async () => {
      expect(await fixture.read("model-resume.jsonl")).toContain("Account for the greenhouse.");
    }, { timeout: 5000 });
    await vi.waitFor(async () => {
      const window = await json<FeedWindow>(await recovered.request(feed, owner));
      expect(window.live).toBeNull();
      expect(window.items.map(({ role, text }) => ({ role, text }))).toEqual([
        { role: "user", text: "Account for the greenhouse." },
        { role: "assistant", text: "The greenhouse is accounted for." },
      ]);
    });
    expect(await json(await recovered.request(metrics, owner))).toEqual({ metrics: [] });
  } finally {
    await fixture.close();
  }
}, 45_000);

it.each([false, true])("recovers a killed tool exactly once and scopes the notice and metric (multi-user: %s)", async (multiUser) => {
  const fixture = await crashFixture(multiUser);
  try {
    const original = await fixture.start("tool");
    const alice = multiUser ? await signUp(original, "alice") : "";
    const bob = multiUser ? await signUp(original, "bob") : "";
    await enableDurable(original, alice);
    if (multiUser) await enableDurable(original, bob);
    const sending = send(original, "Record the basil seedlings.", "tool-crash", alice);
    await vi.waitFor(async () => {
      expect(await fixture.read("tool-ready.txt")).toBe("ready");
    }, { timeout: 5000 });
    expect(await original.kill()).toEqual([null, "SIGKILL"]);
    expect(await sending).toBeInstanceOf(Error);
    expect(await fixture.read("tool-executions.txt")).toBe("Recorded seedlings.\n");

    const recovered = await fixture.start("resume");
    // Reading any agent route earlier would trigger the lazy host open and hide a startup regression.
    const modelRequest = await vi.waitFor(async () => {
      const first = (await fixture.read("model-resume.jsonl")).split("\n")[0];
      return JSON.parse(first) as unknown;
    }, { timeout: 5000 });
    expect(modelRequest).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "assistant", content: [expect.objectContaining({
        type: "toolCall", id: "basil-record", name: "record_seedlings", arguments: { bed: "basil" },
      })] }),
      expect.objectContaining({ role: "toolResult", toolCallId: "basil-record", toolName: "record_seedlings", isError: true,
        content: expect.arrayContaining([
          { type: "text", text: expect.stringContaining("Partial receipt: basil seedlings.") },
          { type: "text", text: expect.stringContaining("may have partially run") },
        ]),
      }),
    ]));
    expect(JSON.stringify(modelRequest)).not.toContain(warning);
    const owner = { headers: { Cookie: alice } };
    const window = await vi.waitFor(async () => {
      const projection = await json<FeedWindow>(await recovered.request(feed, owner));
      expect(projection.live).toBeNull();
      expect(projection.items.map(({ role, text }) => ({ role, text }))).toEqual([
        { role: "user", text: "Record the basil seedlings." },
        { role: "assistant", text: "" },
        { role: "failure", text: warning },
        { role: "assistant", text: "The greenhouse is accounted for." },
      ]);
      return projection;
    }, { timeout: 5000 });
    expect(window.items[2]).toMatchObject({ kind: "tool_interrupted" });
    expect(await json(await recovered.request(history, owner))).toMatchObject({
      messages: [
        { role: "user" }, { role: "assistant" }, { role: "toolResult" },
        { role: "assistant", content: [{ type: "text", text: warning }], meta: { failure: { kind: "tool_interrupted" } } },
        { role: "assistant", content: [{ type: "text", text: "The greenhouse is accounted for." }] },
      ],
    });

    const socket = new WebSocket(recovered.base.replace("http:", "ws:") + "/ws", owner);
    try {
      await once(socket, "open", { signal: AbortSignal.timeout(5000) });
      const received = once(socket, "message", { signal: AbortSignal.timeout(5000) });
      socket.send(JSON.stringify({ type: "subscribeFeed", agentId: "pilot" }));
      const [raw] = await received;
      const snapshot: WsServerMessage = JSON.parse(raw.toString());
      expect(snapshot).toMatchObject({ type: "feed_snapshot", items: window.items, live: null });
    } finally {
      socket.terminate();
    }

    expect(await json(await recovered.request(metrics, owner))).toEqual({
      metrics: [{ id: "interrupted_tool_calls", agentId: "pilot", value: 1 }],
    });
    expect(await fixture.exists("agents/spare/durable/agent.sqlite")).toBe(false);
    if (multiUser) {
      const other = { headers: { Cookie: bob } };
      expect(await json<FeedWindow>(await recovered.request(feed, other))).toMatchObject({ items: [] });
      expect((await recovered.request(metrics, other)).status).toBe(403);
      expect((await recovered.request(metrics)).status).toBe(401);
    }

    expect(await recovered.kill()).toEqual([null, "SIGKILL"]);
    const settled = await fixture.start("settled");
    expect(await json(await settled.request(feed, owner))).toEqual(window);
    expect(await json(await settled.request(metrics, owner))).toEqual({ metrics: [] });
    expect(await fixture.read("tool-executions.txt")).toBe("Recorded seedlings.\n");
    expect(await fixture.exists("model-settled.jsonl")).toBe(false);
  } finally {
    await fixture.close();
  }
}, 45_000);

it("resumes an interrupted thread and retains its dashboard and feed after a killed gateway", async () => {
  const fixture = await crashFixture();
  try {
    const original = await fixture.start("stream");
    await enableDurable(original);
    const threads = "/api/agents/pilot/threads";
    const created = await original.request(threads, post("POST", { dashboardId: "orchard/board" }));
    expect(created.status).toBe(201);
    const thread = await created.json() as { id: string };
    const threadFeed = feed + "?thread=" + thread.id;
    const pending = original.request("/api/agents/pilot/messages", post("POST", {
      message: "Account for the orchard.", clientSendId: "thread-crash", sessionId: "thread:" + thread.id,
    })).catch((error: unknown) => error);
    await vi.waitFor(async () => {
      expect((await json<FeedWindow>(await original.request(threadFeed))).live?.text).toContain("An unfinished");
    }, { timeout: 5000 });
    expect(await original.kill()).toEqual([null, "SIGKILL"]);
    expect(await pending).toBeInstanceOf(Error);

    const recovered = await fixture.start("resume");
    await vi.waitFor(async () => {
      expect(await fixture.read("model-resume.jsonl")).toContain("Account for the orchard.");
    }, { timeout: 5000 });
    expect(await json(await recovered.request(threads))).toMatchObject([{
      id: thread.id, dashboardId: "orchard/board", closed: false, generation: 1,
    }]);
    await vi.waitFor(async () => {
      const window = await json<FeedWindow>(await recovered.request(threadFeed));
      expect(window.live).toBeNull();
      expect(window.items.map(({ text }) => text)).toEqual([
        "Account for the orchard.", "The greenhouse is accounted for.",
      ]);
    });
    expect((await json<FeedWindow>(await recovered.request(feed))).items).toEqual([]);
  } finally {
    await fixture.close();
  }
}, 45_000);


it("forks an interrupted round with results for both sibling calls", async () => {
  const fixture = await crashFixture();
  try {
    const original = await fixture.start("tool-pair");
    await enableDurable(original);
    const sending = send(original, "Record both seedling beds.", "tool-pair-crash");
    await vi.waitFor(async () => {
      expect(await fixture.read("tool-executions.txt")).toBe("Recorded seedlings.\nRecorded seedlings.\n");
      expect(await fixture.read("tool-ready.txt")).toBe("ready");
    }, { timeout: 5000 });
    await original.kill();
    expect(await sending).toBeInstanceOf(Error);

    const recovered = await fixture.start("resume");
    const answer = await vi.waitFor(async () => {
      const window = await json<FeedWindow>(await recovered.request(feed));
      expect(window.live).toBeNull();
      expect(window.items.map(({ role }) => role)).toEqual(["user", "assistant", "failure", "failure", "assistant"]);
      expect(window.items[1]).toMatchObject({ text: "Recording two beds.", toolCallCount: 2 });
      return window.items[1]!;
    }, { timeout: 5000 });
    const created = await recovered.request("/api/agents/pilot/threads", post("POST", { messageId: answer.id }));
    expect(created.status).toBe(201);
    const { id } = await created.json() as { id: string };
    const detail = await json(await recovered.request(feed + "/messages/" + answer.id + "?thread=" + id));
    expect(detail).toMatchObject({
      toolCalls: [{ id: "basil-record", status: "error" }, { id: "mint-record", status: "error" }],
    });
    await json(await recovered.request("/api/agents/pilot/messages", post("POST", {
      sessionId: "thread:" + id, message: "Review receipts in the fork.", clientSendId: "review-fork",
    })));
    const capture = (await fixture.read("model-resume.jsonl")).trim().split("\n").at(-1)!;
    const request = JSON.parse(capture) as { role: string; toolCallId?: string }[];
    const results = request.filter(({ role }) => role === "toolResult");
    expect(results).toHaveLength(2);
    for (const toolCallId of ["basil-record", "mint-record"]) {
      expect(results).toContainEqual(expect.objectContaining({
        toolCallId, isError: true,
        content: expect.arrayContaining([{ type: "text", text: expect.stringContaining("may have partially run") }]),
      }));
    }
    expect(capture).not.toContain("The greenhouse is accounted for.");
  } finally {
    await fixture.close();
  }
}, 45_000);
