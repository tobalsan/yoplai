import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { FeedWindow } from "@yoplai/shared";
import { expect, it, vi } from "vitest";
import { startDurableTestGateway } from "../test-utils/durable-gateway.js";

const feed = "/api/agents/pilot/feed";

it("continues a tool-heavy run after a native cut with complete retained tool pairs", async () => {
  const steps: number[] = [];
  let finish!: () => void;
  const held = new Promise<void>((resolve) => { finish = resolve; });
  let releaseTool!: () => void;
  const toolHeld = new Promise<void>((resolve) => { releaseTool = resolve; });
  const gateway = await startDurableTestGateway({
    extraYaml: "toolDeferral: { enabled: false }",
    keeper: { idleMs: 60_000, turns: 1 },
    fixture: { extension: defineExtension({
      name: "compaction-fixture",
      tools: [defineTool({
        name: "inspect_orchard", description: "Inspect an orchard row",
        parameters: { type: "object", properties: { row: { type: "number" } }, required: ["row"] },
        async execute({ row }) {
          steps.push(row);
          if (row === 2) await toolHeld;
          return { output: [{ type: "text", text: "orchard ".repeat(row === 1 ? 275 : 720) }] };
        },
      })],
    }) },
  });
  const { MaintenanceCompletion } = await import("../maintenance/completion.js");
  const keeper = vi.spyOn(MaintenanceCompletion, "complete").mockResolvedValue('{"topics":[]}');
  keeper.mockImplementationOnce(async ({ prompt }) => JSON.stringify({
    topics: [{ kind: "open", title: "Greenhouse report", note: "Send the seedling inventory Friday.", refs: [JSON.parse(prompt).messages[0].id] }],
  }));
  keeper.mockImplementationOnce(async ({ prompt }) => JSON.stringify({
    topics: [{ id: JSON.parse(prompt).topics[0].id, note: "Inventory moved to Monday." }],
  }));
  try {
    const previous = "Check the greenhouse. " + "seedling ".repeat(130);
    const opening = "Inspect the apple orchard. " + "apple ".repeat(100);
    gateway.script({ content: "The seedlings are ready. " + "sprout ".repeat(130), usage: { input: 200 } });
    expect((await gateway.send("local", previous, { clientSendId: "greenhouse" })).status).toBe(200);
    await vi.waitFor(() => expect(keeper).toHaveBeenCalledTimes(1));
    const before: FeedWindow = await (await gateway.request("local", feed)).json();
    const socket = await gateway.socket();
    socket.send({ type: "subscribeFeed", agentId: "pilot" });
    await vi.waitFor(() => expect(socket.events[0]).toMatchObject({ type: "feed_snapshot", items: before.items }));
    const narrow = await gateway.socket();
    narrow.send({ type: "subscribeFeed", agentId: "pilot", limit: 2 });

    gateway.script(
      { content: ["I will check the first row.", { tool: "inspect_orchard", id: "inspect-first", args: { row: 1 } }], usage: { input: 200 } },
      { content: ["The first row is checked.", { tool: "inspect_orchard", id: "inspect-second", args: { row: 2 } }], usage: { input: 5300 } },
      { content: async () => { await held; return "Both orchard rows are ready."; }, usage: { input: 180, cacheRead: 20, output: 12 } },
    );
    const running = gateway.send("local", opening, { clientSendId: "orchard" });
    await vi.waitFor(() => expect(narrow.events.some((event) => event.type === "feed_delta"
      && event.upsert.some((item) => item.role === "assistant" && item.toolCallCount === 2))).toBe(true));
    releaseTool();
    await vi.waitFor(() => expect(gateway.requests).toHaveLength(4));
    const atCut: FeedWindow = await (await gateway.request("local", feed)).json();
    expect(atCut.items.slice(0, 2)).toEqual(before.items);
    expect(atCut.items.slice(2)).toMatchObject([
      { role: "user", text: opening },
      { role: "seam", text: "Context compacted", reason: "threshold",
        carried: { firstKept: expect.stringMatching(/^m_\d+$/), indexed: 2 } },
      { role: "assistant", text: "I will check the first row.\nThe first row is checked.", toolCallCount: 2 },
    ]);
    const [, seam, answer] = atCut.items.slice(2);
    await vi.waitFor(() => expect(narrow.events).toContainEqual(expect.objectContaining({
      type: "feed_snapshot", items: [seam, answer],
    })));
    expect((await gateway.history("local", "?view=full")).activeContextUsage).toEqual({ inputTokens: 0 });
    finish();
    expect((await running).status).toBe(200);
    expect(steps).toEqual([1, 2]);
    expect(gateway.requests).toHaveLength(4);

    const messages = gateway.requests[3]!.messages;
    expect(messages[0]?.role).toBe("system");
    const summary = messages[1];
    expect(summary).toMatchObject({
      role: "user", content: [{ type: "text", text: expect.stringContaining("Answer the latest request") }],
    });
    const summaryBlock = summary?.role === "user" && Array.isArray(summary.content) ? summary.content[0] : undefined;
    const summaryText = summaryBlock?.type === "text" ? summaryBlock.text : "";
    expect(summaryText).toMatch(/Running turn[\s\S]*\n\nMemory\n[\s\S]*\n\nOlder requests/);
    const memory = summaryText.split("\n\nMemory\n")[1]?.split("\n\nOlder requests")[0];
    expect(memory).toBe("- Open: Greenhouse report: Send the seedling inventory Friday. (refs: " + before.items[0]!.id + ")");
    expect(memory!.length).toBeLessThanOrEqual(4_000);
    expect(JSON.stringify(gateway.requests.slice(0, 3))).not.toContain("Send the seedling inventory Friday.");
    const transcript = JSON.stringify(messages);
    expect(transcript).toContain("Inspect the apple orchard.");
    expect(summary).toMatchObject({
      content: [{ text: expect.stringContaining('inspect_orchard {"row":1} (ok)') }],
    });
    expect(transcript).toContain("[" + before.items[0].id + "]");
    expect(transcript).not.toContain(previous);
    expect(messages).toContainEqual(expect.objectContaining({ role: "assistant", content: expect.arrayContaining([
      expect.objectContaining({ type: "text", text: "The first row is checked." }),
    ]) }));
    for (const request of gateway.requests) {
      const calls = request.messages.flatMap((message) => message.role === "assistant"
        ? message.content.flatMap((block) => block.type === "toolCall" ? [block.id] : []) : []);
      const results = request.messages.flatMap((message) => message.role === "toolResult" ? [message.toolCallId] : []);
      expect(results).toEqual(calls);
    }
    const history = await gateway.history("local", "?view=full");
    expect(history.activeContextUsage).toEqual({ inputTokens: 200, model: "fixture" });
    expect(JSON.stringify(history.messages)).not.toContain("Context compacted");
    await vi.waitFor(() => expect(socket.events.some((event) =>
      event.type === "feed_snapshot" && event.items.some((item) => item.id === seam!.id))).toBe(true));
    const page = async (query: string): Promise<FeedWindow> => (await gateway.request("local", feed + "?" + query)).json();
    expect((await page("before=" + seam!.id + "&limit=1")).items).toEqual([atCut.items[2]]);
    expect((await page("after=" + seam!.id + "&limit=1")).items).toMatchObject([
      { id: answer!.id, role: "assistant", text: "I will check the first row.\nThe first row is checked.\nBoth orchard rows are ready.", toolCallCount: 2 },
    ]);
    expect((await page("around=" + seam!.id + "&limit=3")).items.map(({ id }) => id)).toEqual([atCut.items[2]!.id, seam!.id, answer!.id]);
    expect((await gateway.request("local", feed + "/messages/" + seam!.id)).status).toBe(404);
    expect(await (await gateway.request("local", feed + "/search?q=Context%20compacted")).json()).toEqual({ hits: [] });
    expect(await (await gateway.request("local", feed + "/search?q=Answer%20the%20latest%20request")).json()).toEqual({ hits: [] });
    gateway.script(
      { content: "The orchard report is complete.", usage: { input: 220 } },
      { content: "The report is saved.", usage: { input: 240 } },
    );
    await vi.waitFor(() => expect(keeper).toHaveBeenCalledTimes(2));
    expect((await gateway.send("local", "Give me the orchard report", { clientSendId: "orchard-report" })).status).toBe(200);
    expect((await gateway.send("local", "Confirm the report", { clientSendId: "orchard-confirm" })).status).toBe(200);
    expect(gateway.requests).toHaveLength(6);
    expect(JSON.stringify(gateway.requests.slice(3))).not.toContain("Inventory moved to Monday.");
    const prefixBreaks = gateway.requests.slice(1).flatMap((request, index) => {
      const prior = gateway.requests[index]!.messages;
      return JSON.stringify(request.messages.slice(0, prior.length)) === JSON.stringify(prior) ? [] : [index + 1];
    });
    expect(prefixBreaks).toEqual([3]);
  } finally {
    releaseTool();
    finish();
    await gateway.close();
    keeper.mockRestore();
  }
}, 20000);

