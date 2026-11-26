import { AssistantEntry, CompactionEntry, ToolResultEntry, type EntryId, type EntryRecord, type LiveState } from "@earendil-works/pi-durable";
import {
  McpAppViewReferenceSchema, runFailureMessage, type ContentBlock, type FeedDelivery, type FeedDetail, type FeedHit, type FeedItem, type FeedLive, type FeedToolCall, type FullHistoryMessage,
  type McpAppViewReference, type ModelMeta, type RunFailureKind, type ToolCallBlock,
} from "@yoplai/shared";
import { isSafeModelAccessError } from "../desktop/model-auth.js";
import { draftDigest } from "./review.js";
import { ChildDigestEntry, FailureNoteEntry, InputEntry, type ReviewDecision } from "./state.js";

type AssistantBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; redacted?: boolean }
  | { type: "toolCall"; id: string; name: string; arguments: unknown };
type StoredAssistant = Extract<NonNullable<EntryRecord["model"]>[number], { role: "assistant" }>;
type Usage = NonNullable<NonNullable<LiveState["generation"]>["message"]>["usage"];

type ToolDetails = {
  kind?: string;
  hidden?: boolean;
  view?: unknown;
  diff?: unknown;
  result?: ToolDetails;
  content?: unknown;
  fullOutputPath?: unknown;
  nested?: unknown;
};
type PublicResult = Extract<FullHistoryMessage, { role: "toolResult" }>;
type PublicToolCall = ToolCallBlock & { view?: McpAppViewReference };
type PublicBlock = Exclude<ContentBlock, ToolCallBlock> | PublicToolCall;
type ToolResult = { message: PublicResult; nested: Array<{ call: PublicToolCall; message: PublicResult }> };
type PublicAssistant = Omit<Extract<FullHistoryMessage, { role: "assistant" }>, "content"> & { content: PublicBlock[] };
export type PublicRecord =
  | { kind: "user"; id: string; sender: string; surface: NonNullable<Extract<FeedItem, { role: "user" }>["surface"]>; message: Extract<FullHistoryMessage, { role: "user" }> }
  | { kind: "failure"; id: string; message: PublicAssistant & { meta: { failure: NonNullable<ModelMeta["failure"]>; stopReason: "error" } } }
  | { kind: "assistant"; id: string; entryId: EntryId; message: PublicAssistant }
  | { kind: "seam"; item: Extract<FeedItem, { role: "seam" }> }
  | { kind: "result"; message: PublicResult };
type FailureRecord = Extract<PublicRecord, { kind: "failure" }>;

function failureRecord(id: EntryRecord["id"], timestamp: number, kind: RunFailureKind, text: string): FailureRecord {
  return { kind: "failure", id: "m_" + id, message: {
    role: "assistant", timestamp, content: [{ type: "text", text }],
    meta: { stopReason: "error", failure: { kind } },
  } };
}

export function feedBoundary(entry: EntryRecord) {
  // Only boundaries that close the adjacent answer can end a window scan.
  return InputEntry.is(entry) || ChildDigestEntry.is(entry) || (FailureNoteEntry.is(entry) && !!entry.model?.length);
}

export function activeDurableContextUsage(entries: readonly EntryRecord[]): { inputTokens: number; model?: string } {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (CompactionEntry.is(entry)) break;
    if (!AssistantEntry.is(entry)) continue;
    const messages = entry.model ?? [];
    for (let offset = messages.length - 1; offset >= 0; offset--) {
      const message = messages[offset]!;
      if (message.role !== "assistant" || !message.usage
        || message.stopReason === "error" || message.stopReason === "aborted" || message.stopReason === "deferred") continue;
      const { input, cacheRead, cacheWrite } = message.usage;
      return { inputTokens: input + (cacheRead ?? 0) + (cacheWrite ?? 0), model: message.model };
    }
  }
  return { inputTokens: 0 };
}

export function compactionIndexLines(entry: EntryRecord) {
  const summary = entry.model?.[0];
  if (summary?.role !== "user") return [];
  const text = typeof summary.content === "string" ? summary.content : publicText(textBlocks(summary.content));
  return text.match(/^\[m_\d+\] .+$/gm) ?? [];
}

