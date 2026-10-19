import type { FullHistoryMessage } from "@yoplai/shared";
import { toolLabel, type ToolLabelTemplates } from "@yoplai/shared/tool-labels";

export const DEFAULT_TEXT_LIMIT = 300;
export const DEFAULT_OUTPUT_BUDGET = 4000;
export const FULL_MESSAGE_CAP = 8000;

export type CondenseOptions = {
  sessionId: string;
  /** Inclusive start index (default 0). */
  from?: number;
  /** Inclusive end index (default last). */
  to?: number;
  /** Include system messages only when this is "system". */
  role?: "user" | "assistant" | "system";
  /** Expand a single message untruncated (capped at FULL_MESSAGE_CAP chars). */
  full?: number;
  budget?: number;
  /** Stored per-tool label templates (tool-labels.json). */
  templates?: ToolLabelTemplates;
};

type ToolResultMessage = Extract<FullHistoryMessage, { role: "toolResult" }>;

/** Joined text blocks of a message, with files as `[image name]` / `[file name]`. */
export function messageText(message: FullHistoryMessage): string {
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === "text") parts.push(block.text);
    else if (block.type === "file") {
      const kind = block.mimeType.startsWith("image/") ? "image" : "file";
      parts.push(`[${kind} ${block.filename}]`);
    }
  }
  return parts.join("\n").trim();
}

export function messageToolCalls(
  message: FullHistoryMessage
): Array<{ id: string; name: string; arguments: unknown }> {
  if (message.role !== "assistant") return [];
  return message.content.flatMap((block) =>
    block.type === "toolCall" ? [block] : []
  );
}

function formatTime(timestamp: number): string {
  return Number.isFinite(timestamp) && timestamp > 0
    ? new Date(timestamp).toISOString().slice(11, 16)
    : "";
}

function formatSize(chars: number): string {
  return chars >= 1000 ? `${(chars / 1000).toFixed(1)}k chars` : `${chars} chars`;
}

export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function toolLine(
  call: { id: string; name: string; arguments: unknown },
  result: ToolResultMessage | undefined,
  templates?: ToolLabelTemplates
): string {
  let label = toolLabel(call.name, call.arguments, templates);
  if (label.startsWith("Called tool:")) {
    const arg = Object.values((call.arguments ?? {}) as Record<string, unknown>).find(
      (v): v is string => typeof v === "string" && v.trim() !== ""
    );
    label = arg ? `${call.name} ${oneLine(arg).slice(0, 60)}` : call.name;
  }
  if (!result) return `    → ${label} (no result)`;
  const text = messageText(result);
  if (result.isError) {
    const firstLine = oneLine(text.split("\n")[0] ?? "").slice(0, 100);
    return `    → ${label} (ERR: ${firstLine}, ${formatSize(text.length)})`;
  }
  return `    → ${label} (ok, ${formatSize(text.length)})`;
}

/** One message as text lines: header line with text, then merged tool-call lines. */
function formatMessage(
  index: number,
  message: FullHistoryMessage,
  results: Map<string, ToolResultMessage>,
  textLimit: number,
  templates?: ToolLabelTemplates
): string {
  const role =
    message.role === "assistant" ? "asst" : message.role === "user" ? "user" : "sys";
  let text = messageText(message);
  if (text.length > textLimit) {
    const rest = text.length - textLimit;
    text = `${text.slice(0, textLimit)}… [+${rest} chars · read full=${index}]`;
  }
  const lines: string[] = [];
  const calls = messageToolCalls(message);
  if (text || calls.length === 0) {
    lines.push(`#${index} ${role} ${formatTime(message.timestamp)}  ${text}`.trimEnd());
  } else {
    lines.push(`#${index} ${role} ${formatTime(message.timestamp)}`.trimEnd());
  }
  for (const call of calls) lines.push(toolLine(call, results.get(call.id), templates));
  return lines.join("\n");
}

/** Condense a session transcript into compact plain text with #idx anchors. */
export function condense(
  entries: FullHistoryMessage[],
  options: CondenseOptions
): string {
  const results = new Map<string, ToolResultMessage>();
  for (const entry of entries) {
    if (entry.role === "toolResult") results.set(entry.toolCallId, entry);
  }
  const budget = options.budget ?? DEFAULT_OUTPUT_BUDGET;
  const last = entries.length - 1;
  const header = (shown: string) =>
    `session ${options.sessionId} · ${entries.length} msgs · showing ${shown}`;

  if (options.full !== undefined) {
    const message = entries[options.full];
    if (!message || message.role === "toolResult") {
      return `${header("none")}\nno message #${options.full}`;
    }
    let body = formatMessage(options.full, message, results, Infinity, options.templates);
    if (body.length > FULL_MESSAGE_CAP) {
      body = `${body.slice(0, FULL_MESSAGE_CAP)}… [truncated at ${FULL_MESSAGE_CAP} chars]`;
    }
    return `${header(`#${options.full}`)}\n${body}`;
  }

  const from = Math.max(0, options.from ?? 0);
  const to = Math.min(last, options.to ?? last);
  const blocks: string[] = [];
  let used = 0;
  let shownFrom = -1;
  let shownTo = -1;
  let next: number | undefined;
  for (let i = from; i <= to; i++) {
    const message = entries[i];
    if (message.role === "toolResult") continue;
    if (message.role === "system" && options.role !== "system") continue;
    if (options.role && message.role !== options.role) continue;
    const block = formatMessage(i, message, results, DEFAULT_TEXT_LIMIT, options.templates);
    if (blocks.length > 0 && used + block.length + 1 > budget) {
      next = i;
      break;
    }
    blocks.push(block);
    used += block.length + 1;
    if (shownFrom < 0) shownFrom = i;
    shownTo = i;
  }
  const shown = blocks.length ? `#${shownFrom}–#${shownTo}` : "none";
  const lines = [header(shown), ...blocks];
  if (next !== undefined) {
    lines.push(`more: read session=${options.sessionId} from=${next}`);
  }
  return lines.join("\n");
}

/** ~160-char snippet centred on the first case-insensitive match, or null. */
export function matchSnippet(text: string, query: string, width = 160): string | null {
  const flat = oneLine(text);
  const at = flat.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return null;
  const start = Math.max(0, at - Math.floor((width - query.length) / 2));
  const end = Math.min(flat.length, start + width);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

/** Text a search scans: message text plus tool-call name and arguments. */
export function searchableText(message: FullHistoryMessage): string {
  const calls = messageToolCalls(message).map(
    (call) => `${call.name} ${JSON.stringify(call.arguments ?? "")}`
  );
  return [messageText(message), ...calls].filter(Boolean).join("\n");
}