it("retries a provider overflow once after a smaller request and does not repeat a completed tool", async () => {
  let effects = 0;
  const gateway = await startDurableTestGateway({
    extraYaml: "toolDeferral: { enabled: false }",
    fixture: { extension: defineExtension({
      name: "shipment-fixture",
      tools: [defineTool({
        name: "record_shipment", description: "Record an orchard shipment", parameters: { type: "object" },
        async execute() {
          effects++;
          return { output: [{ type: "text", text: "shipment recorded. ".repeat(310) }] };
        },
      })],
    }) },
  });
  try {
    const oldRequest = "Read the packing list. " + "crate ".repeat(200);
    gateway.script({ content: "List reviewed. " + "box ".repeat(230), usage: { input: 200 } });
    expect((await gateway.send("local", oldRequest, { clientSendId: "packing" })).status).toBe(200);
    gateway.script(
      { content: { tool: "record_shipment", id: "shipment" }, usage: { input: 260 } },
      { content: { errorMessage: "Your input exceeds the context window of this model" }, usage: { input: 8000 } },
      { content: "The shipment was recorded.", usage: { input: 330 } },
    );
    const response = await gateway.send("local", "Record the shipment of green apples.", { clientSendId: "shipping" });
    expect(response.status).toBe(200);
    expect((await gateway.history("local")).messages.at(-1)).toMatchObject({ content: "The shipment was recorded." });
    expect(gateway.callCount()).toBe(4);
    expect(effects).toBe(1);
    const rejected = JSON.stringify(gateway.requests[2]?.messages);
    const recovered = JSON.stringify(gateway.requests[3]?.messages);
    expect(rejected).toContain(oldRequest);
    expect(recovered).not.toContain(oldRequest);
    expect(recovered).toContain("Answer the latest request");
    expect(recovered.length).toBeLessThan(rejected.length);
    expect(gateway.requests[3]?.messages).toContainEqual(expect.objectContaining({ role: "toolResult", toolCallId: "shipment" }));
  } finally {
    await gateway.close();
  }
}, 20000);

