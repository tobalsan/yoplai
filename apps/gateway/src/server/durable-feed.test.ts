import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { FeedItem } from "@yoplai/shared";
import { expect, it, vi } from "vitest";
import { startDurableTestGateway } from "../test-utils/durable-gateway.js";

const feed = "/api/agents/pilot/feed";

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((release) => { resolve = release; });
  return { promise, resolve };
}

it("pages whole Durable messages around stable ids across a restart", async () => {
  const gateway = await startDurableTestGateway();
  try {
    expect(await (await gateway.request("local", feed)).json()).toEqual({
      items: [], hasBefore: false, hasAfter: false, live: null,
    });
    expect((await gateway.send("local", "Check the greenhouse", { clientSendId: "greenhouse" })).status).toBe(200);
    const response = await gateway.request("local", feed + "?limit=1");
    expect(response.status).toBe(200);
    const tail = await response.json();
    expect(tail).toMatchObject({
      items: [{ id: expect.stringMatching(/^m_\d+$/), role: "assistant", text: "The seedlings are ready.", toolCallCount: 0 }],
      hasBefore: true, hasAfter: false, live: null,
    });
    const id = tail.items[0].id;
    const before = await (await gateway.request("local", feed + "?limit=1&before=" + id)).json();
    expect(before).toMatchObject({
      items: [{ id: expect.stringMatching(/^m_\d+$/), role: "user", text: "Check the greenhouse" }],
      hasBefore: false, hasAfter: true,
    });
    await gateway.restart();
    expect(await (await gateway.request("local", feed + "?limit=1&after=" + before.items[0].id)).json()).toEqual(tail);
    expect(await (await gateway.request("local", feed + "?limit=1&around=" + id)).json()).toEqual(tail);
    expect((await gateway.request("local", feed + "?before=" + id + "&after=" + id)).status).toBe(400);
    expect((await gateway.request("local", feed + "?around=m_0")).status).toBe(404);
  } finally {
    await gateway.close();
  }
});

it("finds public messages and opens the agent trace without searching it", async () => {
  const gateway = await startDurableTestGateway({ extraYaml: "toolDeferral:\n  enabled: false" });
  try {
    const path = await gateway.seedConversationFile("local", "orchard.txt", "private-to-search payload");
    gateway.script({ tool: "read", id: "orchard-read", args: { path } }, "The orchard is ready.");
    expect((await gateway.send("local", "Inspect the orchard", { clientSendId: "orchard" })).status).toBe(200);
    const search = await gateway.request("local", feed + "/search?q=ORCHARD");
    expect(search.status).toBe(200);
    const { hits } = await search.json();
    expect(hits).toMatchObject([
      { role: "assistant", snippet: "The orchard is ready." },
      { role: "user", snippet: "Inspect the orchard" },
    ]);
    expect(await (await gateway.request("local", feed + "/search?q=private-to-search")).json()).toEqual({ hits: [] });
    const detail = await gateway.request("local", feed + "/messages/" + hits[0].id);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      id: hits[0].id,
      text: "The orchard is ready.",
      reasoning: [],
      toolCalls: [{
        id: "orchard-read", name: "read", arguments: { path },
        status: "done", isError: false, result: { text: "private-to-search payload" },
      }],
    });
    expect((await gateway.request("local", feed + "/messages/" + hits[1].id)).status).toBe(404);
  } finally {
    await gateway.close();
  }
});

