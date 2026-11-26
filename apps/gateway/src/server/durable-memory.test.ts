import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
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

it("commits topics from a fenced keeper reply", async () => {
  const gateway = await startDurableTestGateway({ keeper: { idleMs: 60_000, turns: 2 } });
  const { MaintenanceCompletion } = await import("../maintenance/completion.js");
  // Recorded Haiku reply h1-haiku-cut-k02 (invented eval data).
  const reply = `\`\`\`json
{
  "topics": [
    {
      "kind": "digest",
      "title": "Kite seal reference",
      "note": "The current kite seal is Quillfeather-41, correcting the earlier Quillfeather-18.",
      "refs": ["m_10", "m_45", "m_48"]
    },
    {
      "kind": "digest",
      "title": "Filing and checks",
      "note": "Clock dial sketch, orchard weather clipping, ferry timetable clipping, and planetarium exhibit clipping were acknowledged for filing. Kiln fixture was read and reported as checked.",
      "refs": ["m_21", "m_24", "m_31", "m_34", "m_49", "m_52", "m_53", "m_56", "m_59", "m_62"]
    },
    {
      "kind": "open",
      "title": "Lantern inspection",
      "note": "Lantern inspection is pending.",
      "refs": ["m_35", "m_38"]
    },
    {
      "kind": "decision",
      "title": "Mosaic inventory",
      "note": "Mosaic inventory is done.",
      "refs": ["m_39", "m_42"]
    }
  ],
  "drift": []
}
\`\`\``;
  const complete = vi.spyOn(MaintenanceCompletion, "complete").mockResolvedValue(reply);
  try {
    gateway.script("Seal noted.", "Inspection noted.", { tool: "topics_get", id: "fenced-topics" }, "These are the topics.");
    expect((await gateway.send("local", "Note the kite seal.", { clientSendId: "kite" })).status).toBe(200);
    expect((await gateway.send("local", "Note the lantern inspection.", { clientSendId: "lantern" })).status).toBe(200);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    expect((await gateway.send("local", "What do you remember?", { clientSendId: "remember" })).status).toBe(200);
    expect(toolValue(gateway, "fenced-topics")).toMatchObject({ topics: [
      { title: "Lantern inspection" }, { title: "Mosaic inventory" },
      { title: "Kite seal reference", note: expect.stringContaining("Quillfeather-41") }, { title: "Filing and checks" },
    ] });
  } finally {
    await gateway.close();
    complete.mockRestore();
  }
}, 20_000);