it("cuts above 5,250 with cache-write tokens and keeps the same cuttable history at 5,250", async () => {
  const gateway = await startDurableTestGateway();
  try {
    const seed = "Check the growing schedule. " + "seedling ".repeat(160);
    const tail = "Schedule reviewed. " + "calendar ".repeat(650);
    gateway.script(
      { content: "Ready for the schedule.", usage: { input: 200 } },
      { content: tail, usage: { input: 1, cacheWrite: 5241 } },
      { content: tail, usage: { input: 1, cacheWrite: 5242 } },
      { content: "Watered today.", usage: { input: 310 } },
    );
    expect((await gateway.send("local", "Open the greenhouse.", { clientSendId: "greenhouse" })).status).toBe(200);
    expect((await gateway.send("local", seed, { clientSendId: "schedule" })).status).toBe(200);
    const before = await (await gateway.request("local", feed)).json();
    // Durable 1.6.0 estimates eight tokens for the 27-character input including its sender header.
    expect((await gateway.send("local", "A", { clientSendId: "at-ceiling" })).status).toBe(200);
    expect((await gateway.send("local", "B", { clientSendId: "above-ceiling" })).status).toBe(200);
    expect(gateway.callCount()).toBe(4);
    expect(JSON.stringify(gateway.requests[2]?.messages)).toContain(seed);
    expect(JSON.stringify(gateway.requests[3]?.messages)).toContain("[" + before.items[0].id + "]");
    expect(JSON.stringify(gateway.requests[3]?.messages)).not.toContain(seed);
  } finally {
    await gateway.close();
  }
}, 20000);

