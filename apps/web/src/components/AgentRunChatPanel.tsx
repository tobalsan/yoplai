import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
} from "solid-js";
import type { JSX } from "solid-js";
import type {
  FileAttachment,
  FullHistoryMessage,
  LeadSession,
  SubagentRun,
} from "@yoplai/shared/types";
import {
  archiveRuntimeSubagent,
  createLeadSession,
  deleteLeadSession,
  deleteRuntimeSubagent,
  fetchAgents,
  fetchLeadSessionTranscript,
  fetchLeadSessions,
  fetchRuntimeSubagentLogs,
  fetchRuntimeSubagents,
  interruptRuntimeSubagent,
  patchLeadSession,
  postAbort,
  resumeRuntimeSubagent,
  selectDefaultProjectManagerAgent,
  sendLeadSessionMessage,
  subscribeToFileChanges,
  subscribeToLeadSessionChanges,
  subscribeToSubagentChanges,
  uploadFiles,
} from "../api";
import type { Agent, SubagentLogEvent } from "../api/types";
import { FILE_INPUT_ACCEPT, formatFileSize } from "../lib/attachments";
import { BoardChatLog } from "./BoardChatRenderer";
import type { BoardLogItem } from "./BoardChatRenderer";

type Segment = "lead" | "subagents";

type LogState = {
  events: SubagentLogEvent[];
  cursor: number;
};

type LeadTranscriptState = {
  messages: FullHistoryMessage[];
  loaded: boolean;
};

type PendingMessage = {
  id: string;
  family: Segment;
  targetId: string;
  content: string;
  queued: boolean;
  sending: boolean;
  error?: string;
  files?: FileAttachment[];
};

function formatRuntimeTime(run: SubagentRun) {
  return formatElapsed(run.lastActiveAt ?? run.finishedAt ?? run.startedAt);
}

