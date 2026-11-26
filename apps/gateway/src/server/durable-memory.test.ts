import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { FeedWindow } from "@yoplai/shared";
import { expect, it, vi } from "vitest";
import { startDurableTestGateway } from "../test-utils/durable-gateway.js";

type Gateway = Awaited<ReturnType<typeof startDurableTestGateway>>;
const feed = "/api/agents/pilot/feed";

function toolValue(gateway: Gateway, callId: string): unknown {
  const result = gateway.requests.at(-1)?.messages.find((message) => message.role === "toolResult" && message.toolCallId === callId);
  const block = result?.role === "toolResult" ? result.content[0] : undefined;
  if (block?.type !== "text") throw new Error("Missing result for " + callId);
  return JSON.parse(block.text);
}

it("remembers public messages on the first keeper tick and returns topics to the model", async () => {
  const gateway = await startDurableTestGateway({ keeper: { idleMs: 60_000, turns: 2 } });
  const { MaintenanceCompletion } = await import("../maintenance/completion.js");
  const complete = vi.spyOn(MaintenanceCompletion, "complete").mockResolvedValue('{"topics":[]}');
  try {
    gateway.script("I will wait for Casey.", "The packing list is ready.");
    expect((await gateway.send("local", "Wait for Casey's report.", { clientSendId: "report" })).status).toBe(200);
    const first: FeedWindow = await (await gateway.request("local", feed)).json();
    const ref = first.items[0]?.id;
    expect(ref).toMatch(/^m_\d+$/);
    complete.mockResolvedValueOnce(JSON.stringify({ topics: [
      { kind: "open", title: "Orchard report", note: "Waiting for Casey.", refs: [ref, "m_900001"] },
    ] }));
    expect((await gateway.send("local", "Print the packing list.", { clientSendId: "packing" })).status).toBe(200);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    expect(complete.mock.calls[0]?.[0].prompt).toContain("The packing list is ready.");

    gateway.script({ tool: "topics_get", id: "read-topics" }, "I remember the report.");
    expect((await gateway.send("local", "What do you remember?", { clientSendId: "memory" })).status).toBe(200);
    expect(toolValue(gateway, "read-topics")).toMatchObject({
      topics: [{ kind: "open", title: "Orchard report", note: "Waiting for Casey.", refs: [ref] }],
    });

    gateway.script("Casey confirmed Friday.", { tool: "topics_get", id: "new-topics" }, "The report is due Friday.");
    complete.mockImplementationOnce(async ({ prompt }) => {
      const { topics, messages } = JSON.parse(prompt);
      return JSON.stringify({ topics: [
        { id: topics[0].id, note: "Casey confirmed Friday.", resolved: true, refs: [messages.at(-1).id] },
        { kind: "digest", title: "Gate", note: "Use the south gate." },
      ] });
    });
    expect((await gateway.send("local", "Casey picked a date.", { clientSendId: "date" })).status).toBe(200);
    const updated: FeedWindow = await (await gateway.request("local", feed)).json();
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2));
    expect((await gateway.send("local", "What changed?", { clientSendId: "changed" })).status).toBe(200);
    expect(toolValue(gateway, "new-topics")).toMatchObject({
      topics: [
        { kind: "decision", title: "Orchard report", note: "Casey confirmed Friday.", refs: [ref, updated.items.at(-1)?.id] },
        { kind: "digest", title: "Gate", note: "Use the south gate." },
      ],
    });
  } finally {
    await gateway.close();
    complete.mockRestore();
  }
}, 20_000);

