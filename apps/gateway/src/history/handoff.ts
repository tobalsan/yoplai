import type { ToolLabelTemplates } from "@yoplai/shared/tool-labels";
import { formatSize, FULL_MESSAGE_CAP, toolLine } from "./condense.js";
import type { ToolStep, TranscriptEntry } from "./transcript.js";

const CHARS_PER_TOKEN = 4;
const MEMORY_TOKENS = 3_000;
const RECENT_TOKENS = 20_000;
const STEP_TOKENS = 2_000;
const OMISSION_TOKENS = 1_000;
const TOPIC_EXCERPT_CHARS = 4_000;
const USER_EXCERPT_CHARS = 8_000;
const REPLY_EXCERPT_CHARS = 4_000;
const TOPIC_TEXT_CAP = 500;
const USER_TEXT_CAP = 800;
const REPLY_TEXT_CAP = 1_200;
const OMITTED_TURN_LIMIT = 3;
const RECOVERY_TOOL_NAME_HINT_CHARS = 80;

const MEMORY_HEADER = "## Memory\n";
const OLDER_HEADER = "## Older excerpts\n";
const STEP_HEADER = "## Condensed steps\n";
const RECENT_HEADER = "## Recent messages\n";
const OMISSION_HEADER = "## Omission notice\n";
const SEPARATOR = "\n\n";

type HandoffMemory = {
  text: string;
  topicRefs?: Array<{ id: string; note?: string }>;
};

type HandoffInput = {
  transcript: TranscriptEntry[];
  memory?: HandoffMemory;
  templates?: ToolLabelTemplates;
};

export type HandoffBreakdown = {
  totalTokens: number;
  memoryTokens: number;
  excerptTokens: number;
  stepTokens: number;
  recentTokens: number;
  omissionTokens: number;
};

function shorten(value: string, limit: number): string {
  return value.length <= limit
    ? value
    : value.slice(0, Math.max(0, limit - 1)) + "…";
}

function memorySection(text = ""): string {
  if (!text) return "";
  const budget =
    MEMORY_TOKENS * CHARS_PER_TOKEN - MEMORY_HEADER.length - SEPARATOR.length;
  if (text.length <= budget) return MEMORY_HEADER + text;
  const marker = (removed: number) => `… [+${removed} chars]`;
  const keep = budget - marker(text.length).length;
  return MEMORY_HEADER + text.slice(0, keep) + marker(text.length - keep);
}

function renderEntry(
  entry: TranscriptEntry,
  cap: number,
  maxLength: number
): string {
  const { id, role, text, timestamp, author } = entry;
  const time =
    timestamp === undefined ? undefined : new Date(timestamp).toJSON();
  const name = author?.name || author?.id;
  const clipped = text.length > cap;
  function render(displayId: string, displayName?: string): string {
    const header = [`[${displayId}] ${role}`, time, displayName]
      .filter(Boolean)
      .join(" · ");
    if (!text) return header;
    const body = clipped
      ? `${text.slice(0, cap)}… [+${text.length - cap} chars · ${displayId}]`
      : text;
    return `${header}\n${body}`;
  }

  const full = render(id, name);
  if (full.length <= maxLength) return full;
  const withoutAuthor = render(id);
  if (withoutAuthor.length <= maxLength) {
    const authorLimit = maxLength - withoutAuthor.length - " · ".length;
    return name && authorLimit > 0
      ? render(id, shorten(name, authorLimit))
      : withoutAuthor;
  }
  // A clipped message repeats the ID in its marker.
  const idLimit = Math.floor(
    (maxLength - render("").length) / (clipped ? 2 : 1)
  );
  return render(shorten(id, idLimit));
}