function toolView(value: unknown) {
  return McpAppViewReferenceSchema.safeParse(value).data;
}

function textBlocks(blocks: readonly unknown[]) {
  return blocks.flatMap((block) => {
    if (!block || typeof block !== "object" || !("type" in block) || block.type !== "text" ||
        !("text" in block) || typeof block.text !== "string") return [];
    return [{ type: "text" as const, text: block.text }];
  });
}

function toolText(output: readonly unknown[], details: ToolDetails | undefined, codemodeFailed: boolean) {
  const blocks = textBlocks(output);
  if (!codemodeFailed) return blocks;
  const failure = [{ type: "text" as const, text: "Script failed." }];
  const marker = "Script error:\n";
  // Truncation can erase the boundary between script output and diagnostics.
  if (!blocks[0]?.text.startsWith("Script failed\nWall time ") || details?.fullOutputPath ||
      !blocks.some(({ text }) => text.includes(marker))) return failure;
  const result: typeof blocks = [];
  for (const block of blocks) {
    const boundary = block.text.indexOf(marker);
    if (boundary < 0) {
      result.push(block);
      continue;
    }
    const text = block.text.slice(0, boundary).trimEnd();
    if (text) result.push({ type: "text", text });
    if (block.text.slice(boundary + marker.length).startsWith("Script timed out:")) {
      result.push({ type: "text", text: "Script timed out." });
    }
    break;
  }
  return result;
}

function publicUsage(usage: Usage) {
  return {
    input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite,
    cacheWrite1h: usage.cacheWrite1h, reasoning: usage.reasoning, totalTokens: usage.totalTokens,
    cost: {
      input: usage.cost.input, output: usage.cost.output, cacheRead: usage.cost.cacheRead,
      cacheWrite: usage.cost.cacheWrite, total: usage.cost.total, totalFromProvider: usage.cost.totalFromProvider,
    },
  };
}

function publicBlocks(
  blocks: readonly AssistantBlock[],
  showReply: boolean,
  projectCall: (call: PublicToolCall) => PublicToolCall | undefined,
): PublicBlock[] {
  return blocks.flatMap<PublicBlock>((block) => {
    switch (block.type) {
      case "text": return showReply ? [{ type: "text", text: block.text }] : [];
      case "thinking": return showReply && !block.redacted ? [{ type: "thinking", thinking: block.thinking }] : [];
      case "toolCall": {
        const call = projectCall({ type: "toolCall", id: block.id, name: block.name, arguments: block.arguments });
        return call ? [call] : [];
      }
      default: return [];
    }
  });
}

function projectStoredAssistant(
  message: StoredAssistant,
  decision: ReviewDecision | undefined,
  projectCall: (call: PublicToolCall) => PublicToolCall | undefined,
) {
  if (message.stopReason === "error" || message.stopReason === "aborted") return;
  const showReply = decision?.state === "stream" ||
    (decision?.state === "approved" && decision.digest === draftDigest(message.content));
  const content = publicBlocks(message.content, showReply, (call) =>
    showReply || message.stopReason === "toolUse" ? projectCall(call) : undefined);
  return { showReply, content };
}

export function projectReplyRounds(entries: readonly EntryRecord[], byTask: Readonly<Record<string, ReviewDecision>>) {
  return entries.flatMap((entry) => {
    const taskId = entry.byTaskId;
    if (taskId === undefined || !AssistantEntry.is(entry)) return [];
    return (entry.model ?? []).flatMap((message) => {
      if (message.role !== "assistant") return [];
      const reply = projectStoredAssistant(message, byTask[taskId], () => undefined);
      return reply?.showReply ? [{ taskId, text: publicText(reply.content) }] : [];
    });
  });
}