it("replaces the agent plan during a pending keeper tick and keeps the keeper's drift separate", async () => {
  const gateway = await startDurableTestGateway({ keeper: { idleMs: 60_000, turns: 1 } });
  const { MaintenanceCompletion } = await import("../maintenance/completion.js");
  const complete = vi.spyOn(MaintenanceCompletion, "complete").mockResolvedValue('{"topics":[]}');
  let release!: (text: string) => void;
  complete.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  try {
    gateway.script(
      { tool: "plan_update", id: "old-plan", args: { goals: ["Pack pears"], nextSteps: ["Find boxes", "Call Casey"] } },
      "The packing plan is set.",
      { tool: "plan_update", id: "new-plan", args: { goals: ["Ship apples"], nextSteps: ["Book a truck"] } },
      "The shipping plan is set.",
    );
    expect((await gateway.send("local", "Plan the pear packing.", { clientSendId: "plan-pears" })).status).toBe(200);
    expect(toolValue(gateway, "old-plan")).toMatchObject({ plan: { goals: ["Pack pears"], nextSteps: ["Find boxes", "Call Casey"] } });
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    expect(JSON.parse(complete.mock.calls[0]![0].prompt).plan).toMatchObject({ goals: ["Pack pears"] });

    expect((await gateway.send("local", "Switch to shipping apples.", { clientSendId: "plan-apples" })).status).toBe(200);
    expect(toolValue(gateway, "new-plan")).toMatchObject({ plan: { goals: ["Ship apples"], nextSteps: ["Book a truck"] } });
    expect(complete).toHaveBeenCalledTimes(1);
    release(JSON.stringify({ topics: [], drift: [{ note: "The packing work switched to shipping." }], plan: { goals: ["Overwrite this"] } }));
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2));
    expect(JSON.parse(complete.mock.calls[1]![0].prompt)).toMatchObject({
      plan: { goals: ["Ship apples"], nextSteps: ["Book a truck"] },
      messages: [
        { role: "user", text: "Switch to shipping apples." },
        { role: "assistant", text: "The shipping plan is set." },
      ],
      toolResults: [],
    });

    gateway.script({ tool: "plan_get", id: "read-plan" }, "I remember the shipping plan.");
    expect((await gateway.send("local", "What is the plan?", { clientSendId: "read-plan" })).status).toBe(200);
    expect(toolValue(gateway, "read-plan")).toEqual({
      plan: { goals: ["Ship apples"], nextSteps: ["Book a truck"], updatedAt: expect.any(Number) },
      drift: [{ note: "The packing work switched to shipping.", at: expect.any(Number), refs: [] }],
    });
  } finally {
    release?.('{"topics":[]}');
    await gateway.close();
    complete.mockRestore();
  }
}, 20_000);

it("warns on null, invalid and thrown responses and retries the same public messages", async () => {
  const gateway = await startDurableTestGateway({ keeper: { idleMs: 60_000, turns: 1 } });
  const { MaintenanceCompletion } = await import("../maintenance/completion.js");
  const complete = vi.spyOn(MaintenanceCompletion, "complete")
    .mockResolvedValueOnce(null).mockResolvedValueOnce("invalid JSON")
    .mockRejectedValueOnce(new Error("fixture completion rejected"))
    .mockResolvedValue('{"topics":[]}');
  const warn = vi.spyOn(await import("../logging.js"), "logWarn");
  try {
    const prompts = ["Read the orchard list.", "Check the packing list.", "Verify the count.", "Publish the report."];
    for (const [index, message] of prompts.entries()) {
      gateway.script("Report checked.");
      expect((await gateway.send("local", message, { clientSendId: "failure-" + index })).status).toBe(200);
      await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(index + 1));
      if (index < 3) {
        await vi.waitFor(() => expect(warn.mock.calls.filter(([message]) => message === "Durable memory keeper failed")).toHaveLength(index + 1));
      }
    }
    const attempts = complete.mock.calls.map(([{ prompt }]) =>
      JSON.parse(prompt).messages.filter(({ role }: { role: string }) => role === "user").map(({ text }: { text: string }) => text));
    expect(attempts).toEqual([
      ["Read the orchard list."],
      ["Read the orchard list.", "Check the packing list."],
      ["Read the orchard list.", "Check the packing list.", "Verify the count."],
      ["Read the orchard list.", "Check the packing list.", "Verify the count.", "Publish the report."],
    ]);
  } finally {
    await gateway.close();
    warn.mockRestore();
    complete.mockRestore();
  }
}, 20_000);