function formatLeadTime(session: LeadSession) {
  return formatElapsed(session.updatedAt || session.createdAt);
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

function isLegacyLeadSession(session: LeadSession) {
  return session.id === `lead:${session.projectId}:legacy:${session.agentId}`;
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

function messageText(message: FullHistoryMessage) {
  return message.content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "file") return block.filename ?? block.fileId;
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function leadItems(messages: FullHistoryMessage[]) {
  return messages
    .map((message): BoardLogItem | null => {
      if (message.role !== "user" && message.role !== "assistant") return null;
      const content = messageText(message).trim();
      return content ? { type: "text", role: message.role, content } : null;
    })
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

function leadSortValue(session: LeadSession) {
  return Date.parse(session.updatedAt || session.createdAt) || 0;
}

function singleQueryValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function upsertLeadSession(
  sessions: LeadSession[],
  session: LeadSession
): LeadSession[] {
  return [session, ...sessions.filter((item) => item.id !== session.id)];
}

export function AgentRunChatPanel(props: {
  projectId: string;
  sliceId?: string;
  selectedRunId?: string | string[];
  selectedLeadId?: string | string[];
  onSelectedRunIdChange?: (runId: string | undefined) => void;
  onSelectedLeadIdChange?: (leadId: string | undefined) => void;
  filter?: (run: SubagentRun) => boolean;
}) {
  const [agents, setAgents] = createSignal<Agent[]>([]);
  const [leadSessions, setLeadSessions] = createSignal<LeadSession[]>([]);
  const [runs, setRuns] = createSignal<SubagentRun[]>([]);
  const [logsByRunId, setLogsByRunId] = createSignal<Record<string, LogState>>(
    {}
  );
  const [leadTranscripts, setLeadTranscripts] = createSignal<
    Record<string, LeadTranscriptState>
  >({});
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [archivedOpen, setArchivedOpen] = createSignal(false);
  const [activeSegment, setActiveSegment] = createSignal<Segment>("lead");
  const [selectionCleared, setSelectionCleared] = createSignal(false);
  const [internalRunId, setInternalRunId] = createSignal<string | undefined>();
  const [internalLeadId, setInternalLeadId] = createSignal<string | undefined>();
  const [draft, setDraft] = createSignal("");
  const [pendingFiles, setPendingFiles] = createSignal<File[]>([]);
  const [pendingMessages, setPendingMessages] = createSignal<PendingMessage[]>(
    []
  );
  const [creatingLeadSession, setCreatingLeadSession] = createSignal(false);
  const [draftAgentByLeadId, setDraftAgentByLeadId] = createSignal<
    Record<string, string>
  >({});
  let fileInputEl: HTMLInputElement | undefined;
  let chatMessagesEl: HTMLDivElement | undefined;
  let loadSeq = 0;

  const scopedLeadSessions = createMemo(() =>
    leadSessions().filter((session) =>
      props.sliceId
        ? session.sliceId === props.sliceId
        : session.sliceId === undefined
    )
  );
  const sortedLeads = createMemo(() =>
    [...scopedLeadSessions()].sort((a, b) => leadSortValue(b) - leadSortValue(a))
  );
  const activeLeads = createMemo(() =>
    sortedLeads().filter((session) => !session.archivedAt)
  );
  const archivedLeads = createMemo(() =>
    sortedLeads().filter((session) => session.archivedAt)
  );
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
  const selectedLeadId = createMemo(
    () => singleQueryValue(props.selectedLeadId) ?? internalLeadId()
  );
  const selectedRun = createMemo(() =>
    sortedRuns().find((run) => run.id === selectedRunId())
  );
  const selectedLead = createMemo(() =>
    sortedLeads().find((session) => session.id === selectedLeadId())
  );
  const selectedItems = createMemo(() =>
    activeSegment() === "lead"
      ? selectedLead()
        ? leadItems(leadTranscripts()[selectedLead()!.id]?.messages ?? [])
        : []
      : selectedRun()
        ? transcriptItems(logsByRunId()[selectedRun()!.id]?.events ?? [])
        : []
  );
  const waitingForSelectedAssistant = createMemo(() => {
    if (activeSegment() === "lead") {
      return pendingForSelected().some(
        (message) => message.sending && !message.error
      );
    }
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
  const scopeId = createMemo(() =>
    props.sliceId ? `${props.projectId}:${props.sliceId}` : props.projectId
  );
  const lastViewedKey = createMemo(() => `lead-session:lastViewed:${scopeId()}`);
  const defaultAgent = createMemo(() =>
    selectDefaultProjectManagerAgent(agents())
  );

  async function loadRunLogs(runId: string) {
    const data = await fetchRuntimeSubagentLogs(runId, 0);
    setLogsByRunId((prev) => ({
      ...prev,
      [runId]: { events: data.events, cursor: data.cursor },
    }));
  }

  async function loadLeadTranscript(sessionId: string) {
    const data = await fetchLeadSessionTranscript(sessionId);
    setLeadTranscripts((prev) => ({
      ...prev,
      [sessionId]: { messages: data.messages, loaded: true },
    }));
  }

  async function loadAll(projectId: string, sliceId: string | undefined, seq: number) {
    setLoading(true);
    try {
      const [agentList, activeLeadData, archivedLeadData, runData] =
        await Promise.all([
          fetchAgents(),
          fetchLeadSessions(projectId, { archived: false, sliceId }),
          fetchLeadSessions(projectId, { archived: true, sliceId }),
          fetchRuntimeSubagents({
            projectId,
            sliceId,
            includeArchived: true,
          }),
        ]);
      if (seq !== loadSeq) return;
      const allLeads = [...activeLeadData.items, ...archivedLeadData.items].filter(
        (session) =>
          sliceId ? session.sliceId === sliceId : session.sliceId === undefined
      );
      const runItems = props.filter
        ? runData.items.filter(props.filter)
        : runData.items;
      const orderedRuns = [...runItems].sort(
        (a, b) => runSortValue(b) - runSortValue(a)
      );
      setAgents(agentList);
      setLeadSessions(allLeads);
      setRuns(orderedRuns);
      setLogsByRunId({});
      setLeadTranscripts({});
      await Promise.all([
        ...orderedRuns.map((run) => loadRunLogs(run.id)),
        ...allLeads.map((session) => loadLeadTranscript(session.id)),
      ]);
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
    setLeadSessions([]);
    setRuns([]);
    setInternalLeadId(undefined);
    setInternalRunId(undefined);
    setSelectionCleared(false);
    void loadAll(projectId, sliceId, loadSeq);
  });

  function runItems(run: SubagentRun) {
    return transcriptItems(logsByRunId()[run.id]?.events ?? []);
  }

  function leadSessionItems(session: LeadSession) {
    return leadItems(leadTranscripts()[session.id]?.messages ?? []);
  }

  function leadHasUserMessage(session: LeadSession) {
    return (leadTranscripts()[session.id]?.messages ?? []).some(
      (message) => message.role === "user"
    );
  }

  function shouldShowRun(run: SubagentRun) {
    return isRunning(run) || runItems(run).length > 0;
  }

  function selectRun(runId: string | undefined, cleared = false) {
    setSelectionCleared(cleared);
    setActiveSegment("subagents");
    setInternalRunId(runId);
    setInternalLeadId(undefined);
    props.onSelectedRunIdChange?.(runId);
  }

  function selectLead(leadId: string | undefined, cleared = false) {
    setSelectionCleared(cleared);
    setActiveSegment("lead");
    setInternalLeadId(leadId);
    setInternalRunId(undefined);
    if (leadId) localStorage.setItem(lastViewedKey(), leadId);
    props.onSelectedLeadIdChange?.(leadId);
  }

  createEffect(() => {
    if (loading()) return;
    const leadParam = singleQueryValue(props.selectedLeadId);
    const runParam = singleQueryValue(props.selectedRunId);
    if (leadParam && sortedLeads().some((session) => session.id === leadParam)) {
      setActiveSegment("lead");
      return;
    }
    if (runParam && sortedRuns().some((run) => run.id === runParam)) {
      setActiveSegment("subagents");
      return;
    }
    if (selectedLead()) {
      setActiveSegment("lead");
      return;
    }
    if (selectedRun()) {
      setActiveSegment("subagents");
      return;
    }
    if (selectionCleared()) return;

    const lastViewed = localStorage.getItem(lastViewedKey());
    const lastLead = activeLeads().find((session) => session.id === lastViewed);
    if (lastLead) {
      selectLead(lastLead.id);
      return;
    }
    const newestVisibleLead = activeLeads().find(leadHasUserMessage);
    if (newestVisibleLead) {
      selectLead(newestVisibleLead.id);
      return;
    }
    if (activeLeads().length > 0) {
      setActiveSegment("lead");
      return;
    }
    const nextRun = activeRuns().find((run) => shouldShowRun(run));
    if (nextRun) {
      selectRun(nextRun.id);
      return;
    }
    setActiveSegment("lead");
  });

  createEffect(() => {
    const lead = selectedLead();
    const run = selectedRun();
    if (lead?.archivedAt || run?.archived) setArchivedOpen(true);
  });

  createEffect(() => {
    const run = selectedRun();
    if (!run || isRunning(run)) return;
    const next = pendingMessages().find(
      (message) =>
        message.family === "subagents" &&
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
  const unsubscribeLeadSessions = subscribeToLeadSessionChanges({
    onLeadSessionChanged: (event) => {
      if (event.session.projectId !== props.projectId) return;
      const inScope = props.sliceId
        ? event.session.sliceId === props.sliceId
        : event.session.sliceId === undefined;
      if (!inScope) return;
      if (event.kind === "deleted") {
        setLeadSessions((prev) =>
          prev.filter((session) => session.id !== event.session.id)
        );
        setLeadTranscripts((prev) => {
          const next = { ...prev };
          delete next[event.session.id];
          return next;
        });
        if (selectedLeadId() === event.session.id) selectLead(undefined, true);
        return;
      }
      setLeadSessions((prev) => upsertLeadSession(prev, event.session));
      void loadLeadTranscript(event.session.id);
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
    unsubscribeLeadSessions();
    unsubscribeFiles();
  });

  function clearSelectedRunAfterMutation(runId: string) {
    setRuns((prev) => prev.filter((run) => run.id !== runId));
    if (selectedRunId() === runId) selectRun(undefined, true);
  }

  function clearSelectedLeadAfterMutation(leadId: string) {
    setLeadSessions((prev) => prev.filter((session) => session.id !== leadId));
    if (selectedLeadId() === leadId) selectLead(undefined, true);
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

  async function stopSelectedChat() {
    if (activeSegment() === "subagents") {
      await stopSelected();
      return;
    }
    const lead = selectedLead();
    if (!lead) return;
    try {
      await postAbort(lead.agentId, lead.transcriptRef);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
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

  async function archiveLead(session: LeadSession, archived: boolean) {
    try {
      const updated = await patchLeadSession(session.id, { archived });
      setLeadSessions((prev) =>
        prev.map((item) => (item.id === updated.id ? updated : item))
      );
      if (archived && selectedLeadId() === session.id) selectLead(undefined, true);
      if (!archived) setArchivedOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function renameLead(session: LeadSession) {
    const title = window.prompt("Rename lead session", session.title)?.trim();
    if (!title || title === session.title) return;
    try {
      const updated = await patchLeadSession(session.id, { title });
      setLeadSessions((prev) =>
        prev.map((item) => (item.id === updated.id ? updated : item))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function deleteLead(session: LeadSession) {
    if (isLegacyLeadSession(session)) return;
    if (!window.confirm("Delete this lead session?")) return;
    try {
      await deleteLeadSession(session.id);
      clearSelectedLeadAfterMutation(session.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function createNewLeadSession() {
    if (creatingLeadSession()) return;
    const agent = defaultAgent();
    if (!agent) return;
    setCreatingLeadSession(true);
    try {
      const created = await createLeadSession(props.projectId, {
        agentId: agent.id,
        ...(props.sliceId ? { sliceId: props.sliceId } : {}),
      });
      setLeadSessions((prev) => upsertLeadSession(prev, created));
      setLeadTranscripts((prev) => ({
        ...prev,
        [created.id]: { messages: [], loaded: true },
      }));
      setDraftAgentByLeadId((prev) => ({ ...prev, [created.id]: agent.id }));
      selectLead(created.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingLeadSession(false);
    }
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

  async function sendLead(message: PendingMessage, agentId?: string) {
    setPendingMessages((prev) =>
      prev.map((item) =>
        item.id === message.id ? { ...item, sending: true, queued: false } : item
      )
    );
    try {
      const response = await sendLeadSessionMessage(message.targetId, {
        content: message.content,
        ...(agentId ? { agentId } : {}),
        ...(message.files?.length ? { files: message.files } : {}),
      });
      setLeadSessions((prev) =>
        prev.map((session) =>
          session.id === response.session.id ? response.session : session
        )
      );
      setPendingMessages((prev) => prev.filter((item) => item.id !== message.id));
      await loadLeadTranscript(message.targetId);
    } catch (err) {
      setPendingMessages((prev) =>
        prev.map((item) =>
          item.id === message.id
            ? {
                ...item,
                sending: false,
                error: err instanceof Error ? err.message : String(err),
              }
            : item
        )
      );
    }
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

    if (activeSegment() === "lead") {
      const lead = selectedLead();
      if (!lead) return;
      const agentId = leadAgentLocked(lead)
        ? undefined
        : draftAgentByLeadId()[lead.id] || lead.agentId;
      const message: PendingMessage = {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        family: "lead",
        targetId: lead.id,
        content,
        queued: false,
        sending: false,
        files: attachments,
      };
      setPendingMessages((prev) => [...prev, message]);
      await sendLead(message, agentId);
      return;
    }

    const run = selectedRun();
    if (!run) return;
    const message: PendingMessage = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      family: "subagents",
      targetId: run.id,
      content,
      queued: isRunning(run),
      sending: false,
    };
    setPendingMessages((prev) => [...prev, message]);
    if (!isRunning(run)) await sendPendingRun(message);
  }

  function leadAgentLocked(session: LeadSession) {
    const transcript = leadTranscripts()[session.id];
    if (!transcript?.loaded) return true;
    return transcript.messages.some((message) => message.role === "user");
  }

  function leadAgent(session: LeadSession) {
    return agents().find((agent) => agent.id === session.agentId);
  }

  function pendingForSelected() {
    const family = activeSegment();
    const id = family === "lead" ? selectedLeadId() : selectedRunId();
    return pendingMessages().filter(
      (message) => message.family === family && message.targetId === id
    );
  }

  function selectedChatIsRunning() {
    if (activeSegment() === "lead") {
      return pendingForSelected().some(
        (message) => message.sending && !message.error
      );
    }
    if (draft().trim() || pendingFiles().length > 0) return false;
    const run = selectedRun();
    return Boolean(run && isRunning(run));
  }

  createEffect(() => {
    const id = activeSegment() === "lead" ? selectedLeadId() : selectedRunId();
    const itemCount = selectedItems().length;
    const pendingCount = pendingForSelected().length;
    const isWaiting = waitingForSelectedAssistant();
    if (!id || (!itemCount && !pendingCount && !isWaiting)) return;
    requestAnimationFrame(() => {
      if (!chatMessagesEl) return;
      chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
    });
  });

  function AgentBadge(props: { agent?: Agent; agentId: string }) {
    const label = () => props.agent?.name ?? props.agentId;
    return (
      <span class="lead-agent-badge">
        <span>{label()}</span>
      </span>
    );
  }

  function RowActionIcon(props: { type: "rename" | "archive" | "unarchive" | "delete" }) {
    return (
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <Show when={props.type === "rename"}>
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </Show>
        <Show when={props.type === "archive"}>
          <path d="M21 8v13H3V8" />
          <path d="M1 3h22v5H1Z" />
          <path d="M10 12h4" />
        </Show>
        <Show when={props.type === "unarchive"}>
          <path d="M21 8v13H3V8" />
          <path d="M1 3h22v5H1Z" />
          <path d="m9 15 3-3 3 3" />
          <path d="M12 12v6" />
        </Show>
        <Show when={props.type === "delete"}>
          <path d="M3 6h18" />
          <path d="M8 6V4h8v2" />
          <path d="M19 6l-1 14H6L5 6" />
          <path d="M10 11v6" />
          <path d="M14 11v6" />
        </Show>
      </svg>
    );
  }

  function LeadRow(rowProps: { session: LeadSession }) {
    const items = createMemo(() => leadSessionItems(rowProps.session));
    const archived = () => !!rowProps.session.archivedAt;
    return (
      <div
        class={`agent-run-row lead-session-row ${
          selectedLeadId() === rowProps.session.id ? "selected" : ""
        }`}
        onDblClick={() => void renameLead(rowProps.session)}
      >
        <button
          type="button"
          class="agent-run-row-main"
          onClick={() => selectLead(rowProps.session.id)}
        >
          <div class="agent-run-row-title">{rowProps.session.title}</div>
          <div class="agent-run-row-excerpt">{latestExcerpt(items())}</div>
          <div class="agent-run-row-meta">
            <AgentBadge
              agent={leadAgent(rowProps.session)}
              agentId={rowProps.session.agentId}
            />
            <span>{formatLeadTime(rowProps.session)}</span>
          </div>
        </button>
        <div class="agent-run-row-actions">
          <button
            type="button"
            aria-label="Rename lead session"
            title="Rename"
            onClick={() => void renameLead(rowProps.session)}
          >
            <RowActionIcon type="rename" />
          </button>
          <button
            type="button"
            aria-label={
              archived() ? "Unarchive lead session" : "Archive lead session"
            }
            title={archived() ? "Unarchive" : "Archive"}
            onClick={() => void archiveLead(rowProps.session, !archived())}
          >
            <RowActionIcon type={archived() ? "unarchive" : "archive"} />
          </button>
          <Show when={!isLegacyLeadSession(rowProps.session)}>
            <button
              type="button"
              aria-label="Delete lead session"
              title="Delete"
              onClick={() => void deleteLead(rowProps.session)}
            >
              <RowActionIcon type="delete" />
            </button>
          </Show>
        </div>
      </div>
    );
  }

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

  const leadCount = createMemo(() => activeLeads().length);
  const subagentCount = createMemo(
    () => activeRuns().filter((run) => shouldShowRun(run)).length
  );
  const archivedLeadCount = createMemo(() => archivedLeads().length);
  const archivedRunCount = createMemo(
    () => archivedRuns().filter((run) => shouldShowRun(run)).length
  );
  const sidebarCount = createMemo(
    () =>
      leadCount() + subagentCount() + archivedLeadCount() + archivedRunCount()
  );

  function renderSidebarList() {
    return (
      <div class="agent-run-list">
        <Show when={leadCount() > 0}>
          <SidebarSection title="Lead chats">
            <For each={activeLeads()}>
              {(session) => <LeadRow session={session} />}
            </For>
          </SidebarSection>
        </Show>
        <Show when={subagentCount() > 0}>
          <SidebarSection title="Subagents">
            <For each={activeRuns().filter((run) => shouldShowRun(run))}>
              {(run) => <RunRow run={run} />}
            </For>
          </SidebarSection>
        </Show>
        <Show when={archivedLeadCount() + archivedRunCount() > 0}>
          <ArchivedSection>
            <Show when={archivedLeadCount() > 0}>
              <SidebarSection title="Lead chats">
              <For each={archivedLeads()}>
                {(session) => <LeadRow session={session} />}
              </For>
              </SidebarSection>
            </Show>
            <Show when={archivedRunCount() > 0}>
              <SidebarSection title="Subagents">
                <For each={archivedRuns().filter((run) => shouldShowRun(run))}>
                  {(run) => <RunRow run={run} />}
                </For>
              </SidebarSection>
            </Show>
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

  function LeadComposerAgentPicker(props: { session: LeadSession }) {
    const locked = () => leadAgentLocked(props.session);
    const currentAgentId = () =>
      draftAgentByLeadId()[props.session.id] || props.session.agentId;
    return (
      <Show when={!locked()}>
        <div class="lead-agent-picker">
          <select
            aria-label="Lead agent"
            value={currentAgentId()}
            onChange={(event) => {
              const agentId = event.currentTarget.value;
              setDraftAgentByLeadId((prev) => ({
                ...prev,
                [props.session.id]: agentId,
              }));
            }}
          >
            <For each={agents()}>
              {(agent) => <option value={agent.id}>{agent.name}</option>}
            </For>
          </select>
        </div>
      </Show>
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
        <div class="agent-run-sidebar-header">
          <button
            type="button"
            class="agent-run-new-session"
            onClick={() => void createNewLeadSession()}
            disabled={!defaultAgent() || creatingLeadSession()}
          >
            + New session
          </button>
        </div>
        <div class="agent-run-sidebar-scroll">
          <Show
            when={sidebarCount() > 0}
            fallback={
              <div class="agent-run-empty">
                {loading() ? "Loading agent sessions…" : "No agent runs yet."}
              </div>
            }
          >
            {renderSidebarList()}
          </Show>
        </div>
      </aside>
      <section class="agent-run-chat">
        <Show
          when={activeSegment() === "lead"}
          fallback={
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
          }
        >
          <Show
            when={selectedLead()}
            fallback={
              <div class="agent-run-placeholder">No lead session selected.</div>
            }
          >
            {(session) => (
              <>
                <header class="agent-run-chat-header">
                  <div>
                    <div class="agent-run-chat-title">{session().title}</div>
                    <div class="agent-run-chat-meta">
                      <AgentBadge
                        agent={leadAgent(session())}
                        agentId={session().agentId}
                      />
                      <span>{formatLeadTime(session())}</span>
                    </div>
                  </div>
                  <div class="agent-run-actions">
                    <button type="button" onClick={() => void renameLead(session())}>
                      Rename
                    </button>
                    <button
                      type="button"
                      onClick={() => void archiveLead(session(), !session().archivedAt)}
                    >
                      {session().archivedAt ? "Unarchive" : "Archive"}
                    </button>
                    <Show when={!isLegacyLeadSession(session())}>
                      <button type="button" onClick={() => void deleteLead(session())}>
                        Delete
                      </button>
                    </Show>
                  </div>
                </header>
                <LeadComposerAgentPicker session={session()} />
                <ChatBody agentName={leadAgent(session())?.name ?? session().agentId} />
              </>
            )}
          </Show>
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

        .agent-run-sidebar-header {
          display: grid;
          gap: 8px;
          padding: 8px;
          border-bottom: 1px solid var(--border-default);
        }

        .agent-run-new-session {
          background: transparent;
          border: 1px solid var(--border-default);
          border-radius: 6px;
          color: var(--text-primary);
          min-height: 30px;
          text-align: left;
          padding: 0 10px;
          cursor: pointer;
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

        .lead-session-row {
          cursor: default;
        }

        .agent-run-row-main {
          width: 100%;
          padding: 0;
          border: 0;
          background: transparent;
          text-align: left;
          color: inherit;
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

        .agent-run-row-actions {
          position: absolute;
          top: 6px;
          right: 6px;
          display: flex;
          gap: 4px;
          opacity: 0;
          pointer-events: none;
          transition: opacity 120ms ease;
        }

        .agent-run-row-actions button {
          border: 1px solid var(--border-default);
          border-radius: 4px;
          background: var(--surface-default, #fff);
          color: var(--text-secondary);
          display: inline-grid;
          place-items: center;
          width: 22px;
          height: 22px;
          padding: 0;
          cursor: pointer;
        }

        .agent-run-row:hover .agent-run-row-actions,
        .agent-run-row:focus-within .agent-run-row-actions {
          opacity: 1;
          pointer-events: auto;
        }

        .agent-run-row-actions button:hover {
          color: var(--text-primary);
          border-color: var(--text-secondary);
        }

        .lead-agent-badge {
          display: inline-flex;
          align-items: center;
          min-width: 0;
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

        .lead-agent-picker {
          display: flex;
          align-items: center;
          gap: 8px;
          min-height: 42px;
          padding: 8px 20px 0;
          color: var(--text-secondary);
          font-size: 12px;
        }

        .lead-agent-picker select {
          border: 1px solid var(--border-default);
          border-radius: 6px;
          background: var(--surface-default, #fff);
          color: var(--text-primary);
          padding: 5px 8px;
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
                onClick={() => void stopSelectedChat()}
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