it("attaches before the first send and keeps a one-item subscription equal to the HTTP tail", async () => {
  const gateway = await startDurableTestGateway({ extraYaml: "toolDeferral: { enabled: false }" });
  try {
    const socket = await gateway.socket();
    socket.send({ type: "subscribeFeed", agentId: "pilot", limit: 1 });
    await vi.waitFor(() => expect(socket.events).toContainEqual({
      type: "feed_snapshot", agentId: "pilot", seq: 1, items: [], hasBefore: false, live: null,
    }));
    gateway.script({ tool: "bash", id: "basil-count", args: { command: "sleep 0.3; echo 2" } }, "There are two basil plants.");
    const response = gateway.send("local", "Count the basil plants", { clientSendId: "basil-count" });
    await vi.waitFor(() => expect(socket.events).toContainEqual(expect.objectContaining({
      live: expect.objectContaining({ toolCalls: [expect.objectContaining({ id: "basil-count", status: "running" })] }),
    })));
    expect((await response).status).toBe(200);
    const tail = await (await gateway.request("local", feed + "?limit=1")).json();
    expect(tail).toMatchObject({ items: [{ role: "assistant", text: "There are two basil plants.", toolCallCount: 1 }], hasBefore: true, live: null });
    await vi.waitFor(() => {
      let items: FeedItem[] = [];
      let seq = 0;
      let settled = false;
      for (const event of socket.events) {
        if (event.type !== "feed_snapshot" && event.type !== "feed_delta") continue;
        expect(event.seq).toBe(++seq);
        if (event.type === "feed_snapshot") items = event.items.slice();
        else {
          for (const item of event.upsert) {
            const index = items.findIndex(({ id }) => id === item.id);
            if (index === -1) items.push(item);
            else items[index] = item;
          }
          if (event.dropBefore) {
            const index = items.findIndex(({ id }) => id === event.dropBefore);
            expect(index).toBeGreaterThanOrEqual(0);
            items = items.slice(index);
          }
        }
        settled = event.hasBefore && event.live === null;
      }
      expect(items).toEqual(tail.items);
      expect(settled).toBe(true);
      expect(socket.events[1]).toMatchObject({ type: "feed_snapshot", seq: 2 });
      expect(socket.events.some((event) => event.type === "feed_delta")).toBe(true);
    });
    socket.close();
    const reconnected = await gateway.socket();
    reconnected.send({ type: "subscribeFeed", agentId: "pilot", limit: 1 });
    await vi.waitFor(() => expect(reconnected.events[0]).toMatchObject({
      type: "feed_snapshot", seq: 1, items: tail.items, hasBefore: true, live: null,
    }));
  } finally {
    await gateway.close();
  }
});

it("keeps an owner-scoped Code Mode file view live and after restart", async () => {
  const gateway = await startDurableTestGateway({ multiUser: true, extraYaml: "codemode: true" });
  try {
    const filename = await gateway.seedConversationFile("alice", "orchard.txt", "Five pear trees.");
    const socket = await gateway.socket("alice");
    const legacy = await gateway.subscribe("alice");
    socket.send({ type: "subscribeFeed", agentId: "pilot" });
    await vi.waitFor(() => expect(socket.events[0]).toMatchObject({ type: "feed_snapshot" }));
    gateway.script({
      tool: "codemode", id: "orchard-code", args: { code:
        "await tools.send_file({ path: " + JSON.stringify(filename) + ", fixtureExtra: 'runtime-' + 'orchard-marker' });\n" +
        "await tools.bash({ command: 'sleep 0.6' });",
      },
    }, "The file is ready.");
    const running = gateway.send("alice", "Send the orchard file", { clientSendId: "orchard-file" });
    const nested = {
      id: expect.stringMatching(/^orchard-code\/.+$/), name: "send_file", parentToolCallId: "orchard-code",
      view: expect.objectContaining({ file: expect.objectContaining({ filename: "orchard.txt" }) }),
    };
    await vi.waitFor(() => {
      expect(socket.events.some((event) => event.type === "feed_delta" &&
        event.live?.toolCalls.some((call) => call.name === "send_file" && call.view))).toBe(true);
      expect(legacy.events).toContainEqual(expect.objectContaining({
        type: "active_turn", toolCalls: expect.arrayContaining([expect.objectContaining(nested)]),
      }));
    }, { timeout: 5000 });
    expect((await running).status).toBe(200);

    for (const restart of [false, true]) {
      if (restart) await gateway.restart();
      const tail = await (await gateway.request("alice", feed + "?limit=1")).json();
      expect(tail.items).toMatchObject([{ role: "assistant", text: "The file is ready.", toolCallCount: 2 }]);
      const history = await gateway.history("alice", "?view=full");
      expect(history.messages).toContainEqual(expect.objectContaining({
        role: "assistant", content: expect.arrayContaining([
          expect.objectContaining({ type: "toolCall", id: "orchard-code" }),
          expect.objectContaining({ type: "toolCall", ...nested }),
        ]),
      }));
      const detail = await (await gateway.request("alice", feed + "/messages/" + tail.items[0].id)).json();
      expect(detail.toolCalls).toContainEqual(expect.objectContaining({ ...nested, status: "done" }));
      const nestedCall = detail.toolCalls.find((call: { name: string }) => call.name === "send_file");
      expect(Object.keys(nestedCall).sort()).toEqual(["id", "isError", "name", "parentToolCallId", "status", "view"]);
      expect(history.messages).toContainEqual(expect.objectContaining({
        role: "toolResult", toolCallId: nestedCall.id, parentToolCallId: "orchard-code", view: nestedCall.view, content: [],
      }));
      const observer = await gateway.socket("alice");
      observer.send({ type: "subscribeFeed", agentId: "pilot", limit: 1 });
      await vi.waitFor(() => expect(observer.events[0]).toMatchObject({ type: "feed_snapshot", items: tail.items, live: null }));
      expect(JSON.stringify([socket.events, legacy.events, tail, history, detail, observer.events])).not.toContain("runtime-orchard-marker");
      for (const session of ["durable-main", "main"]) {
        const route = "/api/agents/pilot/sessions/" + session + "/mcp-apps/" + encodeURIComponent(nestedCall.id) + "/data";
        expect((await gateway.request("alice", route, { method: "POST" })).status).toBe(200);
        expect((await gateway.request("bob", route, { method: "POST" })).status).toBe(404);
      }
    }
  } finally {
    await gateway.close();
  }
}, 15000);