export function projectRecords(
  entries: readonly EntryRecord[],
  byTask: Readonly<Record<string, ReviewDecision>>,
  hiddenNames: ReadonlySet<string>,
  language: Parameters<typeof runFailureMessage>[1],
): PublicRecord[] {
  const records: PublicRecord[] = [];
  let anchor: string | undefined;
  let pending: { entry: EntryRecord; results: Map<string, ToolResult | null>; interruptions: FailureRecord[] } | undefined;
  const flush = () => {
    if (!pending) return;
    const { entry, results, interruptions } = pending;
    const decision = entry.byTaskId === undefined ? undefined : byTask[entry.byTaskId];
    const invisible = decision?.hiddenTools ? new Set(decision.hiddenTools) : hiddenNames;
    for (const message of entry.model ?? []) {
      if (message.role !== "assistant") continue;
      const visible = new Set<string>();
      const projected = projectStoredAssistant(message, decision, (call) => {
        const result = results.get(call.id);
        if (result === null || invisible.has(call.name)) return;
        visible.add(call.id);
        return result?.message.view ? { ...call, view: result.message.view } : call;
      });
      if (!projected) continue;
      const content = projected.content.flatMap((block) => {
        if (block.type !== "toolCall" || block.name !== "codemode") return [block];
        return [block, ...(results.get(block.id)?.nested.map(({ call }) => call) ?? [])];
      });
      if (!content.length) continue;
      records.push({ kind: "assistant", id: anchor ?? "m_" + entry.id, entryId: entry.id, message: {
        role: "assistant", content, timestamp: decision?.answeredAt ?? message.timestamp,
        meta: { api: message.api, provider: message.provider, model: message.model, usage: publicUsage(message.usage), stopReason: message.stopReason },
      } });
      for (const [id, result] of results) {
        if (!result || !visible.has(id)) continue;
        records.push({ kind: "result", message: result.message });
        for (const nested of result.nested) records.push({ kind: "result", message: nested.message });
      }
    }
    if (interruptions.length) {
      records.push(...interruptions);
      anchor = undefined;
    }
    pending = undefined;
  };
  for (const entry of entries) {
    if (InputEntry.is(entry) || ChildDigestEntry.is(entry)) {
      flush();
      anchor = undefined;
      const { data } = entry;
      const sender = "name" in data ? data.name : "sender" in data ? data.sender.name : data.actor.name;
      records.push({ kind: "user", id: "m_" + entry.id, sender, surface: data.surface ?? "web", message: {
        role: "user", timestamp: entry.data.timestamp, content: [{ type: "text", text: entry.data.text }],
      } });
    } else if (FailureNoteEntry.is(entry)) {
      flush();
      anchor = undefined;
      const note = entry.model?.[0];
      if (!note) continue;
      const { kind, accessError } = entry.data;
      records.push(failureRecord(entry.id, note.timestamp, kind,
        isSafeModelAccessError(accessError) ? accessError : runFailureMessage(kind, language)));
    } else if (CompactionEntry.is(entry) && entry.head !== undefined) {
      const summary = entry.model?.[0];
      if (summary?.role !== "user") continue;
      flush();
      records.push({ kind: "seam", item: {
        id: "m_" + entry.id, role: "seam", timestamp: summary.timestamp, text: "Context compacted",
        reason: entry.data.reason,
        carried: { firstKept: "m_" + entry.head, indexed: compactionIndexLines(entry).length },
      } });
    } else if (AssistantEntry.is(entry) && entry.byTaskId !== undefined) {
      flush();
      anchor ??= "m_" + entry.id;
      pending = { entry, results: new Map(), interruptions: [] };
    } else if (ToolResultEntry.is(entry) && pending) {
      for (const message of entry.model ?? []) {
        if (message.role !== "toolResult") continue;
        if (entry.data?.diagnostics?.some(({ code }) => code === "interrupted")) {
          pending.interruptions.push(failureRecord(entry.id, message.timestamp, "tool_interrupted",
            runFailureMessage("tool_interrupted", language)));
        }
        const details = message.details as ToolDetails | undefined;
        if (details?.hidden === true) {
          pending.results.set(message.toolCallId, null);
          continue;
        }
        const wrapped = details?.kind === "yoplai.tool";
        const view = wrapped ? toolView(details.view) : undefined;
        const original = wrapped ? details.result : details;
        const diff = original?.diff;
        const { toolCallId, toolName, timestamp, isError } = message;
        // Durable appends its diagnostics as the final model-facing text block.
        const output = entry.data?.diagnostics?.length ? message.content.slice(0, -1) : message.content;
        // The gateway wrapper encodes extension results as model-facing JSON.
        // The original text blocks are the public output for content envelopes.
        const shownOutput = wrapped && Array.isArray(original?.content) ? original.content : output;
        const nested: ToolResult["nested"] = [];
        if (wrapped && toolName === "codemode" && Array.isArray(details.nested)) {
          for (const item of details.nested) {
            const { id, name, view: rawView } = item ?? {};
            const view = toolView(rawView);
            if (typeof id !== "string" || typeof name !== "string" || !view || hiddenNames.has(name)) continue;
            nested.push({
              call: { type: "toolCall", id, name, arguments: undefined, parentToolCallId: toolCallId, view },
              message: { role: "toolResult", toolCallId: id, parentToolCallId: toolCallId, toolName: name, view, isError: false, timestamp, content: [] },
            });
          }
        }
        pending.results.set(toolCallId, {
          message: {
            role: "toolResult", toolCallId, toolName, timestamp, isError,
            content: toolText(shownOutput, original, toolName === "codemode" && isError),
            ...(view ? { view } : {}),
            ...(typeof diff === "string" ? { details: { diff } } : {}),
          },
          nested,
        });
      }
    }
  }
  flush();
  return records;
}