it("commits a keeper update from one fenced JSON block inside prose", async () => {
  const gateway = await startDurableTestGateway({ keeper: { idleMs: 60_000, turns: 1 } });
  const { MaintenanceCompletion } = await import("../maintenance/completion.js");
  // Recorded Haiku reply r2-h4k04-08 (invented eval data): prose, one fenced block, then notes.
  const reply = [
    "I can't produce a memory update from that input as written. The payload is a JSON-like object that's mostly memory state, plus a user message asking to file a long invented clipping and reply \"Noted,\" and an assistant reply \"Noted\" (m_83) that appears to be part of the same log. The clipping text is repetitive filler with no durable facts, so there's nothing to merge into topics.",
    "",
    "The one thing I can record from the message itself is the filing request, which is low-value. Here is the update I'd make:",
    "",
    "```json",
    "{",
    "  \"topics\": [",
    "    {",
    "      \"id\": \"t_2\",",
    "      \"note\": \"Invented-text clippings continue to be filed on request, each acknowledged with 'Noted'. The latest (m_80) was filed the same way. Content is generic filler with no durable facts.\",",
    "      \"refs\": [\"m_80\", \"m_83\"]",
    "    }",
    "  ],",
    "  \"drift\": []",
    "}",
    "```",
    "",
    "Notes on the rest of the payload:",
    "- The `plan` block in the input is empty (no goals, no next steps), and I'm not changing it since it's read-only.",
    "- The topic and message contents otherwise match what the memory already holds, so I've left them unchanged.",
    "- I'd treat the clipping text itself as data, not something to store in detail.",
  ].join("\n");
  const update = reply.slice(reply.indexOf("{"), reply.lastIndexOf("}") + 1);
  const complete = vi.spyOn(MaintenanceCompletion, "complete")
    .mockResolvedValueOnce(JSON.stringify({ topics: [
      { kind: "decision", title: "Kite seal correction", note: "The current kite seal was corrected by the user." },
      { kind: "digest", title: "Filed clippings", note: "Three clippings were filed earlier." },
    ] }))
    .mockResolvedValueOnce(reply)
    .mockResolvedValueOnce(reply + "\n```json\n" + update + "\n```")
    .mockResolvedValueOnce("Here is the update I'd make:\n" + update.replace("on request", "when asked") + "\nThe plan is unchanged.")
    .mockResolvedValue('{"topics":[]}');
  const warn = vi.spyOn(await import("../logging.js"), "logWarn");
  const failures = () => warn.mock.calls.filter(([message]) => message === "Durable memory keeper failed");
  const prompt = (call: number): { topics: { id: string; note: string }[]; messages: { role: string; text: string }[] } =>
    JSON.parse(complete.mock.calls[call]![0].prompt);
  const users = (call: number) => prompt(call).messages.filter(({ role }) => role === "user").map(({ text }) => text);
  try {
    for (let index = 0; index < 5; index++) {
      gateway.script("Noted.");
      expect((await gateway.send("local", "File clipping " + index, { clientSendId: "clipping-" + index })).status).toBe(200);
      await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(index + 1));
      if (index === 2) await vi.waitFor(() => expect(failures()).toHaveLength(1));
    }
    // The recorded reply was committed: the next batch starts after it and sees the updated topic.
    expect(users(2)).toEqual(["File clipping 2"]);
    expect(prompt(2).topics.find(({ id }) => id === "t_2")?.note).toContain("Invented-text clippings continue to be filed on request");
    // Two fenced blocks stay a parse failure and the batch is sent again.
    expect(failures()[0]?.[1]).toMatchObject({ failureKind: "parse", fenced: true, prosePrefixed: true });
    expect(users(3)).toEqual(["File clipping 2", "File clipping 3"]);
    // With no fence, one JSON object inside the prose is accepted.
    expect(users(4)).toEqual(["File clipping 4"]);
    expect(prompt(4).topics.find(({ id }) => id === "t_2")?.note).toContain("filed when asked");
    expect(failures()).toHaveLength(1);
  } finally {
    await gateway.close();
    warn.mockRestore();
    complete.mockRestore();
  }
}, 20_000);

