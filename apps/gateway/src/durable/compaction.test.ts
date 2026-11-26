import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, CompactionEntry, LiveDoc, ToolResultEntry, type ConversationId, type EntryId, type EntryRecord, type HookApi, type TaskId } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai-durable/providers/faux";
import { expect, it, vi } from "vitest";
import { summarizeCompaction } from "./compaction.js";
import { emptyMemory, renderMemory } from "./memory.js";
import { InputEntry, ReviewDoc } from "./state.js";

const conversationId = 1 as ConversationId;
const taskId = 8 as TaskId;
const date = Date.UTC(2026, 7, 12);

function entry(id: number, kind: string, fields: Pick<EntryRecord, "data" | "model">): EntryRecord {
  return { id: id as EntryId, conversationId, kind, byTaskId: taskId, ...fields };
}

function input(id: number, text: string) {
  return entry(id, InputEntry.kind, { data: {
    timestamp: date, sender: { id: "fixture-casey", name: "Casey" }, surface: "web", text,
  } });
}

function toolRound(id: number, name: string, args: Record<string, string>, isError = false) {
  const callId = "call-" + id;
  return [
    entry(id, AssistantEntry.kind, {
      model: [fauxAssistantMessage([fauxText("withheld draft text"), fauxToolCall(name, args, { id: callId })], { stopReason: "toolUse" })],
    }),
    entry(id + 1, ToolResultEntry.kind, { model: [{
      role: "toolResult", timestamp: date, toolCallId: callId, toolName: name, isError,
      content: [{ type: "text", text: "private output body" }],
    }] }),
  ];
}

function history(entries: EntryRecord[], first: number) {
  return {
    conversationId,
    snapshot: vi.fn().mockImplementation((doc) => {
      if (doc === LiveDoc) return { run: { first, taskId } };
      if (doc === ReviewDoc) return { byTask: { [taskId]: { state: "held", hiddenTools: ["internal_probe"] } } };
    }),
    entries: vi.fn<HookApi["entries"]>().mockImplementation(async (query, limit, cursor) => {
      const matching = entries.filter(({ id }) => id >= (query.minEntryId ?? 0) && id <= (query.maxEntryId ?? Infinity));
      if (query.order === "descending") matching.reverse();
      const offset = typeof cursor?.offset === "number" ? cursor.offset : 0;
      const next = offset + limit < matching.length ? { offset: offset + limit } : undefined;
      return { items: matching.slice(offset, offset + limit), next };
    }),
  };
}

it("builds the running turn from before the active slice using only public inputs and calls", async () => {
  const earlier = input(10, "Check the greenhouse.");
  const opening = input(20, "Record the shipment. " + "s".repeat(600));
  const olderRound = toolRound(21, "record_shipment", { crate: "pears" });
  const steer = input(23, "Check the apple crates too.");
  const recent = [
    ...toolRound(24, "internal_probe", { marker: "hidden args" }),
    ...toolRound(26, "check_crate", { crate: "apples" }, true),
  ];
  const { summary } = await summarizeCompaction({ entries: recent, firstKept: 28 as EntryId },
    history([earlier, opening, ...olderRound, steer, ...recent], 20), BACKGROUND_CONTEXT, async () => new Set());
  const [running, index] = summary.split("\n\nOlder requests\n");
  expect(running).toContain("Running turn\n- Record the shipment.");
  expect(running).toContain("\n- Check the apple crates too.");
  expect(running).toContain('check_crate {"crate":"apples"} (error)\n    → record_shipment {"crate":"pears"} (ok)');
  expect(running).not.toContain("s".repeat(500));
  expect(index?.split("\n").map((line) => line.split(" · ")[0])).toEqual([
    "[m_23] 2026-08-12", "[m_20] 2026-08-12", "[m_10] 2026-08-12",
  ]);
  expect(index).toContain("[m_10] 2026-08-12 · Casey · web · Check the greenhouse.");
  expect(summary).not.toMatch(/internal_probe|hidden args|withheld draft|private output body/);
});

