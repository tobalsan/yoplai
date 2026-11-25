import type { Context } from "@earendil-works/chord/context";
import { CompactionEntry, LiveDoc, type CompactionHooks, type Cursor, type EntryId, type EntryRecord, type HookApi } from "@earendil-works/pi-durable";
import type { Models } from "@earendil-works/pi-ai-durable/models";
import type { AgentConfig } from "@yoplai/shared";
import { messageText, messageToolCalls, oneLine } from "../history/condense.js";
import { compactionIndexLines, projectRecords } from "./feed-projection.js";
import { InputEntry, ReviewDoc } from "./state.js";

const KEEP_RECENT_TOKENS = 20_000;
const SUMMARY_CHARS = 16_000;
const FRAME = "Older messages are stored outside this context. Answer the latest request. Return to an older topic only if the user does. Bracketed ids identify older requests.";
const OMITTED_TOOLS = "Earlier tool calls in this run are not listed.";

export function createMainCompactionSettings(models: Models) {
  // A run can still use a former model selection while the agent config changes.
  const reserveTokens = models.getModels().reduce((reserve, model) => Math.max(reserve, model.maxTokens), 16_384);
  return (agent: AgentConfig) => {
    const modelOverrides: Record<string, { reserveTokens: number; keepRecentTokens: number }> = {};
    for (const ref of [agent.model, agent.fallback_model]) {
      if (!ref?.provider) continue;
      const model = models.getModel(ref.provider, ref.model);
      if (!model) continue;
      const ceiling = Math.min(150_000, Math.floor(0.75 * Math.max(0, model.contextWindow - model.maxTokens)));
      modelOverrides[`${ref.provider}/${ref.model}`] = {
        reserveTokens: model.contextWindow - ceiling,
        keepRecentTokens: Math.min(KEEP_RECENT_TOKENS, Math.floor(ceiling / 4)),
      };
    }
    return { enabled: true, reserveTokens, keepRecentTokens: KEEP_RECENT_TOKENS, backgroundTokens: 0, modelOverrides };
  };
}

export async function summarizeCompaction(
  { entries, firstKept }: Pick<Parameters<CompactionHooks["beforeCompact"]>[0], "entries" | "firstKept">,
  api: Pick<HookApi, "conversationId" | "entries" | "snapshot">,
  context: Context,
  hiddenTools: () => Promise<ReadonlySet<string>>,
): Promise<{ summary: string }> {
  try {
    const live = await api.snapshot(LiveDoc, api.conversationId, context);
    const runFirst = live?.run?.first;
    let running = "";
    if (runFirst !== undefined && runFirst < firstKept) {
      const review = await api.snapshot(ReviewDoc, api.conversationId, context);
      const slice = entries.filter(({ id }) => id >= runFirst && id < firstKept);
      const oldestInSlice = slice.find((entry) => !CompactionEntry.is(entry))?.id ?? firstKept;
      const older: EntryRecord[] = [];
      if (runFirst < oldestInSlice) {
        // A previous cut in this run can already have removed its opening input and completed rounds.
        const query = { order: "ascending" as const, minEntryId: runFirst, maxEntryId: (oldestInSlice - 1) as EntryId };
        let cursor: Cursor | undefined;
        do {
          const page = await api.entries(query, 100, cursor, context);
          older.push(...page.items);
          cursor = page.next;
        } while (cursor !== undefined);
      }
      const records = projectRecords([...older, ...slice.filter((entry) => !CompactionEntry.is(entry))],
        review?.byTask ?? {}, await hiddenTools(), "en");
      const inputs = records.flatMap((record) => record.kind === "user" ? [oneLine(messageText(record.message)).slice(0, 500)] : []);
      const results = new Map(records.flatMap((record) => record.kind === "result" ? [[record.message.toolCallId, record.message]] : []));
      const calls = records.flatMap((record) => record.kind === "assistant" ? messageToolCalls(record.message) : []).reverse();
      const limit = SUMMARY_CHARS / 2;
      const heading = "\n\nRunning turn";
      running = heading;
      for (const input of inputs) {
        if (running.length + input.length + 3 > limit - OMITTED_TOOLS.length - 1) break;
        running += "\n- " + input;
      }
      for (const [index, call] of calls.entries()) {
        const result = results.get(call.id);
        if (!result) continue;
        const args = oneLine(JSON.stringify(call.arguments) ?? "").slice(0, 100);
        const line = `\n    → ${call.name} ${args} (${result.isError ? "error" : "ok"})`;
        const reserve = index < calls.length - 1 ? OMITTED_TOOLS.length + 1 : 0;
        if (running.length + line.length + reserve > limit) {
          running += "\n" + OMITTED_TOOLS;
          break;
        }
        running += line;
      }
    }

    let summary = FRAME + running + "\n\nOlder requests";
    let cursor: Cursor | undefined;
    const previous = entries[0];
    const previousCut = CompactionEntry.is(previous) ? previous : undefined;
    const query = { order: "descending" as const, minEntryId: previousCut?.head, maxEntryId: (firstKept - 1) as EntryId };
    do {
      const page = await api.entries(query, 100, cursor, context);
      for (const entry of page.items) {
        if (!InputEntry.is(entry)) continue;
        const [record] = projectRecords([entry], {}, new Set(), "en");
        if (record?.kind !== "user") continue;
        const date = new Date(record.message.timestamp).toISOString().slice(0, 10);
        const line = `\n[${record.id}] ${date} · ${oneLine(record.sender)} · ${record.surface} · ${oneLine(messageText(record.message)).slice(0, 200)}`;
        if (summary.length + line.length > SUMMARY_CHARS) return { summary };
        summary += line;
      }
      cursor = page.next;
    } while (cursor !== undefined);
    if (previousCut) {
      // The previous checkpoint already indexed the prefix before its retained tail.
      for (const line of compactionIndexLines(previousCut)) {
        if (summary.length + line.length + 1 > SUMMARY_CHARS) break;
        summary += "\n" + line;
      }
    }
    return { summary };
  } catch {
    return { summary: FRAME };
  }
}