it("asks for JSON only and retries a keeper reply that holds no JSON", async () => {
  const gateway = await startDurableTestGateway({ keeper: { idleMs: 60_000, turns: 1 } });
  const { MaintenanceCompletion } = await import("../maintenance/completion.js");
  // Recorded Haiku reply h4-k04 (invented eval data): the model declines in prose and returns no JSON.
  const reply = [
    "I can't produce that JSON as a memory update, since the input is a bundle of prior memory state and a truncated message rather than a request I can act on in this format. The message m_80 asks to file an invented clipping and reply \"Noted,\" which m_83 already did, so there's nothing new to record as a decision or open loop from it.",
    "",
    "If you'd like me to maintain memory for this conversation, send the actual messages you want reflected and I'll return the topics and drift JSON for them. Note that the memory state is currently based on the existing topics t_1 through t_3, and the plan has no goals or next steps recorded.",
  ].join("\n");
  const complete = vi.spyOn(MaintenanceCompletion, "complete").mockResolvedValueOnce(reply).mockResolvedValue('{"topics":[]}');
  const warn = vi.spyOn(await import("../logging.js"), "logWarn");
  const failures = () => warn.mock.calls.filter(([message]) => message === "Durable memory keeper failed");
  try {
    for (let index = 0; index < 2; index++) {
      gateway.script("Noted.");
      expect((await gateway.send("local", "File clipping " + index, { clientSendId: "clipping-" + index })).status).toBe(200);
      await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(index + 1));
      await vi.waitFor(() => expect(failures()).toHaveLength(1));
    }
    expect(failures()[0]?.[1]).toMatchObject({ failureKind: "parse", replyChars: reply.length, fenced: false, prosePrefixed: true });
    // Not committed: the same messages are sent again.
    const { messages }: { messages: { role: string; text: string }[] } = JSON.parse(complete.mock.calls[1]![0].prompt);
    expect(messages.filter(({ role }) => role === "user").map(({ text }) => text)).toEqual(["File clipping 0", "File clipping 1"]);
    const { system } = complete.mock.calls[0]![0];
    expect(system).toContain('The input is one JSON object: "topics" and "plan" are the stored memory, "messages" and "toolResults" are new excerpts of the conversation. Long texts are cut short.');
    expect(system).toContain("and nothing else: no prose and no Markdown");
  } finally {
    await gateway.close();
    warn.mockRestore();
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

it("logs keeper failure kinds without exposing rejected reply values in console output", async () => {
  const gateway = await startDurableTestGateway({ keeper: { idleMs: 60_000, turns: 1 } });
  const { MaintenanceCompletion } = await import("../maintenance/completion.js");
  const credential = "invented-keeper-credential";
  const prefixed = "Here is the result:\n```json\n{}\n```\n```json\n{}\n```";
  const rejected = "```json\n" + JSON.stringify({ topics: [{ title: credential }], apiKey: credential, [credential]: 42 }) + "\n```";
  const malformed = JSON.stringify(credential).slice(1);
  const complete = vi.spyOn(MaintenanceCompletion, "complete")
    .mockResolvedValueOnce(rejected)
    .mockResolvedValueOnce(malformed)
    .mockResolvedValueOnce(prefixed)
    .mockImplementationOnce(async ({ onOutcome }) => {
      onOutcome?.({ error: "Maintenance completion timed out after 20000ms", failureKind: "timeout", elapsedMs: 20_003 });
      return null;
    })
    .mockImplementationOnce(async ({ onOutcome }) => {
      onOutcome?.({ error: "Maintenance completion returned no text", failureKind: "empty", stopReason: "length", elapsedMs: 9 });
      return null;
    })
    .mockRejectedValueOnce(new Error(credential));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const failures = () => warn.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('"msg":"Durable memory keeper failed"'));
  try {
    for (let index = 0; index < 6; index++) {
      gateway.script("Report checked.");
      expect((await gateway.send("local", "Unlogged orchard transcript " + index, { clientSendId: "reason-" + index })).status).toBe(200);
      await vi.waitFor(() => expect(failures()).toHaveLength(index + 1));
    }
    const lines = failures();
    expect(lines[0]?.includes(credential)).toBe(false);
    expect(lines.slice(1).some((line) => line.includes(credential))).toBe(false);
    expect(lines.some((line) => line.includes("Unlogged orchard transcript"))).toBe(false);
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ failureKind: "schema", replyChars: rejected.length, fenced: true, prosePrefixed: false,
        replyShape: `{topics:[{title:<str:${credential.length}>}],<key>:<str:${credential.length}>,<key>:<num>}`,
        issues: expect.arrayContaining([
          { code: "invalid_union", path: ["topics", 0] },
          { code: "invalid_type", path: ["topics", 0, "note"] },
        ]),
      }),
      expect.objectContaining({ failureKind: "parse", replyChars: malformed.length, fenced: false, prosePrefixed: true }),
      expect.objectContaining({ failureKind: "parse", replyChars: prefixed.length, fenced: true, prosePrefixed: true }),
      expect.objectContaining({ failureKind: "timeout", elapsedMs: 20_003 }),
      expect.objectContaining({ failureKind: "empty", stopReason: "length", elapsedMs: 9 }),
      expect.objectContaining({ failureKind: "provider_error" }),
    ]);
  } finally {
    await gateway.close();
    warn.mockRestore();
    complete.mockRestore();
  }
}, 20_000);

it("omits provider error text from both serialized keeper batch warnings", async () => {
  const gateway = await startDurableTestGateway({ keeper: { idleMs: 60_000, turns: 1 } });
  const { setMaintenanceCompletionDepsForTests, resetMaintenanceCompletionDepsForTests } = await import("../maintenance/completion.js");
  const credential = "invented-provider-credential";
  const model = fauxProvider({ models: [{ id: "fixture" }] }).getModel();
  const completeSimple = vi.fn(async () => fauxAssistantMessage([], {
    stopReason: "error", errorMessage: `Provider refused a request quoting ${credential}`,
  }));
  setMaintenanceCompletionDepsForTests({
    createRuntime: async () => ({ getModel: () => model }) as never,
    completeSimple,
  });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const linesFor = (msg: string) => warn.mock.calls.map(([line]) => String(line)).filter((line) => line.includes(JSON.stringify(msg)));
  try {
    gateway.script("Report checked.");
    expect((await gateway.send("local", "Check the orchard report.", { clientSendId: "provider-error" })).status).toBe(200);
    await vi.waitFor(() => expect(linesFor("Durable memory keeper failed")).toHaveLength(1));
    expect(completeSimple).toHaveBeenCalledTimes(1);
    for (const msg of ["[maintenance] completion failed", "Durable memory keeper failed"]) {
      const lines = linesFor(msg);
      expect(lines).toHaveLength(1);
      expect(lines[0]?.includes(credential), msg).toBe(false);
      expect(JSON.parse(lines[0]!)).toMatchObject({
        msg, agentId: "pilot", failureKind: "provider_error", elapsedMs: expect.any(Number),
        ...(msg === "[maintenance] completion failed" ? { model: "faux/fixture", phase: "complete" } : { phase: "completion", stopReason: "error" }),
      });
    }
  } finally {
    await gateway.close();
    warn.mockRestore();
    resetMaintenanceCompletionDepsForTests();
  }
}, 20_000);