it("scopes message ids to the caller's Main and terminates an open cookie stream on unapproval", async () => {
  const gateway = await startDurableTestGateway({ multiUser: true, recheckMs: 50, extraYaml: "toolDeferral: { enabled: false }" });
  try {
    gateway.script("The pear trees are ready.");
    expect((await gateway.send("alice", "Check my pears", { clientSendId: "pear-check" })).status).toBe(200);
    const aliceTail = await (await gateway.request("alice", feed + "?limit=1")).json();
    const aliceId = aliceTail.items[0].id;
    gateway.script("The plums are ready.");
    expect((await gateway.send("bob", "Check my plums", { clientSendId: "plum-check" })).status).toBe(200);
    const bobTail = await (await gateway.request("bob", feed + "?limit=1")).json();
    expect(bobTail.items).toMatchObject([{ text: "The plums are ready." }]);
    expect(bobTail.items[0].id).not.toBe(aliceId);
    for (const route of [feed + "?around=", feed + "/messages/"]) {
      const other = await gateway.request("bob", route + aliceId);
      const unknown = await gateway.request("bob", route + "m_0");
      expect(other.status).toBe(404);
      expect(unknown.status).toBe(404);
      expect(await other.text()).toBe(await unknown.text());
    }
    expect(await (await gateway.request("bob", feed + "/search?q=pears")).json()).toEqual({ hits: [] });

    const socket = await gateway.socket("bob");
    socket.send({ type: "subscribeFeed", agentId: "pilot", limit: 1 });
    await vi.waitFor(() => expect(socket.events[0]).toMatchObject({ type: "feed_snapshot", items: bobTail.items }));
    gateway.script({ tool: "bash", args: { command: "sleep 0.6; echo checked" }, id: "plum-hold" }, "The plum check finished.");
    const running = gateway.send("bob", "Wait for the plum check", { clientSendId: "plum-hold" });
    await vi.waitFor(() => expect(socket.events.some((event) =>
      event.type === "feed_delta" && event.live?.toolCalls.some((call) => call.id === "plum-hold"))).toBe(true));
    const admin = await gateway.request("alice", "/api/admin/users/" + gateway.accountId("bob"), {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ approved: false }),
    });
    expect(admin.status).toBe(200);
    const ended = { type: "feed_end", agentId: "pilot", reason: "forbidden" };
    await vi.waitFor(() => expect(socket.events.at(-1)).toEqual(ended), { timeout: 6000 });
    await running;
    for (const route of [feed, feed + "?before=" + bobTail.items[0].id, feed + "/search?q=plums", feed + "/messages/" + bobTail.items[0].id]) {
      expect((await gateway.request("bob", route)).status).toBe(403);
    }
    const reconnect = await gateway.socket("bob");
    reconnect.send({ type: "subscribeFeed", agentId: "pilot" });
    await vi.waitFor(() => expect(reconnect.events).toEqual([ended]));
    socket.send({ type: "subscribeFeed", agentId: "pilot" });
    await vi.waitFor(() => expect(socket.events.filter((event) => event.type === "feed_end")).toEqual([ended, ended]));
    const endIndex = socket.events.findIndex((event) => event.type === "feed_end");
    expect(socket.events.slice(endIndex)).toEqual([ended, ended]);
  } finally {
    await gateway.close();
  }
}, 12000);

