// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import type { FullHistoryMessage, LeadSession, SubagentRun } from "@yoplai/shared/types";
import { AgentRunChatPanel } from "./AgentRunChatPanel";
import {
  createLeadSession,
  fetchLeadSessionTranscript,
  fetchLeadSessions,
  fetchRuntimeSubagentLogs,
  fetchRuntimeSubagents,
  patchLeadSession,
  postAbort,
  sendLeadSessionMessage,
  subscribeToLeadSessionChanges,
  uploadFiles,
} from "../api";

vi.mock("../api", () => ({
  fetchAgents: vi.fn(async () => [
    {
      id: "pom",
      name: "Pom",
      avatar: "/pom.png",
      model: { provider: "anthropic", model: "haiku" },
      isDefaultProjectManager: true,
    },
    {
      id: "driller",
      name: "SpecsDriller",
      model: { provider: "anthropic", model: "sonnet" },
    },
  ]),
  selectDefaultProjectManagerAgent: vi.fn((agents) => agents[0]),
  fetchLeadSessions: vi.fn(),
  createLeadSession: vi.fn(),
  patchLeadSession: vi.fn(),
  postAbort: vi.fn(async () => {}),
  deleteLeadSession: vi.fn(async () => ({ ok: true })),
  fetchLeadSessionTranscript: vi.fn(),
  sendLeadSessionMessage: vi.fn(),
  fetchRuntimeSubagents: vi.fn(),
  fetchRuntimeSubagentLogs: vi.fn(),
  resumeRuntimeSubagent: vi.fn(async () => ({ ok: true })),
  interruptRuntimeSubagent: vi.fn(async () => ({ ok: true })),
  archiveRuntimeSubagent: vi.fn(async () => ({ ok: true, data: {} })),
  deleteRuntimeSubagent: vi.fn(async () => ({ ok: true })),
  subscribeToFileChanges: vi.fn(() => () => {}),
  subscribeToSubagentChanges: vi.fn(() => () => {}),
  subscribeToLeadSessionChanges: vi.fn(() => () => {}),
  uploadFiles: vi.fn(async () => []),
}));

const fetchLeadSessionsMock = vi.mocked(fetchLeadSessions);
const fetchLeadTranscriptMock = vi.mocked(fetchLeadSessionTranscript);
const createLeadSessionMock = vi.mocked(createLeadSession);
const patchLeadSessionMock = vi.mocked(patchLeadSession);
const postAbortMock = vi.mocked(postAbort);
const sendLeadMock = vi.mocked(sendLeadSessionMessage);
const fetchRunsMock = vi.mocked(fetchRuntimeSubagents);
const fetchLogsMock = vi.mocked(fetchRuntimeSubagentLogs);
const subscribeLeadMock = vi.mocked(subscribeToLeadSessionChanges);
const uploadFilesMock = vi.mocked(uploadFiles);

function lead(overrides: Partial<LeadSession>): LeadSession {
  return {
    id: overrides.id ?? "lead:PRO-1:a",
    projectId: overrides.projectId ?? "PRO-1",
    sliceId: overrides.sliceId,
    agentId: overrides.agentId ?? "pom",
    kind: "lead",
    title: overrides.title ?? "Lead chat",
    titleLocked: overrides.titleLocked ?? false,
    createdAt: overrides.createdAt ?? "2026-05-13T10:00:00Z",
    updatedAt: overrides.updatedAt ?? "2026-05-13T10:01:00Z",
    archivedAt: overrides.archivedAt,
    transcriptRef: overrides.transcriptRef ?? "a",
  };
}

function run(overrides: Partial<SubagentRun>): SubagentRun {
  return {
    id: overrides.id ?? "run-1",
    label: overrides.label ?? "Worker",
    projectId: overrides.projectId ?? "PRO-1",
    cli: overrides.cli ?? "codex",
    cwd: overrides.cwd ?? "/tmp/pro",
    prompt: overrides.prompt ?? "Do work",
    status: overrides.status ?? "done",
    startedAt: overrides.startedAt ?? "2026-05-13T10:00:00Z",
    lastActiveAt: overrides.lastActiveAt ?? "2026-05-13T10:01:00Z",
    archived: overrides.archived,
    sliceId: overrides.sliceId,
  };
}

function userMessage(text: string): FullHistoryMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.parse("2026-05-13T10:00:00Z"),
  };
}

function assistantMessage(text: string): FullHistoryMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: Date.parse("2026-05-13T10:01:00Z"),
  };
}

