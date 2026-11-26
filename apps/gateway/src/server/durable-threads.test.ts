import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { FeedWindow } from "@yoplai/shared";
import { expect, it, vi } from "vitest";
import { sessionHistoryExtension } from "../session-history/index.js";
import { startDurableTestGateway } from "../test-utils/durable-gateway.js";

type Gateway = Awaited<ReturnType<typeof startDurableTestGateway>>;
type User = Parameters<Gateway["request"]>[0];
type Thread = {
  id: string;
  title: string;
  preview: string;
  createdAt: number;
  lastActivityAt: number;
  closed: boolean;
  generation: number;
  dashboardId?: string;
  forkedFrom?: string;
};

const agent = "/api/agents/pilot";
const threads = agent + "/threads";

function deferred<T>() {
  let resolve!: (result: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function post(gateway: Gateway, path: string, body: object, user: User = "local") {
  return gateway.request(user, path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function create(gateway: Gateway, body = {}, user: User = "local") {
  const response = await post(gateway, threads, body, user);
  expect(response.status).toBe(201);
  return await response.json() as Thread;
}

it("creates and lists an empty thread with a dashboard reference", async () => {
  const gateway = await startDurableTestGateway();
  try {
    const thread = await create(gateway, { dashboardId: " draft/board " });
    expect(thread).toEqual({
      id: expect.any(String),
      title: "New thread",
      preview: "",
      createdAt: expect.any(Number),
      lastActivityAt: thread.createdAt,
      closed: false,
      generation: 1,
      dashboardId: " draft/board ",
    });
    expect(thread.id).toBeTruthy();
    const list = await gateway.request("local", threads);
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual([thread]);
  } finally {
    await gateway.close();
  }
}, 20_000);

async function feed(gateway: Gateway, id?: string, user: User = "local") {
  const response = await gateway.request(user, agent + "/feed" + (id === undefined ? "" : "?thread=" + id));
  expect(response.status).toBe(200);
  return await response.json() as FeedWindow;
}

async function send(gateway: Gateway, text: string, id?: string, user: User = "local") {
  const response = await gateway.send(user, text, { clientSendId: randomUUID(), ...(id && { sessionId: "thread:" + id }) });
  expect(response.status, await response.clone().text()).toBe(200);
  return response;
}

function requestText(gateway: Gateway, index = -1) {
  return gateway.requests.at(index)?.messages.filter(({ role }) => role === "user" || role === "assistant").map((message) =>
    typeof message.content === "string" ? message.content :
      message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n"));
}

it("starts an empty thread with the owner's memory and isolates its chat from Main", async () => {
  const onBatch = vi.fn();
  const gateway = await startDurableTestGateway({ keeper: { idleMs: 60_000, turns: 1, onBatch } });
  const { MaintenanceCompletion } = await import("../maintenance/completion.js");
  const complete = vi.spyOn(MaintenanceCompletion, "complete").mockResolvedValue(JSON.stringify({
    topics: [{ kind: "decision", title: "Kiln", note: "Fire on Friday." }],
  }));
  try {
    gateway.script("Friday is booked.", "Try glazing a cup.", "Main is ready.");
    await send(gateway, "Book the kiln.");
    await vi.waitFor(() => expect(onBatch).toHaveBeenCalledWith("committed"));
    const thread = await create(gateway);
    const sent = await send(gateway, "Explore a glaze.", thread.id);
    expect(await sent.json()).toMatchObject({ meta: { sessionId: "thread:" + thread.id } });
    expect(requestText(gateway)).toEqual([
      expect.stringContaining("- Decision: Kiln: Fire on Friday."),
      expect.stringContaining("\nExplore a glaze."),
    ]);
    const threadFeed = await feed(gateway, thread.id);
    expect(threadFeed.items.map(({ text }) => text)).toEqual(["Explore a glaze.", "Try glazing a cup."]);
    expect((await (await gateway.request("local", threads)).json())[0]).toMatchObject({
      title: "Explore a glaze.", preview: "Try glazing a cup.", lastActivityAt: threadFeed.items.at(-1)?.timestamp,
    });
    await send(gateway, "Return to the booking.");
    expect(requestText(gateway)).toEqual([
      expect.stringContaining("\nBook the kiln."), "Friday is booked.", expect.stringContaining("\nReturn to the booking."),
    ]);
    await vi.waitFor(() => expect(onBatch).toHaveBeenCalledTimes(2));
    expect(complete.mock.calls[1]?.[0].prompt).toContain("Return to the booking.");
    expect(complete.mock.calls.flatMap(([request]) => request.prompt)).not.toEqual(expect.arrayContaining([expect.stringContaining("Explore a glaze.")]));
  } finally {
    await gateway.close();
    complete.mockRestore();
  }
}, 20_000);

it("forks the complete settled Main answer, keeps its message IDs and lists only own activity", async () => {
  const onBatch = vi.fn();
  const gateway = await startDurableTestGateway({
    extraYaml: "toolDeferral: { enabled: false }", keeper: { idleMs: 60_000, turns: 1, onBatch },
    fixture: { extension: defineExtension({
      name: "stockroom",
      tools: [defineTool({
        name: "check_stock", description: "Check the stockroom.", parameters: { type: "object" },
        execute: async () => ({ output: [{ type: "text", text: "Stockroom checked." }] }),
      })],
    }) },
  });
  const { MaintenanceCompletion } = await import("../maintenance/completion.js");
  const complete = vi.spyOn(MaintenanceCompletion, "complete").mockResolvedValue(JSON.stringify({
    topics: [{ kind: "decision", title: "Inventory", note: "Count shelves monthly." }],
  }));
  const held = deferred<string>();
  try {
    gateway.script(
      ["Checking the plan.", { tool: "check_stock", id: "plan" }],
      ["Checking the topics.", { tool: "check_stock", id: "topics" }],
      () => held.promise,
      "Main moved on.",
      "Check the east shelf.",
    );
    const sending = send(gateway, "Review the stockroom.");
    let inheritedId = "";
    await vi.waitFor(async () => {
      expect(gateway.requests).toHaveLength(3);
      const snapshot = await feed(gateway);
      const answer = snapshot.items.find(({ role }) => role === "assistant");
      expect(answer?.text).toContain("Checking the topics.");
      inheritedId = answer!.id;
    });
    const running = await post(gateway, threads, { messageId: inheritedId });
    expect(running.status).toBe(409);
    expect(await running.json()).toEqual({ error: "Message is still running" });

    held.resolve("The stockroom is ready.");
    await sending;
    await vi.waitFor(() => expect(onBatch).toHaveBeenCalledWith("committed"));
    const inherited = (await feed(gateway)).items;
    expect(inherited.at(-1)).toMatchObject({
      id: inheritedId, text: "Checking the plan.\nChecking the topics.\nThe stockroom is ready.", toolCallCount: 2,
    });
    await send(gateway, "Main-only follow-up.");
    const fork = await create(gateway, { messageId: inheritedId });
    expect(fork).toMatchObject({
      forkedFrom: inheritedId, title: "Checking the plan.", preview: "Checking the plan.", lastActivityAt: fork.createdAt,
    });
    expect((await feed(gateway, fork.id)).items).toEqual(inherited);

    await send(gateway, "Inspect a shelf.\nSecond line.", fork.id);
    const history = gateway.requests.at(-1)?.messages ?? [];
    expect(history.flatMap((message) => message.role === "toolResult" ? [message.toolCallId] : [])).toEqual(["plan", "topics"]);
    expect(requestText(gateway)?.slice(-3)).toEqual([
      "The stockroom is ready.",
      expect.stringContaining("- Decision: Inventory: Count shelves monthly."),
      expect.stringContaining("\nInspect a shelf.\nSecond line."),
    ]);
    expect(requestText(gateway)?.join("\n")).not.toContain("Main-only follow-up.");
    const items = (await feed(gateway, fork.id)).items;
    expect(items.slice(0, 2)).toEqual(inherited);
    const lastMain = (await feed(gateway)).items.at(-1)!;
    expect(Number(items[2]?.id.slice(2))).toBeGreaterThan(Number(lastMain.id.slice(2)));
    expect((await (await gateway.request("local", threads)).json())[0]).toMatchObject({
      title: "Inspect a shelf.", preview: "Check the east shelf.", lastActivityAt: items.at(-1)?.timestamp,
    });
    const detail = await gateway.request("local", agent + "/feed/messages/" + inheritedId + "?thread=" + fork.id);
    expect(await detail.json()).toMatchObject({
      id: inheritedId, toolCalls: [{ id: "plan", status: "done" }, { id: "topics", status: "done" }],
    });
    const search = await gateway.request("local", agent + "/feed/search?q=east+shelf&thread=" + fork.id);
    expect(await search.json()).toMatchObject({ hits: [{ id: items.at(-1)?.id }] });
    const missing = await post(gateway, threads, { messageId: "m_999999" });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Message not found" });
  } finally {
    held.resolve("Released.");
    await gateway.close();
    complete.mockRestore();
  }
}, 20_000);

async function idle(gateway: Gateway, id: string, user: User = "local") {
  await vi.waitFor(async () => expect((await feed(gateway, id, user)).live).toBeNull());
}

async function close(gateway: Gateway, thread: Thread, user: User = "local") {
  const response = await post(gateway, threads + "/" + thread.id + "/close", { generation: thread.generation }, user);
  expect(response.status, await response.clone().text()).toBe(200);
  return await response.json() as Thread;
}

async function reopen(gateway: Gateway, id: string, user: User = "local") {
  const response = await post(gateway, threads + "/" + id + "/reopen", {}, user);
  expect(response.status, await response.clone().text()).toBe(200);
  return await response.json() as Thread;
}

function toolText(gateway: Gateway, id: string) {
  const result = gateway.requests.at(-1)?.messages.find((message) => message.role === "toolResult" && message.toolCallId === id);
  if (result?.role !== "toolResult") throw new Error("Missing result for " + id);
  expect(result.isError).toBe(false);
  const block = result.content[0];
  if (block?.type !== "text") throw new Error("Missing text result for " + id);
  return block.text;
}

it("archives once per generation, restores the dashboard on reopen and rejects stale closes", async () => {
  const gateway = await startDurableTestGateway();
  try {
    const older = await create(gateway);
    const thread = await create(gateway, { title: "Shipping", dashboardId: "shipping/board" });
    gateway.script("Use the night train.\nBook two boxes.", { tool: "topics_get", id: "shipping" }, "Topic read.", "Use the ferry.");
    await send(gateway, "Compare departure times.", thread.id);
    await idle(gateway, thread.id);
    const [closed, retry] = await Promise.all([close(gateway, thread), close(gateway, thread)]);
    expect(closed).toMatchObject({ closed: true, generation: 1, preview: "Use the night train.", dashboardId: "shipping/board" });
    expect(retry).toEqual(closed);
    expect(await (await gateway.request("local", threads)).json()).toEqual([closed, older]);
    const denied = await gateway.send("local", "Do not send", { sessionId: "thread:" + thread.id, clientSendId: "archived" });
    expect(denied.status).toBe(409);
    expect(await denied.json()).toEqual({ error: "Thread is closed" });

    await send(gateway, "Read the shipping decision.");
    expect(requestText(gateway)?.filter((text) => text.startsWith('[thread "Shipping" closed]'))).toEqual([
      '[thread "Shipping" closed] Use the night train.',
    ]);
    expect(JSON.parse(toolText(gateway, "shipping"))).toMatchObject({ topics: [
      { id: "th_" + thread.id, kind: "digest", title: "Shipping", note: "Use the night train." },
    ] });
    expect((await feed(gateway)).items.map(({ text }) => text)).toEqual(["Read the shipping decision.", "Topic read."]);

    const reopened = await reopen(gateway, thread.id);
    expect(reopened).toEqual({ ...closed, closed: false, generation: 2 });
    expect(await reopen(gateway, thread.id)).toEqual(reopened);
    const stale = await post(gateway, threads + "/" + thread.id + "/close", { generation: 1 });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "Stale generation" });
    await send(gateway, "Compare with the ferry.", thread.id);
    expect(requestText(gateway)).toEqual([
      expect.stringContaining("\nCompare departure times."),
      "Use the night train.\nBook two boxes.",
      expect.stringContaining("\nCompare with the ferry."),
    ]);
  } finally {
    await gateway.close();
  }
}, 20_000);

it("keeps a new and then a replaced digest when an older keeper snapshot commits", async () => {
  const onBatch = vi.fn();
  const gateway = await startDurableTestGateway({ keeper: { idleMs: 60_000, turns: 1, onBatch } });
  const { MaintenanceCompletion } = await import("../maintenance/completion.js");
  const first = deferred<string>();
  const second = deferred<string>();
  const complete = vi.spyOn(MaintenanceCompletion, "complete")
    .mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockResolvedValue('{"topics":[]}');
  try {
    const thread = await create(gateway, { title: "Meetup" });
    gateway.script("Meet on Friday.", "Main noted.", "Meet on Saturday.", { tool: "topics_get", id: "first-digest" }, "Read Friday.",
      { tool: "topics_get", id: "second-digest" }, "Read Saturday.");
    await send(gateway, "Pick a day.", thread.id);
    await idle(gateway, thread.id);
    await send(gateway, "Update the guest list.");
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    await close(gateway, thread);
    first.resolve('{"topics":[]}');
    await vi.waitFor(() => expect(onBatch.mock.calls).toEqual([["committed"]]));

    const reopened = await reopen(gateway, thread.id);
    await send(gateway, "Pick a new day.", thread.id);
    await idle(gateway, thread.id);
    await send(gateway, "What day did we pick?");
    expect(JSON.parse(toolText(gateway, "first-digest"))).toMatchObject({
      topics: [{ id: "th_" + thread.id, note: "Meet on Friday." }],
    });
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2));
    expect(complete.mock.calls[1]?.[0].prompt).toContain("Meet on Friday.");
    await close(gateway, reopened);
    second.resolve(JSON.stringify({ topics: [{ id: "th_" + thread.id, note: "Stale Friday note." }] }));
    await vi.waitFor(() => expect(onBatch.mock.calls).toEqual([["committed"], ["committed"]]));

    await send(gateway, "Read the changed day.");
    expect(JSON.parse(toolText(gateway, "second-digest"))).toMatchObject({
      topics: [{ id: "th_" + thread.id, note: "Meet on Saturday." }],
    });
    expect(requestText(gateway)?.filter((text) => text.startsWith('[thread "Meetup" closed]'))).toEqual([
      '[thread "Meetup" closed] Meet on Friday.',
      '[thread "Meetup" closed] Meet on Saturday.',
    ]);
  } finally {
    first.resolve('{"topics":[]}');
    second.resolve('{"topics":[]}');
    await gateway.close();
    complete.mockRestore();
  }
}, 20_000);

it.each(["endpoint", "/stop", "/abort"])("stops a live thread via %s and leaves Main's events alone", async (stop) => {
  const release = deferred<void>();
  const gateway = await startDurableTestGateway({
    extraYaml: "toolDeferral: { enabled: false }",
    fixture: { extension: defineExtension({
      name: "thread-stop-fixture",
      tools: [defineTool({
        name: "wait_for_stock", description: "Wait for the stock count.", parameters: { type: "object" },
        async execute(_args, _api, context) {
          context.abortSignal?.addEventListener("abort", () => release.resolve(), { once: true });
          await release.promise;
          return { output: [{ type: "text", text: "Done waiting." }] };
        },
      })],
    }) },
  });
  try {
    const thread = await create(gateway);
    const observer = await gateway.subscribe("local");
    await observer.flush();
    gateway.script({ tool: "wait_for_stock", id: "stock" }, "Finished stock count.");
    const sending = gateway.send("local", "Wait for the stock count.", { sessionId: "thread:" + thread.id, clientSendId: "stock" });
    const runId = await vi.waitFor(async () => {
      const { live } = await feed(gateway, thread.id);
      expect(live?.toolCalls).toContainEqual(expect.objectContaining({ id: "stock", status: "running" }));
      expect(live?.runId).toEqual(expect.any(String));
      return live?.runId;
    });
    const closing = await post(gateway, threads + "/" + thread.id + "/close", { generation: thread.generation });
    expect(closing.status).toBe(409);
    expect(await closing.json()).toEqual({ error: "Stop the thread before closing it" });
    const stopping = stop === "endpoint"
      ? await post(gateway, agent + "/stop", { threadId: thread.id, runId })
      : await gateway.send("local", stop, { sessionId: "thread:" + thread.id });
    expect(stopping.status).toBe(200);
    expect(await stopping.json()).toEqual({ status: "stopped" });
    expect(await (await sending).json()).toMatchObject({ meta: { aborted: true, sessionId: "thread:" + thread.id } });
    await idle(gateway, thread.id);
    await observer.flush();
    expect(observer.events.filter(({ type }) => type === "active_turn" || type === "history_updated")).toEqual([]);
    expect((await feed(gateway)).items).toEqual([]);
  } finally {
    release.resolve();
    await gateway.close();
  }
}, 20_000);

it("lists open and closed threads in session_history and searches multi-conversation history without duplicate fork hits", async () => {
  const gateway = await startDurableTestGateway({
    fixtureExtensions: [sessionHistoryExtension], extraYaml: "toolDeferral: { enabled: false }",
  });
  try {
    gateway.script("The juniper box is upstairs.", [
      { tool: "session_history", id: "list", args: { action: "list" } },
      { tool: "session_history", id: "search", args: { action: "search", query: "juniper", role: "assistant" } },
      { tool: "session_history", id: "read", args: { action: "read" } },
    ], "Branch read.");
    await send(gateway, "Where is the crate?");
    const parent = (await feed(gateway)).items.at(-1)!;
    const fork = await create(gateway, { messageId: parent.id });
    const archived = await close(gateway, await create(gateway, { title: "Folding Cart" }));
    await send(gateway, "Sketch a storage rack.", fork.id);

    const rows = toolText(gateway, "list").split("\n");
    expect(rows).toEqual(expect.arrayContaining([
      expect.stringMatching(/^durable-main · .* · 2 msgs · Where is the crate\?$/),
      expect.stringMatching(new RegExp("^thread:" + fork.id + " · .* · 2 msgs · Sketch a storage rack\\. ★ CURRENT CONVERSATION$")),
      expect.stringMatching(new RegExp("^thread:" + archived.id + " · .* · 0 msgs · Folding Cart · closed$")),
    ]));
    expect(rows.filter((row) => row.includes("CURRENT CONVERSATION"))).toHaveLength(1);
    const hits = toolText(gateway, "search").split("\n").filter((line) => line.startsWith("[m_"));
    expect(hits).toEqual([expect.stringContaining("[" + parent.id + "]")]);
    const transcript = toolText(gateway, "read");
    expect(transcript).toContain("conversation thread:" + fork.id);
    expect(transcript).toContain("[" + parent.id + "]");
    expect(transcript).toContain("Sketch a storage rack.");

    gateway.script("Move the juniper box to the annex.",
      { tool: "session_history", id: "newest", args: { action: "search", query: "juniper", role: "assistant", limit: 1 } },
      "Found the move.");
    await send(gateway, "Find a different place for the box.", fork.id);
    await send(gateway, "Find the newest mention of the box.");
    const newest = toolText(gateway, "newest");
    expect(newest).toContain("conversation thread:" + fork.id);
    expect(newest).toContain("Move the juniper box to the annex.");
    expect(newest).not.toContain("The juniper box is upstairs.");
  } finally {
    await gateway.close();
  }
}, 20_000);

it("finishes an interrupted archive when the thread is reopened after restart", async () => {
  let interrupt = true;
  const gateway = await startDurableTestGateway({
    afterThreadArchive() {
      if (!interrupt) return;
      interrupt = false;
      throw new Error("Fixture stopped after archiving.");
    },
  });
  try {
    const thread = await create(gateway, { title: "Roof", dashboardId: "roof" });
    gateway.script("Seal the west edge.", { tool: "topics_get", id: "recovered-digest" }, "Recovered.");
    await send(gateway, "Check the roof.", thread.id);
    await idle(gateway, thread.id);
    const closing = await post(gateway, threads + "/" + thread.id + "/close", { generation: thread.generation });
    expect(closing.status).toBe(500);
    await gateway.restart();
    expect(await (await gateway.request("local", threads)).json()).toMatchObject([
      { id: thread.id, closed: true, generation: 1 },
    ]);

    const restored = await reopen(gateway, thread.id);
    expect(restored).toMatchObject({ id: thread.id, closed: false, generation: 2, dashboardId: "roof" });
    expect(await reopen(gateway, thread.id)).toEqual(restored);
    await send(gateway, "Recall the roof decision.");
    expect(JSON.parse(toolText(gateway, "recovered-digest"))).toMatchObject({
      topics: [{ id: "th_" + thread.id, note: "Seal the west edge." }],
    });
    expect(requestText(gateway)?.filter((text) => text.startsWith('[thread "Roof" closed]'))).toEqual([
      '[thread "Roof" closed] Seal the west edge.',
    ]);
  } finally {
    await gateway.close();
  }
}, 20_000);

it("keeps threads private across the authenticated HTTP routes and session_history", async () => {
  const gateway = await startDurableTestGateway({
    multiUser: true, fixtureExtensions: [sessionHistoryExtension], extraYaml: "toolDeferral: { enabled: false }",
  });
  try {
    gateway.script("Alice's Main reply.", "Alice's thread reply.", [
      { tool: "session_history", id: "bob-list", args: { action: "list" } },
    ], "Bob's Main reply.");
    await send(gateway, "Alice's planning question.", undefined, "alice");
    const answer = (await feed(gateway, undefined, "alice")).items.at(-1)!;
    const alice = await create(gateway, { title: "Orchard Budget" }, "alice");
    await send(gateway, "Alice's private draft.", alice.id, "alice");
    const item = (await feed(gateway, alice.id, "alice")).items.at(-1)!;
    await idle(gateway, alice.id, "alice");
    const archived = await close(gateway, alice, "alice");
    expect(archived.closed).toBe(true);

    const ref = "thread:" + alice.id;
    const forbidden = [
      await post(gateway, threads + "/" + alice.id + "/close", { generation: 1 }, "bob"),
      await post(gateway, threads + "/" + alice.id + "/reopen", {}, "bob"),
      await post(gateway, agent + "/stop", { threadId: alice.id }, "bob"),
      await gateway.send("bob", "Bob's attempted send.", { sessionId: ref, clientSendId: "bob-send" }),
      await gateway.send("bob", "/abort", { sessionId: ref }),
      await gateway.request("bob", agent + "/feed?thread=" + alice.id),
      await gateway.request("bob", agent + "/feed/search?q=draft&thread=" + alice.id),
      await gateway.request("bob", agent + "/feed/messages/" + item.id + "?thread=" + alice.id),
    ];
    for (const response of forbidden) {
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Thread not found" });
    }
    expect(await (await gateway.request("bob", threads)).json()).toEqual([]);
    for (const main of ["main", "durable-main"]) {
      const mainClose = await post(gateway, threads + "/" + main + "/close", { generation: 1 }, "bob");
      expect(mainClose.status).toBe(400);
      expect(await mainClose.json()).toEqual({ error: "Main cannot be closed" });
    }
    await send(gateway, "List Bob's conversations.", undefined, "bob");
    expect(toolText(gateway, "bob-list")).toMatch(/^durable-main · .* · List Bob's conversations\. ★ CURRENT CONVERSATION$/);
    expect(toolText(gateway, "bob-list")).not.toContain(ref);
    gateway.script({ tool: "session_history", id: "bob-read", args: { action: "read", session: ref } }, "No private read.");
    await send(gateway, "Try reading Alice's thread.", undefined, "bob");
    expect(toolText(gateway, "bob-read")).toBe("no such session: " + ref);
    const missing = await post(gateway, threads, { messageId: answer.id }, "bob");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Message not found" });

    await gateway.setDurableMode("bob", false);
    expect((await gateway.request("bob", threads)).status).toBe(404);
    expect((await gateway.send("bob", "Durable mode is off.", { sessionId: ref, clientSendId: "mode-off" })).status).toBe(404);
  } finally {
    await gateway.close();
  }
}, 20_000);

it("never seeds a thread late when its first send had empty memory", async () => {
  const onBatch = vi.fn();
  const gateway = await startDurableTestGateway({ keeper: { idleMs: 60_000, turns: 1, onBatch } });
  const { MaintenanceCompletion } = await import("../maintenance/completion.js");
  const complete = vi.spyOn(MaintenanceCompletion, "complete").mockResolvedValue(JSON.stringify({
    topics: [{ kind: "decision", title: "Shed", note: "Use pine." }],
  }));
  try {
    const thread = await create(gateway);
    gateway.script("Use the small brush.", "Pine is ready.", "Rinse the brush.");
    await send(gateway, "Pick a brush.", thread.id);
    expect(requestText(gateway)).toEqual([expect.stringContaining("\nPick a brush.")]);
    await send(gateway, "Choose timber for the shed.");
    await vi.waitFor(() => expect(onBatch.mock.calls).toEqual([["committed"]]));
    await send(gateway, "Care for the brush.", thread.id);
    expect(requestText(gateway)).toEqual([
      expect.stringContaining("\nPick a brush."), "Use the small brush.",
      expect.stringContaining("\nCare for the brush."),
    ]);
    expect(complete).toHaveBeenCalledTimes(1);
  } finally {
    await gateway.close();
    complete.mockRestore();
  }
}, 20_000);

it("compacts an over-budget thread while keeping Main's prompt and feed intact", async () => {
  const gateway = await startDurableTestGateway();
  try {
    const thread = await create(gateway);
    gateway.script(
      "The bell is blue.",
      { content: "The crate is periwinkle.", usage: { input: 200 } },
      { content: "Boxes ready. " + "crate ".repeat(1000), usage: { input: 5300 } },
      { content: "The crate is checked.", usage: { input: 344 } },
      "The bell is still blue.",
    );
    await send(gateway, "Record the bell.");
    await send(gateway, "Label the crate.", thread.id);
    await send(gateway, "Pack the boxes.", thread.id);
    await send(gateway, "Verify the boxes.", thread.id);
    const window = await feed(gateway, thread.id);
    expect(window.items.map(({ role }) => role)).toEqual(["user", "assistant", "user", "assistant", "user", "seam", "assistant"]);
    expect(requestText(gateway)?.[0]).toContain("Answer the latest request");
    expect(requestText(gateway)).not.toContain("The crate is periwinkle.");
    expect(window.items.map(({ text }) => text)).toContain("The crate is periwinkle.");

    await send(gateway, "Check the bell.");
    expect(requestText(gateway)).toEqual([
      expect.stringContaining("\nRecord the bell."), "The bell is blue.", expect.stringContaining("\nCheck the bell."),
    ]);
    expect((await feed(gateway)).items.map(({ role }) => role)).toEqual(["user", "assistant", "user", "assistant"]);
  } finally {
    await gateway.close();
  }
}, 20_000);

it("keeps a reused tool call ID from attaching Main's file view to a thread", async () => {
  const release = deferred<void>();
  const gateway = await startDurableTestGateway({
    extraYaml: "toolDeferral: { enabled: false }",
    fixture: { extension: defineExtension({
      name: "view-isolation-fixture",
      tools: [defineTool({
        name: "inspect_labels", description: "Inspect paper labels.", parameters: { type: "object" },
        async execute() {
          await release.promise;
          return { output: [{ type: "text", text: "Labels inspected." }] };
        },
      })],
    }) },
  });
  try {
    const filename = await gateway.seedConversationFile("local", "orchard.txt", "Five pear crates.");
    gateway.script({ tool: "send_file", id: "reused", args: { path: filename } }, "Orchard file sent.",
      { tool: "inspect_labels", id: "reused" }, "Label inspection done.");
    await send(gateway, "Send the orchard file.");
    const mainAnswer = (await feed(gateway)).items.at(-1)!;
    const detail = await gateway.request("local", agent + "/feed/messages/" + mainAnswer.id);
    expect(await detail.json()).toMatchObject({
      toolCalls: [{ id: "reused", result: { view: { file: { filename: "orchard.txt" } } } }],
    });
    const thread = await create(gateway);
    const sending = send(gateway, "Inspect paper labels.", thread.id);
    const call = await vi.waitFor(async () => {
      const { live } = await feed(gateway, thread.id);
      const found = live?.toolCalls.find(({ id }) => id === "reused");
      expect(found).toMatchObject({ name: "inspect_labels", status: "running" });
      return found;
    });
    expect(call?.view).toBeUndefined();
    release.resolve();
    await sending;
  } finally {
    release.resolve();
    await gateway.close();
  }
}, 20_000);

it("leaves kept inputs archived at startup and runs them when reopened", async () => {
  const aborting = deferred<void>();
  const release = deferred<void>();
  const queuedClient = new AbortController();
  const gateway = await startDurableTestGateway({
    extraYaml: "toolDeferral: { enabled: false }",
    fixture: { extension: defineExtension({
      name: "archive-kept-fixture",
      tools: [defineTool({
        name: "hold_inventory", description: "Hold the stockroom inventory.", parameters: { type: "object" },
        async execute(_args, _api, context) {
          context.abortSignal?.addEventListener("abort", () => aborting.resolve(), { once: true });
          await release.promise;
          return { output: [{ type: "text", text: "Inventory released." }] };
        },
      })],
    }) },
  });
  try {
    const thread = await create(gateway);
    const sessionId = "thread:" + thread.id;
    gateway.script({ tool: "hold_inventory", id: "inventory" }, "Main continued.", "The mint shelf is accounted for.");
    const running = gateway.send("local", "Hold the inventory.", { sessionId, clientSendId: "running" });
    await vi.waitFor(async () => expect((await feed(gateway, thread.id)).live?.toolCalls).toContainEqual(
      expect.objectContaining({ id: "inventory", status: "running" }),
    ));
    const queued = gateway.request("local", agent + "/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, clientSendId: "kept", message: "Remember to check the mint shelf." }),
      signal: queuedClient.signal,
    }).catch((error: unknown) => error);
    // HTTP waits for settlement. Give the second request time to enter the live run's inbox.
    await setTimeout(100);
    const stopping = post(gateway, agent + "/stop", { threadId: thread.id });
    await Promise.race([aborting.promise, stopping.then(() => { throw new Error("Stop completed before entering the tool."); })]);
    await gateway.setDurableMode("local", false);
    release.resolve();
    expect(await (await stopping).json()).toEqual({ status: "stopped" });
    expect(await (await running).json()).toMatchObject({ meta: { aborted: true } });
    queuedClient.abort();
    expect(await queued).toBeInstanceOf(Error);
    await gateway.setDurableMode("local", true);
    const archived = await close(gateway, thread);
    expect(archived.closed).toBe(true);
    await gateway.restart();

    expect(await (await send(gateway, "Use Main while the thread is archived.")).json()).toMatchObject({
      payloads: [{ text: "Main continued." }],
    });
    expect((await feed(gateway, thread.id)).items.map(({ text }) => text)).not.toContain("Remember to check the mint shelf.");
    await reopen(gateway, thread.id);
    expect(await (await send(gateway, "Continue the inventory.", thread.id)).json()).toMatchObject({
      payloads: [{ text: "The mint shelf is accounted for." }],
    });
    expect(requestText(gateway)).toContainEqual(expect.stringContaining("\nRemember to check the mint shelf."));
  } finally {
    release.resolve();
    queuedClient.abort();
    await gateway.close();
  }
}, 20_000);