function selectRecent(transcript: TranscriptEntry[]) {
  const messages: string[] = [];
  const carried = new Set<string>();
  let start = transcript.length;
  const budget = RECENT_TOKENS * CHARS_PER_TOKEN - RECENT_HEADER.length;
  let remaining = budget;
  for (let i = transcript.length - 1; i >= 0; i--) {
    const entry = transcript[i];
    if (carried.has(entry.id)) continue;
    const block = renderEntry(
      entry,
      FULL_MESSAGE_CAP,
      budget - SEPARATOR.length
    );
    const cost = block.length + SEPARATOR.length;
    if (cost > remaining) break;
    remaining -= cost;
    messages.push(block);
    carried.add(entry.id);
    start = i;
  }
  return { start, carried, messages: messages.reverse() };
}

function omittedTurnReplies(
  transcript: TranscriptEntry[],
  recentStart: number
): number[] {
  let hasRecentReply = false;
  for (let i = recentStart; i < transcript.length; i++) {
    const entry = transcript[i];
    if (entry.role === "user") break;
    if (entry.text) {
      hasRecentReply = true;
      break;
    }
  }

  const replies: number[] = [];
  let turns = 0;
  let reply: number | undefined;
  for (let i = recentStart - 1; i >= 0 && turns < OMITTED_TURN_LIMIT; i--) {
    const entry = transcript[i];
    if (entry.role === "assistant") {
      if (entry.text) reply ??= i;
    } else {
      if (!hasRecentReply) {
        if (reply !== undefined) replies.push(reply);
        turns++;
      }
      hasRecentReply = false;
      reply = undefined;
    }
  }
  return replies;
}

function selectExcerpts(
  omitted: TranscriptEntry[],
  carried: Set<string>,
  replies: number[],
  refs: HandoffMemory["topicRefs"] = []
): string[] {
  const excerpts = new Map<number, string>();
  function take(indices: number[], cap: number, budget: number) {
    let remaining = budget;
    for (const index of indices) {
      const entry = omitted[index];
      if (carried.has(entry.id)) continue;
      const block = renderEntry(entry, cap, budget - SEPARATOR.length);
      const cost = block.length + SEPARATOR.length;
      if (cost > remaining) break;
      remaining -= cost;
      excerpts.set(index, block);
      carried.add(entry.id);
    }
  }

  const byId = new Map(omitted.map((entry, index) => [entry.id, index]));
  const topics: number[] = [];
  for (const { id } of refs) {
    const index = byId.get(id);
    if (index !== undefined) topics.push(index);
  }
  const users: number[] = [];
  for (const [index, entry] of omitted.entries()) {
    if (entry.role === "user") users.push(index);
  }
  take(topics, TOPIC_TEXT_CAP, TOPIC_EXCERPT_CHARS - OLDER_HEADER.length);
  const [first, ...rest] = users;
  if (first !== undefined)
    take([first, ...rest.reverse()], USER_TEXT_CAP, USER_EXCERPT_CHARS);
  take(replies, REPLY_TEXT_CAP, REPLY_EXCERPT_CHARS);
  return [...excerpts].sort(([a], [b]) => a - b).map(([, block]) => block);
}

function section(header: string, blocks: string[]): string {
  return blocks.length ? header + blocks.join(SEPARATOR) : "";
}

function selectSteps(
  transcript: TranscriptEntry[],
  start: number,
  templates?: ToolLabelTemplates
) {
  const lines: string[] = [];
  let remaining = STEP_TOKENS * CHARS_PER_TOKEN - STEP_HEADER.length - 1;
  let omittedCount = 0;
  let latestOmittedResult: ToolStep | undefined;
  for (let i = transcript.length - 1; i >= 0; i--) {
    const { id, toolCalls = [] } = transcript[i];
    for (let j = toolCalls.length - 1; j >= 0; j--) {
      const call = toolCalls[j];
      if (i >= start && remaining > 0) {
        const callTemplates =
          templates && Object.hasOwn(templates, call.name)
            ? templates
            : undefined;
        const label = toolLine(call, call.result, callTemplates)
          .trimStart()
          .replace(/[\r\n]+/g, " ");
        const line = `[${id}] ${label}`;
        const cost = line.length + 1;
        if (cost <= remaining) {
          lines.push(line);
          remaining -= cost;
          continue;
        }
        remaining = 0;
      }
      omittedCount++;
      if (call.result) latestOmittedResult ??= call;
    }
  }
  return {
    text: lines.length ? STEP_HEADER + lines.reverse().join("\n") : "",
    omittedCount,
    latestOmittedResult,
  };
}

