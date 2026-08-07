import {
  For,
  Index,
  Show,
  batch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  untrack,
} from "solid-js";
import {
  createVirtualizer,
  measureElement as measureVirtualElement,
} from "@tanstack/solid-virtual";
import { getMaxContextTokens } from "@yoplai/shared/model-context";
import type { ContextEstimate } from "@yoplai/shared/types";
import {
  archiveSubagent,
  fetchFullHistory,
  fetchSubagents,
  fetchSubagentLogs,
  getSessionKey,
  interruptSubagent,
  killSubagent,
  spawnSubagent,
  streamMessage,
  subscribeToSession,
  type DoneMeta,
  uploadFiles,
} from "../api";
import type {
  FullHistoryMessage,
  FullToolResultMessage,
  SubagentLogEvent,
  SubagentStatus,
  FileAttachment,
} from "../api/types";
import { extractBlockText, getTextBlocks } from "../lib/history";
import { toggleZenMode, zenMode } from "../lib/layout";
import { renderMarkdown } from "../lib/markdown";
import { createChatAttachmentRuntime } from "../lib/chat-runtime";

type AgentChatProps = {
  agentId: string | null;
  agentName: string | null;
  sessionKey?: string | null;
  sessionNonce?: number | null;
  agentType: "lead" | "subagent" | null;
  subagentInfo?: {
    projectId: string;
    slug: string;
    cli?: string;
    runMode?: "main-run" | "worktree" | "clone" | "none";
    status?: SubagentStatus;
  };
  onBack: () => void;
  onOpenProject?: (id: string) => void;
  fullscreen?: boolean;
  showHeader?: boolean;
  inputDraft?: string;
  onInputDraftChange?: (value: string) => void;
};

type SubagentRunInfo = {
  toolUseId: string;
  nestedItems: LogItem[];
};

type LogItem = {
  tone: "assistant" | "user" | "muted" | "warning" | "error";
  icon?:
    | "read"
    | "write"
    | "bash"
    | "tool"
    | "warning"
    | "output"
    | "diff"
    | "system"
    | "error"
    | "subagent"
    | "thinking";
  title?: string;
  summaryPreview?: string;
  body: string;
  collapsible?: boolean;
  systemCallout?: boolean;
  subagentRun?: SubagentRunInfo;
  clientId?: string;
  pending?: boolean;
  queued?: boolean;
};

type RenderedLogItem = {
  item: LogItem;
  collapsibleKey: string;
  virtualKey: string | number;
};

function countLines(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\r?\n/).length;
}

function countChanges(text: string): number {
  return text.split(/\r?\n/).filter((line) => /^[+-](?![+-])/.test(line))
    .length;
}

function formatMeasure(value: number, unit: string): string {
  if (value <= 0) return `No ${unit}`;
  return `${value} ${unit}${value === 1 ? "" : "s"}`;
}

function summarizeToolLabel(
  toolName: string,
  args: Record<string, unknown> | null,
  body: string,
  diff?: string
): string {
  const key = toolName.trim().toLowerCase();
  if (key === "read") {
    const path =
      typeof args?.path === "string"
        ? args.path
        : typeof args?.file_path === "string"
          ? args.file_path
          : "file";
    return `Read ${path} · ${formatMeasure(countLines(body), "line")}`;
  }
  if (key === "exec_command" || key === "bash") {
    const command =
      typeof args?.cmd === "string"
        ? args.cmd
        : typeof args?.command === "string"
          ? args.command
          : "";
    const output = body.trim()
      ? formatMeasure(countLines(body), "line")
      : "No output";
    return `Bash ${command || toolName} · ${output}`;
  }
  if (key === "write" || key === "apply_patch") {
    const path =
      typeof args?.path === "string"
        ? args.path
        : typeof args?.file_path === "string"
          ? args.file_path
          : "file";
    const amount = diff ? countChanges(diff) : countLines(body);
    return `Edit ${path} · ${formatMeasure(amount, diff ? "change" : "line")}`;
  }
  if (key === "skill") {
    return `Skill · ${formatMeasure(countLines(body), "line")}`;
  }
  return `${toolName || "Tool"} · ${
    diff
      ? formatMeasure(countChanges(diff), "change")
      : formatMeasure(countLines(body), "line")
  }`;
}

type PendingCliUserMessage = {
  id: string;
  text: string;
  body: string;
  pending: boolean;
  queued: boolean;
  uploading: boolean;
  attachments?: FileAttachment[];
};

type SubagentTransientUiState = {
  awaiting: boolean;
  pending: PendingCliUserMessage[];
};
type PendingLeadUserMessage = {
  id: string;
  text: string;
  body: string;
  queued: boolean;
};
const subagentTransientState = new Map<string, SubagentTransientUiState>();
const activeSubagentPollIntervals = new Map<string, number>();
const VIRTUAL_LOG_OVERSCAN = 5;
const VIRTUAL_LOG_MIN_COUNT = 80;

export function __resetAgentChatStateForTests(): void {
  subagentTransientState.clear();
  if (typeof window !== "undefined") {
    for (const timer of activeSubagentPollIntervals.values()) {
      window.clearInterval(timer);
    }
  }
  activeSubagentPollIntervals.clear();
}

function subagentStateKey(
  info: { projectId: string; slug: string } | undefined
): string | null {
  if (!info?.projectId || !info?.slug) return null;
  return `${info.projectId}:${info.slug}`;
}

const supportedImageTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/jpg",
]);
const supportedImageExtensions = new Set(["jpg", "jpeg", "png", "gif", "webp"]);