it("coalesces changes behind a pending send into a new snapshot", async () => {
  const { promise: held, resolve: release } = latch();
  const gateway = await startDurableTestGateway({ feedSendComplete: () => held });
  try {
    const socket = await gateway.socket();
    socket.send({ type: "subscribeFeed", agentId: "pilot" });
    await vi.waitFor(() => expect(socket.events[0]).toMatchObject({ type: "feed_snapshot", seq: 1, items: [] }));
    expect((await gateway.send("local", "Check the blueberries", { clientSendId: "blueberries" })).status).toBe(200);
    expect(socket.events).toHaveLength(1);
    const tail = await (await gateway.request("local", feed)).json();
    release();
    await vi.waitFor(() => expect(socket.events[1]).toMatchObject({
      type: "feed_snapshot", seq: 2, items: tail.items, hasBefore: tail.hasBefore, live: tail.live,
    }));
  } finally {
    release();
    await gateway.close();
  }
});

it("streams a later model round before its tool finishes and reloads the stored rounds", async () => {
  const { promise: countingPlums, resolve: finishCounting } = latch();
  const gateway = await startDurableTestGateway({
    tokensPerSecond: 60,
    extraYaml: "toolDeferral: { enabled: false }",
    fixture: { extension: defineExtension({
      name: "orchard-round-fixture",
      tools: [defineTool({
        name: "count_plums", description: "Count the orchard plums", parameters: { type: "object" },
        async execute() {
          await countingPlums;
          return { output: [{ type: "text", text: "3" }] };
        },
      })],
    }) },
  });
  try {
    gateway.script(
      ["First, count the pears in the orchard.", { tool: "bash", id: "count-pears", args: { command: "echo 5" } }],
      ["Second, count the plums in the orchard.", { tool: "count_plums", id: "count-plums" }],
      "There are five pears and three plums.",
    );
    const observer = await gateway.subscribe("local");
    const sender = await gateway.send("local", "Count the fruit", { clientSendId: "count-fruit" }, "ws");
    await vi.waitFor(() => expect(observer.events.some((event) =>
      event.type === "active_turn" && event.toolCalls.some((call) => call.id === "count-plums" && call.status === "running"))).toBe(true), { timeout: 4000 });
    const text = () => sender.events.flatMap((event) => event.type === "text" ? [event.data] : []).join("");
    await vi.waitFor(() => expect(text()).toBe("First, count the pears in the orchard.Second, count the plums in the orchard."));
    expect(sender.events.some((event) => event.type === "done")).toBe(false);
    const running = await gateway.history("local", "?view=full");
    expect(running.activeTurn).toMatchObject({
      text: "", toolCalls: [{ id: "count-plums", status: "running" }],
    });
    expect(running.messages.filter((row: { role: string; toolCallId?: string }) => row.role === "toolResult").map((row: { toolCallId: string }) => row.toolCallId)).toEqual(["count-pears"]);
    finishCounting();
    await vi.waitFor(() => expect(sender.events.some((event) => event.type === "done")).toBe(true), { timeout: 4000 });
    expect(text()).toBe("First, count the pears in the orchard.Second, count the plums in the orchard.There are five pears and three plums.");
    expect((await gateway.history("local")).messages.map((row: { content: string }) => row.content)).toEqual([
      "Count the fruit", "First, count the pears in the orchard.", "Second, count the plums in the orchard.", "There are five pears and three plums.",
    ]);
  } finally {
    finishCounting();
    await gateway.close();
  }
}, 12000);