it("budgets the active fallback model's smaller window", async () => {
  const gateway = await startDurableTestGateway({
    extraYaml: "retryMaxAttempts: 1\nfallback_model: { provider: faux, model: fixture-alternate }",
  });
  try {
    const request = "File the orchard plan. " + "plan ".repeat(250);
    gateway.script(
      { content: "Ready for the plan.", usage: { input: 250 } },
      { content: "Plan filed. " + "orchard ".repeat(670), usage: { input: 4200 } },
      { content: { errorMessage: "429 Too Many Requests" }, usage: { input: 0 } },
      { content: (model) => `The ${model} model answered.`, usage: { input: 300 } },
    );
    expect((await gateway.send("local", "Open the orchard plans.", { clientSendId: "open" })).status).toBe(200);
    expect((await gateway.send("local", request, { clientSendId: "plan" })).status).toBe(200);
    expect((await gateway.send("local", "Confirm the plan.", { clientSendId: "confirm" })).status).toBe(200);

    expect((await gateway.history("local")).messages.at(-1)).toMatchObject({ content: "The fixture-alternate model answered." });
    expect(gateway.requests).toHaveLength(4);
    expect(JSON.stringify(gateway.requests[2]?.messages)).toContain(request);
    expect(JSON.stringify(gateway.requests[3]?.messages)).toContain("Answer the latest request");
    expect(JSON.stringify(gateway.requests[3]?.messages)).not.toContain(request);
  } finally {
    await gateway.close();
  }
}, 20000);