function formatJson(args: unknown): string {
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

function parseJsonRecord(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const KNOWN_SYSTEM_EVENT_TYPES = new Set([
  "rate_limit_event",
  "system",
  "init",
  "config",
  "ping",
  "pong",
]);

function isSystemEventPayload(payload: Record<string, unknown>): boolean {
  if (
    typeof payload.type === "string" &&
    KNOWN_SYSTEM_EVENT_TYPES.has(payload.type)
  )
    return true;
  if (
    typeof payload.session_id === "string" &&
    typeof payload.uuid === "string"
  )
    return true;
  if (payload.rate_limit_info && typeof payload.rate_limit_info === "object")
    return true;
  return false;
}

function toSystemCalloutItem(text: string): LogItem {
  const payload = parseJsonRecord(text);
  const eventType =
    payload && typeof payload.type === "string" ? payload.type : "";
  return {
    tone: "muted",
    icon: "system",
    title: eventType ? `System: ${eventType}` : "System event",
    body: text,
    collapsible: true,
    systemCallout: true,
  };
}

function isBase64ImageText(text: string): boolean {
  return /data:image\/[^;]+;base64,/i.test(text.trim());
}

function toImageAttachmentItem(text: string): LogItem {
  const preview = `${text.slice(0, 80)}...`;
  return {
    tone: "muted",
    icon: "system",
    title: "Image attachment",
    body: preview,
    collapsible: true,
  };
}

function summarizeInitialPrompt(text: string): string {
  const firstLines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 3)
    .join(" ");
  const compact = firstLines || text.replace(/\s+/g, " ").trim();
  if (!compact) return "Details";
  return compact.length > 200 ? `${compact.slice(0, 200)}...` : compact;
}

function buildLeadLogs(messages: FullHistoryMessage[]): LogItem[] {
  const entries: LogItem[] = [];
  let initialPromptAdded = false;
  let skipNextUserIfSkill = false;
  const toolResults = new Map<string, FullToolResultMessage>();
  for (const msg of messages) {
    if (msg.role === "toolResult") {
      toolResults.set(msg.toolCallId, msg);
    }
  }
  const skipResults = new Set<string>();

  for (const msg of messages) {
    if (msg.role === "system") {
      const text = getTextBlocks(msg.content);
      if (!text) continue;
      entries.push({
        tone: "muted",
        title: "System Context",
        body: text,
        collapsible: true,
      });
      continue;
    }
    if (msg.role === "user") {
      const text = getTextBlocks(msg.content);
      if (!text) continue;
      if (skipNextUserIfSkill) {
        skipNextUserIfSkill = false;
        continue;
      }
      skipNextUserIfSkill = false;
      const parsed = parseJsonRecord(text);
      if (parsed && isSystemEventPayload(parsed)) {
        entries.push(toSystemCalloutItem(text));
        continue;
      }
      if (isBase64ImageText(text)) {
        entries.push(toImageAttachmentItem(text));
        continue;
      }
      if (!initialPromptAdded) {
        entries.push({
          tone: "user",
          summaryPreview: summarizeInitialPrompt(text),
          body: text,
          collapsible: true,
        });
        initialPromptAdded = true;
        continue;
      }
      entries.push({ tone: "user", body: text });
      continue;
    }
    if (msg.role === "assistant") {
      for (const block of msg.content) {
        if (block.type === "thinking" && block.thinking) {
          const text =
            typeof block.thinking === "string" ? block.thinking : "";
          if (text) {
            entries.push({
              tone: "muted",
              icon: "thinking",
              title: "Thinking",
              body: text,
              collapsible: true,
            });
          }
        } else if (block.type === "text" && block.text) {
          const text = extractBlockText(block.text);
          if (!text) continue;
          const parsed = parseJsonRecord(text);
          if (parsed && isSystemEventPayload(parsed)) {
            entries.push(toSystemCalloutItem(text));
          } else {
            entries.push({ tone: "assistant", body: text });
          }
        } else if (block.type === "toolCall") {
          const toolName = block.name ?? "";
          const toolKey = toolName.toLowerCase();
          const args = block.arguments as Record<string, unknown>;
          if (toolKey === "read") {
            const output = toolResults.get(block.id);
            const body = output ? getTextBlocks(output.content) : "";
            entries.push({
              tone: "muted",
              icon: "read",
              title: summarizeToolLabel(
                "read",
                args,
                body,
                output?.details?.diff
              ),
              body,
              collapsible: true,
            });
            skipResults.add(block.id);
            continue;
          }
          if (toolKey === "bash") {
            const output = toolResults.get(block.id);
            const body = output ? getTextBlocks(output.content) : "";
            entries.push({
              tone: "muted",
              icon: "bash",
              title: summarizeToolLabel(
                toolKey,
                args,
                body,
                output?.details?.diff
              ),
              body,
              collapsible: true,
            });
            skipResults.add(block.id);
            continue;
          }
          if (toolKey === "write") {
            const content =
              typeof args?.content === "string" ? args.content : "";
            entries.push({
              tone: "muted",
              icon: "write",
              title: summarizeToolLabel(toolKey, args, content),
              body: content,
              collapsible: true,
            });
            skipResults.add(block.id);
            continue;
          }
          if (toolKey === "skill") {
            const output = toolResults.get(block.id);
            const body = output ? getTextBlocks(output.content) : "";
            entries.push({
              tone: "muted",
              icon: "tool",
              title: summarizeToolLabel(
                "skill",
                null,
                body || formatJson(block.arguments)
              ),
              body: body || formatJson(block.arguments),
              collapsible: true,
            });
            if (output) skipResults.add(block.id);
            skipNextUserIfSkill = true;
            continue;
          }
          if (toolKey === "agent") {
            const prompt = typeof args?.prompt === "string" ? args.prompt : "";
            const description =
              typeof args?.description === "string" ? args.description : "";
            const subagentType =
              typeof args?.subagent_type === "string" ? args.subagent_type : "";
            const agentOutput = toolResults.get(block.id);
            const summary = agentOutput
              ? getTextBlocks(agentOutput.content)
              : "";
            const nestedItems: LogItem[] = [];
            if (prompt) {
              nestedItems.push({
                tone: "user",
                title: "Coordinator \u2192 Subagent",
                body: prompt,
              });
            }
            if (summary) {
              nestedItems.push({
                tone: "assistant",
                title: "Subagent summary returned",
                body: summary,
              });
            }
            entries.push({
              tone: "muted",
              icon: "subagent",
              title: `Subagent Run${subagentType ? ` (${subagentType})` : ""}`,
              body:
                description || (prompt ? prompt.slice(0, 200) : "Subagent run"),
              subagentRun: { toolUseId: block.id, nestedItems },
            });
            skipResults.add(block.id);
            continue;
          }
          const output = toolResults.get(block.id);
          const outputText = output ? getTextBlocks(output.content) : "";
          entries.push({
            tone: "muted",
            icon: "tool",
            title: summarizeToolLabel(
              toolName,
              args,
              outputText || formatJson(block.arguments),
              output?.details?.diff
            ),
            body: outputText || formatJson(block.arguments),
            collapsible: true,
          });
          if (output) skipResults.add(block.id);
        }
      }
      continue;
    }
    if (msg.role === "toolResult") {
      if (skipResults.has(msg.toolCallId)) continue;
      const text = getTextBlocks(msg.content);
      if (text) {
        entries.push({
          tone: "muted",
          icon: "output",
          title: `Result · ${formatMeasure(countLines(text), "line")}`,
          body: text,
          collapsible: text.length > 80,
        });
      }
      if (msg.details?.diff) {
        entries.push({
          tone: "muted",
          icon: "diff",
          title: `Diff · ${formatMeasure(
            countChanges(msg.details.diff),
            "change"
          )}`,
          body: msg.details.diff,
          collapsible: true,
        });
      }
    }
  }
  return entries;
}

function parseToolArgs(raw: string): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function logTone(
  type: string
): "assistant" | "user" | "muted" | "warning" | "error" {
  if (type === "user") return "user";
  if (type === "assistant") return "assistant";
  if (type === "error" || type === "stderr") return "error";
  if (type === "warning") return "warning";
  if (
    type === "tool_call" ||
    type === "tool_output" ||
    type === "diff" ||
    type === "session" ||
    type === "message"
  ) {
    return "muted";
  }
  return "assistant";
}

function logLabel(type: string, text: string): string {
  if (type === "tool_call") {
    const name = text.split("\n")[0]?.trim();
    return name ? `Tool: ${name}` : "Tool call";
  }
  if (type === "tool_output") return "Tool output";
  if (type === "warning") return "Warning";
  if (type === "diff") return "Diff";
  if (type === "stderr") return "Error";
  if (type === "session") return "Session";
  if (type === "message") return "Message";
  return "";
}

function toLogItem(entry: SubagentLogEvent): LogItem {
  const tone = logTone(entry.type);
  const body = entry.text ?? "";
  const title = logLabel(entry.type, body);
  const icon =
    entry.type === "tool_call"
      ? "tool"
      : entry.type === "warning"
        ? "warning"
        : entry.type === "tool_output"
          ? "output"
          : entry.type === "diff"
            ? "diff"
            : entry.type === "session" || entry.type === "message"
              ? "system"
              : entry.type === "error" || entry.type === "stderr"
                ? "error"
                : undefined;
  return {
    tone,
    icon,
    title: title || undefined,
    body,
    collapsible: tone === "muted" && body.length > 80,
  };
}

function relabelAsSubagent(items: LogItem[]): LogItem[] {
  return items.map((item) => {
    if (item.subagentRun) return item;
    if (item.tone === "assistant") return { ...item, title: "Subagent" };
    if (item.icon === "tool")
      return {
        ...item,
        title:
          item.title?.replace(/^Tool:/, "Subagent Tool:") ?? "Subagent Tool",
      };
    if (item.icon === "output") return { ...item, title: "Subagent Result" };
    return item;
  });
}

function buildCliLogs(events: SubagentLogEvent[]): LogItem[] {
  // Phase 1: group nested events by parentToolUseId
  const nestedByParent = new Map<string, SubagentLogEvent[]>();
  for (const event of events) {
    if (event.parentToolUseId) {
      const group = nestedByParent.get(event.parentToolUseId) ?? [];
      group.push(event);
      nestedByParent.set(event.parentToolUseId, group);
    }
  }

  // Phase 2: build log items, filtering out nested events
  const entries: LogItem[] = [];
  let initialPromptAdded = false;
  let skipNextUserIfSkill = false;
  const toolOutputs = new Map<string, SubagentLogEvent>();
  const toolWarnings = new Map<string, SubagentLogEvent>();
  for (const event of events) {
    if (
      event.type === "tool_output" &&
      event.tool?.id &&
      !event.parentToolUseId
    ) {
      toolOutputs.set(event.tool.id, event);
    }
    if (event.type === "warning" && event.tool?.id && !event.parentToolUseId) {
      toolWarnings.set(event.tool.id, event);
    }
  }
  const skipOutputs = new Set<string>();

  for (const event of events) {
    if (event.parentToolUseId) continue;
    if (event.type === "skip") continue;
    if (event.type === "session" || event.type === "message") continue;
    if (event.type === "user") {
      if (event.text) {
        if (skipNextUserIfSkill) {
          skipNextUserIfSkill = false;
          continue;
        }
        skipNextUserIfSkill = false;
        const parsed = parseJsonRecord(event.text);
        if (parsed && isSystemEventPayload(parsed)) {
          entries.push(toSystemCalloutItem(event.text));
          continue;
        }
        if (isBase64ImageText(event.text)) {
          entries.push(toImageAttachmentItem(event.text));
          continue;
        }
        if (!initialPromptAdded) {
          entries.push({
            tone: "user",
            summaryPreview: summarizeInitialPrompt(event.text),
            body: event.text,
            collapsible: true,
          });
          initialPromptAdded = true;
          continue;
        }
        const last = entries[entries.length - 1];
        if (!last || last.tone !== "user" || last.body !== event.text) {
          entries.push({ tone: "user", body: event.text });
        }
      }
      continue;
    }
    if (event.type === "assistant") {
      if (event.text) {
        const parsed = parseJsonRecord(event.text);
        if (parsed && isSystemEventPayload(parsed)) {
          entries.push(toSystemCalloutItem(event.text));
          continue;
        }
        const last = entries[entries.length - 1];
        if (!last || last.tone !== "assistant" || last.body !== event.text) {
          entries.push({ tone: "assistant", body: event.text });
        }
      }
      continue;
    }
    if (event.type === "tool_call") {
      const toolId = event.tool?.id ?? "";
      const toolName = (event.tool?.name ?? "").trim();
      const toolKey = toolName.toLowerCase();
      const args = parseToolArgs(event.text ?? "");

      // Agent tool call → Subagent Run card
      if (toolKey === "agent" && toolId) {
        const prompt = typeof args?.prompt === "string" ? args.prompt : "";
        const description =
          typeof args?.description === "string" ? args.description : "";
        const subagentType =
          typeof args?.subagent_type === "string" ? args.subagent_type : "";
        const output = toolOutputs.get(toolId);
        const summary = output?.text ?? "";
        const nested = nestedByParent.get(toolId) ?? [];
        const nestedLogItems =
          nested.length > 0 ? relabelAsSubagent(buildCliLogs(nested)) : [];

        const allNested: LogItem[] = [];
        if (prompt) {
          allNested.push({
            tone: "user",
            title: "Coordinator \u2192 Subagent",
            body: prompt,
          });
        }
        allNested.push(...nestedLogItems);
        if (summary) {
          allNested.push({
            tone: "assistant",
            title: "Subagent summary returned",
            body: summary,
          });
        }
        entries.push({
          tone: "muted",
          icon: "subagent",
          title: `Subagent Run${subagentType ? ` (${subagentType})` : ""}`,
          body: description || (prompt ? prompt.slice(0, 200) : "Subagent run"),
          subagentRun: { toolUseId: toolId, nestedItems: allNested },
        });
        if (toolId) skipOutputs.add(toolId);
        continue;
      }

      const output = toolId ? toolOutputs.get(toolId) : undefined;
      const warning = toolId ? toolWarnings.get(toolId) : undefined;
      if (toolKey === "exec_command" || toolKey === "bash") {
        const command =
          typeof args?.cmd === "string"
            ? args.cmd
            : typeof args?.command === "string"
              ? args.command
              : "";
        const summary = ["Bash", command]
          .filter((part) => part.trim())
          .join(" ");
        const warningText = (warning?.text ?? "").trim();
        const outputText = (output?.text ?? "").trim();
        if (warningText || !outputText) {
          const defaultWarning = ["No output captured.", command]
            .filter((part) => part.trim())
            .join("\nCommand: ");
          entries.push({
            tone: "warning",
            icon: "warning",
            title:
              summarizeToolLabel(toolKey, args, outputText || warningText) ||
              summary ||
              "Bash",
            body: warningText || defaultWarning,
          });
        } else {
          entries.push({
            tone: "muted",
            icon: "bash",
            title: summarizeToolLabel(toolKey, args, output?.text ?? ""),
            body: output?.text ?? "",
            collapsible: true,
          });
        }
        if (toolId) skipOutputs.add(toolId);
        continue;
      }
      if (toolKey === "skill") {
        entries.push({
          tone: "muted",
          icon: "tool",
          title: summarizeToolLabel(
            "skill",
            null,
            output?.text ?? event.text ?? ""
          ),
          body: output?.text ?? event.text ?? "",
          collapsible: true,
        });
        if (toolId) skipOutputs.add(toolId);
        skipNextUserIfSkill = true;
        continue;
      }
      entries.push({
        tone: "muted",
        icon: "tool",
        title: summarizeToolLabel(
          toolName || "Tool",
          args,
          output?.text ?? event.text ?? ""
        ),
        body: output?.text ?? event.text ?? "",
        collapsible: true,
      });
      if (toolId) skipOutputs.add(toolId);
      continue;
    }
    if (event.type === "tool_output") {
      if (event.tool?.id && skipOutputs.has(event.tool.id)) continue;
      entries.push(toLogItem(event));
      continue;
    }
    if (event.type === "warning") {
      if (event.tool?.id && skipOutputs.has(event.tool.id)) continue;
      entries.push(toLogItem(event));
      continue;
    }
    if (event.type === "diff") {
      entries.push({
        tone: "muted",
        icon: "diff",
        title: `Diff · ${formatMeasure(countChanges(event.text ?? ""), "change")}`,
        body: event.text ?? "",
        collapsible: true,
      });
      continue;
    }
    if (event.text) {
      const parsed = parseJsonRecord(event.text);
      if (parsed && isSystemEventPayload(parsed)) {
        entries.push(toSystemCalloutItem(event.text));
        continue;
      }
      entries.push(toLogItem(event));
    }
  }

  return entries;
}

function isUiNoopSubagentEvent(event: SubagentLogEvent): boolean {
  return (
    event.type === "skip" ||
    event.type === "session" ||
    event.type === "message"
  );
}

function hasTextContent(event: SubagentLogEvent): boolean {
  return typeof event.text === "string" && event.text.trim().length > 0;
}

function isMeaningfulSubagentResponseEvent(event: SubagentLogEvent): boolean {
  return event.type === "assistant" && hasTextContent(event);
}

function SubagentRunCard(props: {
  item: LogItem;
  showNested: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const run = props.item.subagentRun!;
  const count = run.nestedItems.length;
  return (
    <div class="subagent-run-card" classList={{ open: props.expanded }}>
      <button
        type="button"
        class="subagent-run-header"
        onClick={props.onToggle}
        aria-expanded={props.expanded}
      >
        <span class="subagent-fork-icon" aria-hidden="true">
          &#x2442;
        </span>
        <div class="subagent-run-info">
          <span class="subagent-run-title">{props.item.title}</span>
          <span class="subagent-run-desc">{props.item.body}</span>
        </div>
        <span class="subagent-run-badge">
          {count} {count === 1 ? "item" : "items"}
        </span>
        <span class="subagent-run-chevron" aria-hidden="true">
          {props.expanded ? "▲" : "▼"}
        </span>
      </button>
      <Show when={props.expanded && props.showNested && count > 0}>
        <div class="subagent-run-content">
          {run.nestedItems.map((nested) => renderLogItem(nested))}
        </div>
      </Show>
    </div>
  );
}

function CollapsibleLogLine(props: {
  item: LogItem;
  summaryText: string;
  collapsibleKey: string;
  initialExpanded: boolean;
  onToggle: (next: boolean) => void;
  onMeasure: (element: HTMLDivElement) => void;
}) {
  let detailsRef: HTMLDetailsElement | undefined;
  const [open, setOpen] = createSignal(props.initialExpanded);
  let lastCollapsibleKey = props.collapsibleKey;

  createEffect(() => {
    const nextKey = props.collapsibleKey;
    if (nextKey === lastCollapsibleKey) return;
    lastCollapsibleKey = nextKey;
    setOpen(props.initialExpanded);
  });

  const measureRow = () => {
    if (!detailsRef) return;
    const row = detailsRef.closest(".log-virtual-row");
    if (!(row instanceof HTMLDivElement)) return;
    queueMicrotask(() => {
      if (row.isConnected) props.onMeasure(row);
    });
  };

  const toggleHandler = () => {
    if (!detailsRef) return;
    const next = detailsRef.open;
    setOpen(next);
    props.onToggle(next);
    measureRow();
  };

  onMount(() => {
    if (!detailsRef) return;
    detailsRef.addEventListener("toggle", toggleHandler);
  });
  onCleanup(() => {
    if (!detailsRef) return;
    detailsRef.removeEventListener("toggle", toggleHandler);
  });

  return (
    <details
      class={`log-line ${props.item.tone} collapsible${props.item.systemCallout ? " system-callout" : ""}`}
      classList={{ pending: !!props.item.pending, queued: !!props.item.queued }}
      open={open()}
      ref={detailsRef}
    >
      <summary class="log-summary">
        {logIcon(props.item.icon)}
        <span class="log-summary-text">{props.summaryText}</span>
      </summary>
      {props.item.tone === "assistant" || props.item.tone === "user" ? (
        <div
          class="log-text log-markdown"
          innerHTML={renderMarkdown(
            props.item.body.length > 0 ? props.item.body : "Empty content"
          )}
        />
      ) : (
        <pre class="log-text">
          {props.item.body.length > 0 ? props.item.body : "Empty content"}
        </pre>
      )}
    </details>
  );
}

function renderLogItem(
  item: LogItem,
  collapsibleKey?: string,
  initialExpanded?: boolean,
  onToggle?: (next: boolean) => void,
  onMeasure?: (element: HTMLDivElement) => void
) {
  const useMarkdown = item.tone === "assistant" || item.tone === "user";
  if (item.collapsible) {
    const summaryText =
      item.summaryPreview ??
      item.title ??
      item.body.split("\n")[0] ??
      "Details";
    if (
      collapsibleKey &&
      typeof initialExpanded === "boolean" &&
      onToggle &&
      onMeasure
    ) {
      return (
        <CollapsibleLogLine
          item={item}
          summaryText={summaryText}
          collapsibleKey={collapsibleKey}
          initialExpanded={initialExpanded}
          onToggle={onToggle}
          onMeasure={onMeasure}
        />
      );
    }
    return (
      <details
        class={`log-line ${item.tone} collapsible${item.systemCallout ? " system-callout" : ""}`}
        classList={{ pending: !!item.pending, queued: !!item.queued }}
        open={false}
      >
        <summary class="log-summary">
          {logIcon(item.icon)}
          <span class="log-summary-text">{summaryText}</span>
        </summary>
        <pre class="log-text">
          {item.body.length > 0 ? item.body : "Empty content"}
        </pre>
      </details>
    );
  }
  return (
    <div
      class={`log-line ${item.tone}${item.systemCallout ? " system-callout" : ""}`}
      classList={{ pending: !!item.pending, queued: !!item.queued }}
    >
      {logIcon(item.icon)}
      <div class="log-stack">
        {item.title && <div class="log-title">{item.title}</div>}
        {useMarkdown ? (
          <div
            class="log-text log-markdown"
            innerHTML={renderMarkdown(item.body)}
          />
        ) : (
          <pre class="log-text">{item.body}</pre>
        )}
        <Show when={item.pending || item.queued}>
          <div class="log-status">{item.queued ? "Queued" : "Sending..."}</div>
        </Show>
      </div>
    </div>
  );
}

function logIcon(icon?: LogItem["icon"]) {
  if (icon === "bash") {
    return (
      <svg
        class="log-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
      >
        <path d="M4 5h16v14H4z" />
        <path d="M7 9l3 3-3 3" />
        <path d="M12 15h4" />
      </svg>
    );
  }
  if (icon === "read") {
    return (
      <svg
        class="log-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
      >
        <path d="M4 19h12a4 4 0 0 0 0-8h-1" />
        <path d="M4 19V5h9a4 4 0 0 1 4 4v2" />
      </svg>
    );
  }
  if (icon === "write") {
    return (
      <svg
        class="log-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
      >
        <path d="M12 20h9" />
        <path d="M16.5 3.5l4 4L8 20l-4 1 1-4L16.5 3.5z" />
      </svg>
    );
  }
  if (icon === "tool") {
    return (
      <svg
        class="log-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
      >
        <path d="M14.7 6.3a5 5 0 0 0-6.4 6.4L3 18l3 3 5.3-5.3a5 5 0 0 0 6.4-6.4l-3 3-3-3 3-3z" />
      </svg>
    );
  }
  if (icon === "warning") {
    return (
      <svg
        class="log-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
      >
        <path d="M12 9v4M12 17h.01" />
        <path d="M10.3 3.8L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.8a2 2 0 0 0-3.4 0z" />
      </svg>
    );
  }
  if (icon === "output") {
    return (
      <svg
        class="log-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
      >
        <path d="M20 6L9 17l-5-5" />
      </svg>
    );
  }
  if (icon === "diff") {
    return (
      <svg
        class="log-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
      >
        <path d="M8 7v10M16 7v10M3 12h5M16 12h5" />
      </svg>
    );
  }
  if (icon === "system") {
    return (
      <svg
        class="log-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
      >
        <path d="M4 5h16v10H7l-3 3V5z" />
      </svg>
    );
  }
  if (icon === "thinking") {
    return (
      <svg
        class="log-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
      >
        <circle cx="12" cy="12" r="10" />
        <path d="M12 6v6l4 2" />
      </svg>
    );
  }
  if (icon === "error") {
    return (
      <svg
        class="log-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
      >
        <path d="M12 8v5M12 16h.01" />
        <circle cx="12" cy="12" r="9" />
      </svg>
    );
  }
  if (icon === "subagent") {
    return (
      <svg
        class="log-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
      >
        <path d="M6 3v12" />
        <path d="M6 15c0-3 6-3 6-6" />
        <path d="M12 9v12" />
      </svg>
    );
  }
  return null;
}

function extractUserTexts(messages: FullHistoryMessage[]): string[] {
  const texts: string[] = [];
  for (const msg of messages) {
    if (msg.role !== "user") continue;
    const text = getTextBlocks(msg.content);
    if (text) texts.push(text);
  }
  return texts;
}

function extractCliUserTexts(events: SubagentLogEvent[]): string[] {
  const texts: string[] = [];
  for (const event of events) {
    if (event.type !== "user") continue;
    if (event.text) texts.push(event.text);
  }
  return texts;
}

function mergePendingLeadMessages(
  messages: FullHistoryMessage[],
  pending: PendingLeadUserMessage[]
): { merged: LogItem[]; remaining: PendingLeadUserMessage[] } {
  if (pending.length === 0)
    return { merged: buildLeadLogs(messages), remaining: [] };
  const historyUsers = extractUserTexts(messages);
  let cursor = 0;
  const remaining: PendingLeadUserMessage[] = [];
  for (const item of pending) {
    const idx = historyUsers.indexOf(item.text, cursor);
    if (idx === -1) {
      remaining.push(item);
    } else {
      cursor = idx + 1;
    }
  }
  const base = buildLeadLogs(messages);
  const merged =
    remaining.length > 0
      ? [
          ...base,
          ...remaining.map((item) => ({
            tone: "user" as const,
            body: item.body,
            clientId: item.id,
            pending: !item.queued,
            queued: item.queued,
          })),
        ]
      : base;
  return { merged, remaining };
}

export function AgentChat(props: AgentChatProps) {
  const [localInput, setLocalInput] = createSignal("");
  const [error, setError] = createSignal("");
  const attachmentRuntime = createChatAttachmentRuntime({
    acceptFile: (file) => isSupportedImage(file),
    previewImages: false,
  });
  const pendingFiles = attachmentRuntime.pendingFiles;
  const [leadLogs, setLeadLogs] = createSignal<LogItem[]>([]);
  const [leadLive, setLeadLive] = createSignal("");
  const [leadStreaming, setLeadStreaming] = createSignal(false);
  const [leadPending, setLeadPending] = createSignal(false);
  const [leadHistoryMessages, setLeadHistoryMessages] = createSignal<
    FullHistoryMessage[]
  >([]);
  const [pendingLeadUserMessages, setPendingLeadUserMessages] = createSignal<
    PendingLeadUserMessage[]
  >([]);
  const [cliLogs, setCliLogs] = createSignal<SubagentLogEvent[]>([]);
  const [cliCursor, setCliCursor] = createSignal(0);
  const [subagentContextEstimate, setSubagentContextEstimate] = createSignal<
    ContextEstimate | undefined
  >();
  const [pendingCliUserMessages, setPendingCliUserMessages] = createSignal<
    PendingCliUserMessage[]
  >([]);
  const [subagentAwaitingResponse, setSubagentAwaitingResponse] =
    createSignal(false);
  const [subagentSending, setSubagentSending] = createSignal(false);
  const [stopping, setStopping] = createSignal(false);
  const [isAtBottom, setIsAtBottom] = createSignal(true);
  const input = createMemo(() => props.inputDraft ?? localInput());
  const setInput = (value: string) => {
    if (props.onInputDraftChange) {
      props.onInputDraftChange(value);
      return;
    }
    setLocalInput(value);
  };
  const streamingToolCalls = new Map<
    string,
    { index: number; name: string; args: Record<string, unknown> }
  >();
  const SCROLL_THRESHOLD = 100;

  let streamCleanup: (() => void) | null = null;
  let subscriptionCleanup: (() => void) | null = null;
  let pollInterval: number | null = null;
  let pollStateKey: string | null = null;
  let subagentSetupToken = 0;
  let activeChatIdentity: string | null = null;
  let pendingLeadHistoryRefresh = false;
  let skipNextLeadHistoryRefresh = false;
  let rootRef: HTMLDivElement | undefined;
  let logPaneRef: HTMLDivElement | undefined;
  let textareaRef: HTMLTextAreaElement | undefined;
  let fileInputRef: HTMLInputElement | undefined;
  let wasRunning = false;
  let lastTouchY: number | null = null;
  let lastLogScrollTop = 0;

  const clearSubagentPollInterval = () => {
    if (pollInterval !== null) {
      window.clearInterval(pollInterval);
      if (pollStateKey) {
        const active = activeSubagentPollIntervals.get(pollStateKey);
        if (active === pollInterval) {
          activeSubagentPollIntervals.delete(pollStateKey);
        }
      }
    }
    pollInterval = null;
    pollStateKey = null;
  };
  const teardownChatRuntime = () => {
    if (streamCleanup) {
      streamCleanup();
      streamCleanup = null;
    }
    if (subscriptionCleanup) {
      subscriptionCleanup();
      subscriptionCleanup = null;
    }
    clearSubagentPollInterval();
    subagentSetupToken += 1;
    pendingLeadHistoryRefresh = false;
    skipNextLeadHistoryRefresh = false;
  };

  const sessionKey = createMemo(() => {
    if (props.sessionKey) return props.sessionKey;
    return props.agentId ? getSessionKey(props.agentId) : "main";
  });
  const cliTokens = new Set(["claude", "codex", "pi"]);
  const canSendLead = createMemo(
    () => props.agentType === "lead" && Boolean(props.agentId)
  );
  const canSendSubagent = createMemo(
    () =>
      props.agentType === "subagent" &&
      props.subagentInfo &&
      props.subagentInfo.cli &&
      !subagentSending()
  );
  const canAttach = createMemo(
    () =>
      (props.agentType === "lead" && Boolean(props.agentId)) ||
      (props.agentType === "subagent" && Boolean(props.subagentInfo?.cli))
  );
  const isRunning = createMemo(() => {
    if (props.agentType === "lead") return leadStreaming();
    if (props.agentType === "subagent") {
      return (
        subagentSending() ||
        subagentAwaitingResponse() ||
        props.subagentInfo?.status === "running"
      );
    }
    return false;
  });
  const [showSubagents, setShowSubagents] = createSignal(true);
  const [expandedSubagentCards, setExpandedSubagentCards] = createSignal<
    Set<string>
  >(new Set());
  const [expandedCollapsibles, setExpandedCollapsibles] = createSignal<
    Set<string>
  >(new Set());
  const toggleSubagentCard = (toolUseId: string) => {
    setExpandedSubagentCards((prev) => {
      const next = new Set(prev);
      if (next.has(toolUseId)) {
        next.delete(toolUseId);
      } else {
        next.add(toolUseId);
      }
      return next;
    });
  };
  const setCollapsibleOpen = (key: string, expanded: boolean) => {
    setExpandedCollapsibles((prev) => {
      const next = new Set(prev);
      if (expanded) {
        next.add(key);
      } else {
        next.delete(key);
      }
      return next;
    });
  };

  const isSupportedImage = (file: File) => {
    if (supportedImageTypes.has(file.type)) return true;
    const ext = file.name.toLowerCase().split(".").pop();
    return ext ? supportedImageExtensions.has(ext) : false;
  };

  const addPendingFiles = (files: FileList | File[]) => {
    attachmentRuntime.attachFiles(files);
  };

  const handleFileDragOver = (event: Event) => {
    const dragEvent = event as DragEvent;
    if (!canAttach()) return;
    dragEvent.preventDefault();
  };

  const handleFileDrop = (event: Event) => {
    const dragEvent = event as DragEvent;
    if (!canAttach()) return;
    dragEvent.preventDefault();
    const files = dragEvent.dataTransfer?.files;
    if (!files || files.length === 0) return;
    addPendingFiles(files);
  };

  const removePendingFile = (id: string) => {
    attachmentRuntime.removeFile(id);
  };

  const resizeTextarea = (value = input()) => {
    if (!textareaRef) return;
    const lineHeight = 20;
    const maxHeight = lineHeight * 10;
    const lines = Math.max(1, value.split("\n").length);
    const height = Math.min(lines * lineHeight + 24, maxHeight + 24);
    textareaRef.style.height = `${height}px`;
  };

  const isChatActive = () => {
    if (!rootRef || !rootRef.isConnected) return false;
    if (rootRef.closest('[aria-hidden="true"]')) return false;
    return true;
  };

  const focusInput = () => {
    window.setTimeout(() => {
      if (!textareaRef || textareaRef.disabled || !isChatActive()) return;
      textareaRef.focus();
    }, 0);
  };

  onMount(() => {
    resizeTextarea(input());
    focusInput();

    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      if (!isChatActive() || event.defaultPrevented) return;

      if (event.key === "Escape") {
        if (!isRunning()) return;
        event.preventDefault();
        void handleStop();
        return;
      }

      if (
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "k"
      ) {
        const canStartNewSession =
          (props.agentType === "lead" && Boolean(props.agentId)) ||
          (props.agentType === "subagent" && canSendSubagent());
        if (!canStartNewSession) return;
        event.preventDefault();
        void handleSend("/new");
      }
    };

    window.addEventListener("keydown", handleGlobalKeyDown);
    rootRef?.addEventListener("dragover", handleFileDragOver, true);
    rootRef?.addEventListener("drop", handleFileDrop, true);
    onCleanup(() => {
      window.removeEventListener("keydown", handleGlobalKeyDown);
      rootRef?.removeEventListener("dragover", handleFileDragOver, true);
      rootRef?.removeEventListener("drop", handleFileDrop, true);
    });
  });

  onMount(() => {
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(() => {
      if (!logPaneRef || !shouldVirtualizeLogs()) return;
      const rows = logPaneRef.querySelectorAll<HTMLDivElement>(".log-virtual-row");
      rows.forEach((row) => logVirtualizer.measureElement(row));
      if (!isAtBottom()) return;
      const lastIndex = activeRenderedLogItems().length - 1;
      if (lastIndex >= 0) {
        queueMicrotask(() => {
          if (logPaneRef?.isConnected) {
            logVirtualizer.scrollToIndex(lastIndex, { align: "end" });
          }
        });
      }
    });
    if (logPaneRef) observer.observe(logPaneRef);
    onCleanup(() => observer.disconnect());
  });

  const distanceFromBottom = () => {
    if (!logPaneRef) return 0;
    const { scrollTop, scrollHeight, clientHeight } = logPaneRef;
    return scrollHeight - scrollTop - clientHeight;
  };

  const checkShouldResumeFollow = () => {
    return distanceFromBottom() <= SCROLL_THRESHOLD;
  };

  const handleScroll = () => {
    if (!logPaneRef) return;
    const currentScrollTop = logPaneRef.scrollTop;
    if (currentScrollTop < lastLogScrollTop) {
      setIsAtBottom(false);
    } else if (checkShouldResumeFollow()) {
      setIsAtBottom(true);
    } else {
      setIsAtBottom(false);
    }
    lastLogScrollTop = currentScrollTop;
  };

  const handleWheel = (event: WheelEvent) => {
    if (event.deltaY < 0) {
      if (logPaneRef) lastLogScrollTop = logPaneRef.scrollTop;
      setIsAtBottom(false);
    }
  };

  const handleTouchStart = (event: TouchEvent) => {
    if (logPaneRef) lastLogScrollTop = logPaneRef.scrollTop;
    lastTouchY = event.touches[0]?.clientY ?? null;
  };

  const handleTouchMove = (event: TouchEvent) => {
    const currentY = event.touches[0]?.clientY;
    if (currentY == null) return;
    if (lastTouchY !== null && currentY > lastTouchY) {
      setIsAtBottom(false);
    }
    lastTouchY = currentY;
  };

  const handleTouchEnd = () => {
    lastTouchY = null;
  };

  const scrollToBottom = (force = false) => {
    if (!logPaneRef) return;
    if (force || isAtBottom()) {
      logPaneRef.scrollTop = logPaneRef.scrollHeight;
      lastLogScrollTop = logPaneRef.scrollTop;
      setIsAtBottom(true);
    }
  };

  const markLeadStreaming = () => {
    if (leadPending()) setLeadPending(false);
  };

  const updateLeadUserLogState = (
    clientId: string,
    patch: Pick<LogItem, "pending" | "queued">
  ) => {
    setLeadLogs((prev) =>
      prev.map((item) =>
        item.clientId === clientId
          ? { ...item, pending: patch.pending, queued: patch.queued }
          : item
      )
    );
  };

  const updatePendingLeadUserMessage = (
    clientId: string,
    updater: (item: PendingLeadUserMessage) => PendingLeadUserMessage | null
  ) => {
    setPendingLeadUserMessages((prev) => {
      const next: PendingLeadUserMessage[] = [];
      for (const item of prev) {
        if (item.id !== clientId) {
          next.push(item);
          continue;
        }
        const updated = updater(item);
        if (updated) next.push(updated);
      }
      return next;
    });
  };

  const persistSubagentTransientState = (
    pending: PendingCliUserMessage[],
    awaiting: boolean
  ) => {
    const key =
      props.agentType === "subagent" && props.subagentInfo
        ? subagentStateKey({
            projectId: props.subagentInfo.projectId,
            slug: props.subagentInfo.slug,
          })
        : null;
    if (!key) return;
    if (!awaiting && pending.length === 0) {
      subagentTransientState.delete(key);
      return;
    }
    subagentTransientState.set(key, { awaiting, pending });
  };

  const updatePendingCliUserMessages = (
    updater: (
      items: PendingCliUserMessage[]
    ) => PendingCliUserMessage[],
    awaiting = subagentAwaitingResponse()
  ) => {
    setPendingCliUserMessages((prev) => {
      const next = updater(prev);
      persistSubagentTransientState(next, awaiting);
      return next;
    });
  };

  const updatePendingCliUserMessage = (
    clientId: string,
    updater: (
      item: PendingCliUserMessage
    ) => PendingCliUserMessage | null,
    awaiting = subagentAwaitingResponse()
  ) => {
    updatePendingCliUserMessages((prev) => {
      const next: PendingCliUserMessage[] = [];
      for (const item of prev) {
        if (item.id !== clientId) {
          next.push(item);
          continue;
        }
        const updated = updater(item);
        if (updated) next.push(updated);
      }
      return next;
    }, awaiting);
  };

  const maybeLoadDeferredLeadHistory = () => {
    if (!pendingLeadHistoryRefresh) return;
    pendingLeadHistoryRefresh = false;
    skipNextLeadHistoryRefresh = false;
    void loadLeadHistory();
  };

  const resolveToolPath = (args: Record<string, unknown>) => {
    if (typeof args.path === "string") return args.path;
    if (typeof args.file_path === "string") return args.file_path;
    return "";
  };

  const appendStreamingToolCall = (
    id: string,
    name: string,
    rawArgs: unknown
  ) => {
    const args =
      rawArgs && typeof rawArgs === "object"
        ? (rawArgs as Record<string, unknown>)
        : {};
    const toolKey = name.toLowerCase();
    let item: LogItem;

    if (toolKey === "read") {
      const path = resolveToolPath(args);
      item = {
        tone: "muted",
        icon: "read",
        title: `read ${path}`.trim(),
        body: "",
        collapsible: true,
      };
    } else if (toolKey === "bash") {
      const command = typeof args.command === "string" ? args.command : "";
      const params = typeof args.args === "string" ? args.args : "";
      const description =
        typeof args.description === "string" ? args.description : "";
      const summary = ["Bash", command, params, description]
        .filter((part) => part.trim())
        .join(" ");
      item = {
        tone: "muted",
        icon: "bash",
        title: summary || "Bash",
        body: "",
        collapsible: true,
      };
    } else if (toolKey === "write") {
      const path = resolveToolPath(args);
      const content = typeof args.content === "string" ? args.content : "";
      item = {
        tone: "muted",
        icon: "write",
        title: `write ${path}`.trim(),
        body: content,
        collapsible: true,
      };
    } else if (toolKey === "agent") {
      const prompt = typeof args.prompt === "string" ? args.prompt : "";
      const description =
        typeof args.description === "string" ? args.description : "";
      const subagentType =
        typeof args.subagent_type === "string" ? args.subagent_type : "";
      item = {
        tone: "muted",
        icon: "subagent",
        title: `Subagent Run${subagentType ? ` (${subagentType})` : ""}`,
        body:
          description ||
          (prompt ? prompt.slice(0, 200) : "Subagent running..."),
        subagentRun: {
          toolUseId: id,
          nestedItems: prompt
            ? [
                {
                  tone: "user",
                  title: "Coordinator \u2192 Subagent",
                  body: prompt,
                },
              ]
            : [],
        },
      };
    } else {
      item = {
        tone: "muted",
        icon: "tool",
        title: name ? `Tool: ${name}` : "Tool",
        body: "",
        collapsible: true,
      };
    }

    setLeadLogs((prev) => {
      streamingToolCalls.set(id, { index: prev.length, name, args });
      return [...prev, item];
    });
  };

  const updateStreamingToolResult = (
    id: string,
    content: string,
    details?: { diff?: string }
  ) => {
    const entry = streamingToolCalls.get(id);
    if (!entry) return;

    const toolKey = entry.name.toLowerCase();
    if (toolKey === "write") return;

    if (toolKey === "agent") {
      if (!content) return;
      setLeadLogs((prev) => {
        if (entry.index < 0 || entry.index >= prev.length) return prev;
        const current = prev[entry.index];
        if (!current.subagentRun) return prev;
        const next = [...prev];
        const updatedNested = [...current.subagentRun.nestedItems];
        updatedNested.push({
          tone: "assistant",
          title: "Subagent summary returned",
          body: content,
        });
        next[entry.index] = {
          ...current,
          subagentRun: {
            ...current.subagentRun,
            nestedItems: updatedNested,
          },
        };
        return next;
      });
      return;
    }

    const nextBody =
      content ||
      (toolKey === "read" || toolKey === "bash" ? "" : formatJson(entry.args));

    setLeadLogs((prev) => {
      if (entry.index < 0 || entry.index >= prev.length) return prev;
      const current = prev[entry.index];
      if (current.body === nextBody) return prev;
      const next = [...prev];
      next[entry.index] = { ...current, body: nextBody };
      return next;
    });

    if (details?.diff) {
      setLeadLogs((prev) => [
        ...prev,
        {
          tone: "muted",
          icon: "diff",
          title: "Diff",
          body: details.diff ?? "",
          collapsible: true,
        },
      ]);
    }
  };

  const loadLeadHistory = async () => {
    if (!props.agentId) return;
    const res = await fetchFullHistory(props.agentId, sessionKey());
    const rawMessages = res.messages ?? [];
    const nextMessages = (() => {
      if (!leadStreaming()) return rawMessages;
      const lastUserIndex = rawMessages.findLastIndex(
        (message) => message.role === "user"
      );
      return lastUserIndex === -1
        ? rawMessages
        : rawMessages.slice(0, lastUserIndex + 1);
    })();
    setLeadHistoryMessages(nextMessages);
    const pending = pendingLeadUserMessages();
    const { merged, remaining } = mergePendingLeadMessages(
      nextMessages,
      pending
    );
    setLeadLogs(merged);
    setPendingLeadUserMessages(remaining);
    if (!leadStreaming()) {
      setLeadLive("");
      streamingToolCalls.clear();
    }
  };

  const setupLead = () => {
    if (!props.agentId) return;
    let hydratedFromStream = false;
    const hydrateLeadHistoryFromStream = () => {
      if (hydratedFromStream) return;
      hydratedFromStream = true;
      void loadLeadHistory();
    };
    const markLeadStreamActivity = () => {
      setLeadStreaming(true);
      markLeadStreaming();
      hydrateLeadHistoryFromStream();
    };

    if (props.sessionNonce) {
      setLeadPending(true);
    }

    void loadLeadHistory();
    subscriptionCleanup = subscribeToSession(props.agentId, sessionKey(), {
      onText: (chunk) => {
        markLeadStreamActivity();
        setLeadLive((prev) => prev + chunk);
      },
      onThinking: () => {
        markLeadStreamActivity();
      },
      onToolCall: (id, name, args) => {
        markLeadStreamActivity();
        appendStreamingToolCall(id, name, args);
      },
      onToolResult: (id, _name, content, _isError, details) => {
        markLeadStreamActivity();
        updateStreamingToolResult(id, content, details);
      },
      onDone: () => {
        setLeadStreaming(false);
        setLeadPending(false);
        maybeLoadDeferredLeadHistory();
      },
      onHistoryUpdated: () => {
        if (leadStreaming()) {
          pendingLeadHistoryRefresh = true;
          return;
        }

        if (skipNextLeadHistoryRefresh) {
          skipNextLeadHistoryRefresh = false;
          pendingLeadHistoryRefresh = false;
          return;
        }

        void loadLeadHistory();
        if (!leadStreaming() && leadPending()) {
          setLeadPending(false);
        }
      },
    });
  };

  const setupSubagent = (setupToken: number) => {
    const subagentInfo = props.subagentInfo;
    if (!subagentInfo) return;
    let activeSlug = subagentInfo.slug;
    const resolveSlug = async () => {
      if (!cliTokens.has(activeSlug)) return;
      const res = await fetchSubagents(subagentInfo.projectId);
      if (setupToken !== subagentSetupToken) return;
      if (!res.ok) return;
      const token = activeSlug;
      const match = res.data.items.find(
        (item) => item.slug === token || item.cli === token
      );
      if (match) {
        activeSlug = match.slug;
      } else if (res.data.items.length === 1) {
        activeSlug = res.data.items[0].slug;
      }
    };
    const loadLogs = async () => {
      if (setupToken !== subagentSetupToken) return;
      const currentCursor = cliCursor();
      const res = await fetchSubagentLogs(
        subagentInfo.projectId,
        activeSlug,
        currentCursor
      );
      if (setupToken !== subagentSetupToken) return;
      if (!res.ok) return;
      setSubagentContextEstimate(res.data.latestContextEstimate);
      const stateKey = `${subagentInfo.projectId}:${activeSlug}`;
      const fetchedEvents = res.data.events;
      if (fetchedEvents.length > 0) {
        const keptEvents = fetchedEvents.filter(
          (event) => !isUiNoopSubagentEvent(event)
        );
        const next =
          keptEvents.length > 0 ? [...cliLogs(), ...keptEvents] : cliLogs();
        const pending = pendingCliUserMessages();
        const sawResponse = keptEvents.some(isMeaningfulSubagentResponseEvent);
        let remaining = pending;
        let nextAwaiting = subagentAwaitingResponse();

        if (pending.length > 0) {
          const historyUsers = extractCliUserTexts(next);
          let cursor = 0;
          remaining = [];
          for (const item of pending) {
            const idx = historyUsers.indexOf(item.text, cursor);
            if (idx === -1) {
              remaining.push(item);
            } else {
              cursor = idx + 1;
            }
          }
          if (sawResponse) {
            const activePendingIndex = remaining.findIndex(
              (item) => item.pending && !item.queued
            );
            if (activePendingIndex !== -1) {
              remaining = [
                ...remaining.slice(0, activePendingIndex),
                ...remaining.slice(activePendingIndex + 1),
              ];
            }
          }
        }

        batch(() => {
          if (keptEvents.length > 0) {
            setCliLogs(next);
          }
          if (sawResponse) {
            nextAwaiting = false;
            setSubagentAwaitingResponse(false);
          } else if (next.every((event) => event.type === "user")) {
            nextAwaiting = true;
            setSubagentAwaitingResponse(true);
          }
          if (pending.length > 0) {
            setPendingCliUserMessages(remaining);
            if (remaining.length > 0 || nextAwaiting) {
              subagentTransientState.set(stateKey, {
                awaiting: nextAwaiting,
                pending: remaining,
              });
            } else {
              subagentTransientState.delete(stateKey);
            }
          }
        });
      }
      setCliCursor(res.data.cursor);
    };
    void resolveSlug().then(() => {
      if (setupToken !== subagentSetupToken) return;
      pollStateKey = `${subagentInfo.projectId}:${activeSlug}`;
      const existing = activeSubagentPollIntervals.get(pollStateKey);
      if (existing !== undefined) {
        window.clearInterval(existing);
      }
      void loadLogs();
      pollInterval = window.setInterval(() => {
        void loadLogs();
      }, 2000);
      if (pollInterval !== null) {
        activeSubagentPollIntervals.set(pollStateKey, pollInterval);
      }
    });
  };

  createEffect(() => {
    const nextIdentity =
      props.agentType === "lead"
        ? `lead:${props.agentId ?? ""}:${props.sessionKey ?? ""}:${props.sessionNonce ?? ""}`
        : `subagent:${props.subagentInfo?.projectId ?? ""}:${props.subagentInfo?.slug ?? ""}`;
    if (nextIdentity === activeChatIdentity) return;
    const isAgentSwitch = activeChatIdentity !== null;
    activeChatIdentity = nextIdentity;

    teardownChatRuntime();

    setError("");
    if (isAgentSwitch) setInput("");
    setLeadLogs([]);
    setLeadLive("");
    setLeadStreaming(false);
    setLeadPending(false);
    setLeadHistoryMessages([]);
    attachmentRuntime.clearFiles();
    setPendingLeadUserMessages([]);
    streamingToolCalls.clear();
    setCliLogs([]);
    setCliCursor(0);
    setSubagentContextEstimate(undefined);
    setExpandedCollapsibles(new Set<string>());
    setExpandedSubagentCards(new Set<string>());
    const persistedState =
      props.agentType === "subagent" && props.subagentInfo
        ? subagentTransientState.get(
            subagentStateKey({
              projectId: props.subagentInfo.projectId,
              slug: props.subagentInfo.slug,
            }) ?? ""
          )
        : undefined;
    setPendingCliUserMessages(persistedState?.pending ?? []);
    setSubagentAwaitingResponse(persistedState?.awaiting ?? false);
    setSubagentSending(false);
    setIsAtBottom(true);
    if (textareaRef) {
      resizeTextarea("");
    }
    focusInput();

    if (props.agentType === "lead" && props.agentId) {
      setupLead();
    }

    if (props.agentType === "subagent" && props.subagentInfo) {
      setupSubagent(subagentSetupToken);
    }
  });

  onCleanup(() => {
    teardownChatRuntime();
    activeChatIdentity = null;
  });

  createEffect(() => {
    leadLogs();
    leadLive();
    cliLogs();
    pendingCliUserMessages();
    leadPending();
    scrollToBottom();
  });

  createEffect(() => {
    if (!shouldVirtualizeLogs() || !isAtBottom()) return;
    if (activeRenderedLogItems().length === 0 || virtualRows().length === 0) {
      return;
    }
    const lastIndex = activeRenderedLogItems().length - 1;
    queueMicrotask(() => {
      if (!logPaneRef?.isConnected || !isAtBottom()) return;
      logVirtualizer.scrollToIndex(lastIndex, { align: "end" });
    });
  });

  createEffect(() => {
    resizeTextarea(input());
  });

  createEffect(() => {
    const running = isRunning();
    if (!running) {
      setStopping(false);
      if (wasRunning) focusInput();
    }
    wasRunning = running;
  });

  createEffect(() => {
    if (props.agentType !== "subagent" || !props.subagentInfo) return;
    const key = subagentStateKey({
      projectId: props.subagentInfo.projectId,
      slug: props.subagentInfo.slug,
    });
    if (!key) return;
    if (
      (props.subagentInfo.status === "replied" ||
        props.subagentInfo.status === "error" ||
        props.subagentInfo.status === "idle") &&
      !subagentSending() &&
      pendingCliUserMessages().length === 0
    ) {
      subagentTransientState.delete(key);
    }
  });

  const resolveSubagentRunMode = () =>
    props.subagentInfo?.runMode === "main-run"
      ? "main-run"
      : props.subagentInfo?.runMode === "worktree"
        ? "worktree"
        : props.subagentInfo?.runMode === "clone"
          ? "clone"
          : props.subagentInfo?.runMode === "none"
            ? "none"
            : props.subagentInfo?.slug === "main"
              ? "main-run"
              : "clone";

  const startSubagentSend = (message: PendingCliUserMessage) => {
    if (!props.subagentInfo || !props.subagentInfo.cli) return;
    setSubagentSending(true);
    setError("");
    setSubagentAwaitingResponse(true);
    if (message.queued) {
      updatePendingCliUserMessage(
        message.id,
        (item) => ({ ...item, pending: true, queued: false }),
        true
      );
    } else {
      persistSubagentTransientState(pendingCliUserMessages(), true);
    }

    void spawnSubagent(props.subagentInfo.projectId, {
      slug: props.subagentInfo.slug,
      cli: props.subagentInfo.cli,
      prompt: message.text,
      mode: resolveSubagentRunMode(),
      resume: true,
      attachments: message.attachments,
    }).then((res) => {
      if (!res.ok) {
        setError(res.error);
        updatePendingCliUserMessage(message.id, () => null, false);
        setSubagentAwaitingResponse(false);
      } else {
        updatePendingCliUserMessage(
          message.id,
          (item) => ({ ...item, pending: false, queued: false }),
          true
        );
      }
      setSubagentSending(false);
    });
  };

  createEffect(() => {
    if (props.agentType !== "subagent" || !props.subagentInfo?.cli) return;
    if (props.subagentInfo.status === "running") return;
    if (subagentSending() || subagentAwaitingResponse()) return;
    const nextQueued = pendingCliUserMessages().find(
      (item) => item.queued && !item.uploading
    );
    if (!nextQueued) return;
    startSubagentSend(nextQueued);
  });

  const handleSend = async (overrideText?: string) => {
    const text = (overrideText ?? input()).trim();
    if (!text) return;
    const isAbort = text === "/abort";

    if (props.agentType === "subagent") {
      if (!props.subagentInfo || !props.subagentInfo.cli || subagentSending())
        return;
      const currentPending = pendingFiles();
      const clientId = crypto.randomUUID();
      const shouldQueue =
        props.subagentInfo.status === "running" || subagentAwaitingResponse();
      const optimisticAttachmentList =
        currentPending.length > 0
          ? currentPending
              .map((item) => `📎 ${item.name} (uploading...)`)
              .join("\n")
          : "";
      let logBody = optimisticAttachmentList
        ? `${text}\n\n${optimisticAttachmentList}`
        : text;
      let queuedMessage: PendingCliUserMessage = {
        id: clientId,
        text,
        body: logBody,
        pending: !shouldQueue,
        queued: shouldQueue,
        uploading: currentPending.length > 0,
      };

      setError("");
      updatePendingCliUserMessages(
        (prev) => [...prev, queuedMessage],
        shouldQueue ? subagentAwaitingResponse() : true
      );
      if (!shouldQueue) {
        setSubagentAwaitingResponse(true);
      }
      setInput("");
      attachmentRuntime.clearFiles();
      resizeTextarea("");
      scrollToBottom(true);
      focusInput();

      if (currentPending.length > 0) {
        try {
          const attachments = await uploadFiles(
            currentPending.map((f) => f.file)
          );
          const attachmentList = attachments.map((f) => `📎 ${f.path}`).join("\n");
          logBody = `${text}\n\n${attachmentList}`;
          queuedMessage = {
            ...queuedMessage,
            body: logBody,
            attachments,
            uploading: false,
          };
          updatePendingCliUserMessage(clientId, () => queuedMessage);
        } catch {
          queuedMessage = {
            ...queuedMessage,
            body: text,
            uploading: false,
          };
          updatePendingCliUserMessage(clientId, () => queuedMessage);
        }
      } else {
        queuedMessage = {
          ...queuedMessage,
          uploading: false,
        };
      }

      if (!shouldQueue) {
        startSubagentSend(queuedMessage);
      }
      return;
    }

    if (!props.agentId) return;

    const currentPendingFiles = pendingFiles();
    const clientId = crypto.randomUUID();
    const isQueuedLeadSend = leadStreaming() && !isAbort;
    const optimisticAttachmentList =
      currentPendingFiles.length > 0
        ? currentPendingFiles
            .map((item) => `📎 ${item.name} (uploading...)`)
            .join("\n")
        : "";
    let logBody = optimisticAttachmentList
      ? text
        ? `${text}\n\n${optimisticAttachmentList}`
        : optimisticAttachmentList
      : text;

    if (!isAbort) {
      setPendingLeadUserMessages((prev) => [
        ...prev,
        { id: clientId, text, body: logBody, queued: false },
      ]);
      setLeadLogs((prev) => [
        ...prev,
        {
          tone: "user",
          body: logBody,
          clientId,
          pending: true,
          queued: false,
        },
      ]);
      setInput("");
    attachmentRuntime.clearFiles();
    }
    setError("");
    resizeTextarea("");
    scrollToBottom(true);
    focusInput();

    let fileAttachments: FileAttachment[] = [];
    if (currentPendingFiles.length > 0 && !isAbort) {
      try {
        fileAttachments = await uploadFiles(
          currentPendingFiles.map((p) => p.file)
        );
        const fileList = fileAttachments.map((f) => `📎 ${f.path}`).join("\n");
        logBody = text ? `${text}\n\n${fileList}` : fileList;
        setLeadLogs((prev) =>
          prev.map((item) =>
            item.clientId === clientId ? { ...item, body: logBody } : item
          )
        );
        updatePendingLeadUserMessage(clientId, (item) => ({
          ...item,
          body: logBody,
        }));
      } catch (err) {
        updateLeadUserLogState(clientId, { pending: false, queued: false });
        updatePendingLeadUserMessage(clientId, () => null);
        setError(err instanceof Error ? err.message : "Failed to upload files");
        return;
      }
    }

    if (isQueuedLeadSend) {
      const queueCleanup = streamMessage(
        props.agentId,
        text,
        sessionKey(),
        (_chunk) => {
          updateLeadUserLogState(clientId, { pending: false, queued: false });
        },
        (meta?: DoneMeta) => {
          if (meta?.queued) {
            updateLeadUserLogState(clientId, { pending: false, queued: true });
            updatePendingLeadUserMessage(clientId, (item) => ({
              ...item,
              queued: true,
            }));
            if (queueCleanup) queueCleanup();
            return;
          }

          updateLeadUserLogState(clientId, { pending: false, queued: false });
          updatePendingLeadUserMessage(clientId, () => null);

          if (queueCleanup) queueCleanup();
        },
        (err) => {
          updateLeadUserLogState(clientId, { pending: false, queued: false });
          updatePendingLeadUserMessage(clientId, () => null);
          setError(err);
          scrollToBottom(true);
          if (queueCleanup) queueCleanup();
        },
        {
          onThinking: (_chunk) => {
            updateLeadUserLogState(clientId, {
              pending: false,
              queued: false,
            });
          },
          onToolCall: (_id, _name, _args) => {
            updateLeadUserLogState(clientId, {
              pending: false,
              queued: false,
            });
          },
        },
        {
          attachments: fileAttachments.length > 0 ? fileAttachments : undefined,
        }
      );
      return;
    }

    setLeadLive("");
    setLeadStreaming(true);
    setLeadPending(true);
    streamingToolCalls.clear();
    skipNextLeadHistoryRefresh = true;

    streamCleanup?.();
    streamCleanup = streamMessage(
      props.agentId,
      text,
      sessionKey(),
      (_chunk) => {
        markLeadStreaming();
        updateLeadUserLogState(clientId, { pending: false, queued: false });
      },
      () => {
        setLeadStreaming(false);
        setLeadLive("");
        setLeadPending(false);
        streamingToolCalls.clear();
        updateLeadUserLogState(clientId, { pending: false, queued: false });
        updatePendingLeadUserMessage(clientId, () => null);
        void loadLeadHistory();
      },
      (err) => {
        setError(err);
        scrollToBottom(true);
        setLeadStreaming(false);
        setLeadPending(false);
        streamingToolCalls.clear();
        skipNextLeadHistoryRefresh = false;
        updateLeadUserLogState(clientId, { pending: false, queued: false });
        updatePendingLeadUserMessage(clientId, () => null);
        void loadLeadHistory();
      },
      {
        onThinking: (_chunk) => {
          markLeadStreaming();
          updateLeadUserLogState(clientId, { pending: false, queued: false });
        },
        onToolCall: (_id, _name, _args) => {
          markLeadStreaming();
          updateLeadUserLogState(clientId, { pending: false, queued: false });
        },
        onToolResult: (_id, _name, _content, _isError, _details) => {
          markLeadStreaming();
          updateLeadUserLogState(clientId, { pending: false, queued: false });
        },
        onSessionReset: () => {
          setLeadLogs([]);
          setLeadLive("");
          setLeadStreaming(false);
          setLeadPending(false);
          setPendingLeadUserMessages([]);
          streamingToolCalls.clear();
          pendingLeadHistoryRefresh = false;
          skipNextLeadHistoryRefresh = false;
        },
      },
      { attachments: fileAttachments.length > 0 ? fileAttachments : undefined }
    );
  };

  const handleStop = async () => {
    if (stopping()) return;
    setStopping(true);
    if (props.agentType === "lead") {
      try {
        await handleSend("/abort");
      } finally {
        setStopping(false);
      }
      return;
    }
    if (props.agentType === "subagent" && props.subagentInfo) {
      const { projectId, slug } = props.subagentInfo;
      const key = subagentStateKey({ projectId, slug });
      try {
        const res = await interruptSubagent(projectId, slug);
        if (!res.ok) {
          setError(res.error);
        } else {
          setSubagentAwaitingResponse(false);
          setPendingCliUserMessages([]);
          if (key) subagentTransientState.delete(key);
        }
      } finally {
        setStopping(false);
      }
      return;
    }
    setStopping(false);
  };

  const leadLogItems = createMemo(() => leadLogs());
  const estimatedContextUsagePct = createMemo(() => {
    let highestInputTokens = 0;
    let modelName: string | undefined;
    for (const message of leadHistoryMessages()) {
      if (message.role !== "assistant") continue;
      const meta = message.meta;
      if (meta?.model) modelName = meta.model;
      const rawUsage = meta?.usage as
        | (NonNullable<typeof meta>["usage"] & {
            input_tokens?: number;
            total_tokens?: number;
          })
        | undefined;
      if (!rawUsage) continue;
      const inputTokens =
        (typeof rawUsage.input === "number"
          ? rawUsage.input
          : typeof rawUsage.input_tokens === "number"
            ? rawUsage.input_tokens
            : 0) +
        (typeof rawUsage.cacheRead === "number" ? rawUsage.cacheRead : 0) +
        (typeof rawUsage.cacheWrite === "number" ? rawUsage.cacheWrite : 0);
      if (inputTokens > highestInputTokens) highestInputTokens = inputTokens;
    }
    const maxTokens = getMaxContextTokens(modelName);
    if (maxTokens <= 0 || highestInputTokens <= 0) return 0;
    const rawPct = (highestInputTokens / maxTokens) * 100;
    if (rawPct > 0 && rawPct < 1) return 1;
    return Math.max(0, Math.min(100, Math.round(rawPct)));
  });
  const contextUsageDisplay = createMemo(() => {
    if (props.agentType === "lead" && leadHistoryMessages().length > 0) {
      const pct = estimatedContextUsagePct();
      return pct > 0
        ? { text: `~${pct}% context used`, unavailable: false }
        : null;
    }
    if (props.agentType !== "subagent" || !props.subagentInfo) return null;
    const estimate = subagentContextEstimate();
    if (!estimate) return null;
    if (estimate.available && estimate.pct > 0) {
      return {
        text: `~${estimate.pct}% context used`,
        unavailable: false,
      };
    }
    if (estimate.available === false) {
      return { text: "Context usage unavailable", unavailable: true };
    }
    return null;
  });
  const contextWarning = createMemo(() => {
    if (props.agentType === "lead" && leadHistoryMessages().length > 0) {
      const pct = estimatedContextUsagePct();
      if (pct >= 80) {
        return `Context usage is high (~${pct}%). Consider wrapping up this conversation or creating a handoff document to continue in a new session.`;
      }
      return null;
    }
    if (props.agentType !== "subagent" || !props.subagentInfo) return null;
    const estimate = subagentContextEstimate();
    if (!estimate?.available || estimate.pct < 80) return null;
    return `Context usage is high (~${estimate.pct}%). Consider wrapping up this conversation or creating a handoff document to continue in a new session.`;
  });
  const cliDisplayEvents = createMemo(() => {
    return cliLogs();
  });
  const queuedCliLogItems = createMemo<LogItem[]>(() =>
    pendingCliUserMessages().map((item) => ({
      tone: "user",
      body: item.body,
      clientId: item.id,
      pending: item.pending,
      queued: item.queued,
    }))
  );
  const cliLogItems = createMemo<LogItem[]>(() => [
    ...buildCliLogs(cliDisplayEvents()),
    ...queuedCliLogItems(),
  ]);
  const hasPendingCliIndicator = createMemo(() =>
    pendingCliUserMessages().some((item) => item.pending || item.queued)
  );
  const leadRenderedLogItems = createMemo<RenderedLogItem[]>(() =>
    leadLogItems().map((item, index) => {
      const collapsibleKey = item.subagentRun
        ? `subagent:${item.subagentRun.toolUseId}`
        : `lead-collapsible:${item.summaryPreview ?? item.title ?? item.body.slice(0, 80)}:${item.body.length}`;
      return {
        item,
        collapsibleKey,
        virtualKey: item.subagentRun
          ? `lead:subagent:${item.subagentRun.toolUseId}`
          : item.clientId
            ? `lead:client:${item.clientId}`
            : `lead:${item.tone}:${item.title ?? item.summaryPreview ?? item.body.slice(0, 40)}:${item.body.length}:${index}`,
      };
    })
  );
  const cliRenderedLogItems = createMemo<RenderedLogItem[]>(() =>
    cliLogItems().map((item, index) => {
      const collapsibleKey = item.subagentRun
        ? `subagent:${item.subagentRun.toolUseId}`
        : `cli-collapsible:${item.summaryPreview ?? item.title ?? item.body.slice(0, 80)}:${item.body.length}`;
      return {
        item,
        collapsibleKey,
        virtualKey: item.subagentRun
          ? `cli:subagent:${item.subagentRun.toolUseId}`
          : item.clientId
            ? `cli:client:${item.clientId}`
            : `cli:${item.tone}:${item.title ?? item.summaryPreview ?? item.body.slice(0, 40)}:${item.body.length}:${index}`,
      };
    })
  );
  const activeRenderedLogItems = createMemo<RenderedLogItem[]>(() => {
    if (props.agentType === "lead") return leadRenderedLogItems();
    if (props.agentType === "subagent") return cliRenderedLogItems();
    return [];
  });
  const shouldVirtualizeLogs = createMemo(
    () => activeRenderedLogItems().length >= VIRTUAL_LOG_MIN_COUNT
  );
  const logVirtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    get count() {
      return activeRenderedLogItems().length;
    },
    getScrollElement: () => logPaneRef ?? null,
    initialRect: { width: 0, height: 720 },
    estimateSize: (index) => {
      const rendered = activeRenderedLogItems()[index];
      if (!rendered) return 72;
      if (rendered.item.subagentRun) return 120;
      if (rendered.item.collapsible) return 52;
      if (rendered.item.tone === "assistant") return 120;
      if (rendered.item.tone === "user") return 88;
      return 60;
    },
    measureElement: (element, entry, instance) => {
      const size = measureVirtualElement(element, entry, instance);
      if (size > 0) return size;
      const index = Number(element.dataset.index ?? 0);
      return instance.options.estimateSize(index);
    },
    overscan: VIRTUAL_LOG_OVERSCAN,
    gap: 2,
    getItemKey: (index) => {
      const rendered = activeRenderedLogItems()[index];
      return rendered ? rendered.virtualKey : index;
    },
  });
  const hasSubagentRuns = createMemo(() => {
    const items = props.agentType === "lead" ? leadLogItems() : cliLogItems();
    return items.some((item) => item.subagentRun);
  });
  const virtualRows = createMemo(() =>
    shouldVirtualizeLogs() ? logVirtualizer.getVirtualItems() : []
  );
  const virtualPaddingTop = createMemo(() => virtualRows()[0]?.start ?? 0);
  const virtualPaddingBottom = createMemo(() => {
    const rows = virtualRows();
    const last = rows[rows.length - 1];
    return last ? Math.max(0, logVirtualizer.getTotalSize() - last.end) : 0;
  });
  const headerSessionLabel = createMemo(() => {
    if (props.agentType === "lead" && props.agentId) {
      return sessionKey();
    }
    if (props.subagentInfo?.slug) return props.subagentInfo.slug;
    return "session";
  });
  const showHeader = createMemo(() => props.showHeader !== false || zenMode());
  const renderRenderedLogItem = (rendered: RenderedLogItem) => {
    if (rendered.item.subagentRun) {
      const id = rendered.item.subagentRun.toolUseId;
      return (
        <SubagentRunCard
          item={rendered.item}
          showNested={showSubagents()}
          expanded={expandedSubagentCards().has(id)}
          onToggle={() => toggleSubagentCard(id)}
        />
      );
    }
    return renderLogItem(
      rendered.item,
      rendered.collapsibleKey,
      untrack(() => expandedCollapsibles().has(rendered.collapsibleKey)),
      (next) => setCollapsibleOpen(rendered.collapsibleKey, next),
      (element) => logVirtualizer.measureElement(element)
    );
  };

  return (
    <div
      class="agent-chat"
      ref={rootRef}
      classList={{ fullscreen: Boolean(props.fullscreen), zen: zenMode() }}
    >
      <Show when={showHeader()}>
        <div class="chat-header">
          <Show when={props.showHeader !== false}>
            <button class="back-btn" type="button" onClick={props.onBack}>
              ←
            </button>
          </Show>
          <div class="chat-title-row">
            <h3>{props.agentName ?? "Select an agent"}</h3>
            <span class="chat-session-chip">{headerSessionLabel()}</span>
            <Show when={props.agentType === "subagent" && props.subagentInfo}>
              <button
                class="open-project-btn"
                type="button"
                title="Open project details"
                aria-label="Open project details"
                onClick={() => {
                  const info = props.subagentInfo;
                  if (!info || !props.onOpenProject) return;
                  props.onOpenProject(info.projectId);
                }}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                >
                  <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              </button>
            </Show>
          </div>
          <button
            class="zen-toggle-btn"
            type="button"
            onClick={toggleZenMode}
            aria-label={zenMode() ? "Exit zen mode" : "Enter zen mode"}
          >
            {zenMode() ? "Exit Zen" : "Zen"}
          </button>
          <Show when={props.agentType === "subagent" && props.subagentInfo}>
            <button
              class="archive-btn"
              type="button"
              title="Archive run"
              aria-label="Archive run"
              onClick={async () => {
                const info = props.subagentInfo!;
                if (!window.confirm(`Archive run ${info.slug}?`)) return;
                const res = await archiveSubagent(info.projectId, info.slug);
                if (res.ok) {
                  props.onBack();
                } else {
                  setError(res.error);
                }
              }}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <path d="M3 7h18v13H3z" />
                <path d="M7 7V4h10v3" />
                <path d="M7 12h10" />
              </svg>
            </button>
          </Show>
          <Show when={props.agentType === "subagent" && props.subagentInfo}>
            <button
              class="kill-btn"
              type="button"
              title="Kill subagent"
              onClick={async () => {
                const info = props.subagentInfo!;
                if (
                  !window.confirm(
                    `Kill subagent ${info.slug}? This removes all workspace data.`
                  )
                )
                  return;
                const res = await killSubagent(info.projectId, info.slug);
                if (res.ok) {
                  props.onBack();
                } else {
                  setError(res.error);
                }
              }}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14" />
              </svg>
            </button>
          </Show>
        </div>
      </Show>

      <div class="chat-messages">
        <Show when={!props.agentName}>
          <div class="chat-empty">Select an agent to chat</div>
        </Show>

        <Show when={props.agentName && props.agentType === "lead"}>
          <div
            class="log-pane"
            ref={logPaneRef}
            onScroll={handleScroll}
            onWheel={handleWheel}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
          >
            <Show when={hasSubagentRuns()}>
              <div class="subagent-filter-bar">
                <button
                  type="button"
                  class="subagent-filter-toggle"
                  classList={{ active: !showSubagents() }}
                  onClick={() => setShowSubagents((prev) => !prev)}
                >
                  {showSubagents() ? "All messages" : "Main only"}
                </button>
              </div>
            </Show>
            <Show
              when={leadLogItems().length > 0}
              fallback={<div class="log-empty">New session — send a message to start.</div>}
            >
              <Show
                when={shouldVirtualizeLogs() && virtualRows().length > 0}
                fallback={
                  <For each={leadRenderedLogItems()}>
                    {(item) => <>{renderRenderedLogItem(item)}</>}
                  </For>
                }
              >
                <div
                  class="log-virtual-space"
                  style={{
                    "padding-top": `${virtualPaddingTop()}px`,
                    "padding-bottom": `${virtualPaddingBottom()}px`,
                  }}
                >
                  <For each={virtualRows()}>
                    {(virtualRow) => {
                      const rendered = createMemo(
                        () => leadRenderedLogItems()[virtualRow.index]
                      );
                      return (
                        <Show when={rendered()}>
                          {(item) => (
                            <div
                              class="log-virtual-row"
                              data-index={virtualRow.index}
                              ref={(el) => logVirtualizer.measureElement(el)}
                            >
                              {renderRenderedLogItem(item())}
                            </div>
                          )}
                        </Show>
                      );
                    }}
                  </For>
                </div>
              </Show>
            </Show>
            <Show when={leadLive()}>
              <div class="log-line assistant live">
                <div class="log-stack">
                  <pre class="log-text">{leadLive()}</pre>
                </div>
              </div>
            </Show>
            <Show when={leadPending()}>
              <div class="log-line pending">
                <span class="log-spinner" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </span>
              </div>
            </Show>
          </div>
        </Show>

        <Show when={props.agentName && props.agentType === "subagent"}>
          <div
            class="log-pane"
            ref={logPaneRef}
            onScroll={handleScroll}
            onWheel={handleWheel}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
          >
            <Show when={hasSubagentRuns()}>
              <div class="subagent-filter-bar">
                <button
                  type="button"
                  class="subagent-filter-toggle"
                  classList={{ active: !showSubagents() }}
                  onClick={() => setShowSubagents((prev) => !prev)}
                >
                  {showSubagents() ? "All messages" : "Main only"}
                </button>
              </div>
            </Show>
            <Show
              when={cliLogItems().length > 0}
              fallback={<div class="log-empty">No logs yet.</div>}
            >
              <Show
                when={shouldVirtualizeLogs() && virtualRows().length > 0}
                fallback={
                  <Index each={cliRenderedLogItems()}>
                    {(item) => <>{() => renderRenderedLogItem(item())}</>}
                  </Index>
                }
              >
                <div
                  class="log-virtual-space"
                  style={{
                    "padding-top": `${virtualPaddingTop()}px`,
                    "padding-bottom": `${virtualPaddingBottom()}px`,
                  }}
                >
                  <For each={virtualRows()}>
                    {(virtualRow) => {
                      const rendered = createMemo(
                        () => cliRenderedLogItems()[virtualRow.index]
                      );
                      return (
                        <Show when={rendered()}>
                          {(item) => (
                            <div
                              class="log-virtual-row"
                              data-index={virtualRow.index}
                              ref={(el) => logVirtualizer.measureElement(el)}
                            >
                              {renderRenderedLogItem(item())}
                            </div>
                          )}
                        </Show>
                      );
                    }}
                  </For>
                </div>
              </Show>
            </Show>
            <Show
              when={
                hasPendingCliIndicator() ||
                subagentSending() ||
                subagentAwaitingResponse()
              }
            >
              <div class="log-line pending">
                <span class="log-spinner" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </span>
              </div>
            </Show>
          </div>
        </Show>
      </div>

      <Show when={error()}>
        <div class="chat-error">{error()}</div>
      </Show>

      <Show when={pendingFiles().length > 0}>
        <div class="chat-attachments">
          {pendingFiles().map((item) => (
            <div class="attachment-pill">
              <span class="attachment-name" title={item.name}>
                {item.name}
              </span>
              <button
                type="button"
                class="attachment-remove"
                aria-label={`Remove ${item.name}`}
                onClick={() => removePendingFile(item.id)}
              >
                x
              </button>
            </div>
          ))}
        </div>
      </Show>

      <div class="chat-input">
        <div class="chat-controls">
          <input
            ref={fileInputRef}
            class="chat-file-input"
            type="file"
            accept="image/jpeg,image/png,image/gif,image/webp,image/jpg"
            multiple
            onChange={(e) => {
              if (!canAttach()) return;
              const files = e.currentTarget.files;
              if (!files || files.length === 0) return;
              addPendingFiles(files);
              e.currentTarget.value = "";
            }}
          />
          <button
            type="button"
            class="attach-btn"
            aria-label="Attach images"
            disabled={!canAttach()}
            onClick={() => fileInputRef?.click()}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                fill="currentColor"
                d="M16.5 6.5v9.1a4.5 4.5 0 0 1-9 0V6.3a3.3 3.3 0 0 1 6.6 0v8.8a2.1 2.1 0 1 1-4.2 0V7.2h1.6v7.9a.5.5 0 1 0 1 0V6.3a1.7 1.7 0 0 0-3.4 0v9.3a2.9 2.9 0 0 0 5.8 0V6.5h1.6z"
              />
            </svg>
          </button>
          <textarea
            placeholder="Type a message..."
            disabled={!canSendLead() && !canSendSubagent()}
            value={input()}
            ref={textareaRef}
            rows={1}
            onInput={(e) => {
              const value = e.currentTarget.value;
              setInput(value);
              resizeTextarea(value);
            }}
            onKeyDown={(e) => {
              const isComposing = e.isComposing === true || e.keyCode === 229;
              if (e.key === "Enter" && !e.shiftKey && !isComposing) {
                e.preventDefault();
                void handleSend();
              }
            }}
          />
          <Show
            when={props.agentType === "lead"}
            fallback={
              <>
                <button
                  type="button"
                  class="send-btn"
                  disabled={!canSendSubagent() || !input().trim()}
                  onClick={() => void handleSend()}
                >
                  Send
                </button>
                <Show when={isRunning()}>
                  <button
                    type="button"
                    class="stop-btn"
                    classList={{ stopping: stopping() }}
                    disabled={stopping()}
                    onClick={() => void handleStop()}
                  >
                    {stopping() ? "Stopping..." : "Stop"}
                  </button>
                </Show>
              </>
            }
          >
            <button
              type="button"
              class="send-btn"
              disabled={!canSendLead() || !input().trim()}
              onClick={() => void handleSend()}
            >
              Send
            </button>
            <Show when={isRunning()}>
              <button
                type="button"
                class="stop-btn"
                classList={{ stopping: stopping() }}
                disabled={stopping()}
                onClick={() => void handleStop()}
              >
                {stopping() ? "Stopping..." : "Stop"}
              </button>
            </Show>
          </Show>
        </div>
        <Show when={contextUsageDisplay()}>
          {(display) => (
            <div
              class="context-usage"
              classList={{ unavailable: display().unavailable }}
            >
              {display().text}
            </div>
          )}
        </Show>
        <Show when={contextWarning()}>
          {(warning) => <div class="context-warning">{warning()}</div>}
        </Show>
      </div>

      <style>{`
        .agent-chat {
          display: flex;
          flex-direction: column;
          height: 100%;
          min-width: 0;
          font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
          font-size: 14px;
          line-height: 1.6;
          color: var(--text-primary);
        }

        /* ── Header ── */

        .chat-header {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 16px;
          border-bottom: 1px solid var(--border-default);
        }

        .chat-header h3 {
          margin: 0;
          font-size: 14px;
          font-weight: 600;
          color: var(--text-primary);
        }

        .chat-title-row {
          display: flex;
          align-items: center;
          gap: 6px;
          min-width: 0;
          flex: 1;
        }

        .chat-session-chip {
          display: inline-flex;
          align-items: center;
          padding: 2px 8px;
          border-radius: 999px;
          border: 1px solid var(--border-default);
          background: rgba(255, 255, 255, 0.03);
          font-size: 11px;
          color: var(--text-secondary);
        }

        .back-btn {
          background: none;
          border: none;
          color: var(--text-tertiary);
          font-size: 16px;
          cursor: pointer;
        }

        .back-btn:hover { color: var(--text-primary); }

        .back-btn:focus-visible {
          outline: 2px solid rgba(59, 130, 246, 0.6);
          outline-offset: 2px;
        }

        .chat-header .open-project-btn,
        .chat-header .archive-btn {
          background: none;
          border: none;
          padding: 4px;
          cursor: pointer;
          color: #8b96a5;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .chat-header .open-project-btn svg,
        .chat-header .archive-btn svg,
        .chat-header .kill-btn svg {
          width: 16px;
          height: 16px;
        }

        .chat-header .open-project-btn:hover { color: #d4dbe5; }
        .chat-header .archive-btn:hover { color: #f6c454; }

        .chat-header .kill-btn {
          background: none;
          border: none;
          padding: 4px;
          cursor: pointer;
          color: var(--text-muted);
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .chat-header .kill-btn:hover { color: #e53935; }

        .zen-toggle-btn {
          border: 1px solid var(--border-default);
          background: transparent;
          color: var(--text-secondary);
          border-radius: 999px;
          padding: 5px 10px;
          font-size: 11px;
          font-weight: 600;
          cursor: pointer;
          margin-left: auto;
        }

        .zen-toggle-btn:hover {
          color: var(--text-primary);
          border-color: var(--text-tertiary);
        }

        /* ── Messages area ── */

        .chat-messages {
          flex: 1;
          overflow-y: auto;
          padding: 0;
          display: flex;
          min-width: 0;
          scroll-behavior: smooth;
        }

        .chat-messages,
        .log-pane {
          scrollbar-width: thin;
          scrollbar-color: var(--scrollbar-thumb) transparent;
        }

        .chat-messages::-webkit-scrollbar,
        .log-pane::-webkit-scrollbar { width: 8px; }

        .chat-messages::-webkit-scrollbar-track,
        .log-pane::-webkit-scrollbar-track { background: transparent; }

        .chat-messages::-webkit-scrollbar-thumb,
        .log-pane::-webkit-scrollbar-thumb {
          background: var(--scrollbar-thumb);
          border: 2px solid transparent;
          background-clip: content-box;
          border-radius: 999px;
        }

        .chat-messages::-webkit-scrollbar-thumb:hover,
        .log-pane::-webkit-scrollbar-thumb:hover {
          background: var(--bg-raised);
          border: 2px solid transparent;
          background-clip: content-box;
        }

        .chat-empty {
          flex: 1;
          display: flex;
          align-items: center;
          justify-content: center;
          color: var(--text-muted);
          font-size: 14px;
        }

        .chat-error {
          padding: 8px 16px;
          font-size: 12px;
          color: #f5b0b0;
          border-top: 1px solid var(--border-default);
        }

        /* ── Log pane — flat, no container chrome ── */

        .log-pane {
          background: transparent;
          border: none;
          border-radius: 0;
          padding: 12px 16px;
          overflow: auto;
          display: flex;
          flex-direction: column;
          gap: 2px;
          flex: 1;
          min-height: 0;
          min-width: 0;
          max-width: 100%;
        }

        .log-virtual-space {
          width: 100%;
          flex: none;
        }

        .log-virtual-row {
          width: 100%;
        }

        /* ── Log lines — flat, full-width ── */

        .log-line {
          display: flex;
          gap: 10px;
          align-items: flex-start;
          padding: 9px 12px;
          border-radius: 0 8px 8px 0;
          background: rgba(255, 255, 255, 0.015);
          min-width: 0;
          max-width: 100%;
          border-left: 2px solid transparent;
        }

        .log-line + .log-line {
          border-top: 1px solid rgba(255, 255, 255, 0.04);
        }

        /* ── User messages — subtle green left accent ── */

        .log-line.user {
          color: var(--text-primary);
          background: rgba(59, 130, 246, 0.05);
          border-left-color: rgba(59, 130, 246, 0.55);
          border-radius: 0 8px 8px 0;
          padding-left: 14px;
          margin: 8px 0 4px;
        }

        .log-line.user + .log-line {
          border-top: none;
        }

        .log-line + .log-line.user {
          border-top: none;
        }

        .log-line.user.pending {
          opacity: 0.82;
        }

        .log-line.user.queued {
          box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--subagent-border) 45%, transparent);
        }

        /* ── Assistant messages — clean, no background ── */

        .log-line.assistant {
          color: var(--text-primary);
          padding: 10px 12px;
        }

        .log-line.live {
          color: var(--tone-live);
        }

        /* ── Muted / tool calls — compact, subtle ── */

        .log-line.muted {
          color: var(--text-tertiary);
          background: transparent;
          font-size: 13px;
          padding: 4px 12px;
        }

        .log-line.error {
          color: var(--tone-error);
          background: rgba(220, 50, 50, 0.06);
          border-left: 2px solid rgba(220, 50, 50, 0.4);
          border-radius: 0 6px 6px 0;
          padding-left: 14px;
        }

        .log-line.warning {
          color: #f7d49a;
          background: rgba(176, 122, 31, 0.12);
          border-left: 2px solid rgba(224, 164, 61, 0.55);
          border-radius: 0 6px 6px 0;
          padding-left: 14px;
        }

        .log-line.system-callout {
          background: rgba(59, 130, 246, 0.08);
          border-left: 3px solid #3b82f6;
          font-size: 11px;
          padding: 8px 12px;
          border-radius: 6px;
          color: var(--text-secondary);
        }

        /* ── Collapsible tool calls ── */

        .log-line.collapsible {
          padding: 0;
          display: block;
          border-radius: 0 8px 8px 0;
        }

        .log-line.collapsible + .log-line,
        .log-line + .log-line.collapsible {
          border-top: none;
        }

        .log-summary {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 6px 12px;
          cursor: pointer;
          list-style: none;
          width: 100%;
          font-size: 13px;
          color: var(--text-tertiary);
          border-radius: 6px;
          transition: background 0.1s;
          min-width: 0;
        }

        .log-summary span {
          flex: 1;
          min-width: 0;
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        .log-summary:hover {
          background: rgba(255, 255, 255, 0.03);
        }

        .log-summary::-webkit-details-marker {
          display: none;
        }

        .log-summary::before {
          display: none;
          content: "";
        }

        .log-line.collapsible .log-text {
          background: rgba(255, 255, 255, 0.02);
          border-radius: 0 0 8px 8px;
          border-top: 1px solid rgba(255, 255, 255, 0.05);
          /* Align expanded tool output with tool-call label text (after chevron+icon). */
          padding: 10px 12px 10px 36px;
          font-family: "SF Mono", "Consolas", "Liberation Mono", monospace;
          font-size: 12px;
          line-height: 1.5;
          color: var(--text-tertiary);
          max-height: 300px;
          overflow: auto;
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        .log-line.collapsible.user .log-text {
          font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
          font-size: 13px;
          color: var(--text-primary);
          max-height: none;
          overflow: visible;
        }

        .log-line.collapsible.system-callout {
          padding: 0;
        }

        .log-line.collapsible.system-callout .log-summary {
          background: rgba(59, 130, 246, 0.08);
          border-left: 3px solid #3b82f6;
          border-radius: 6px 6px 0 0;
          padding: 8px 12px;
          font-size: 11px;
        }

        .log-line.collapsible.system-callout .log-summary:hover {
          background: rgba(59, 130, 246, 0.12);
        }

        .log-line.collapsible.system-callout .log-text {
          background: rgba(59, 130, 246, 0.08);
          border-top: 1px solid rgba(59, 130, 246, 0.35);
          border-left: 3px solid #3b82f6;
          border-radius: 0 0 6px 6px;
          padding: 8px 12px 8px 36px;
          font-size: 11px;
          color: var(--text-secondary);
        }

        /* ── Content layout ── */

        .log-stack {
          display: flex;
          flex-direction: column;
          gap: 4px;
          min-width: 0;
          flex: 1;
        }

        .log-status {
          font-size: 11px;
          color: var(--text-muted);
        }

        .log-line.pending {
          opacity: 0.82;
        }

        .log-line.queued {
          box-shadow: inset 0 0 0 1px color-mix(in srgb, #3b82f6 35%, transparent);
        }

        .log-title {
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: var(--text-muted);
          font-weight: 500;
        }

        .log-icon {
          width: 14px;
          height: 14px;
          opacity: 0.5;
          margin-top: 3px;
          flex: 0 0 auto;
        }

        pre.log-text {
          margin: 0;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
          word-break: break-word;
          line-height: 1.6;
          max-width: 100%;
          font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
        }

        /* Terminal/tool output should stay monospace. */
        .log-line.muted pre.log-text,
        .log-line.error pre.log-text {
          font-family: "SF Mono", "Consolas", "Liberation Mono", monospace;
        }

        /* ── Markdown rendering ── */

        .log-markdown {
          white-space: normal;
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        .log-markdown p {
          margin: 0;
        }

        .log-markdown p + p {
          margin-top: 8px;
        }

        .log-markdown strong {
          color: var(--text-primary);
          font-weight: 600;
        }

        .log-markdown code {
          background: rgba(255, 255, 255, 0.06);
          border-radius: 4px;
          padding: 2px 6px;
          font-family: "SF Mono", "Consolas", "Liberation Mono", monospace;
          font-size: 0.9em;
          color: var(--text-secondary);
          white-space: break-spaces;
          overflow-wrap: anywhere;
          word-break: break-word;
        }

        .log-markdown pre {
          margin: 10px 0;
          padding: 12px 14px;
          background: var(--shadow-md);
          border: 1px solid rgba(255, 255, 255, 0.06);
          border-radius: 8px;
          overflow: auto;
          font-family: "SF Mono", "Consolas", "Liberation Mono", monospace;
          font-size: 13px;
          line-height: 1.5;
          color: var(--text-secondary);
        }

        .log-markdown pre code {
          background: transparent;
          padding: 0;
          color: inherit;
          white-space: pre;
          overflow-wrap: normal;
          word-break: normal;
        }

        .log-markdown ul,
        .log-markdown ol {
          margin: 8px 0;
          padding-left: 22px;
        }

        .log-markdown li {
          margin: 0;
        }

        .log-markdown li + li {
          margin-top: 4px;
        }

        .log-markdown li > p {
          margin: 0;
        }

        .log-markdown hr {
          margin: 12px 0;
          border: 0;
          border-top: 1px solid rgba(255, 255, 255, 0.08);
        }

        .log-markdown h1,
        .log-markdown h2,
        .log-markdown h3,
        .log-markdown h4 {
          color: var(--text-primary);
          margin: 16px 0 8px;
          line-height: 1.3;
        }

        .log-markdown h1 { font-size: 1.25em; }
        .log-markdown h2 { font-size: 1.15em; }
        .log-markdown h3 { font-size: 1.05em; }
        .log-markdown h4 { font-size: 1em; }

        .log-markdown h1:first-child,
        .log-markdown h2:first-child,
        .log-markdown h3:first-child,
        .log-markdown h4:first-child {
          margin-top: 0;
        }

        .log-markdown blockquote {
          margin: 8px 0;
          padding: 4px 12px;
          border-left: 2px solid rgba(255, 255, 255, 0.15);
          color: var(--text-tertiary);
        }

        .log-markdown table {
          width: 100%;
          display: block;
          overflow-x: auto;
          -webkit-overflow-scrolling: touch;
          border-collapse: collapse;
          margin: 10px 0;
          font-size: 13px;
        }

        .log-markdown th,
        .log-markdown td {
          border: 1px solid var(--border-default);
          padding: 8px 12px;
          text-align: left;
        }

        .log-markdown th {
          background: rgba(255, 255, 255, 0.04);
          color: var(--text-primary);
          font-weight: 600;
        }

        .log-markdown tbody tr:nth-child(even) {
          background: rgba(255, 255, 255, 0.02);
        }

        /* ── Pending / spinner ── */

        .log-line.pending {
          opacity: 0.9;
          align-items: center;
          background: transparent;
          padding: 8px 12px;
        }

        .log-spinner {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          height: 12px;
          padding: 0 4px;
        }

        .log-spinner span {
          width: 4px;
          height: 4px;
          border-radius: 999px;
          background: rgba(45, 212, 191, 0.8);
          animation: chat-pulse 1s ease-in-out infinite;
        }

        .log-spinner span:nth-child(2) { animation-delay: 0.15s; }
        .log-spinner span:nth-child(3) { animation-delay: 0.3s; }

        @keyframes chat-pulse {
          0%, 100% { transform: translateY(0); opacity: 0.3; }
          50% { transform: translateY(-3px); opacity: 1; }
        }

        /* ── Input area ── */

        .chat-input {
          display: flex;
          flex-direction: column;
          gap: 10px;
          padding: 12px 16px 16px;
          border-top: 1px solid var(--border-default);
          background: var(--bg-base);
          position: sticky;
          bottom: 0;
          z-index: 2;
          min-width: 0;
        }

        .chat-controls {
          display: flex;
          gap: 8px;
          align-items: flex-end;
          width: 100%;
          min-width: 0;
        }

        .context-usage {
          align-self: flex-end;
          color: var(--text-muted);
          font-size: 11px;
        }

        .context-usage.unavailable {
          opacity: 0.9;
        }

        .context-warning {
          margin-top: 6px;
          padding: 8px 10px;
          border: 1px solid color-mix(in srgb, #ef4444 35%, transparent);
          border-radius: 10px;
          background: color-mix(in srgb, #ef4444 10%, transparent);
          color: #fca5a5;
          font-size: 12px;
          line-height: 1.4;
        }

        .chat-file-input {
          display: none;
        }

        .attach-btn {
          width: 36px;
          height: 36px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border-radius: 8px;
          border: 1px solid var(--border-default);
          background: transparent;
          color: var(--text-tertiary);
          cursor: pointer;
        }

        .attach-btn svg {
          width: 18px;
          height: 18px;
        }

        .attach-btn:hover { background: rgba(255, 255, 255, 0.04); color: var(--text-secondary); }

        .attach-btn:disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }

        .chat-input textarea {
          flex: 1;
          min-width: 0;
          background: rgba(255, 255, 255, 0.03);
          border: 1px solid var(--border-default);
          border-radius: 8px;
          padding: 12px 14px;
          color: var(--text-primary);
          font-size: 13px;
          font-family: inherit;
          outline: none;
          resize: none;
          min-height: 44px;
          line-height: 20px;
        }

        .chat-input textarea:focus {
          border-color: var(--bg-raised);
          background: rgba(255, 255, 255, 0.04);
        }

        .chat-input textarea:disabled {
          opacity: 0.4;
        }

        .chat-input .send-btn {
          background: #3b82f6;
          border: none;
          border-radius: 8px;
          padding: 10px 16px;
          color: #fff;
          font-size: 13px;
          font-weight: 500;
          cursor: pointer;
          flex: 0 0 auto;
        }

        .chat-input .send-btn:hover { background: #2563eb; }

        .chat-input .send-btn:disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }

        .chat-input .stop-btn {
          background: #e53935;
          color: #fff;
          border: none;
          border-radius: 8px;
          padding: 10px 16px;
          cursor: pointer;
          font-size: 13px;
          font-weight: 500;
          flex: 0 0 auto;
          display: inline-flex;
          align-items: center;
          gap: 8px;
        }

        .chat-input .stop-btn:hover { background: #c62828; }

        .chat-input .stop-btn.stopping {
          opacity: 0.75;
          cursor: wait;
        }

        .chat-input .stop-btn.stopping::before {
          content: "";
          width: 12px;
          height: 12px;
          border: 2px solid rgba(255, 255, 255, 0.8);
          border-top-color: transparent;
          border-radius: 999px;
          animation: stop-btn-spin 0.8s linear infinite;
        }

        @keyframes stop-btn-spin {
          to { transform: rotate(360deg); }
        }

        /* ── Attachments ── */

        .chat-attachments {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          padding: 8px 16px 0;
        }

        .attachment-pill {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 6px 10px;
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.04);
          border: 1px solid var(--border-default);
          max-width: 180px;
        }

        .attachment-name {
          font-size: 12px;
          color: var(--text-secondary);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .attachment-remove {
          border: none;
          background: none;
          color: var(--text-muted);
          cursor: pointer;
          font-size: 12px;
          padding: 0;
        }

        .attachment-remove:hover { color: #f5b0b0; }

        /* ── Fullscreen overrides ── */

        .agent-chat.fullscreen .chat-header h3 {
          font-size: 16px;
          font-weight: 700;
        }

        .agent-chat.fullscreen .chat-input {
          padding-bottom: 20px;
        }

        .agent-chat.zen .chat-header {
          padding: 12px 16px;
        }

        .agent-chat.zen .chat-header .back-btn,
        .agent-chat.zen .chat-header .open-project-btn,
        .agent-chat.zen .chat-header .archive-btn,
        .agent-chat.zen .chat-header .kill-btn {
          display: none;
        }

        .log-empty {
          color: var(--text-muted);
          font-size: 13px;
          padding: 4px 0;
        }

        /* ── Subagent Run Cards ── */

        .subagent-run-card {
          background: var(--subagent-bg);
          border-left: 3px solid var(--subagent-border);
          border-radius: 0 8px 8px 0;
          margin: 4px 0;
        }

        .subagent-run-card .subagent-run-content {
          display: none;
        }

        .subagent-run-card.open .subagent-run-content {
          display: flex;
        }

        .subagent-run-header {
          width: 100%;
          border: none;
          background: none;
          color: inherit;
          text-align: left;
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 10px 12px;
          cursor: pointer;
          user-select: none;
        }

        .subagent-fork-icon {
          color: var(--subagent-text);
          font-size: 16px;
          flex-shrink: 0;
        }

        .subagent-run-info {
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 2px;
        }

        .subagent-run-title {
          font-weight: 600;
          font-size: 12px;
          color: var(--subagent-text);
        }

        .subagent-run-desc {
          font-size: 12px;
          color: var(--text-muted);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .subagent-run-badge {
          font-size: 11px;
          color: var(--text-muted);
          background: rgba(124, 58, 237, 0.1);
          padding: 2px 8px;
          border-radius: 999px;
          flex-shrink: 0;
        }

        .subagent-run-chevron {
          color: var(--text-muted);
          font-size: 10px;
          flex-shrink: 0;
        }

        .subagent-run-content {
          padding: 4px 12px 12px 24px;
          display: flex;
          flex-direction: column;
          gap: 2px;
        }

        .subagent-run-content .log-line {
          font-size: 13px;
        }

        .subagent-run-content .log-line + .log-line {
          border-top: 1px solid rgba(124, 58, 237, 0.08);
        }

        /* ── Subagent Filter Toggle ── */

        .subagent-filter-bar {
          display: flex;
          justify-content: flex-end;
          padding: 0 0 8px;
        }

        .subagent-filter-toggle {
          background: var(--bg-overlay);
          border: 1px solid var(--border-subtle);
          color: var(--text-secondary);
          border-radius: 999px;
          padding: 4px 12px;
          font-size: 11px;
          cursor: pointer;
          transition: background 0.15s, color 0.15s;
        }

        .subagent-filter-toggle:hover {
          background: rgba(124, 58, 237, 0.08);
        }

        .subagent-filter-toggle.active {
          background: rgba(124, 58, 237, 0.15);
          border-color: var(--subagent-border);
          color: var(--subagent-text);
        }
      `}</style>
    </div>
  );
}