it("reports a changed reply when a provider retry replaces text already sent to the sender", async () => {
  const gateway = await startDurableTestGateway({
    tokensPerSecond: 60,
    extraYaml: "retryMaxAttempts: 2\nretryBaseDelay: 0.01\ntoolDeferral: { enabled: false }",
  });
  try {
    gateway.script(
      { errorMessage: "503 Service Unavailable", partial: "I am counting the fruit in the wrong row of trees." },
      { tool: "bash", id: "count-correct-row", args: { command: "echo 4" } },
      "There are four apples in the correct row.",
    );
    const sender = await gateway.send("local", "Count the apples", { clientSendId: "count-apples" }, "ws");
    await vi.waitFor(() => expect(sender.events.flatMap((event) => event.type === "text" ? [event.data] : []).join(""))
      .toMatch(/^I am counting/), { timeout: 4000 });
    await vi.waitFor(() => expect(sender.events.filter((event) => event.type === "error" || event.type === "done"))
      .toEqual([{ type: "error", message: "The reply changed while streaming." }]), { timeout: 4000 });
    expect((await gateway.history("local")).messages.map((row: { content: string }) => row.content)).toEqual([
      "Count the apples", "There are four apples in the correct row.",
    ]);
  } finally {
    await gateway.close();
  }
}, 12000);