function describeRange(entries: TranscriptEntry[], idLimit: number): string {
  const first = entries[0];
  const last = entries.at(-1);
  if (!first || !last) return "";
  const from = shorten(first.id, idLimit);
  if (first === last) return ` ([${from}])`;
  return ` ([${from}] to [${shorten(last.id, idLimit)}])`;
}

function omissionNotice(
  omitted: TranscriptEntry[],
  carried: Set<string>,
  steps: ReturnType<typeof selectSteps>
): string {
  const users = omitted.filter(
    (entry) => entry.role === "user" && !carried.has(entry.id)
  );
  function render(
    rangeIdLimit: number,
    resultIdLimit: number,
    toolNameLimit: number
  ): string {
    const lines = [
      `${omitted.length} messages before the recent window${describeRange(omitted, rangeIdLimit)}.`,
      `${users.length} omitted user messages not carried${describeRange(users, rangeIdLimit)}.`,
    ];
    if (steps.omittedCount)
      lines.push(`${steps.omittedCount} tool steps not shown.`);
    const call = steps.latestOmittedResult;
    if (call?.result) {
      const id = shorten(call.result.id, resultIdLimit);
      const name = shorten(call.name, toolNameLimit);
      lines.push(
        `Latest omitted tool output: [${id}] ${name} (${formatSize(call.result.text.length)}).`
      );
    }
    lines.push(
      "Use the session_history tool’s search action to recover originals. Bracketed IDs identify the originals."
    );
    return OMISSION_HEADER + lines.join("\n");
  }

  const budget = OMISSION_TOKENS * CHARS_PER_TOKEN - SEPARATOR.length;
  const full = render(Infinity, Infinity, Infinity);
  if (full.length <= budget) return full;

  // Keep the recoverable result ID ahead of the tool name and up to four range IDs.
  const resultIdLimit =
    render(0, Infinity, 0).length <= budget
      ? Infinity
      : budget - render(0, 0, RECOVERY_TOOL_NAME_HINT_CHARS).length;
  const toolNameLimit =
    render(0, resultIdLimit, Infinity).length <= budget
      ? Infinity
      : budget - render(0, resultIdLimit, 0).length;
  const rangeIdLimit = Math.floor(
    (budget - render(0, resultIdLimit, toolNameLimit).length) / 4
  );
  return render(rangeIdLimit, resultIdLimit, toolNameLimit);
}

export function buildHandoff(input: HandoffInput): {
  text: string;
  breakdown: HandoffBreakdown;
} {
  const recent = selectRecent(input.transcript);
  const omitted = input.transcript.slice(0, recent.start);
  const older = selectExcerpts(
    omitted,
    recent.carried,
    omittedTurnReplies(input.transcript, recent.start),
    input.memory?.topicRefs
  );
  const steps = selectSteps(input.transcript, recent.start, input.templates);
  const sections: Array<
    [Exclude<keyof HandoffBreakdown, "totalTokens">, string]
  > = [
    ["memoryTokens", memorySection(input.memory?.text)],
    ["excerptTokens", section(OLDER_HEADER, older)],
    ["stepTokens", steps.text],
    ["recentTokens", section(RECENT_HEADER, recent.messages)],
    ["omissionTokens", omissionNotice(omitted, recent.carried, steps)],
  ];
  const breakdown: HandoffBreakdown = {
    totalTokens: 0,
    memoryTokens: 0,
    excerptTokens: 0,
    stepTokens: 0,
    recentTokens: 0,
    omissionTokens: 0,
  };
  let text = "";
  for (const [field, part] of sections) {
    if (!part) continue;
    const block = text ? SEPARATOR + part : part;
    text += block;
    breakdown[field] = Math.ceil(block.length / CHARS_PER_TOKEN);
  }
  breakdown.totalTokens = Math.ceil(text.length / CHARS_PER_TOKEN);
  return { text, breakdown };
}
