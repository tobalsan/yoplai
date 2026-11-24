import { AssistantEntry, ToolResultEntry, type ConversationId, type EntryId, type EntryRecord, type TaskId } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai-durable/providers/faux";
import type { FeedItem } from "@yoplai/shared";
import { expect, it } from "vitest";
import { feedDelta } from "./feed-delta.js";
import { feedDetail, feedItems, projectRecords } from "./feed-projection.js";
import { InputEntry, type ReviewDecision } from "./state.js";

const conversationId = 1 as ConversationId;
const task = 8 as TaskId;

function entry(id: number, kind: string, fields: Pick<EntryRecord, "data" | "model"> = {}): EntryRecord {
  return { id: id as EntryId, conversationId, kind, ...fields, byTaskId: task };
}

it("groups public rounds behind their first entry and ignores unknown entries and fields", () => {
  const input = entry(10, InputEntry.kind, {
    data: { text: "Check the orchard", timestamp: 100, sender: { name: "Casey", id: "private-fixture-id" }, secret: "unknown-fixture-field" },
  });
  const firstRound = entry(11, AssistantEntry.kind, {
    model: [fauxAssistantMessage(fauxToolCall("count_pears", {}, { id: "pear-call" }), { stopReason: "toolUse", timestamp: 110 })],
  });
  const ignored = entry(12, "fixture.unknown", {
    data: { secret: "unknown-fixture-data" },
    model: [fauxAssistantMessage("unknown-fixture-text")],
  });
  const result = entry(13, ToolResultEntry.kind, {
    model: [{
      role: "toolResult", toolCallId: "pear-call", toolName: "count_pears",
      timestamp: 115, isError: false, content: [{ type: "text", text: "Three pears." }],
      details: { diff: "+three", fixtureSecret: "unknown-fixture-details", content: [{ type: "text", text: "unknown-fixture-envelope" }] },
    }],
  });
  const finalRound = entry(14, AssistantEntry.kind, { model: [fauxAssistantMessage("Three pears are ripe.", { timestamp: 120 })] });
  const decisions: Record<string, ReviewDecision> = { [task]: { state: "stream" } };
  const project = (entries: EntryRecord[]) => projectRecords(entries, decisions, new Set(), "en");
  const early = project([input, firstRound, ignored]);
  expect(feedItems(early)).toEqual([
    { id: "m_10", role: "user", sender: "Casey", text: "Check the orchard", timestamp: 100 },
    { id: "m_11", role: "assistant", text: "", toolCallCount: 1, timestamp: 110 },
  ]);
  const settled = project([input, firstRound, ignored, result, finalRound]);
  expect(feedItems(settled).at(-1)).toEqual({
    id: "m_11", role: "assistant", text: "Three pears are ripe.", toolCallCount: 1, timestamp: 110,
  });
  expect(feedDetail(settled, "m_11")).toMatchObject({
    toolCalls: [{ id: "pear-call", status: "done", result: { text: "Three pears.", diff: "+three" } }],
  });
  expect(JSON.stringify(settled)).not.toMatch(/unknown-fixture|private-fixture-id/);
});

it("expresses a sliding window as a prefix drop and upserts, with gaps requiring a snapshot", () => {
  const user: FeedItem = { id: "m_10", role: "user", text: "Count pears", sender: "Casey", timestamp: 100 };
  const answer: FeedItem = { id: "m_11", role: "assistant", text: "", toolCallCount: 1, timestamp: 110 };
  const settled = { ...answer, text: "Three pears." };
  const nextUser: FeedItem = { id: "m_20", role: "user", text: "Count plums", sender: "Casey", timestamp: 200 };
  expect(feedDelta([user, answer], [settled, nextUser])).toEqual({
    dropBefore: "m_11", upsert: [settled, nextUser],
  });
  expect(feedDelta([user, answer], [user, nextUser])).toBeUndefined();
  expect(feedDelta([user, answer], [nextUser])).toEqual({ dropBefore: "m_20", upsert: [nextUser] });
});

it("keeps an invisible call private when Durable supplies a synthetic result without host details", () => {
  const answer = entry(20, AssistantEntry.kind, {
    model: [fauxAssistantMessage(fauxToolCall("internal_probe", { note: "orphaned-private-args" }, { id: "private-abort" }), { stopReason: "toolUse" })],
  });
  const syntheticResult = entry(21, ToolResultEntry.kind, {
    model: [{
      role: "toolResult", toolCallId: "private-abort", toolName: "internal_probe",
      timestamp: 200, isError: true, content: [{ type: "text", text: "orphaned-private-result" }],
    }],
  });
  const decisions: Record<string, ReviewDecision> = { [task]: { state: "stream" } };
  const records = projectRecords([answer, syntheticResult], decisions, new Set(["internal_probe"]), "en");
  expect(feedItems(records)).toEqual([]);
  expect(JSON.stringify(records)).not.toContain("orphaned-private");
});

it("remembers a synthetic result's hidden call when the current tool catalog has changed", () => {
  const answer = entry(25, AssistantEntry.kind, {
    model: [fauxAssistantMessage(fauxToolCall("internal_probe", {}, { id: "private-old-call" }), { stopReason: "toolUse" })],
  });
  const result = entry(26, ToolResultEntry.kind, {
    model: [{ role: "toolResult", toolCallId: "private-old-call", toolName: "internal_probe",
      timestamp: 200, isError: true, content: [{ type: "text", text: "private-old-result" }] }],
  });
  const decisions: Record<string, ReviewDecision> = { [task]: { state: "stream", hiddenTools: ["internal_probe"] } };
  expect(feedItems(projectRecords([answer, result], decisions, new Set(), "en"))).toEqual([]);
});