it("logs why the keeper failed, with a bounded reply excerpt and no transcript", async () => {
  const gateway = await startDurableTestGateway({ keeper: { idleMs: 60_000, turns: 1 } });
  const { MaintenanceCompletion } = await import("../maintenance/completion.js");
  const fenced = "```json\n" + JSON.stringify({ topics: [{ kind: "open", title: "Orchard", note: "apiKey=fixture-secret " + "pear ".repeat(100) }] }) + "\n```";
  const complete = vi.spyOn(MaintenanceCompletion, "complete")
    .mockResolvedValueOnce(fenced)
    .mockResolvedValueOnce('{"topics":[{"title":"Orchard"}]}')
    .mockImplementationOnce(async ({ onOutcome }) => {
      onOutcome?.({ error: "Maintenance completion timed out after 20000ms", elapsedMs: 20_003 });
      return null;
    })
    .mockImplementationOnce(async ({ onOutcome }) => {
      onOutcome?.({ error: "Maintenance completion returned no text", stopReason: "length", elapsedMs: 9 });
      return null;
    })
    .mockResolvedValue('{"topics":[]}');
  const warn = vi.spyOn(await import("../logging.js"), "logWarn");
  const failures = () => warn.mock.calls.filter(([message]) => message === "Durable memory keeper failed").map(([, fields]) => fields);
  try {
    for (let index = 0; index < 4; index++) {
      gateway.script("Report checked.");
      expect((await gateway.send("local", "Unlogged orchard transcript " + index, { clientSendId: "reason-" + index })).status).toBe(200);
      await vi.waitFor(() => expect(failures()).toHaveLength(index + 1));
    }
    expect(failures()).toEqual([
      expect.objectContaining({ phase: "result", error: expect.stringContaining("is not valid JSON"), replyChars: fenced.length, reply: fenced.slice(0, 200) }),
      expect.objectContaining({ phase: "result", error: expect.stringContaining("topics"), reply: '{"topics":[{"title":"Orchard"}]}' }),
      { agentId: "pilot", conversationId: expect.any(Number), phase: "completion", error: "Maintenance completion timed out after 20000ms", stopReason: undefined, elapsedMs: 20_003 },
      { agentId: "pilot", conversationId: expect.any(Number), phase: "completion", error: "Maintenance completion returned no text", stopReason: "length", elapsedMs: 9 },
    ]);
    for (const fields of failures()) expect((fields?.error as string).length).toBeLessThanOrEqual(300);
    expect(JSON.stringify(failures())).not.toContain("Unlogged orchard transcript");
  } finally {
    await gateway.close();
    warn.mockRestore();
    complete.mockRestore();
  }
}, 20_000);

it("catches up in order when maintenance recovers with a limited input budget", async () => {
  const gateway = await startDurableTestGateway({ keeper: { idleMs: 60_000, turns: 1 } });
  const { MaintenanceCompletion } = await import("../maintenance/completion.js");
  let offline = false;
  const processed: string[] = [];
  const previousNote = "Orchard season detail. ".repeat(24).trim();
  const complete = vi.spyOn(MaintenanceCompletion, "complete").mockImplementation(async ({ prompt, system, maxTokens }) => {
    if (offline || Buffer.byteLength(prompt) + Buffer.byteLength(system) + maxTokens > 8_000) return null;
    const { messages }: { messages: Array<{ id: string; role: string; text: string }> } = JSON.parse(prompt);
    processed.push(...messages.filter(({ role }) => role === "user").map(({ text }) => text.split("\n")[0]!));
    if (messages.some(({ text }) => text === "Start the orchard log.")) {
      return JSON.stringify({ topics: Array.from({ length: 24 }, (_, index) => ({
        kind: "open", title: "Existing topic " + index, note: previousNote,
      })) });
    }
    const update = messages.find(({ text }) => text.startsWith("The pears ship Friday."));
    return JSON.stringify({ topics: update ? [
      { kind: "decision", title: "Pear delivery", note: "The pears ship Friday.", refs: [update.id] },
    ] : [] });
  });
  try {
    const send = async (id: string, text: string) => {
      gateway.script("Orchard response. " + "Packing crate. ".repeat(260));
      expect((await gateway.send("local", text, { clientSendId: id })).status).toBe(200);
    };
    await send("seed", "Start the orchard log.");
    await vi.waitFor(() => expect(processed).toEqual(["Start the orchard log."]));

    offline = true;
    for (const [index, text] of [
      "Check the inventory.", "Label the crates.", "Send the invoice.", "The pears ship Friday.",
    ].entries()) {
      await send("outage-" + index, text + "\n" + "Orchard detail. ".repeat(260));
      await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(index + 2));
    }
    offline = false;
    await send("restore", "Publish the orchard log.");
    await vi.waitFor(() => expect(processed).toEqual([
      "Start the orchard log.", "Check the inventory.", "Label the crates.",
      "Send the invoice.", "The pears ship Friday.", "Publish the orchard log.",
    ]));

    const history: FeedWindow = await (await gateway.request("local", feed)).json();
    const ref = history.items.find(({ text }) => text.startsWith("The pears ship Friday."))?.id;
    expect(ref).toMatch(/^m_\d+$/);
    gateway.script({ tool: "topics_get", id: "after-outage" }, "The pears ship Friday.");
    expect((await gateway.send("local", "When do the pears ship?", { clientSendId: "remember-shipment" })).status).toBe(200);
    expect(toolValue(gateway, "after-outage")).toMatchObject({
      topics: expect.arrayContaining([
        expect.objectContaining({ kind: "decision", title: "Pear delivery", note: "The pears ship Friday.", refs: [ref] }),
        expect.objectContaining({ title: "Existing topic 0", note: previousNote }),
      ]),
    });
  } finally {
    await gateway.close();
    complete.mockRestore();
  }
}, 20_000);

