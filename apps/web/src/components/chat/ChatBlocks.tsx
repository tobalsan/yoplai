import { createSignal, createEffect, createMemo, For, Index, onCleanup, Show, on, untrack, Switch, Match } from "solid-js";
import { toolLabel } from "@yoplai/shared/tool-labels";
import { toolLabelTemplates } from "../../lib/tool-labels";
import type { FullToolResultMessage, ContentBlock, FileBlock, ModelMeta, ActiveToolCall } from "../../api/types";
import type { CompactStatus } from "./createChatSession";
import { formatTimestamp } from "../../lib/format";
import { extractBlockText } from "../../lib/history";
import { renderMarkdown } from "../../lib/markdown";
import { formatFileSize } from "../../lib/attachments";
import { groupActivityItems, lastFiveWords } from "../../lib/chat-activity";

export function CompactionSummary(props: { text: string; timestamp: number }) {
  return (
    <div class="message compaction-summary">
      <details>
        <summary>Compaction summary</summary>
        <div class="content compaction-summary-text">{props.text}</div>
      </details>
      <div class="message-time">{formatTimestamp(props.timestamp)}</div>
    </div>
  );
}


export function CompactStatusView(props: { status: CompactStatus | undefined }) {
  return (
    <Show when={props.status}>
      {(status) => (
        <div class={`message compact-status ${status().state}`}>
          <div class="content">{status().text}</div>
        </div>
      )}
    </Show>
  );
}

function getFileIcon(mimeType: string): string {
  if (mimeType.startsWith("image/")) return "IMG";
  if (mimeType === "application/pdf") return "PDF";
  if (mimeType.includes("word")) return "DOC";
  if (mimeType.includes("excel") || mimeType.includes("spreadsheet"))
    return "XLS";
  if (mimeType === "text/csv") return "CSV";
  if (mimeType === "text/markdown") return "MD";
  return "FILE";
}

function formatJson(args: unknown): string {
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

function getToolResultText(result?: FullToolResultMessage): string {
  return (result?.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => extractBlockText((b as { text: unknown }).text))
    .join("\n");
}

function getToolInputSummary(toolName: string, args: unknown): string {
  if (args && typeof args === "object") {
    const record = args as Record<string, unknown>;
    if (typeof record.command === "string") return record.command;
    if (typeof record.path === "string") {
      return record.path.split("/").filter(Boolean).at(-1) ?? record.path;
    }
    if (typeof record.pattern === "string") return record.pattern;
    if (typeof record.query === "string") return record.query;
  }
  return toolName;
}

function truncateInline(value: string, max = 96): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length > max
    ? `${singleLine.slice(0, Math.max(0, max - 1))}…`
    : singleLine;
}

function ToolLabelText(props: { label: string }) {
  const parts = () => props.label.split("`");
  return (
    <>
      <For each={parts()}>
        {(part, i) =>
          i() % 2 === 1 && i() < parts().length - 1 ? (
            <code class="tool-label-code">{part}</code>
          ) : (
            <>{i() % 2 === 1 ? `\`${part}` : part}</>
          )
        }
      </For>
    </>
  );
}

function ToolBlock(props: {
  name: string;
  arguments: unknown;
  result?: FullToolResultMessage;
  status?: "running" | "done" | "error";
}) {
  const argsText = () => formatJson(props.arguments);
  const resultText = () => getToolResultText(props.result);
  const failed = () => props.status === "error" || props.result?.isError;
  const summary = () =>
    truncateInline(toolLabel(props.name, props.arguments, toolLabelTemplates()));
  const [collapsed, setCollapsed] = createSignal(true);

  return (
    <div class={`tool-block ${failed() ? "error" : ""}`}>
      <button class="tool-header" onClick={() => setCollapsed(!collapsed())}>
        <i
          class="fa-solid fa-chevron-right collapse-icon"
          classList={{ expanded: !collapsed() }}
          aria-hidden="true"
        />
        <span class="tool-title" title={props.name}>
          <ToolLabelText label={summary()} />
        </span>
      </button>
      <Show when={!collapsed()}>
        <div class="tool-body">
          <Show
            when={props.name === "bash"}
            fallback={
              <>
                <div class="tool-section-label">Input</div>
                <pre class="tool-code">{argsText()}</pre>
                <Show when={props.result}>
                  <div class="tool-section-label">Output</div>
                  <pre class="tool-code">{resultText() || "(no output)"}</pre>
                </Show>
              </>
            }
          >
            <div class="tool-section-label">Shell</div>
            <pre class="tool-code tool-terminal">
              {`$ ${getToolInputSummary(props.name, props.arguments)}${
                props.result ? `\n\n${resultText() || "(no output)"}` : ""
              }`}
            </pre>
          </Show>
          <Show when={props.result?.details?.diff}>
            <div class="tool-section-label">Diff</div>
            <pre class="tool-code">{props.result!.details!.diff}</pre>
          </Show>
        </div>
      </Show>
    </div>
  );
}