export function publicText(content: readonly ContentBlock[]) {
  return content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
}

export function feedItems(records: readonly PublicRecord[], deliveries?: ReadonlyMap<EntryId, FeedDelivery[]>): FeedItem[] {
  const items: FeedItem[] = [];
  let answer: Extract<FeedItem, { role: "assistant" }> | undefined;
  for (const record of records) {
    if (record.kind === "seam") {
      // Place the seam ahead of the whole answer and keep its existing anchor.
      items.splice(items.length - (answer ? 1 : 0), 0, record.item);
      continue;
    }
    if (record.kind === "result") continue;
    const { id, message } = record;
    if (record.kind === "assistant") {
      const text = publicText(message.content);
      const count = message.content.filter((block) => block.type === "toolCall").length;
      if (!text && !count) continue;
      if (!answer) {
        answer = { id, role: "assistant", timestamp: message.timestamp, text, toolCallCount: count };
        items.push(answer);
      } else {
        if (text) answer.text = answer.text ? answer.text + "\n" + text : text;
        answer.toolCallCount += count;
      }
      const answerDeliveries = deliveries?.get(record.entryId);
      if (answerDeliveries) answer.deliveries = [...(answer.deliveries ?? []), ...answerDeliveries];
      continue;
    }
    answer = undefined;
    const base = { id, timestamp: message.timestamp, text: publicText(message.content) };
    items.push(record.kind === "user" ? { ...base, role: "user", sender: record.sender, surface: record.surface }
      : { ...base, role: "failure", kind: record.message.meta.failure.kind });
  }
  return items;
}

function projectPartial(live: LiveState, byTask: Readonly<Record<string, ReviewDecision>>) {
  const showReply = live.run !== undefined && byTask[live.run.taskId]?.state === "stream";
  return publicBlocks(live.generation?.message?.content ?? [], showReply, () => undefined);
}

export function feedDetail(records: readonly PublicRecord[], id: string): FeedDetail | undefined {
  const item = feedItems(records).find((item) => item.id === id);
  if (item?.role !== "assistant") return;
  const { timestamp, text } = item;
  const toolCalls: FeedToolCall[] = [];
  const reasoning: string[] = [];
  const round = new Map<string, FeedToolCall>();
  for (const record of records) {
    if (record.kind === "assistant") {
      round.clear();
      if (record.id !== id) continue;
      for (const block of record.message.content) {
        if (block.type === "thinking") reasoning.push(block.thinking);
        if (block.type !== "toolCall") continue;
        const { id, name, arguments: args, parentToolCallId, view } = block;
        const tool: FeedToolCall = { id, name, arguments: args, parentToolCallId, view: parentToolCallId ? view : undefined, status: "running", isError: false };
        round.set(tool.id, tool);
        toolCalls.push(tool);
      }
    } else if (record.kind === "result") {
      const result = record.message;
      const tool = round.get(result.toolCallId);
      if (!tool) continue;
      tool.status = result.isError ? "error" : "done";
      tool.isError = result.isError;
      if (result.parentToolCallId) continue;
      tool.result = {
        text: publicText(result.content),
        ...(result.details?.diff !== undefined ? { diff: result.details.diff } : {}),
        ...(result.view ? { view: result.view } : {}),
      };
    } else if (record.kind !== "seam") {
      round.clear();
    }
  }
  return { id, timestamp, text, reasoning, toolCalls };
}