it("keeps excluded records and fields out of every feed and compatibility response", async () => {
  const { promise: held, resolve: release } = latch();
  const { promise: reviewing, resolve: markReviewed } = latch();
  const draft = "rejected-draft-priv";
  let filename: string;
  const extension = defineExtension({
    name: "visibility-fixtures",
    tools: [
      defineTool({
        name: "hidden_orchard_probe", description: "Fixture hidden parent", parameters: { type: "object" },
        async execute(_args, api, context) {
          await api.executeTool("send_file", { path: filename, title: "hidden-child-priv" }, context, { key: "hidden-nested-id" });
          return { output: [{ type: "text", text: "hidden-result-priv" }], details: { hidden: true } };
        },
      }),
      defineTool({
        name: "public_orchard_probe", description: "Fixture visible tool", parameters: { type: "object" },
        async execute(_args, api) {
          api.output("running-output-priv");
          api.diagnostic({ severity: "warn", message: "diagnostic-priv" });
          await new Promise((resolve) => setTimeout(resolve, 100));
          return {
            output: [{ type: "text", text: "Public probe result." }, { type: "image", data: "nontext-priv", mimeType: "image/png" }],
            details: { diff: "+seven pears", payload: "raw-tool-details-priv" },
          };
        },
      }),
    ],
  });
  const gateway = await startDurableTestGateway({
    extraYaml: "retryMaxAttempts: 1\ntoolDeferral: { enabled: false }",
    fixture: { extension, invisibleTools: ["hidden_orchard_probe"] },
    reviewer: {
      begin() {}, end() {},
      async review(text) {
        if (text !== draft) return { ok: true };
        markReviewed();
        await held;
        return { ok: false, rewriteHint: "State the orchard count." };
      },
    },
  });
  try {
    filename = await gateway.seedConversationFile("local", "secret.txt", "Fixture orchard notes");
    const live = await gateway.socket();
    const legacy = await gateway.subscribe("local");
    live.send({ type: "subscribeFeed", agentId: "pilot" });
    await vi.waitFor(() => expect(live.events[0]).toMatchObject({ type: "feed_snapshot" }));
    gateway.script(
      [{ tool: "hidden_orchard_probe", id: "hidden-root-id", args: { fixture: "hidden-args-priv" } },
        { tool: "public_orchard_probe", id: "public-probe", args: { fixture: "public-args-not-searchable" } }],
      [{ thinking: "draft-thinking-priv" }, draft],
      [{ thinking: "Public orchard reasoning.", signature: "public-signature-priv" },
        { thinking: "redacted-thinking-priv", redacted: true, signature: "redacted-signature-priv" }, "Seven pears are ready."],
    );
    const sent = gateway.send("local", "Inspect the pear trees", { clientSendId: "exclusion-pears" });
    await reviewing;
    const runningTail = await (await gateway.request("local", feed)).json();
    expect(runningTail.live).toMatchObject({ text: "", reasoning: [] });
    expect(JSON.stringify(runningTail)).not.toContain(draft);
    release();
    expect((await sent).status).toBe(200);
    const settled = await (await gateway.request("local", feed)).json();
    const id = settled.items.at(-1).id;

    for (const [kind, marker] of [["fixture.passive", "unknown-model-priv"], ["pi.system", "system-model-priv"],
      ["pi.reset", "handoff-model-priv"], ["pi.compaction", "compaction-model-priv"]]) {
      await gateway.writePassiveEntry("local", {
        kind, ...(kind === "pi.reset" ? { head: "self" as const } : {}), data: { secret: kind === "fixture.passive" ? "unknown-data-priv" : marker },
        model: [{ role: kind === "pi.system" ? "system" : "user", content: marker, timestamp: Date.now() }],
      });
    }
    gateway.script({ errorMessage: "run-failure-detail-priv" });
    expect((await gateway.send("local", "Check the peach trees", { clientSendId: "exclusion-peaches" })).status).toBe(500);
    const tail = await (await gateway.request("local", feed)).json();
    expect(tail.items.at(-1)).toMatchObject({
      role: "failure", kind: "generic", text: "Something went wrong, please try again.",
    });
    const detail = await (await gateway.request("local", feed + "/messages/" + id)).json();
    expect(detail).toMatchObject({
      text: "Seven pears are ready.", reasoning: ["Public orchard reasoning."],
      toolCalls: [{ id: "public-probe", name: "public_orchard_probe", status: "done", result: { text: "Public probe result.", diff: "+seven pears" } }],
    });
    const window = await (await gateway.request("local", feed + "?around=" + id)).json();
    const snapshot = await gateway.socket();
    snapshot.send({ type: "subscribeFeed", agentId: "pilot" });
    await vi.waitFor(() => {
      expect(snapshot.events[0]).toMatchObject({ type: "feed_snapshot", items: tail.items });
      expect(live.events.some((event) => event.type === "feed_delta")).toBe(true);
      expect(live.events.some((event) => (event.type === "feed_snapshot" ? event.items :
        event.type === "feed_delta" ? event.upsert : []).some((item) => item.role === "failure"))).toBe(true);
    });
    const history = await gateway.history("local", "?view=full");
    const outputs = JSON.stringify([runningTail, settled, tail, detail, window, live.events, snapshot.events, legacy.events, history]);
    const excluded = [draft, "draft-thinking-priv", "hidden_orchard_probe", "hidden-root-id", "hidden-nested-id", "hidden-child-priv",
      "hidden-result-priv", "hidden-args-priv", "public-signature-priv", "redacted-thinking-priv", "redacted-signature-priv",
      "running-output-priv", "diagnostic-priv", "nontext-priv", "raw-tool-details-priv", "unknown-model-priv", "unknown-data-priv",
      "system-model-priv", "handoff-model-priv", "compaction-model-priv", "run-failure-detail-priv"];
    for (const marker of [...excluded, '"conversationId"', '"submissionId"', '"taskId"', '"route"', '"senderId"']) {
      expect(outputs).not.toContain(marker);
    }
    for (const marker of [...excluded, "Public orchard reasoning.", "Public probe result.", "public-args-not-searchable"]) {
      const search = await gateway.request("local", feed + "/search?q=" + encodeURIComponent(marker));
      expect(search.status).toBe(200);
      expect(await search.json()).toEqual({ hits: [] });
    }
    expect(await (await gateway.request("local", feed + "/search?q=seven+pears")).json()).toMatchObject({
      hits: [{ id, role: "assistant", snippet: "Seven pears are ready." }],
    });
  } finally {
    release();
    await gateway.close();
  }
}, 15000);

