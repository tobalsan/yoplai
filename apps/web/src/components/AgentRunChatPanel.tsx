import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
} from "solid-js";
import type { JSX } from "solid-js";
import type { SubagentRun } from "@yoplai/shared/types";
import {
  archiveRuntimeSubagent,
  deleteRuntimeSubagent,
  fetchRuntimeSubagentLogs,
  fetchRuntimeSubagents,
  interruptRuntimeSubagent,
  resumeRuntimeSubagent,
  subscribeToFileChanges,
  subscribeToSubagentChanges,
  uploadFiles,
} from "../api";
import type { SubagentLogEvent } from "../api/types";
import { FILE_INPUT_ACCEPT, formatFileSize } from "../lib/attachments";
import { BoardChatLog } from "./BoardChatRenderer";
import type { BoardLogItem } from "./BoardChatRenderer";

type LogState = {
  events: SubagentLogEvent[];
  cursor: number;
};

type PendingMessage = {
  id: string;
  targetId: string;
  content: string;
  queued: boolean;
  sending: boolean;
  error?: string;
};

function formatRuntimeTime(run: SubagentRun) {
  return formatElapsed(run.lastActiveAt ?? run.finishedAt ?? run.startedAt);
}

function formatElapsed(raw: string) {
  const elapsed = Date.now() - Date.parse(raw);
  if (!Number.isFinite(elapsed) || elapsed < 0) return "now";
  const minutes = Math.floor(elapsed / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function isRunning(run: SubagentRun) {
  return run.status === "running" || run.status === "starting";
}

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

function stringifyToolArgs(text: string) {
  const parsed = parseJsonRecord(text);
  return parsed ?? { input: text };
}

function eventToBoardItem(event: SubagentLogEvent): BoardLogItem | null {
  const text = (
    event.text ??
    event.diff?.summary ??
    event.tool?.name ??
    ""
  ).trim();
  if (!text) return null;

  if (event.type === "stderr" || event.type === "error") {
    return { type: "text", role: "assistant", content: text };
  }
  if (event.type === "tool_call" || event.type === "tool_output") {
    return {
      type: "tool",
      id: event.tool?.id,
      toolName: event.tool?.name ?? "tool",
      args: stringifyToolArgs(text),
      body: event.type === "tool_output" ? text : undefined,
      status: event.type === "tool_output" ? "done" : "running",
    };
  }
  if (event.type === "user") return { type: "text", role: "user", content: text };
  if (event.type === "assistant") {
    return { type: "text", role: "assistant", content: text };
  }

  const parsed = parseJsonRecord(text);
  if (!parsed) {
    return event.type === "stdout"
      ? { type: "text", role: "assistant", content: text }
      : null;
  }

  const payload = getRecord(parsed.payload);
  if (parsed.type === "event_msg" && payload?.type === "user_message") {
    const message = typeof payload.message === "string" ? payload.message : "";
    return message ? { type: "text", role: "user", content: message } : null;
  }
  if (parsed.type === "event_msg" && payload?.type === "agent_message") {
    const message = typeof payload.message === "string" ? payload.message : "";
    return message
      ? { type: "text", role: "assistant", content: message }
      : null;
  }

  const item = getRecord(parsed.item);
  if (item?.type === "command_execution") {
    const command = typeof item.command === "string" ? item.command : "";
    const output =
      typeof item.aggregated_output === "string"
        ? item.aggregated_output.trim()
        : "";
    const status = typeof item.status === "string" ? item.status : "";
    const exitCode =
      typeof item.exit_code === "number" ? item.exit_code : undefined;
    return {
      type: "tool",
      toolName: "exec_command",
      args: { command },
      body: output,
      status:
        status === "completed" && exitCode !== undefined && exitCode !== 0
          ? "error"
          : status === "in_progress"
            ? "running"
            : "done",
    };
  }

  return null;
}

function transcriptItems(events: SubagentLogEvent[]) {
  return events
    .map(eventToBoardItem)
    .filter((item): item is BoardLogItem => item !== null);
}

function latestExcerpt(items: BoardLogItem[]) {
  const item = [...items].reverse().find((entry) => {
    if (entry.type === "text") return entry.content.trim();
    if (entry.type === "tool") return (entry.body ?? entry.toolName).trim();
    return false;
  });
  if (!item) return "No visible transcript";
  const text = item.type === "tool"
    ? item.body || `${item.toolName} call`
    : item.type === "text"
      ? item.content
      : item.content;
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length > 96 ? `${singleLine.slice(0, 95)}…` : singleLine;
}

function runSortValue(run: SubagentRun) {
  return Date.parse(run.lastActiveAt ?? run.finishedAt ?? run.startedAt) || 0;
}

function singleQueryValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export function AgentRunChatPanel(props: {
  projectId: string;
  sliceId?: string;
  selectedRunId?: string | string[];
  onSelectedRunIdChange?: (runId: string | undefined) => void;
  filter?: (run: SubagentRun) => boolean;
}) {
  const [runs, setRuns] = createSignal<SubagentRun[]>([]);
  const [logsByRunId, setLogsByRunId] = createSignal<Record<string, LogState>>(
    {}
  );
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [archivedOpen, setArchivedOpen] = createSignal(false);
  const [selectionCleared, setSelectionCleared] = createSignal(false);
  const [internalRunId, setInternalRunId] = createSignal<string | undefined>();
  const [draft, setDraft] = createSignal("");
  const [pendingFiles, setPendingFiles] = createSignal<File[]>([]);
  const [pendingMessages, setPendingMessages] = createSignal<PendingMessage[]>(
    []
  );
  let fileInputEl: HTMLInputElement | undefined;
  let chatMessagesEl: HTMLDivElement | undefined;
  let loadSeq = 0;

  const sortedRuns = createMemo(() =>
    [...runs()].sort((a, b) => runSortValue(b) - runSortValue(a))
  );
  const activeRuns = createMemo(() => sortedRuns().filter((run) => !run.archived));
  const archivedRuns = createMemo(() =>
    sortedRuns().filter((run) => run.archived)
  );
  const selectedRunId = createMemo(
    () => singleQueryValue(props.selectedRunId) ?? internalRunId()
  );
  const selectedRun = createMemo(() =>
    sortedRuns().find((run) => run.id === selectedRunId())
  );
  const selectedItems = createMemo(() =>
    selectedRun()
      ? transcriptItems(logsByRunId()[selectedRun()!.id]?.events ?? [])
      : []
  );
  const waitingForSelectedAssistant = createMemo(() => {
    const hasAssistantText = selectedItems().some(
      (item) =>
        item.type === "text" &&
        item.role === "assistant" &&
        item.content.trim().length > 0
    );
    if (hasAssistantText) return false;
    const run = selectedRun();
    return Boolean(run && isRunning(run));
  });

  async function loadRunLogs(runId: string) {
    const data = await fetchRuntimeSubagentLogs(runId, 0);
    setLogsByRunId((prev) => ({
      ...prev,
      [runId]: { events: data.events, cursor: data.cursor },
    }));
  }

  async function loadAll(projectId: string, sliceId: string | undefined, seq: number) {
    setLoading(true);
    try {
      const runData = await fetchRuntimeSubagents({
        projectId,
        sliceId,
        includeArchived: true,
      });
      if (seq !== loadSeq) return;
      const runItems = props.filter
        ? runData.items.filter(props.filter)
        : runData.items;
      const orderedRuns = [...runItems].sort(
        (a, b) => runSortValue(b) - runSortValue(a)
      );
      setRuns(orderedRuns);
      setLogsByRunId({});
      await Promise.all(orderedRuns.map((run) => loadRunLogs(run.id)));
      if (seq !== loadSeq) return;
      setError(null);
    } catch (err) {
      if (seq === loadSeq) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (seq === loadSeq) setLoading(false);
    }
  }

  createEffect(() => {
    const projectId = props.projectId;
    const sliceId = props.sliceId;
    loadSeq += 1;
    setRuns([]);
    setInternalRunId(undefined);
    setSelectionCleared(false);
    void loadAll(projectId, sliceId, loadSeq);
  });

  function runItems(run: SubagentRun) {
    return transcriptItems(logsByRunId()[run.id]?.events ?? []);
  }

  function shouldShowRun(run: SubagentRun) {
    return isRunning(run) || runItems(run).length > 0;
  }

  function selectRun(runId: string | undefined, cleared = false) {
    setSelectionCleared(cleared);
    setInternalRunId(runId);
    props.onSelectedRunIdChange?.(runId);
  }

  createEffect(() => {
    if (loading() || selectedRun() || selectionCleared()) return;
    const nextRun = activeRuns().find((run) => shouldShowRun(run));
    if (nextRun) selectRun(nextRun.id);
  });

  createEffect(() => {
    if (selectedRun()?.archived) setArchivedOpen(true);
  });

  createEffect(() => {
    const run = selectedRun();
    if (!run || isRunning(run)) return;
    const next = pendingMessages().find(
      (message) =>
        message.targetId === run.id &&
        message.queued &&
        !message.sending
    );
    if (next) void sendPendingRun(next);
  });

  const unsubscribeSubagents = subscribeToSubagentChanges({
    onSubagentChanged: () => {
      const seq = ++loadSeq;
      void loadAll(props.projectId, props.sliceId, seq);
    },
    onError: setError,
  });
  const unsubscribeFiles = subscribeToFileChanges({
    onAgentChanged: (projectId) => {
      if (projectId === props.projectId) {
        const seq = ++loadSeq;
        void loadAll(props.projectId, props.sliceId, seq);
      }
    },
  });
  onCleanup(() => {
    unsubscribeSubagents();
    unsubscribeFiles();
  });

  function clearSelectedRunAfterMutation(runId: string) {
    setRuns((prev) => prev.filter((run) => run.id !== runId));
    if (selectedRunId() === runId) selectRun(undefined, true);
  }

  async function stopSelected() {
    const run = selectedRun();
    if (!run) return;
    const result = await interruptRuntimeSubagent(run.id);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    const seq = ++loadSeq;
    await loadAll(props.projectId, props.sliceId, seq);
  }

  async function archiveSelectedRun() {
    const run = selectedRun();
    if (!run) return;
    const result = await archiveRuntimeSubagent(run.id);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setRuns((prev) =>
      prev.map((item) =>
        item.id === run.id ? { ...item, archived: true } : item
      )
    );
    setArchivedOpen(false);
    selectRun(undefined, true);
  }

  async function deleteSelectedRun() {
    const run = selectedRun();
    if (!run || !window.confirm("Delete this agent run?")) return;
    const result = await deleteRuntimeSubagent(run.id);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    clearSelectedRunAfterMutation(run.id);
  }

  function addFiles(files: FileList | File[]) {
    setPendingFiles((prev) => [...prev, ...Array.from(files)]);
  }

  function removePendingFile(index: number) {
    setPendingFiles((prev) => prev.filter((_, current) => current !== index));
  }

  function handleDraftKeyDown(event: KeyboardEvent) {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    void sendMessage();
  }

  async function sendPendingRun(message: PendingMessage) {
    setPendingMessages((prev) =>
      prev.map((item) =>
        item.id === message.id ? { ...item, sending: true, queued: false } : item
      )
    );
    const result = await resumeRuntimeSubagent(message.targetId, message.content);
    if (!result.ok) {
      setPendingMessages((prev) =>
        prev.map((item) =>
          item.id === message.id
            ? { ...item, sending: false, error: result.error }
            : item
        )
      );
      return;
    }
    setPendingMessages((prev) => prev.filter((item) => item.id !== message.id));
    const seq = ++loadSeq;
    await loadAll(props.projectId, props.sliceId, seq);
  }

  async function sendMessage() {
    const text = draft().trim();
    const files = pendingFiles();
    if (!text && files.length === 0) return;
    const attachments = files.length ? await uploadFiles(files) : [];
    const attachmentText = attachments
      .map((attachment) => `Attachment: ${attachment.path}`)
      .join("\n");
    const content = [text, attachmentText].filter(Boolean).join("\n\n");
    setDraft("");
    setPendingFiles([]);

    const run = selectedRun();
    if (!run) return;
    const message: PendingMessage = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      targetId: run.id,
      content,
      queued: isRunning(run),
      sending: false,
    };
    setPendingMessages((prev) => [...prev, message]);
    if (!isRunning(run)) await sendPendingRun(message);
  }

  function pendingForSelected() {
    return pendingMessages().filter(
      (message) => message.targetId === selectedRunId()
    );
  }

  function selectedChatIsRunning() {
    if (draft().trim() || pendingFiles().length > 0) return false;
    const run = selectedRun();
    return Boolean(run && isRunning(run));
  }

  createEffect(() => {
    const id = selectedRunId();
    const itemCount = selectedItems().length;
    const pendingCount = pendingForSelected().length;
    const isWaiting = waitingForSelectedAssistant();
    if (!id || (!itemCount && !pendingCount && !isWaiting)) return;
    requestAnimationFrame(() => {
      if (!chatMessagesEl) return;
      chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
    });
  });

  function RunRow(rowProps: { run: SubagentRun }) {
    const items = createMemo(() => runItems(rowProps.run));
    return (
      <button
        type="button"
        class={`agent-run-row ${
          selectedRunId() === rowProps.run.id ? "selected" : ""
        }`}
        onClick={() => selectRun(rowProps.run.id)}
      >
        <div class="agent-run-row-title">{rowProps.run.label}</div>
        <div class="agent-run-row-excerpt">{latestExcerpt(items())}</div>
        <div class="agent-run-row-meta">
          <span>{rowProps.run.status}</span>
          <span>{rowProps.run.cli}</span>
          <span>{formatRuntimeTime(rowProps.run)}</span>
        </div>
      </button>
    );
  }

  const subagentCount = createMemo(
    () => activeRuns().filter((run) => shouldShowRun(run)).length
  );
  const archivedRunCount = createMemo(
    () => archivedRuns().filter((run) => shouldShowRun(run)).length
  );
  const sidebarCount = createMemo(() => subagentCount() + archivedRunCount());

  function renderSidebarList() {
    return (
      <div class="agent-run-list">
        <Show when={subagentCount() > 0}>
          <SidebarSection title="Subagents">
            <For each={activeRuns().filter((run) => shouldShowRun(run))}>
              {(run) => <RunRow run={run} />}
            </For>
          </SidebarSection>
        </Show>
        <Show when={archivedRunCount() > 0}>
          <ArchivedSection>
            <SidebarSection title="Subagents">
              <For each={archivedRuns().filter((run) => shouldShowRun(run))}>
                {(run) => <RunRow run={run} />}
              </For>
            </SidebarSection>
          </ArchivedSection>
        </Show>
      </div>
    );
  }

  function SidebarSection(props: { title: string; children: JSX.Element }) {
    return (
      <section class="agent-run-list-section">
        <div class="agent-run-list-section-title">{props.title}</div>
        <div class="agent-run-list-section-items">{props.children}</div>
      </section>
    );
  }

  function ArchivedSection(props: { children: JSX.Element }) {
    return (
      <div class="agent-run-archived">
        <button
          type="button"
          class="agent-run-archived-toggle"
          onClick={() => setArchivedOpen(!archivedOpen())}
        >
          Archived
        </button>
        <Show when={archivedOpen()}>
          <div class="agent-run-archived-list">{props.children}</div>
        </Show>
      </div>
    );
  }

  return (
    <div
      class="agent-run-chat-panel"
      data-testid="agent-run-chat-panel"
      style={{ height: "100%", overflow: "hidden" }}
    >
      <Show when={error()}>
        {(message) => <div class="agent-run-error">{message()}</div>}
      </Show>
      <aside class="agent-run-sidebar">
        <div class="agent-run-sidebar-scroll">
          <Show
            when={sidebarCount() > 0}
            fallback={
              <div class="agent-run-empty">
                {loading() ? "Loading agent runs…" : "No agent runs yet."}
              </div>
            }
          >
            {renderSidebarList()}
          </Show>
        </div>
      </aside>
      <section class="agent-run-chat">
        <Show
          when={selectedRun()}
          fallback={
            <div class="agent-run-placeholder">No agent run selected.</div>
          }
        >
          {(run) => (
            <>
              <header class="agent-run-chat-header">
                <div>
                  <div class="agent-run-chat-title">{run().label}</div>
                  <div class="agent-run-chat-meta">
                    {run().status} · {run().cli}
                    <Show when={run().model}> · {run().model}</Show> ·{" "}
                    {formatRuntimeTime(run())}
                  </div>
                </div>
                <div class="agent-run-actions">
                  <button
                    type="button"
                    onClick={stopSelected}
                    disabled={!isRunning(run())}
                  >
                    Stop
                  </button>
                  <button type="button" onClick={archiveSelectedRun}>
                    Archive
                  </button>
                  <button type="button" onClick={deleteSelectedRun}>
                    Delete
                  </button>
                </div>
              </header>
              <ChatBody agentName={run().label} />
            </>
          )}
        </Show>
      </section>
      <style>{`
        .agent-run-chat-panel {
          display: grid;
          grid-template-columns: minmax(220px, 280px) minmax(0, 1fr);
          width: 100%;
          min-height: 0;
          max-height: 100%;
          border: 1px solid var(--border-default);
          background: var(--surface-default, #fff);
        }

        .agent-run-sidebar {
          display: flex;
          flex-direction: column;
          min-width: 0;
          min-height: 0;
          border-right: 1px solid var(--border-default);
          background: color-mix(in srgb, var(--text-primary, #111827) 3%, transparent);
        }

        .agent-run-sidebar-scroll {
          flex: 1;
          min-height: 0;
          overflow: auto;
        }

        .agent-run-list {
          padding: 8px;
        }

        .agent-run-list-section {
          border-top: 1px solid var(--border-default);
          padding-top: 8px;
          margin-top: 8px;
        }

        .agent-run-list-section:first-child {
          border-top: 0;
          padding-top: 0;
          margin-top: 0;
        }

        .agent-run-list-section-title {
          color: var(--text-secondary);
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0;
          margin: 0 2px 6px;
          text-transform: uppercase;
        }

        .agent-run-list-section-items {
          display: grid;
          gap: 6px;
        }

        .agent-run-row {
          position: relative;
          width: 100%;
          min-height: 78px;
          padding: 10px;
          border: 1px solid transparent;
          border-radius: 6px;
          background: transparent;
          text-align: left;
          color: var(--text-primary);
          cursor: pointer;
        }

        .agent-run-row:hover,
        .agent-run-row.selected {
          border-color: var(--border-default);
          background: var(--surface-default, #fff);
        }

        .agent-run-row-title {
          font-weight: 700;
          font-size: 13px;
        }

        .agent-run-row-excerpt {
          margin-top: 4px;
          color: var(--text-secondary);
          font-size: 12px;
          line-height: 1.35;
          overflow: hidden;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
        }

        .agent-run-row-meta,
        .agent-run-chat-meta {
          display: flex;
          gap: 8px;
          align-items: center;
          margin-top: 6px;
          color: var(--text-tertiary, var(--text-secondary));
          font-size: 11px;
        }

        .agent-run-archived {
          border-top: 1px solid var(--border-default);
          padding: 8px;
        }

        .agent-run-archived-toggle {
          width: 100%;
          border: 0;
          background: transparent;
          color: var(--text-secondary);
          font-size: 12px;
          font-weight: 700;
          text-align: left;
          cursor: pointer;
        }

        .agent-run-chat {
          min-width: 0;
          min-height: 0;
          display: flex;
          flex-direction: column;
          background: var(--surface-default, #fff);
        }

        .agent-run-chat-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 12px 16px;
          border-bottom: 1px solid var(--border-default);
        }

        .agent-run-chat-title {
          font-weight: 700;
        }

        .agent-run-actions {
          display: flex;
          gap: 8px;
        }

        .agent-run-actions button {
          border: 1px solid var(--border-default);
          border-radius: 6px;
          background: var(--surface-default, #fff);
          padding: 6px 10px;
          color: var(--text-primary);
          cursor: pointer;
        }

        .agent-run-actions button:disabled {
          cursor: default;
          opacity: 0.5;
        }

        .agent-run-chat-messages {
          flex: 1;
          min-height: 0;
          overflow: auto;
          padding: 20px 24px;
          display: flex;
          flex-direction: column;
          gap: 24px;
        }

        .agent-run-placeholder,
        .agent-run-empty {
          padding: 24px;
          color: var(--text-secondary);
        }

        .agent-run-error {
          color: #b91c1c;
          font-size: 12px;
          padding: 8px 12px;
        }

        .board-msg-thinking {
          font-size: 14px;
          font-style: italic;
          color: var(--text-secondary);
          animation: thinking-pulse 1.8s ease-in-out infinite;
        }

        @keyframes thinking-pulse {
          0%, 100% { opacity: 0.4; }
          50% { opacity: 1; }
        }

        @media (prefers-reduced-motion: reduce) {
          .board-msg-thinking {
            animation: none;
            opacity: 0.6;
          }
        }

        .board-chat-input-area {
          border-top: 1px solid var(--border-default);
          padding: 12px 20px 12px;
        }

        .board-chat-input-wrapper {
          display: flex;
          align-items: flex-end;
          gap: 0;
          border-radius: 14px;
          border: 1px solid var(--border-default);
          background: var(--bg-surface);
          transition: border-color 0.2s, box-shadow 0.2s;
          overflow: hidden;
        }

        .board-chat-input-wrapper:focus-within {
          border-color: var(--border-accent, var(--text-accent, #6366f1));
          box-shadow: 0 0 0 3px color-mix(in srgb, var(--text-accent, #6366f1) 15%, transparent);
        }

        .board-file-input {
          display: none;
        }

        .board-chat-attach {
          display: grid;
          place-items: center;
          width: 36px;
          height: 36px;
          margin: 4px 0 4px 4px;
          border: none;
          border-radius: 10px;
          background: transparent;
          color: var(--text-secondary);
          cursor: pointer;
          flex-shrink: 0;
        }

        .board-chat-attach svg {
          width: 19px;
          height: 19px;
        }

        .board-chat-attach:hover:not(:disabled) {
          background: color-mix(in srgb, var(--text-primary) 8%, transparent);
          color: var(--text-primary);
        }

        .board-chat-input {
          flex: 1;
          padding: 12px 4px;
          border: none;
          background: transparent;
          color: var(--text-primary);
          font-size: 14px;
          font-family: inherit;
          line-height: 1.5;
          resize: none;
          min-height: 44px;
          max-height: 160px;
        }

        .board-chat-input::placeholder {
          color: var(--text-secondary);
          opacity: 0.6;
        }

        .board-chat-input:focus {
          outline: none;
        }

        .board-chat-send {
          display: grid;
          place-items: center;
          width: 36px;
          height: 36px;
          margin: 4px;
          border-radius: 10px;
          border: none;
          background: var(--bg-accent, #6366f1);
          color: var(--text-on-accent, #ffffff);
          cursor: pointer;
          transition: opacity 0.15s, transform 0.15s;
          flex-shrink: 0;
        }

        .board-chat-send.board-chat-stop {
          background: #ef4444;
          color: #ffffff;
        }

        .board-chat-send:hover:not(:disabled) {
          opacity: 0.85;
          transform: scale(1.05);
        }

        .board-chat-send:active:not(:disabled) {
          transform: scale(0.95);
        }

        .board-chat-send:disabled {
          opacity: 0.3;
          cursor: default;
        }

        .board-chat-send:focus-visible,
        .board-chat-attach:focus-visible,
        .board-attachment-remove:focus-visible {
          outline: 2px solid var(--text-accent, #6366f1);
          outline-offset: 2px;
        }

        .board-attachments {
          display: flex;
          align-items: center;
          flex-wrap: wrap;
          gap: 8px;
          margin-bottom: 8px;
        }

        .board-attachment-pill {
          display: inline-flex;
          align-items: center;
          gap: 7px;
          min-width: 0;
          max-width: 100%;
          border: 1px solid var(--border-default);
          border-radius: 8px;
          padding: 5px 7px;
          background: color-mix(in srgb, var(--text-primary) 5%, transparent);
          color: var(--text-secondary);
          font-size: 12px;
        }

        .board-attachment-name {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .board-attachment-size {
          flex-shrink: 0;
          color: var(--text-secondary);
          opacity: 0.7;
          font-size: 11px;
        }

        .board-attachment-remove {
          width: 18px;
          height: 18px;
          border: none;
          border-radius: 4px;
          background: transparent;
          color: var(--text-secondary);
          cursor: pointer;
          line-height: 1;
        }

        .board-attachment-remove:hover:not(:disabled) {
          background: color-mix(in srgb, var(--text-primary) 8%, transparent);
          color: var(--text-primary);
        }

        .board-chat-input-hint {
          margin: 6px 0 0;
          font-size: 11px;
          color: var(--text-secondary);
          opacity: 0.5;
          text-align: center;
        }

        @media (max-width: 760px) {
          .agent-run-chat-panel {
            grid-template-columns: 1fr;
          }

          .agent-run-sidebar {
            max-height: 220px;
            border-right: 0;
            border-bottom: 1px solid var(--border-default);
          }
        }
      `}</style>
    </div>
  );

  function ChatBody(props: { agentName: string }) {
    return (
      <>
        <div
          ref={chatMessagesEl}
          class="board-chat-messages agent-run-chat-messages"
          style={{ overflow: "auto" }}
        >
          <BoardChatLog items={selectedItems()} agentName={props.agentName} />
          <For each={pendingForSelected()}>
            {(message) => (
              <div class="board-msg board-msg-user">
                <div class="board-msg-role">
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                    <circle cx="12" cy="7" r="4" />
                  </svg>
                  <span>
                    {message.queued
                      ? "You (queued)"
                      : message.sending
                        ? "You (sending)"
                        : "You"}
                  </span>
                </div>
                <div class="board-msg-content">{message.content}</div>
                <Show when={message.error}>
                  <div class="agent-run-error">{message.error}</div>
                </Show>
              </div>
            )}
          </For>
          <Show when={waitingForSelectedAssistant()}>
            <div class="board-msg board-msg-assistant">
              <div class="board-msg-role">
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M12 2L2 7l10 5 10-5-10-5z" />
                  <path d="M2 17l10 5 10-5" />
                  <path d="M2 12l10 5 10-5" />
                </svg>
                <span>{props.agentName}</span>
              </div>
              <div class="board-msg-thinking">Thinking…</div>
            </div>
          </Show>
        </div>
        <form
          class="board-chat-input-area"
          onSubmit={(event) => {
            event.preventDefault();
            void sendMessage();
          }}
        >
          <Show when={pendingFiles().length}>
            <div class="board-attachments">
              <For each={pendingFiles()}>
                {(file, index) => (
                  <div class="board-attachment-pill">
                    <span class="board-attachment-name" title={file.name}>
                      {file.name}
                    </span>
                    <Show when={formatFileSize(file.size)}>
                      {(size) => (
                        <span class="board-attachment-size">{size()}</span>
                      )}
                    </Show>
                    <button
                      type="button"
                      class="board-attachment-remove"
                      aria-label={`Remove ${file.name}`}
                      onClick={() => removePendingFile(index())}
                    >
                      x
                    </button>
                  </div>
                )}
              </For>
            </div>
          </Show>
          <div class="board-chat-input-wrapper">
            <input
              ref={fileInputEl}
              class="board-file-input"
              type="file"
              multiple
              accept={FILE_INPUT_ACCEPT}
              onChange={(event) => {
                if (event.currentTarget.files) {
                  addFiles(event.currentTarget.files);
                  event.currentTarget.value = "";
                }
              }}
            />
            <button
              type="button"
              class="board-chat-attach"
              aria-label="Attach files"
              onClick={() => fileInputEl?.click()}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M16.5 6.5v9.1a4.5 4.5 0 0 1-9 0V6.3a3.3 3.3 0 0 1 6.6 0v8.8a2.1 2.1 0 1 1-4.2 0V7.2h1.6v7.9a.5.5 0 1 0 1 0V6.3a1.7 1.7 0 0 0-3.4 0v9.3a2.9 2.9 0 0 0 5.8 0V6.5h1.6z"
                />
              </svg>
            </button>
            <textarea
              class="board-chat-input"
              rows={1}
              value={draft()}
              placeholder="Ask anything..."
              onInput={(event) => setDraft(event.currentTarget.value)}
              onKeyDown={handleDraftKeyDown}
            />
            <Show
              when={selectedChatIsRunning()}
              fallback={
                <button
                  type="submit"
                  class="board-chat-send"
                  disabled={!draft().trim() && pendingFiles().length === 0}
                  aria-label="Send message"
                >
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <line x1="22" y1="2" x2="11" y2="13" />
                    <polygon points="22 2 15 22 11 13 2 9 22 2" />
                  </svg>
                </button>
              }
            >
              <button
                type="button"
                class="board-chat-send board-chat-stop"
                aria-label="Stop response"
                onClick={() => void stopSelected()}
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                >
                  <rect x="6" y="6" width="12" height="12" rx="2" />
                </svg>
              </button>
            </Show>
          </div>
          <p class="board-chat-input-hint">
            Enter to send, Shift+Enter for new line
          </p>
        </form>
      </>
    );
  }
}