it("skips a refused keeper batch and commits the next one", async () => {
  const gateway = await startDurableTestGateway({ keeper: { idleMs: 60_000, turns: 1 } });
  const { setMaintenanceCompletionDepsForTests, resetMaintenanceCompletionDepsForTests } = await import("../maintenance/completion.js");
  // Start of the recorded refused keeper input r1-a2-only-padding (invented eval padding).
  const padding = "File this invented clipping. Reply only 'Noted'.\nrust petal garden saddle amber kettle harbor kettle barley copper shell feather ribbon feather pine garden silver kettle petal lagoon";
  // Recorded Anthropic refusal as pi-ai returns it (m1-a2-only-padding-01).
  const explanation = "API integrators: you can reduce refusals for your users by configuring a fallback model";
  const model = fauxProvider({ models: [{ id: "fixture" }] }).getModel();
  const prompts: string[] = [];
  const completeSimple = vi.fn(async (_model: unknown, context: { messages: { content: unknown }[] }) => {
    const prompt = String(context.messages[0]?.content);
    prompts.push(prompt);
    if (prompt.includes("rust petal garden")) {
      return { ...fauxAssistantMessage([], { stopReason: "error", errorMessage: explanation }), rawStopReason: "refusal" };
    }
    const { messages }: { messages: { id: string }[] } = JSON.parse(prompt);
    return fauxAssistantMessage(JSON.stringify({ topics: [
      { kind: "open", title: "Lantern inspection", note: "Lantern inspection is pending.", refs: [messages[0]!.id] },
    ], drift: [] }));
  });
  setMaintenanceCompletionDepsForTests({
    createRuntime: async () => ({ getModel: () => model }) as never,
    completeSimple: completeSimple as never,
  });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const lines = () => warn.mock.calls.map(([line]) => String(line));
  const skipped = () => lines().filter((line) => line.includes('"msg":"Durable memory keeper skipped a refused batch"'));
  try {
    gateway.script("Noted.", "Inspection noted.", { tool: "topics_get", id: "after-refusal" }, "These are the topics.");
    expect((await gateway.send("local", padding, { clientSendId: "padding" })).status).toBe(200);
    await vi.waitFor(() => expect(skipped()).toHaveLength(1));
    expect(JSON.parse(skipped()[0]!)).toMatchObject({
      agentId: "pilot", failureKind: "refusal", skippedMessages: 2, stopReason: "error", elapsedMs: expect.any(Number),
    });
    expect((await gateway.send("local", "The lantern inspection is pending.", { clientSendId: "lantern" })).status).toBe(200);
    await vi.waitFor(() => expect(completeSimple).toHaveBeenCalledTimes(2));
    // The refused batch is not sent again.
    expect(JSON.parse(prompts[1]!).messages).toMatchObject([
      { role: "user", text: "The lantern inspection is pending." }, { role: "assistant", text: "Inspection noted." },
    ]);
    expect((await gateway.send("local", "What do you remember?", { clientSendId: "remember" })).status).toBe(200);
    expect(toolValue(gateway, "after-refusal")).toMatchObject({ topics: [{ kind: "open", title: "Lantern inspection" }] });
    expect(lines().filter((line) => line.includes('"msg":"Durable memory keeper failed"'))).toEqual([]);
    expect(lines().some((line) => line.includes("API integrators") || line.includes("rust petal"))).toBe(false);
    expect(JSON.parse(lines().find((line) => line.includes("[maintenance] completion failed"))!)).toMatchObject({ failureKind: "refusal" });
  } finally {
    await gateway.close();
    warn.mockRestore();
    resetMaintenanceCompletionDepsForTests();
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