it("keeps a whole answer when it spans more entries than the Durable watch window", async () => {
  const gateway = await startDurableTestGateway({
    fixture: { extension: defineExtension({
      name: "orchard-count",
      tools: [defineTool({
        name: "count_tree", description: "Count fruit on a numbered tree", parameters: { type: "object" },
        async execute() { return { output: [{ type: "text", text: "One fruit." }] }; },
      })],
    }) },
  });
  try {
    await (await gateway.send("local", "Warm up the orchard", { clientSendId: "orchard-warm-up" })).json();
    const socket = await gateway.socket();
    socket.send({ type: "subscribeFeed", agentId: "pilot", limit: 1 });
    await vi.waitFor(() => expect(socket.events[0]).toMatchObject({ type: "feed_snapshot", seq: 1 }));
    gateway.script(
      ["Counting all of the trees.", ...Array.from({ length: 120 }, (_, index) =>
        ({ tool: "count_tree", id: "tree-" + index, args: { tree: index } }))],
      "The whole orchard has been counted.",
    );
    expect((await gateway.send("local", "Count the whole orchard", { clientSendId: "whole-orchard" })).status).toBe(200);
    const tail = await (await gateway.request("local", feed + "?limit=1")).json();
    expect(tail).toMatchObject({
      items: [{ text: "Counting all of the trees.\nThe whole orchard has been counted.", toolCallCount: 120 }],
      hasBefore: true, hasAfter: false, live: null,
    });
    await vi.waitFor(() => {
      const last = socket.events.at(-1);
      expect(last?.type === "feed_delta" ? last.upsert : last?.type === "feed_snapshot" ? last.items : []).toEqual(tail.items);
      expect(last).toMatchObject({ live: null, hasBefore: true });
    });
    const detail = await (await gateway.request("local", feed + "/messages/" + tail.items[0].id)).json();
    expect(detail.toolCalls).toHaveLength(120);
    expect(detail.toolCalls[0]).toMatchObject({ id: "tree-0", result: { text: "One fruit." }, status: "done" });
    expect(detail.toolCalls[119]).toMatchObject({ id: "tree-119", result: { text: "One fruit." }, status: "done" });
    expect(await (await gateway.request("local", feed + "?limit=1&around=" + tail.items[0].id)).json()).toEqual(tail);
  } finally {
    await gateway.close();
  }
}, 12000);

it("closes a feed socket when its cookie session signs out", async () => {
  const gateway = await startDurableTestGateway({ multiUser: true, recheckMs: 40 });
  try {
    const observer = await gateway.socket("bob");
    observer.send({ type: "subscribeFeed", agentId: "pilot" });
    await vi.waitFor(() => expect(observer.events[0]).toMatchObject({ type: "feed_snapshot" }));
    expect((await gateway.request("bob", "/api/auth/sign-out", {
      method: "POST", headers: { Origin: "http://localhost:3000", "content-type": "application/json" }, body: "{}",
    })).status).toBe(200);
    await vi.waitFor(() => expect(observer.closedCode()).toBe(1008));
    expect(observer.events).toHaveLength(1);
  } finally {
    await gateway.close();
  }
});

it("ends the target feed when the signed-in admin exits impersonation", async () => {
  const gateway = await startDurableTestGateway({ multiUser: true, recheckMs: 40 });
  try {
    expect((await gateway.send("bob", "Check my orchard", { clientSendId: "bob-orchard" })).status).toBe(200);
    const admin = (path: string, body: object) => gateway.request("alice", "/api/admin/impersonate/" + path, {
      method: "POST", headers: { "content-type": "application/json", Origin: "http://localhost:3000" }, body: JSON.stringify(body),
    });
    expect((await admin("start", { targetUserId: gateway.accountId("bob") })).status).toBe(204);
    const observer = await gateway.socket("alice");
    observer.send({ type: "subscribeFeed", agentId: "pilot" });
    await vi.waitFor(() => expect(observer.events[0]).toMatchObject({
      type: "feed_snapshot", items: [expect.objectContaining({ text: "Check my orchard" }), expect.objectContaining({ role: "assistant" })],
    }));
    expect((await admin("end", {})).status).toBe(204);
    await vi.waitFor(() => expect(observer.events.at(-1)).toEqual({ type: "feed_end", agentId: "pilot", reason: "forbidden" }));
    expect(observer.closedCode()).toBeUndefined();
  } finally {
    await gateway.close();
  }
});