function SimpleToolBlock(props: { name: string; arguments?: unknown }) {
  return (
    <div class="activity-line" title={props.name}>
      <ToolLabelText
        label={toolLabel(props.name, props.arguments, toolLabelTemplates())}
      />
    </div>
  );
}

function ToolRunSection(props: {
  tools: Extract<ActivityItem, { type: "tool" }>[];
  simple?: boolean;
  running: boolean;
}) {
  const [expanded, setExpanded] = createSignal(false);
  const label = () => {
    const bash = props.tools.filter((t) => t.name === "bash").length;
    const kind =
      bash === props.tools.length ? "bash" : bash === 0 ? "tools" : "mixed";
    if (props.running) {
      return kind === "bash"
        ? "Running commands"
        : kind === "tools"
          ? "Calling tools"
          : "Running commands, calling tools";
    }
    return kind === "bash"
      ? "Ran commands"
      : kind === "tools"
        ? "Called tools"
        : "Ran commands, called tools";
  };
  return (
    <div class="activity-item">
      <button class="activity-line" onClick={() => setExpanded(!expanded())}>
        <i
          class="fa-solid fa-chevron-right collapse-icon"
          classList={{ expanded: expanded() }}
          aria-hidden="true"
        />
        {label()}
      </button>
      <Show when={expanded()}>
        <div class="activity-tool-run">
          <Index each={props.tools.filter((tool) => !tool.parentToolCallId)}>
            {(tool) => {
              const children = () => props.tools.filter(
                (child) => child.parentToolCallId === tool().id && tool().id
              );
              return (
                <div class="tool-call-group">
                  {props.simple ? (
                    <SimpleToolBlock name={tool().name} arguments={tool().arguments} />
                  ) : (
                    <ToolBlock
                      name={tool().name}
                      arguments={tool().arguments}
                      result={tool().result}
                      status={tool().status}
                    />
                  )}
                  <Show when={children().length}>
                    <details class="nested-tool-calls">
                      <summary>{children().length} nested tool call{children().length === 1 ? "" : "s"}</summary>
                      <Index each={children()}>
                        {(child) => (
                          <ToolBlock
                            name={child().name}
                            arguments={child().arguments}
                            result={child().result}
                            status={child().status}
                          />
                        )}
                      </Index>
                    </details>
                  </Show>
                </div>
              );
            }}
          </Index>
        </div>
      </Show>
    </div>
  );
}

export type ActivityItem =
  | {
      type: "thinking";
      content: string;
      startedAt?: number;
      endedAt?: number;
      active?: boolean;
    }
  | {
      type: "tool";
      id?: string;
      parentToolCallId?: string;
      name: string;
      arguments?: unknown;
      result?: FullToolResultMessage;
      status?: "running" | "done" | "error";
      /** When the tool was called (epoch ms). */
      at?: number;
    };