it("keeps the owner's history through tool changes, a smaller model, a restart and a second cut", async () => {
  const noDeferral = "toolDeferral: { enabled: false }";
  const deferral = "toolDeferral: { enabled: true }";
  const gateway = await startDurableTestGateway({ multiUser: true, extraYaml: noDeferral });
  try {
    const first = "Check the pear records. " + "pear ".repeat(300);
    const longReply = "The records are ready. " + "orchard ".repeat(650);
    gateway.script(
      { content: "Pear records opened.", usage: { input: 260 } },
      { content: "Plum records opened.", usage: { input: 220 } },
      { content: longReply, usage: { input: 4200 } },
      { content: (model) => `Reviewed on ${model}.`, usage: { input: 340 } },
    );
    expect((await gateway.send("alice", first, { clientSendId: "pears" })).status).toBe(200);
    expect((await gateway.send("bob", "Check the plum records.", { clientSendId: "plums" })).status).toBe(200);
    const aliceFeed = async (): Promise<FeedWindow> => (await gateway.request("alice", feed)).json();
    const bobBefore = await (await gateway.request("bob", feed)).json();
    const aliceBefore = await aliceFeed();

    await gateway.configure("fixture", deferral);
    expect((await gateway.send("alice", "Read the pear rows.", { clientSendId: "rows" })).status).toBe(200);
    expect(gateway.offeredTools(0)).not.toContain("tool_search");
    expect(gateway.offeredTools(2)).toContain("tool_search");
    const afterTools = await aliceFeed();
    expect(afterTools.items.map(({ role }) => role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(afterTools.items.slice(0, 2)).toEqual(aliceBefore.items);
    expect(JSON.stringify(gateway.requests[2]?.messages)).toContain(first);

    const socket = await gateway.socket("alice");
    socket.send({ type: "subscribeFeed", agentId: "pilot" });
    await vi.waitFor(() => expect(socket.events[0]).toMatchObject({ type: "feed_snapshot", items: afterTools.items }));
    await gateway.configure("fixture-alternate", deferral);
    expect((await gateway.send("alice", "Review the pear record.", { clientSendId: "review" })).status).toBe(200);
    const afterCut = await aliceFeed();
    expect(afterCut.items.slice(0, 4)).toEqual(afterTools.items);
    expect(afterCut.items.slice(4)).toMatchObject([
      { role: "user", text: "Review the pear record." },
      { role: "seam", reason: "threshold" },
      { role: "assistant", text: "Reviewed on fixture-alternate." },
    ]);
    const seam = afterCut.items[5]!;
    expect(JSON.stringify(gateway.requests[3]?.messages)).not.toContain(first);
    await vi.waitFor(() => expect(socket.events.some((event) =>
      event.type === "feed_delta" && event.upsert.some(({ id }) => id === seam.id))).toBe(true));
    expect((await gateway.request("bob", feed + "?around=" + seam.id)).status).toBe(404);
    expect(await (await gateway.request("bob", feed)).json()).toEqual(bobBefore);

    await gateway.restart();
    expect(await aliceFeed()).toEqual(afterCut);
    expect(gateway.callCount()).toBe(4);
    gateway.script(
      { content: longReply, usage: { input: 3900 } },
      { content: "The pear report is complete.", usage: { input: 400 } },
    );
    expect((await gateway.send("alice", "Prepare the report.", { clientSendId: "prep" })).status).toBe(200);
    expect((await gateway.send("alice", "Finish the report.", { clientSendId: "finish" })).status).toBe(200);
    expect((await aliceFeed()).items.filter(({ role }) => role === "seam")).toHaveLength(2);
    const secondSummary = gateway.requests[5]?.messages[1];
    expect(secondSummary).toMatchObject({ role: "user", content: [{ text: expect.stringContaining(
      "[" + aliceBefore.items[0]!.id + "]",
    ) }] });
    expect(JSON.stringify(secondSummary)).not.toContain("plum");
    expect(await (await gateway.request("bob", feed)).json()).toEqual(bobBefore);
  } finally {
    await gateway.close();
  }
}, 20000);

it("passes the configured long prompt-cache retention to Durable provider requests", async () => {
  const gateway = await startDurableTestGateway();
  try {
    gateway.script("Short cache request.", "Long cache request.", "Default cache request.");
    expect((await gateway.send("local", "Check the cache default.", { clientSendId: "cache-default" })).status).toBe(200);
    await gateway.configure("fixture", "sandbox:\n  env: { PI_CACHE_RETENTION: long }");
    expect((await gateway.send("local", "Check long cache.", { clientSendId: "cache-long" })).status).toBe(200);
    await gateway.configure("fixture", "sandbox:\n  env: { PI_CACHE_RETENTION: short }");
    expect((await gateway.send("local", "Check default cache again.", { clientSendId: "cache-short" })).status).toBe(200);
    expect(gateway.cacheRetentions).toEqual([undefined, "long", undefined]);
  } finally {
    await gateway.close();
  }
}, 20000);

it("reports usage from a private assistant tool round after a cut without exposing it", async () => {
  let finish!: () => void;
  const held = new Promise<void>((resolve) => { finish = resolve; });
  const gateway = await startDurableTestGateway({
    extraYaml: "toolDeferral: { enabled: false }",
    fixture: { invisibleTools: ["private_probe"], extension: defineExtension({
      name: "private-compaction-fixture",
      tools: [defineTool({
        name: "private_probe", description: "Check a private fixture value", parameters: { type: "object" },
        async execute() { return { output: [{ type: "text", text: "private fixture result" }], details: { hidden: true } }; },
      })],
    }) },
  });
  try {
    gateway.script(
      { content: "Archive ready. " + "crate ".repeat(1000), usage: { input: 5300 } },
      { content: { tool: "private_probe", id: "hidden-usage" }, usage: { input: 101, cacheRead: 200, cacheWrite: 32, output: 17 } },
      { content: async () => { await held; return "Archive verified."; }, usage: { input: 344 } },
    );
    expect((await gateway.send("local", "Open the crate archive.", { clientSendId: "archive" })).status).toBe(200);
    const running = gateway.send("local", "Verify the archive.", { clientSendId: "verify" });
    await vi.waitFor(() => expect(gateway.requests).toHaveLength(3));
    const history = await gateway.history("local", "?view=full");
    expect(history.activeContextUsage).toEqual({ inputTokens: 333, model: "fixture" });
    expect(JSON.stringify(history.messages)).not.toMatch(/private_probe|private fixture result/);
    finish();
    expect((await running).status).toBe(200);
  } finally {
    finish();
    await gateway.close();
  }
}, 20000);