type FeedMessageItem = Extract<FeedItem, { role: "user" | "assistant" }>;

export function isFeedMessage(item: FeedItem): item is FeedMessageItem {
  return item.role === "user" || item.role === "assistant";
}

export function feedSearch(records: readonly PublicRecord[], query: string, limit: number): FeedHit[] {
  return searchFeedMessages(feedItems(records).filter(isFeedMessage), query, limit);
}

export function searchFeedMessages(items: readonly FeedMessageItem[], query: string, limit: number): FeedHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const hits: FeedHit[] = [];
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!;
    const offset = item.text.toLowerCase().indexOf(needle);
    if (offset < 0) continue;
    const start = Math.max(0, offset - 50);
    const end = Math.min(item.text.length, start + 160);
    const snippet = (start ? "…" : "") + item.text.slice(start, end) + (end < item.text.length ? "…" : "");
    hits.push({ id: item.id, role: item.role, timestamp: item.timestamp, snippet });
    if (hits.length === limit) break;
  }
  return hits;
}

export function projectLive(
  live: LiveState,
  records: readonly PublicRecord[],
  byTask: Readonly<Record<string, ReviewDecision>>,
  hiddenNames: ReadonlySet<string>,
  viewFor: (id: string) => unknown,
): FeedLive {
  const blocks = projectPartial(live, byTask);
  const toolCalls: FeedToolCall[] = [];
  if (live.tools?.length) {
    const calls = new Map<string, PublicToolCall>();
    const results = new Map<string, PublicResult>();
    for (let index = records.length - 1; index >= 0; index--) {
      const record = records[index];
      if (record.kind === "seam") continue;
      if (record.kind === "result") {
        results.set(record.message.toolCallId, record.message);
        continue;
      }
      if (record.kind === "failure" && record.message.meta.failure.kind === "tool_interrupted") continue;
      if (record.kind === "assistant") {
        for (const block of record.message.content) if (block.type === "toolCall") calls.set(block.id, block);
      }
      break;
    }
    const visible = new Set<string>();
    for (const slot of live.tools) {
      const call = calls.get(slot.callId);
      if (!call || (slot.status !== "done" && hiddenNames.has(slot.name))) continue;
      const result = slot.status === "done" ? results.get(slot.callId) : undefined;
      const isError = result?.isError ?? (slot.status === "done" && slot.entry === undefined);
      const status = slot.status === "done" ? (isError ? "error" : "done") : "running";
      const view = call.view ?? toolView(viewFor(call.id));
      toolCalls.push({ id: call.id, name: call.name, arguments: call.arguments, status, isError, ...(view ? { view } : {}) });
      visible.add(call.id);
    }
    for (const slot of live.nestedTools ?? []) {
      if (!visible.has(slot.parentCallId) || hiddenNames.has(slot.name)) continue;
      const view = toolView(viewFor(slot.callId));
      const isError = slot.summary?.isError ?? false;
      toolCalls.push({
        id: slot.callId, name: slot.name, parentToolCallId: slot.parentCallId, isError,
        status: slot.status === "done" ? (isError ? "error" : "done") : "running",
        ...(view ? { view } : {}),
      });
      visible.add(slot.callId);
    }
  }
  return {
    text: publicText(blocks),
    reasoning: blocks.flatMap((block) => block.type === "thinking" ? [block.thinking] : []),
    toolCalls,
  };
}