export function ThinkingLine(
  props: Extract<ActivityItem, { type: "thinking" }>
) {
  const [expanded, setExpanded] = createSignal(false);
  const [ticker, setTicker] = createSignal(lastFiveWords(props.content));
  // Memo dedupes: props.active is re-read on every token, but the timer must
  // only restart when the boolean actually flips.
  const active = createMemo(() => Boolean(props.active));
  createEffect(
    on(active, (active) => {
      if (!active) return;
      setTicker(lastFiveWords(untrack(() => props.content)));
      const timer = window.setInterval(
        () => setTicker(lastFiveWords(props.content)),
        5000
      );
      onCleanup(() => window.clearInterval(timer));
    })
  );
  const duration = () =>
    props.startedAt && props.endedAt
      ? Math.max(0, Math.round((props.endedAt - props.startedAt) / 1000))
      : undefined;
  const label = () =>
    props.active
      ? ticker() || "Thinking"
      : duration() !== undefined
        ? `Thought for ${duration()}s`
        : "Thought";
  return (
    <div class="activity-item">
      <button class="activity-line" onClick={() => setExpanded(!expanded())}>
        <i
          class="fa-solid fa-chevron-right collapse-icon"
          classList={{ expanded: expanded() }}
          aria-hidden="true"
        />
        {label()}
      </button>
      <Show when={expanded()}>
        <div class="activity-thinking-content">{props.content}</div>
      </Show>
    </div>
  );
}

export function ActivityGroup(props: {
  items: ActivityItem[];
  simple?: boolean;
  streaming?: boolean;
  /** Agent is still producing activity in this group. */
  working?: boolean;
}) {
  const [expanded, setExpanded] = createSignal(Boolean(props.streaming));
  createEffect(() => {
    if (props.streaming) setExpanded(true);
    else setExpanded(false);
  });
  const segments = createMemo(
    () => {
      const out: (
        | { kind: "thinking"; index: number }
        | { kind: "tools"; start: number; end: number }
      )[] = [];
      props.items.forEach((item, index) => {
        if (item.type === "thinking") {
          out.push({ kind: "thinking", index });
          return;
        }
        const last = out[out.length - 1];
        if (last?.kind === "tools" && last.end === index) last.end = index + 1;
        else out.push({ kind: "tools", start: index, end: index + 1 });
      });
      return out;
    }
  );
  const summary = () => {
    const tools = props.items.filter((item) => item.type === "tool").length;
    // Wall-clock span from first to last known activity timestamp.
    const starts: number[] = [];
    const ends: number[] = [];
    for (const item of props.items) {
      if (item.type === "thinking") {
        if (item.startedAt) starts.push(item.startedAt);
        if (item.endedAt) ends.push(item.endedAt);
      } else {
        if (item.at) {
          starts.push(item.at);
          ends.push(item.at);
        }
        if (item.result?.timestamp) ends.push(item.result.timestamp);
      }
    }
    const span =
      starts.length && ends.length
        ? Math.max(...ends) - Math.min(...starts)
        : 0;
    const label = props.working
      ? "Working"
      : span > 0
        ? `Worked for ${Math.round(span / 1000)}s`
        : "Worked";
    return tools
      ? `${label} · ${tools} tool call${tools === 1 ? "" : "s"}`
      : label;
  };
  return (
    <div class="activity-group">
      <button
        class="activity-group-header"
        onClick={() => setExpanded(!expanded())}
      >
        <i
          class="fa-solid fa-chevron-right collapse-icon"
          classList={{ expanded: expanded() }}
          aria-hidden="true"
        />
        {summary()}
      </button>
      <Show when={expanded()}>
        <div class="activity-group-items">
          <Index each={segments()}>
            {(segment) => {
              const thinking = () => {
                const seg = segment();
                return (seg.kind === "thinking"
                  ? props.items[seg.index]
                  : undefined) as
                  | Extract<ActivityItem, { type: "thinking" }>
                  | undefined;
              };
              const tools = () => {
                const seg = segment();
                return seg.kind === "tools"
                  ? (props.items.slice(seg.start, seg.end) as Extract<
                      ActivityItem,
                      { type: "tool" }
                    >[])
                  : [];
              };
              return (
                <Switch>
                  <Match when={segment().kind === "thinking" && thinking()}>
                    <ThinkingLine
                      type="thinking"
                      content={thinking()!.content}
                      startedAt={thinking()!.startedAt}
                      endedAt={thinking()!.endedAt}
                      active={thinking()!.active}
                    />
                  </Match>
                  <Match when={segment().kind === "tools"}>
                    <ToolRunSection
                      tools={tools()}
                      simple={props.simple}
                      running={
                        Boolean(props.working) &&
                        segment().kind === "tools" &&
                        (segment() as { end: number }).end ===
                          props.items.length
                      }
                    />
                  </Match>
                </Switch>
              );
            }}
          </Index>
        </div>
      </Show>
    </div>
  );
}


