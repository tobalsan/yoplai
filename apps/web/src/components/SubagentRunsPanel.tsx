import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import type { SubagentRun } from "@yoplai/shared/types";
import type { SubagentRunStatus } from "@yoplai/shared/types";
import {
  archiveRuntimeSubagent,
  deleteRuntimeSubagent,
  fetchRuntimeSubagentLogs,
  fetchRuntimeSubagents,
  interruptRuntimeSubagent,
  subscribeToFileChanges,
  subscribeToSubagentChanges,
} from "../api";
import type { SubagentLogEvent } from "../api/types";
import { renderMarkdown } from "../lib/markdown";

function formatRuntime(startedAt: string) {
  const elapsed = Date.now() - Date.parse(startedAt);
  if (!Number.isFinite(elapsed) || elapsed < 0) return "now";
  const minutes = Math.floor(elapsed / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function parentKey(parent: SubagentRun["parent"]) {
  return parent ? `${parent.type}:${parent.id}` : "";
}

type MonitorLogState = {
  cursor: number;
  events: SubagentLogEvent[];
  loading: boolean;
  error?: string;
};

type MonitorHistoryItem = {
  tone: "user" | "assistant" | "tool" | "system" | "error";
  title?: string;
  body: string;
  meta?: string;
  bodyFormat?: "markdown" | "mono";
};

function parseJsonRecord(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function getRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function titleFromType(type: string) {
  return type.replace(/[._-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function toMonitorHistoryItem(
  event: SubagentLogEvent
): MonitorHistoryItem | null {
  const text = (
    event.text ??
    event.diff?.summary ??
    event.tool?.name ??
    ""
  ).trim();
  if (!text) return null;

  if (event.type === "stderr" || event.type === "error") {
    return { tone: "error", title: "Error", body: text, bodyFormat: "mono" };
  }

  if (event.type === "tool_call" || event.type === "tool_output") {
    return {
      tone: "tool",
      title: event.type === "tool_call" ? "Tool call" : "Tool output",
      meta: [event.tool?.name, event.tool?.id].filter(Boolean).join(" · "),
      body: text,
      bodyFormat: "mono",
    };
  }

  const parsed = parseJsonRecord(text);
  if (!parsed) {
    return {
      tone: event.type === "user" ? "user" : "assistant",
      body: text,
    };
  }

  const payload = getRecord(parsed.payload);
  if (parsed.type === "event_msg" && payload?.type === "user_message") {
    const message = typeof payload.message === "string" ? payload.message : "";
    return message ? { tone: "user", body: message } : null;
  }

  const item = getRecord(parsed.item);
  if (item?.type === "command_execution") {
    const command = typeof item.command === "string" ? item.command : "";
    const output =
      typeof item.aggregated_output === "string"
        ? item.aggregated_output.trim()
        : "";
    const status = typeof item.status === "string" ? item.status : "";
    const exitNumber =
      typeof item.exit_code === "number" ? item.exit_code : undefined;
    const exitCode = exitNumber !== undefined ? `exit ${exitNumber}` : status;
    return {
      tone:
        status === "completed" && exitNumber !== undefined && exitNumber !== 0
          ? "error"
          : "tool",
      title: status === "in_progress" ? "Running command" : "Command finished",
      meta: [command, exitCode].filter(Boolean).join(" · "),
      body:
        output || command || titleFromType(String(parsed.type ?? event.type)),
      bodyFormat: "mono",
    };
  }

  if (parsed.type === "thread.started") {
    const threadId =
      typeof parsed.thread_id === "string" ? parsed.thread_id : "";
    return {
      tone: "system",
      title: "Thread started",
      body: threadId || "Subagent session initialized.",
    };
  }

  if (parsed.type === "turn.started") {
    return {
      tone: "system",
      title: "Turn started",
      body: "Processing prompt.",
    };
  }

  if (parsed.type === "turn.completed") {
    return {
      tone: "system",
      title: "Turn completed",
      body: "Subagent turn finished.",
    };
  }

  const parsedType =
    typeof parsed.type === "string" ? parsed.type : String(event.type);
  return {
    tone: "system",
    title: titleFromType(parsedType),
    body: "Runtime event received.",
  };
}

function toMonitorHistory(events: SubagentLogEvent[]) {
  return events
    .map(toMonitorHistoryItem)
    .filter((item): item is MonitorHistoryItem => item !== null);
}

function MonitorHistoryBody(props: { item: MonitorHistoryItem }) {
  if (props.item.bodyFormat === "mono") {
    return <pre class="canvas-monitor-history-mono">{props.item.body}</pre>;
  }
  return (
    <div
      class="canvas-monitor-history-markdown"
      innerHTML={renderMarkdown(props.item.body, { breaks: true })}
    />
  );
}

export function SubagentRunsPanel(props: {
  cwd?: string;
  parent?: string;
  projectId?: string;
  sliceId?: string;
  includeArchived?: boolean;
  mode?: "cwd" | "unassigned";
  excludeCwds?: string[];
  status?: SubagentRunStatus;
  rawLogHref?: (run: SubagentRun) => string | undefined;
  filter?: (run: SubagentRun) => boolean;
}) {
  const [runs, setRuns] = createSignal<SubagentRun[]>([]);
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [expandedRunIds, setExpandedRunIds] = createSignal<Set<string>>(
    new Set()
  );
  const [logsByRunId, setLogsByRunId] = createSignal<
    Record<string, MonitorLogState>
  >({});
  const scrollRefs = new Map<string, HTMLDivElement>();
  const scrollPositions = new Map<string, number>();

  async function loadRuns() {
    const filters = {
      cwd: props.cwd,
      parent: props.parent,
      projectId: props.projectId,
      sliceId: props.sliceId,
      status: props.status,
      includeArchived: props.includeArchived,
    };
    const mode = props.mode;
    const excludeCwds = new Set(props.excludeCwds ?? []);
    setLoading(true);
    try {
      const data = await fetchRuntimeSubagents(filters);
      const items =
        mode === "unassigned"
          ? data.items.filter(
              (run) =>
                (run.status === "running" || run.status === "starting") &&
                (!run.cwd || !excludeCwds.has(run.cwd))
            )
          : data.items;
      setRuns(props.filter ? items.filter(props.filter) : items);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function refreshMonitor() {
    await loadRuns();
    await Promise.all(
      [...expandedRunIds()].map((runId) => loadRunLogs(runId, false))
    );
  }

  function rememberRunScroll(runId: string) {
    const element = scrollRefs.get(runId);
    if (element) scrollPositions.set(runId, element.scrollTop);
  }

  function restoreRunScroll(runId: string) {
    requestAnimationFrame(() => {
      const element = scrollRefs.get(runId);
      if (!element) return;
      element.scrollTop = scrollPositions.get(runId) ?? element.scrollHeight;
    });
  }

  async function loadRunLogs(runId: string, append = false) {
    const current = logsByRunId()[runId];
    setLogsByRunId((prev) => ({
      ...prev,
      [runId]: {
        cursor: current?.cursor ?? 0,
        events: current?.events ?? [],
        loading: true,
      },
    }));
    try {
      const data = await fetchRuntimeSubagentLogs(
        runId,
        append ? (current?.cursor ?? 0) : 0
      );
      setLogsByRunId((prev) => ({
        ...prev,
        [runId]: {
          cursor: data.cursor,
          events: append
            ? [...(prev[runId]?.events ?? []), ...data.events]
            : data.events,
          loading: false,
        },
      }));
      if (!append) restoreRunScroll(runId);
    } catch (err) {
      setLogsByRunId((prev) => ({
        ...prev,
        [runId]: {
          cursor: current?.cursor ?? 0,
          events: current?.events ?? [],
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        },
      }));
    }
  }

  function toggleRun(runId: string) {
    let shouldLoad = false;
    setExpandedRunIds((current) => {
      const next = new Set(current);
      if (next.has(runId)) {
        rememberRunScroll(runId);
        next.delete(runId);
      } else {
        next.add(runId);
        shouldLoad = true;
      }
      return next;
    });
    if (shouldLoad) void loadRunLogs(runId);
  }

  function forgetRun(runId: string) {
    scrollRefs.delete(runId);
    scrollPositions.delete(runId);
    setExpandedRunIds((current) => {
      const next = new Set(current);
      next.delete(runId);
      return next;
    });
    setLogsByRunId((current) => {
      const next = { ...current };
      delete next[runId];
      return next;
    });
  }

  async function interruptRun(runId: string) {
    const result = await interruptRuntimeSubagent(runId);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    await loadRuns();
  }

  async function archiveRun(runId: string) {
    const result = await archiveRuntimeSubagent(runId);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    forgetRun(runId);
    await loadRuns();
  }

  async function deleteRun(run: SubagentRun) {
    if (
      !window.confirm(
        `Kill subagent run ${run.label}? This removes its runtime data.`
      )
    ) {
      return;
    }
    const result = await deleteRuntimeSubagent(run.id);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    forgetRun(run.id);
    await loadRuns();
  }

  createEffect(() => {
    void loadRuns();
  });

  const unsubscribe = subscribeToSubagentChanges({
    onSubagentChanged: (event) => {
      void loadRuns();
      if (expandedRunIds().has(event.runId)) {
        void loadRunLogs(event.runId, true);
      }
    },
    onError: setError,
  });
  onCleanup(unsubscribe);

  const unsubscribeProjectChanges = props.projectId
    ? subscribeToFileChanges({
        onAgentChanged: (projectId) => {
          if (projectId !== props.projectId) return;
          void loadRuns();
          for (const runId of expandedRunIds()) {
            void loadRunLogs(runId, true);
          }
        },
        onError: setError,
      })
    : undefined;
  onCleanup(() => unsubscribeProjectChanges?.());

  const runningCount = () =>
    runs().filter((run) => run.status === "running").length;
  const runningLabel = () => {
    const n = runningCount();
    if (n === 0) return "No agent running";
    if (n === 1) return "One agent running";
    return `${n} agents running`;
  };

  return (
    <div class="canvas-monitor">
      <header class="canvas-monitor-header">
        <p>{runningLabel()}</p>
        <button
          class="canvas-monitor-refresh"
          onClick={refreshMonitor}
          type="button"
        >
          Refresh
        </button>
      </header>
      <Show when={error()}>
        {(message) => <div class="canvas-monitor-error">{message()}</div>}
      </Show>
      <Show
        when={runs().length > 0}
        fallback={
          <Show when={loading()}>
            <p class="canvas-monitor-empty">Loading subagents...</p>
          </Show>
        }
      >
        <div class="canvas-monitor-list">
          <For each={runs()}>
            {(run) => (
              <article class="canvas-monitor-run">
                <div class="canvas-monitor-run-head">
                  <button
                    aria-expanded={expandedRunIds().has(run.id)}
                    class="canvas-monitor-run-toggle"
                    onClick={() => toggleRun(run.id)}
                    type="button"
                  >
                    <div class="canvas-monitor-run-main">
                      <div class="canvas-monitor-run-title">
                        <span class={`canvas-monitor-dot ${run.status}`} />
                        <strong>{run.label}</strong>
                        <span>{run.cli}</span>
                      </div>
                      <div class="canvas-monitor-run-meta">
                        <span>{run.status}</span>
                        <span>{formatRuntime(run.startedAt)}</span>
                        <Show when={run.parent}>
                          {(parent) => <span>{parentKey(parent())}</span>}
                        </Show>
                      </div>
                      <Show when={run.latestOutput}>
                        {(latest) => (
                          <p class="canvas-monitor-output">{latest()}</p>
                        )}
                      </Show>
                    </div>
                  </button>
                  <div class="canvas-monitor-run-actions">
                    <Show when={run.status === "running"}>
                      <button
                        aria-label={`Stop ${run.label}`}
                        class="canvas-monitor-icon-action"
                        onClick={(event) => {
                          event.stopPropagation();
                          void interruptRun(run.id);
                        }}
                        title="Stop"
                        type="button"
                      >
                        <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
                          <rect x="7" y="7" width="10" height="10" rx="1" />
                        </svg>
                      </button>
                    </Show>
                    <button
                      aria-label={`Archive ${run.label}`}
                      class="canvas-monitor-icon-action"
                      onClick={(event) => {
                        event.stopPropagation();
                        void archiveRun(run.id);
                      }}
                      title="Archive"
                      type="button"
                    >
                      <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
                        <path d="M3 7h18v13H3z" />
                        <path d="M7 7V4h10v3" />
                        <path d="M7 12h10" />
                      </svg>
                    </button>
                    <Show when={props.rawLogHref?.(run)}>
                      {(href) => (
                        <a
                          aria-label={`View raw JSON logs for ${run.label}`}
                          class="canvas-monitor-icon-action"
                          href={href()}
                          onClick={(event) => event.stopPropagation()}
                          title="View raw JSON"
                        >
                          <svg
                            aria-hidden="true"
                            fill="none"
                            viewBox="0 0 24 24"
                          >
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                            <path d="M14 2v6h6" />
                            <path d="M10 13l-2 2 2 2" />
                            <path d="M14 13l2 2-2 2" />
                          </svg>
                        </a>
                      )}
                    </Show>
                    <button
                      aria-label={`Kill ${run.label}`}
                      class="canvas-monitor-icon-action danger"
                      onClick={(event) => {
                        event.stopPropagation();
                        void deleteRun(run);
                      }}
                      title="Kill"
                      type="button"
                    >
                      <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
                        <path d="M3 6h18" />
                        <path d="M8 6V4h8v2" />
                        <path d="M6 6l1 15h10l1-15" />
                        <path d="M10 11v6M14 11v6" />
                      </svg>
                    </button>
                  </div>
                </div>
                <Show when={expandedRunIds().has(run.id)}>
                  <div class="canvas-monitor-history">
                    <Show when={logsByRunId()[run.id]?.error}>
                      {(message) => (
                        <div class="canvas-monitor-history-error">
                          {message()}
                        </div>
                      )}
                    </Show>
                    <Show
                      when={(logsByRunId()[run.id]?.events.length ?? 0) > 0}
                      fallback={
                        <p class="canvas-monitor-history-empty">
                          {logsByRunId()[run.id]?.loading
                            ? "Loading history..."
                            : "No history yet."}
                        </p>
                      }
                    >
                      <div
                        class="canvas-monitor-history-scroll"
                        onScroll={(event) => {
                          scrollPositions.set(
                            run.id,
                            event.currentTarget.scrollTop
                          );
                        }}
                        ref={(element) => {
                          scrollRefs.set(run.id, element);
                        }}
                      >
                        <For
                          each={toMonitorHistory(
                            logsByRunId()[run.id]?.events ?? []
                          )}
                        >
                          {(item) => (
                            <div
                              class={`canvas-monitor-history-entry ${item.tone}`}
                            >
                              <Show when={item.title}>
                                {(title) => (
                                  <div class="canvas-monitor-history-title">
                                    {title()}
                                  </div>
                                )}
                              </Show>
                              <Show when={item.meta}>
                                {(meta) => (
                                  <div class="canvas-monitor-history-meta">
                                    {meta()}
                                  </div>
                                )}
                              </Show>
                              <MonitorHistoryBody item={item} />
                            </div>
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>
                </Show>
              </article>
            )}
          </For>
        </div>
      </Show>
      <style>{`
        .canvas-monitor {
          display: flex;
          flex-direction: column;
          gap: 14px;
        }
        .canvas-monitor-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }
        .canvas-monitor h2 {
          margin: 0;
          color: var(--text-primary);
        }
        .canvas-monitor p {
          margin: 0;
          color: var(--text-secondary);
          font-size: 14px;
        }
        .canvas-monitor-refresh {
          border: 1px solid var(--border-default);
          background: var(--surface-secondary);
          color: var(--text-primary);
          border-radius: 6px;
          padding: 7px 10px;
          cursor: pointer;
          font-size: 12px;
        }
        .canvas-monitor-error {
          border: 1px solid rgba(239, 68, 68, 0.35);
          color: #fca5a5;
          border-radius: 6px;
          padding: 8px 10px;
          font-size: 13px;
        }
        .canvas-monitor-list {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .canvas-monitor-run {
          border: 1px solid var(--border-default);
          border-radius: 8px;
          padding: 12px;
          background: var(--surface-secondary);
        }
        .canvas-monitor-run-head {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 12px;
        }
        .canvas-monitor-run-toggle {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 12px;
          min-width: 0;
          flex: 1;
          border: 0;
          padding: 0;
          background: transparent;
          color: inherit;
          text-align: left;
          cursor: pointer;
        }
        .canvas-monitor-run-main {
          min-width: 0;
        }
        .canvas-monitor-run-actions {
          display: flex;
          align-items: center;
          gap: 4px;
          flex: 0 0 auto;
          opacity: 0;
          pointer-events: none;
          transition: opacity 120ms ease;
        }
        .canvas-monitor-run:hover .canvas-monitor-run-actions,
        .canvas-monitor-run:focus-within .canvas-monitor-run-actions {
          opacity: 1;
          pointer-events: auto;
        }
        .canvas-monitor-icon-action {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 24px;
          height: 24px;
          border: 1px solid var(--border-default);
          border-radius: 6px;
          background: rgba(148, 163, 184, 0.08);
          color: var(--text-secondary);
          cursor: pointer;
          padding: 0;
          text-decoration: none;
        }
        .canvas-monitor-icon-action:hover {
          color: var(--text-primary);
          background: rgba(148, 163, 184, 0.16);
        }
        .canvas-monitor-icon-action.danger:hover {
          color: #fca5a5;
          border-color: rgba(239, 68, 68, 0.35);
          background: rgba(239, 68, 68, 0.1);
        }
        .canvas-monitor-icon-action svg {
          width: 13px;
          height: 13px;
          stroke: currentColor;
          stroke-width: 2;
          stroke-linecap: round;
          stroke-linejoin: round;
        }
        .canvas-monitor-run-title,
        .canvas-monitor-run-meta {
          display: flex;
          align-items: center;
          gap: 8px;
          min-width: 0;
        }
        .canvas-monitor-run-title strong {
          color: var(--text-primary);
          font-size: 14px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .canvas-monitor-run-title span,
        .canvas-monitor-run-meta span {
          color: var(--text-secondary);
          font-size: 12px;
        }
        .canvas-monitor-run-meta {
          margin-top: 5px;
          flex-wrap: wrap;
        }
        .canvas-monitor-output {
          margin-top: 8px !important;
          color: var(--text-primary) !important;
          overflow: hidden;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
        }
        .canvas-monitor-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: var(--text-secondary);
          flex: 0 0 auto;
        }
        .canvas-monitor-dot.running,
        .canvas-monitor-dot.starting {
          background: #22c55e;
        }
        .canvas-monitor-dot.error {
          background: #ef4444;
        }
        .canvas-monitor-dot.interrupted {
          background: #f59e0b;
        }
        .canvas-monitor-history {
          margin-top: 10px;
          border-top: 1px solid var(--border-default);
          padding-top: 10px;
        }
        .canvas-monitor-history-scroll {
          display: flex;
          flex-direction: column;
          gap: 10px;
          max-height: 360px;
          overflow: auto;
          padding-right: 4px;
        }
        .canvas-monitor-history-entry {
          width: min(100%, 760px);
          border: 1px solid var(--border-default);
          border-radius: 8px;
          padding: 9px 10px;
          background: var(--surface-primary);
        }
        .canvas-monitor-history-entry.user {
          align-self: flex-end;
          background: rgba(59, 130, 246, 0.12);
          border-color: rgba(59, 130, 246, 0.28);
        }
        .canvas-monitor-history-entry.assistant {
          align-self: flex-start;
        }
        .canvas-monitor-history-entry.tool,
        .canvas-monitor-history-entry.system {
          align-self: stretch;
          width: 100%;
          background: rgba(148, 163, 184, 0.08);
        }
        .canvas-monitor-history-entry.error {
          align-self: stretch;
          width: 100%;
          background: rgba(239, 68, 68, 0.1);
          border-color: rgba(239, 68, 68, 0.3);
        }
        .canvas-monitor-history-title {
          color: var(--text-primary);
          font-size: 12px;
          font-weight: 600;
          margin-bottom: 4px;
        }
        .canvas-monitor-history-meta {
          color: var(--text-secondary);
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
            "Liberation Mono", "Courier New", monospace;
          font-size: 11px;
          margin-bottom: 6px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .canvas-monitor-history-markdown {
          color: var(--text-primary);
          font-size: 13px;
          line-height: 1.5;
          overflow-wrap: anywhere;
        }
        .canvas-monitor-history-markdown p,
        .canvas-monitor-history-markdown ul,
        .canvas-monitor-history-markdown ol,
        .canvas-monitor-history-markdown pre {
          margin: 0;
        }
        .canvas-monitor-history-markdown p + p,
        .canvas-monitor-history-markdown p + ul,
        .canvas-monitor-history-markdown p + ol,
        .canvas-monitor-history-markdown ul + p,
        .canvas-monitor-history-markdown ol + p,
        .canvas-monitor-history-markdown pre + p {
          margin-top: 8px;
        }
        .canvas-monitor-history-markdown ul,
        .canvas-monitor-history-markdown ol {
          padding-left: 20px;
        }
        .canvas-monitor-history-markdown li + li {
          margin-top: 4px;
        }
        .canvas-monitor-history-markdown code,
        .canvas-monitor-history-markdown pre,
        .canvas-monitor-history-mono {
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
            "Liberation Mono", "Courier New", monospace;
          font-size: 12px;
        }
        .canvas-monitor-history-markdown code {
          border: 1px solid var(--border-default);
          border-radius: 4px;
          background: rgba(148, 163, 184, 0.12);
          padding: 1px 4px;
        }
        .canvas-monitor-history-markdown pre {
          margin-top: 8px;
          border: 1px solid var(--border-default);
          border-radius: 6px;
          background: rgba(148, 163, 184, 0.1);
          padding: 8px;
          overflow: auto;
          white-space: pre;
        }
        .canvas-monitor-history-markdown pre code {
          border: 0;
          background: transparent;
          padding: 0;
        }
        .canvas-monitor-history-mono {
          margin: 0;
          color: var(--text-primary);
          line-height: 1.45;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
        }
        .canvas-monitor-history-entry.system .canvas-monitor-history-markdown,
        .canvas-monitor-history-entry.system .canvas-monitor-history-title {
          color: var(--text-secondary);
        }
        .canvas-monitor-history-entry.error .canvas-monitor-history-mono,
        .canvas-monitor-history-entry.error .canvas-monitor-history-markdown,
        .canvas-monitor-history-entry.error .canvas-monitor-history-title {
          color: #fca5a5;
        }
        .canvas-monitor-history-empty,
        .canvas-monitor-history-error {
          font-size: 13px !important;
        }
        .canvas-monitor-history-error {
          color: #fca5a5 !important;
        }
      `}</style>
    </div>
  );
}