it("keeps the latest completed calls and older request ids within the summary budgets", async () => {
  const requests = Array.from({ length: 120 }, (_, i) => input(i + 1, "Previous crate " + i + " " + "p".repeat(250)));
  const opening = input(121, "Check the numbered crates.");
  const dropped = [
    opening,
    ...Array.from({ length: 120 }, (_, i) => toolRound(122 + i * 2, "check_crate", { crate: i + "-" + "x".repeat(160) })).flat(),
  ];
  const { summary } = await summarizeCompaction({ entries: dropped, firstKept: 362 as EntryId },
    history([...requests, ...dropped], 121), BACKGROUND_CONTEXT, async () => new Set());
  const [frame, running, index] = summary.split("\n\n");
  expect(frame).toContain("Bracketed ids identify older requests.");
  expect(running && running.length).toBeLessThanOrEqual(8000);
  expect(running).toContain('check_crate {"crate":"119-');
  expect(running).not.toContain('check_crate {"crate":"0-');
  expect(running?.split("\n").at(-1)).toBe("Earlier tool calls in this run are not listed.");
  expect(index).toContain("[m_120] 2026-08-12 · Casey · web · Previous crate 119");
  expect(index).not.toContain("[m_1]");
  expect(summary.length).toBeLessThanOrEqual(16_000);
});

it("returns only the frame when reading a summary input fails", async () => {
  const api = history([], 20);
  api.entries.mockRejectedValue(new Error("fixture storage read failed"));
  expect(await summarizeCompaction({ entries: [], firstKept: 30 as EntryId }, api,
    BACKGROUND_CONTEXT, async () => new Set())).toEqual({
    summary: "Older messages are stored outside this context. Answer the latest request. Return to an older topic only if the user does. Bracketed ids identify older requests. Open any bracketed request with session_history read, around: <id>.",
  });
});

it("carries older request ids from the previous native checkpoint", async () => {
  const previous = {
    ...entry(32, CompactionEntry.kind, { model: [{
      role: "user", timestamp: date, content: [{ type: "text", text:
        "Prior summary\n\nOlder requests\n[m_10] 2026-08-12 · Casey · web · Check the greenhouse.\n</summary>" }],
    }] }),
    head: 20 as EntryId,
  };
  const newer = input(25, "Read the orchard plan.");
  const { summary } = await summarizeCompaction({ entries: [previous, newer], firstKept: 30 as EntryId },
    history([newer], 34), BACKGROUND_CONTEXT, async () => new Set());
  expect(summary.split("\n").slice(-2)).toEqual([
    "[m_25] 2026-08-12 · Casey · web · Read the orchard plan.",
    "[m_10] 2026-08-12 · Casey · web · Check the greenhouse.",
  ]);
});

it("places bounded memory after the running turn and before the request index", async () => {
  const opening = input(20, "Check the apple crates.");
  const line = "- Open: Wait for the orchard report (refs: m_10)";
  const { summary } = await summarizeCompaction({ entries: [opening], firstKept: 21 as EntryId },
    history([opening], 20), BACKGROUND_CONTEXT, async () => new Set(),
    async () => Array<string>(100).fill(line).join("\n"));
  const [, running, memory, index] = summary.split("\n\n");
  expect(running).toBe("Running turn\n- Check the apple crates.");
  expect(memory).toMatch(/^Memory\n- Open: Wait for the orchard report \(refs: m_10\)/);
  expect(memory!.length).toBeLessThanOrEqual(4_000);
  expect(memory?.split("\n").at(-1)).toBe(line);
  expect(index).toBe("Older requests\n[m_20] 2026-08-12 · Casey · web · Check the apple crates.");
});