// Render content blocks for full mode
export function ContentBlocks(props: {
  blocks: ContentBlock[];
  timestamp?: number;
  toolResultsMap?: Map<string, FullToolResultMessage>;
}) {
  const segments = () =>
    groupActivityItems(
      props.blocks,
      (block) => block.type === "thinking" || block.type === "toolCall"
    );
  return (
    <div class="content-blocks">
      <For each={segments()}>
        {(segment) => {
          if (segment.kind === "activity") {
            return (
              <ActivityGroup
                items={segment.items.map((block) =>
                  block.type === "thinking"
                    ? { type: "thinking" as const, content: block.thinking }
                    : (() => {
                        const tool = block as Extract<
                          ContentBlock,
                          { type: "toolCall" }
                        >;
                        return {
                          type: "tool" as const,
                          id: tool.id,
                          parentToolCallId: tool.parentToolCallId,
                          name: tool.name,
                          arguments: tool.arguments,
                          result: props.toolResultsMap?.get(tool.id),
                        };
                      })()
                )}
              />
            );
          }
          const block = segment.item;
          if (block.type === "text")
            return (
              <AssistantText class="block-text markdown-content" text={block.text} />
            );
          if (block.type === "file") return <FileCard file={block} />;
          return null;
        }}
      </For>
    </div>
  );
}

export function FileAttachmentList(props: { files?: FileBlock[] }) {
  return (
    <Show when={props.files && props.files.length > 0}>
      <div class="message-files">
        <For each={props.files ?? []}>
          {(file) => (
            <div class="message-file-pill">
              <span class="file-icon">{getFileIcon(file.mimeType)}</span>
              <span class="file-name" title={file.filename}>
                {file.filename}
              </span>
              <Show when={formatFileSize(file.size)}>
                {(size) => <span class="file-size">{size()}</span>}
              </Show>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}

export function FileCard(props: { file: FileBlock }) {
  const href = () => `/api/media/download/${props.file.fileId}`;
  return (
    <div class={`file-card ${props.file.direction}`}>
      <span class="file-icon">{getFileIcon(props.file.mimeType)}</span>
      <div class="file-card-body">
        <div class="file-card-name" title={props.file.filename}>
          {props.file.filename}
        </div>
        <div class="file-card-meta">
          {[props.file.mimeType, formatFileSize(props.file.size)]
            .filter(Boolean)
            .join(" · ")}
        </div>
      </div>
      <Show when={props.file.direction === "outbound"}>
        <a class="file-download" href={href()} download="">
          Download
        </a>
      </Show>
    </div>
  );
}

// Model meta display
export function ModelMetaDisplay(props: { meta: ModelMeta }) {
  const usage = props.meta.usage;
  const cacheTokens =
    usage &&
    (typeof usage.cacheRead === "number" ? usage.cacheRead : 0) +
      (typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0);
  return (
    <div class="model-meta">
      <span class="meta-model">{props.meta.model ?? "unknown"}</span>
      {usage && (
        <span class="meta-tokens">
          {usage.input}
          {cacheTokens ? `+${cacheTokens} cache` : ""}→{usage.output} tok
        </span>
      )}
    </div>
  );
}

// Active tool indicator during streaming
export function ActiveToolIndicator(props: { tools: ActiveToolCall[] }) {
  return (
    <div class="active-tools">
      <For each={props.tools}>
        {(tool) => (
          <div class={`active-tool ${tool.status}`}>
            <span class="tool-icon">
              {tool.status === "running"
                ? "⟳"
                : tool.status === "error"
                  ? "✗"
                  : "✓"}
            </span>
            <span class="tool-name">{tool.toolName}</span>
          </div>
        )}
      </For>
    </div>
  );
}


export function AssistantText(props: { text: string; class: string; options?: Parameters<typeof renderMarkdown>[1] }) {
  return <div class={props.class} innerHTML={renderMarkdown(props.text, props.options)} />;
}