it("keeps Alice's plan and topics out of Bob's tools and post-cut summary", async () => {
  const gateway = await startDurableTestGateway({ multiUser: true, keeper: { idleMs: 60_000, turns: 2 } });
  const { MaintenanceCompletion } = await import("../maintenance/completion.js");
  const complete = vi.spyOn(MaintenanceCompletion, "complete").mockResolvedValue('{"topics":[]}');
  complete.mockResolvedValueOnce(JSON.stringify({ topics: [{ kind: "open", title: "Alice orchard handoff", note: "Hold for Alice's private courier." }] }));
  try {
    const longReply = "Bob reviewed the report. " + "packing crate ".repeat(800);
    gateway.script(
      { tool: "plan_update", id: "alice-plan", args: { goals: ["Alice private packing plan"], nextSteps: ["Ask Alice"] } },
      "Alice's plan is set.",
      "Alice's handoff is ready.",
      { tool: "topics_get", id: "bob-topics" },
      { tool: "plan_get", id: "bob-plan" },
      { content: longReply, usage: { input: 5300 } },
      "Bob's report is ready.",
    );

    expect((await gateway.send("alice", "Set my plan.", { clientSendId: "alice-plan" })).status).toBe(200);
    expect((await gateway.send("alice", "Wait for my handoff.", { clientSendId: "alice-handoff" })).status).toBe(200);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    expect((await gateway.send("bob", "What are my topics and plan?", { clientSendId: "bob-memory" })).status).toBe(200);
    expect(toolValue(gateway, "bob-topics")).toEqual({ topics: [] });
    expect(toolValue(gateway, "bob-plan")).toEqual({ plan: { goals: [], nextSteps: [], updatedAt: null }, drift: [] });
    expect((await gateway.send("bob", "Now finish my report.", { clientSendId: "bob-cut" })).status).toBe(200);
    const after = JSON.stringify(gateway.requests.at(-1)?.messages);
    expect(after).toContain("Older requests");
    expect(after).not.toMatch(/Alice orchard handoff|Alice's private courier|Alice private packing plan/);
    const bobFeed: FeedWindow = await (await gateway.request("bob", feed)).json();
    expect(bobFeed.items.some(({ role }) => role === "seam")).toBe(true);

    await gateway.restart();
    gateway.script({ tool: "topics_get", id: "alice-topics" }, "Alice's topics were restored.");
    expect((await gateway.send("alice", "Read my handoff after restart.", { clientSendId: "alice-restore" })).status).toBe(200);
    expect(toolValue(gateway, "alice-topics")).toMatchObject({
      topics: [{ kind: "open", title: "Alice orchard handoff", note: "Hold for Alice's private courier." }],
    });
  } finally {
    await gateway.close();
    complete.mockRestore();
  }
}, 20_000);

it("waits for five turns at a busy audience and counts grouped public messages", async () => {
  const gateway = await startDurableTestGateway({
    keeper: { idleMs: 60_000 },
    fixture: { extension: defineExtension({
      name: "memory-fixture",
      tools: [defineTool({
        name: "count_crates", description: "Count crates", parameters: { type: "object" },
        async execute() { return { output: [{ type: "text", text: "Five crates." }] }; },
      })],
    }) },
  });
  const { MaintenanceCompletion } = await import("../maintenance/completion.js");
  const complete = vi.spyOn(MaintenanceCompletion, "complete").mockResolvedValue('{"topics":[]}');
  try {
    for (let turn = 1; turn <= 4; turn++) {
      gateway.script("Orchard checked.");
      expect((await gateway.send("local", "Check the orchard " + turn, { clientSendId: "turn-" + turn })).status).toBe(200);
    }
    expect(complete).not.toHaveBeenCalled();
    gateway.script(
      ["I'll check.", { tool: "count_crates", id: "count-one" }],
      ["One more check.", { tool: "count_crates", id: "count-two" }],
      "The count is confirmed.",
    );
    expect((await gateway.send("local", "Count the crates.", { clientSendId: "count" })).status).toBe(200);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    expect(JSON.parse(complete.mock.calls[0]![0].prompt)).toMatchObject({
      messages: [
        { role: "user", text: "Check the orchard 1" }, { role: "assistant", text: "Orchard checked." },
        { role: "user", text: "Check the orchard 2" }, { role: "assistant", text: "Orchard checked." },
        { role: "user", text: "Check the orchard 3" }, { role: "assistant", text: "Orchard checked." },
        { role: "user", text: "Check the orchard 4" }, { role: "assistant", text: "Orchard checked." },
        { role: "user", text: "Count the crates." },
        { role: "assistant", text: "I'll check.\nOne more check.\nThe count is confirmed." },
      ],
      toolResults: [{ name: "count_crates", text: "Five crates." }, { name: "count_crates", text: "Five crates." }],
    });
  } finally {
    await gateway.close();
    complete.mockRestore();
  }
}, 20_000);

it("skips a user message followed by private rounds, then catches it on an idle tick", async () => {
  const gateway = await startDurableTestGateway({
    keeper: { idleMs: 30 },
    reviewer: {
      begin() {}, end() {},
      review: (text) => text === "Public orchard count." || text === "" ? { ok: true } : { ok: false, rewriteHint: "Report only the count." },
    },
    fixture: { extension: defineExtension({
      name: "private-memory-fixture",
      tools: [defineTool({
        name: "private_probe", description: "Read a private value", parameters: { type: "object" },
        async execute() { return { output: [{ type: "text", text: "Private tool output." }], details: { hidden: true } }; },
      })],
    }) },
  });
  const { MaintenanceCompletion } = await import("../maintenance/completion.js");
  const complete = vi.spyOn(MaintenanceCompletion, "complete").mockResolvedValue('{"topics":[]}');
  try {
    gateway.script(
      ["Private tool draft.", { tool: "private_probe", id: "probe-one" }],
      ["Another private tool draft.", { tool: "private_probe", id: "probe-two" }],
      "",
      "Private unapproved draft.",
      "Public orchard count.",
    );
    expect((await gateway.send("local", "Run the private checks.", { clientSendId: "private" })).status).toBe(200);
    const before: FeedWindow = await (await gateway.request("local", feed)).json();
    expect(before.items).toMatchObject([{ role: "user", text: "Run the private checks." }]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(complete).not.toHaveBeenCalled();
    expect((await gateway.send("local", "Publish the orchard count.", { clientSendId: "public" })).status).toBe(200);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    const { prompt } = complete.mock.calls[0]![0];
    expect(JSON.parse(prompt)).toMatchObject({
      messages: [
        { role: "user", text: "Run the private checks." },
        { role: "user", text: "Publish the orchard count." },
        { role: "assistant", text: "Public orchard count." },
      ],
      toolResults: [],
    });
    expect(prompt).not.toMatch(/private_probe|Private tool output|Private tool draft|Private unapproved draft/);
  } finally {
    await gateway.close();
    complete.mockRestore();
  }
}, 20_000);