let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.spyOn(Date, "now").mockReturnValue(
    new Date("2026-05-13T10:05:00Z").getTime()
  );
  vi.spyOn(window, "confirm").mockReturnValue(true);
  vi.spyOn(window, "prompt").mockReturnValue("Renamed");
  fetchRunsMock.mockResolvedValue({ items: [] });
  fetchLogsMock.mockResolvedValue({ cursor: 0, events: [] });
  fetchLeadSessionsMock.mockImplementation(async (_projectId, options = {}) => ({
    items: options.archived ? [] : [],
  }));
  fetchLeadTranscriptMock.mockResolvedValue({ messages: [] });
  sendLeadMock.mockImplementation(async (id) => ({
    session: lead({ id, updatedAt: "2026-05-13T10:02:00Z" }),
    result: {},
  }));
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.removeChild(container);
});

describe("AgentRunChatPanel lead sessions", () => {
  it("defaults to Lead when any non-archived lead exists and filters mixed scope responses", async () => {
    const projectLead = lead({ id: "lead:PRO-1:project", title: "Project lead" });
    const sliceLead = lead({
      id: "lead:PRO-1:slice",
      title: "Slice lead",
      sliceId: "PRO-1-S01",
    });
    fetchLeadSessionsMock.mockImplementation(async (_projectId, options = {}) => ({
      items: options.archived ? [] : [projectLead, sliceLead],
    }));
    fetchLeadTranscriptMock.mockImplementation(async (id) => ({
      messages: id === projectLead.id ? [userMessage("project scope")] : [],
    }));
    fetchRunsMock.mockResolvedValue({ items: [run({ id: "run-visible" })] });
    fetchLogsMock.mockResolvedValue({
      cursor: 1,
      events: [{ type: "assistant", text: "visible run" }],
    });

    render(() => <AgentRunChatPanel projectId="PRO-1" />, container);

    await vi.waitFor(() => {
      expect(container.textContent).toContain("Project lead");
      expect(container.textContent).toContain("Worker");
    });
    expect(container.querySelector("[role='tablist']")).toBeNull();
    expect(container.textContent).toContain("Lead chats");
    expect(container.textContent).toContain("Subagents");
    expect(container.textContent).not.toContain("Slice lead");
    expect(container.textContent).toContain("+ New session");
    expect(container.textContent).toContain("project scope");
    expect(container.querySelector(".lead-agent-badge img")).toBeNull();
  });

  it("honors lead over run URL params, falls back from stale lead to valid run, and writes last viewed", async () => {
    const selected = lead({ id: "lead:PRO-1:selected", title: "Selected lead" });
    fetchLeadSessionsMock.mockResolvedValue({ items: [selected] });
    fetchLeadTranscriptMock.mockResolvedValue({ messages: [userMessage("hello")] });
    fetchRunsMock.mockResolvedValue({ items: [run({ id: "run-1" })] });
    fetchLogsMock.mockResolvedValue({
      cursor: 1,
      events: [{ type: "assistant", text: "run text" }],
    });

    render(
      () => (
        <AgentRunChatPanel
          projectId="PRO-1"
          selectedLeadId="lead:PRO-1:selected"
          selectedRunId="run-1"
        />
      ),
      container
    );
    await vi.waitFor(() => expect(container.textContent).toContain("hello"));
    expect(container.querySelector(".agent-run-chat")?.textContent).not.toContain(
      "run text"
    );

    document.body.removeChild(container);
    container = document.createElement("div");
    document.body.appendChild(container);
    render(
      () => (
        <AgentRunChatPanel
          projectId="PRO-1"
          selectedLeadId="missing"
          selectedRunId="run-1"
        />
      ),
      container
    );
    await vi.waitFor(() => expect(container.textContent).toContain("run text"));

    document.body.removeChild(container);
    container = document.createElement("div");
    document.body.appendChild(container);
    localStorage.setItem("lead-session:lastViewed:PRO-1:PRO-1-S01", selected.id);
    render(
      () => (
        <AgentRunChatPanel projectId="PRO-1" sliceId="PRO-1-S01" />
      ),
      container
    );
    await vi.waitFor(() =>
      expect(localStorage.getItem("lead-session:lastViewed:PRO-1:PRO-1-S01")).toBe(
        selected.id
      )
    );
  });

  it("creates with default manager after selecting a non-default lead", async () => {
    const nonDefault = lead({
      id: "lead:PRO-1:driller",
      agentId: "driller",
      title: "Driller",
    });
    const created = lead({ id: "lead:PRO-1:new", agentId: "pom" });
    fetchLeadSessionsMock.mockResolvedValue({ items: [nonDefault] });
    createLeadSessionMock.mockResolvedValue(created);

    render(() => <AgentRunChatPanel projectId="PRO-1" />, container);
    await vi.waitFor(() => expect(container.textContent).toContain("Driller"));
    (container.querySelector(".agent-run-row-main") as HTMLButtonElement).click();
    (
      [...container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("+ New session")
      ) as HTMLButtonElement
    ).click();

    await vi.waitFor(() =>
      expect(createLeadSessionMock).toHaveBeenCalledWith("PRO-1", {
        agentId: "pom",
      })
    );
  });

  it("does not duplicate a session row when New session returns an existing id", async () => {
    const existing = lead({ id: "lead:PRO-1:existing", title: "Existing" });
    fetchLeadSessionsMock.mockResolvedValue({ items: [existing] });
    createLeadSessionMock.mockResolvedValue({
      ...existing,
      title: "Existing refreshed",
      updatedAt: "2026-05-13T10:06:00Z",
    });

    render(() => <AgentRunChatPanel projectId="PRO-1" />, container);
    await vi.waitFor(() => expect(container.textContent).toContain("Existing"));
    (
      [...container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("+ New session")
      ) as HTMLButtonElement
    ).click();

    await vi.waitFor(() =>
      expect(container.textContent).toContain("Existing refreshed")
    );
    const rows = [...container.querySelectorAll(".lead-session-row")].filter((row) =>
      row.textContent?.includes("Existing")
    );
    expect(rows).toHaveLength(1);
  });

  it("locks the agent picker for existing transcripts and sends one message with files", async () => {
    const session = lead({ id: "lead:PRO-1:locked", agentId: "pom" });
    fetchLeadSessionsMock.mockResolvedValue({ items: [session] });
    fetchLeadTranscriptMock.mockResolvedValue({ messages: [userMessage("started")] });
    uploadFilesMock.mockResolvedValue([
      { path: "media/a", filename: "a.txt", mimeType: "text/plain", size: 3 },
    ]);

    render(() => <AgentRunChatPanel projectId="PRO-1" />, container);
    await vi.waitFor(() => expect(container.textContent).toContain("started"));
    expect(container.querySelector("select[aria-label='Lead agent']")).toBeNull();
    expect(container.querySelector(".lead-agent-picker")).toBeNull();

    const fileInput = container.querySelector(".board-file-input") as HTMLInputElement;
    Object.defineProperty(fileInput, "files", {
      value: [new File(["abc"], "a.txt", { type: "text/plain" })],
      configurable: true,
    });
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    const input = container.querySelector(".board-chat-input") as HTMLTextAreaElement;
    input.value = "send once";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    (container.querySelector(".board-chat-send") as HTMLButtonElement).click();

    await vi.waitFor(() => expect(sendLeadMock).toHaveBeenCalledTimes(1));
    expect(sendLeadMock).toHaveBeenCalledWith(session.id, {
      content: "send once\n\nAttachment: media/a",
      files: [
        { path: "media/a", filename: "a.txt", mimeType: "text/plain", size: 3 },
      ],
    });
  });

  it("shows the board chat thinking state while a lead agent reply is pending", async () => {
    const session = lead({ id: "lead:PRO-1:thinking", agentId: "pom" });
    let resolveSend:
      | ((value: Awaited<ReturnType<typeof sendLeadSessionMessage>>) => void)
      | undefined;
    fetchLeadSessionsMock.mockResolvedValue({ items: [session] });
    fetchLeadTranscriptMock.mockResolvedValue({
      messages: [userMessage("started"), assistantMessage("previous reply")],
    });
    sendLeadMock.mockImplementation(
      async (id) =>
        new Promise((resolve) => {
          resolveSend = resolve;
        }).then(() => ({
          session: lead({ id, updatedAt: "2026-05-13T10:02:00Z" }),
          result: {},
        }))
    );

    render(() => <AgentRunChatPanel projectId="PRO-1" />, container);
    await vi.waitFor(() =>
      expect(container.textContent).toContain("previous reply")
    );
    const input = container.querySelector(
      ".board-chat-input"
    ) as HTMLTextAreaElement;
    input.value = "think please";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    (container.querySelector(".board-chat-send") as HTMLButtonElement).click();

    await vi.waitFor(() => {
      expect(container.textContent).toContain("Pom");
      expect(container.textContent).toContain("Thinking");
    });
    expect(container.querySelector(".board-msg-thinking")).not.toBeNull();
    expect(container.textContent).toContain("thinking-pulse");
    expect(
      container.querySelector<HTMLButtonElement>(".board-chat-stop")
    ).not.toBeNull();
    container
      .querySelector<HTMLButtonElement>(".board-chat-stop")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() =>
      expect(postAbortMock).toHaveBeenCalledWith("pom", session.transcriptRef)
    );
    const pendingUserMessage = [...container.querySelectorAll(".board-msg-user")]
      .find((item) => item.textContent?.includes("You (sending)"));
    expect(pendingUserMessage?.querySelector("svg")).not.toBeNull();
    const messages = container.querySelector(
      ".agent-run-chat-messages"
    ) as HTMLDivElement;
    expect(getComputedStyle(messages).display).toBe("flex");
    expect(getComputedStyle(messages).flexDirection).toBe("column");
    expect(getComputedStyle(messages).gap).toBe("24px");

    resolveSend?.({
      session: lead({ id: session.id, updatedAt: "2026-05-13T10:02:00Z" }),
      result: {},
    });
  });

  it("renames, archives, hides delete for legacy rows, and reconciles websocket events", async () => {
    const session = lead({ id: "lead:PRO-1:a", title: "Original" });
    const legacy = lead({
      id: "lead:PRO-1:legacy:pom",
      title: "Main",
      agentId: "pom",
    });
    fetchLeadSessionsMock.mockResolvedValue({ items: [session, legacy] });
    patchLeadSessionMock.mockImplementation(async (id, patch) =>
      lead({
        id,
        title: patch.title ?? "Original",
        archivedAt: patch.archived ? "2026-05-13T10:02:00Z" : undefined,
      })
    );

    render(() => <AgentRunChatPanel projectId="PRO-1" />, container);
    await vi.waitFor(() => expect(container.textContent).toContain("Original"));
    (
      container.querySelector(
        "button[aria-label='Rename lead session']"
      ) as HTMLButtonElement
    ).click();
    await vi.waitFor(() =>
      expect(patchLeadSessionMock).toHaveBeenCalledWith(session.id, {
        title: "Renamed",
      })
    );

    const legacyRow = [...container.querySelectorAll(".lead-session-row")].find(
      (row) => row.textContent?.includes("Main")
    );
    expect(legacyRow?.textContent).not.toContain("Delete");
    const actionButtons = container.querySelectorAll(
      ".lead-session-row .agent-run-row-actions button"
    );
    expect(actionButtons[0]?.textContent).toBe("");
    expect(actionButtons[0]?.getAttribute("aria-label")).toBe(
      "Rename lead session"
    );
    expect(container.textContent).not.toContain("ArchiveDelete");

    const callbacks = subscribeLeadMock.mock.calls[0]?.[0];
    callbacks?.onLeadSessionChanged?.({
      type: "lead_session_changed",
      kind: "updated",
      session: lead({ id: session.id, title: "WS title" }),
    });
    await vi.waitFor(() => expect(container.textContent).toContain("WS title"));
    callbacks?.onLeadSessionChanged?.({
      type: "lead_session_changed",
      kind: "archived",
      session: lead({
        id: session.id,
        title: "WS title",
        archivedAt: "2026-05-13T10:02:00Z",
      }),
    });
    await vi.waitFor(() => expect(container.textContent).toContain("Archived"));
    callbacks?.onLeadSessionChanged?.({
      type: "lead_session_changed",
      kind: "deleted",
      session,
    });
    await vi.waitFor(() => expect(container.textContent).not.toContain("WS title"));
  });

  it("keeps per-session draft agent choices isolated", async () => {
    const first = lead({ id: "lead:PRO-1:first", agentId: "pom", title: "First" });
    const second = lead({ id: "lead:PRO-1:second", agentId: "pom", title: "Second" });
    fetchLeadSessionsMock.mockResolvedValue({ items: [first, second] });
    fetchLeadTranscriptMock.mockResolvedValue({ messages: [] });

    const [selected, setSelected] = createSignal<string | undefined>(first.id);
    render(
      () => (
        <AgentRunChatPanel
          projectId="PRO-1"
          selectedLeadId={selected()}
          onSelectedLeadIdChange={setSelected}
        />
      ),
      container
    );
    await vi.waitFor(() => expect(container.textContent).toContain("First"));
    expect(
      container.querySelectorAll(".lead-agent-picker .lead-agent-badge")
    ).toHaveLength(0);
    const select = container.querySelector(
      "select[aria-label='Lead agent']"
    ) as HTMLSelectElement;
    select.value = "driller";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    setSelected(second.id);
    await vi.waitFor(() => expect(container.textContent).toContain("Second"));
    const input = container.querySelector(".board-chat-input") as HTMLTextAreaElement;
    input.value = "second message";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    (container.querySelector(".board-chat-send") as HTMLButtonElement).click();

    await vi.waitFor(() =>
      expect(sendLeadMock).toHaveBeenCalledWith(second.id, {
        content: "second message",
        agentId: "pom",
      })
    );
  });
});