it("still indexes earlier requests when reading memory fails", async () => {
  const earlier = input(10, "Check the greenhouse.");
  const { summary } = await summarizeCompaction({ entries: [earlier], firstKept: 15 as EntryId },
    history([earlier], 20), BACKGROUND_CONTEXT, async () => new Set(),
    async () => { throw new Error("fixture memory read failed"); });
  expect(summary).toContain("Bracketed ids identify older requests.");
  expect(summary).toContain("\n\nOlder requests\n[m_10] 2026-08-12 · Casey · web · Check the greenhouse.");
  expect(summary).not.toContain("\n\nMemory\n");
});

it("carries only request index lines at the next cut", async () => {
  const earlier = input(10, "Check the greenhouse.");
  const memory = {
    ...emptyMemory(), topics: [{
      id: "report", kind: "decision" as const, title: "Report",
      note: "Use the new form.\n[m_55] This is not an index entry.", refs: ["m_12"],
    }],
  };
  const first = await summarizeCompaction({ entries: [earlier], firstKept: 20 as EntryId },
    history([earlier], 30), BACKGROUND_CONTEXT, async () => new Set(), async () => renderMemory(memory, 4_000));
  expect(first.summary).toContain("This is not an index entry. (refs: m_12)");
  const previous = {
    ...entry(32, CompactionEntry.kind, { model: [{ role: "user", timestamp: date, content: first.summary }] }),
    head: 20 as EntryId,
  };
  const newer = input(25, "Read the orchard plan.");
  const second = await summarizeCompaction({ entries: [previous, newer], firstKept: 30 as EntryId },
    history([newer], 34), BACKGROUND_CONTEXT, async () => new Set());
  expect(second.summary.split("\n\nOlder requests\n")[1]?.split("\n")).toEqual([
    "[m_25] 2026-08-12 · Casey · web · Read the orchard plan.",
    "[m_10] 2026-08-12 · Casey · web · Check the greenhouse.",
  ]);
});

it("clips background digests and keeps carried user requests ahead of newer digests", async () => {
  const previous = {
    ...entry(30, CompactionEntry.kind, { model: [{
      role: "user", timestamp: date, content:
        "Older requests\n[m_10] 2026-08-12 · Casey · web · Read the orchard plan.\n[m_9] 2026-08-12 · Archive · job · Completed.",
    }] }),
    head: 20 as EntryId,
  };
  const job = entry(25, "yoplai.child-digest", { data: {
    timestamp: date, text: "j".repeat(150), surface: "job", name: "Inventory",
  } });
  const webhook = entry(26, "yoplai.child-digest", { data: {
    timestamp: date, text: "w".repeat(150), surface: "webhook", name: "Dispatch",
  } });
  const small = [job, webhook];
  const summarize = (records: EntryRecord[]) => summarizeCompaction({ entries: [previous, ...records], firstKept: 300 as EntryId },
    history(records, 301), BACKGROUND_CONTEXT, async () => new Set());
  const lines = (await summarize(small)).summary.split("\n").slice(-4);
  expect(lines).toEqual([
    "[m_26] 2026-08-12 · Dispatch · webhook · " + "w".repeat(100),
    "[m_25] 2026-08-12 · Inventory · job · " + "j".repeat(100),
    "[m_10] 2026-08-12 · Casey · web · Read the orchard plan.",
    "[m_9] 2026-08-12 · Archive · job · Completed.",
  ]);

  const crowded = [...small, ...Array.from({ length: 200 }, (_, index) => entry(index + 40, "yoplai.child-digest", {
    data: { timestamp: date, text: "w".repeat(150), surface: "webhook", name: "Dispatch" },
  }))];
  const { summary } = await summarize(crowded);
  expect(summary).toContain(lines[2]);
  expect(summary).toContain("[m_239] 2026-08-12 · Dispatch · webhook");
  expect(summary).not.toContain(lines[3]);
  expect(summary.length).toBeLessThanOrEqual(16_000);
});
