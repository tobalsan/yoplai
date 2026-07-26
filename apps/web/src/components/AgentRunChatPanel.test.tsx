// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import type { SubagentRun } from "@yoplai/shared/types";
import { AgentRunChatPanel } from "./AgentRunChatPanel";
import {
  archiveRuntimeSubagent,
  deleteRuntimeSubagent,
  fetchAgents,
  fetchLeadSessionTranscript,
  fetchLeadSessions,
  fetchRuntimeSubagentLogs,
  fetchRuntimeSubagents,
  interruptRuntimeSubagent,
  resumeRuntimeSubagent,
  subscribeToSubagentChanges,
} from "../api";

vi.mock("../api", () => ({
  fetchAgents: vi.fn(async () => [
    {
      id: "pom",
      name: "Pom",
      model: { provider: "anthropic", model: "claude" },
      isDefaultProjectManager: true,
    },
  ]),
  selectDefaultProjectManagerAgent: vi.fn((agents) => agents[0]),
  fetchLeadSessions: vi.fn(async () => ({ items: [] })),
  createLeadSession: vi.fn(),
  patchLeadSession: vi.fn(),
  deleteLeadSession: vi.fn(),
  fetchLeadSessionTranscript: vi.fn(async () => ({ messages: [] })),
  sendLeadSessionMessage: vi.fn(),
  fetchRuntimeSubagents: vi.fn(),
  fetchRuntimeSubagentLogs: vi.fn(),
  resumeRuntimeSubagent: vi.fn(),
  interruptRuntimeSubagent: vi.fn(async () => ({ ok: true, data: {} })),
  postAbort: vi.fn(async () => {}),
  archiveRuntimeSubagent: vi.fn(async () => ({ ok: true, data: {} })),
  deleteRuntimeSubagent: vi.fn(async () => ({ ok: true })),
  subscribeToFileChanges: vi.fn(() => () => {}),
  subscribeToSubagentChanges: vi.fn(() => () => {}),
  subscribeToLeadSessionChanges: vi.fn(() => () => {}),
  uploadFiles: vi.fn(async () => []),
}));

const fetchAgentsMock = vi.mocked(fetchAgents);
const fetchLeadSessionsMock = vi.mocked(fetchLeadSessions);
const fetchLeadTranscriptMock = vi.mocked(fetchLeadSessionTranscript);
const fetchRunsMock = vi.mocked(fetchRuntimeSubagents);
const fetchLogsMock = vi.mocked(fetchRuntimeSubagentLogs);
const resumeMock = vi.mocked(resumeRuntimeSubagent);
const interruptMock = vi.mocked(interruptRuntimeSubagent);
const archiveMock = vi.mocked(archiveRuntimeSubagent);
const deleteMock = vi.mocked(deleteRuntimeSubagent);
const subscribeToSubagentChangesMock = vi.mocked(subscribeToSubagentChanges);

function run(overrides: Partial<SubagentRun>): SubagentRun {
  return {
    id: overrides.id ?? "run-1",
    label: overrides.label ?? "RepoSetter",
    projectId: overrides.projectId ?? "PRO-1",
    cli: overrides.cli ?? "codex",
    cwd: overrides.cwd ?? "/tmp/pro",
    prompt: overrides.prompt ?? "Do work",
    status: overrides.status ?? "done",
    startedAt: overrides.startedAt ?? "2026-05-13T10:00:00Z",
    lastActiveAt: overrides.lastActiveAt ?? "2026-05-13T10:01:00Z",
    archived: overrides.archived,
    latestOutput: overrides.latestOutput,
    sliceId: overrides.sliceId,
    model: overrides.model,
  };
}

let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(
    new Date("2026-05-13T10:05:00Z").getTime()
  );
  vi.spyOn(window, "confirm").mockReturnValue(true);
  fetchAgentsMock.mockResolvedValue([
    {
      id: "pom",
      name: "Pom",
      model: { provider: "anthropic", model: "claude" },
      isDefaultProjectManager: true,
    },
  ]);
  fetchLeadSessionsMock.mockResolvedValue({ items: [] });
  fetchLeadTranscriptMock.mockResolvedValue({ messages: [] });
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.removeChild(container);
});

describe("AgentRunChatPanel", () => {
  it("auto-selects the newest visible run and renders sidebar excerpts without refresh or raw logs", async () => {
    fetchRunsMock.mockResolvedValue({
      items: [
        run({
          id: "setup-only",
          label: "RepoSetter",
          startedAt: "2026-05-13T10:03:00Z",
          lastActiveAt: "2026-05-13T10:03:00Z",
        }),
        run({
          id: "visible-run",
          label: "RepoSetter",
          startedAt: "2026-05-13T10:02:00Z",
          lastActiveAt: "2026-05-13T10:02:00Z",
        }),
      ],
    });
    fetchLogsMock.mockImplementation(async (runId) => ({
      cursor: 1,
      events:
        runId === "visible-run"
          ? [{ type: "assistant", text: "Latest useful transcript line" }]
          : [{ type: "stdout", text: '{"type":"thread.started"}' }],
    }));
    const [selected, setSelected] = createSignal<string | undefined>();
    const selectedCalls: Array<string | undefined> = [];

    render(
      () => (
        <AgentRunChatPanel
          projectId="PRO-1"
          selectedRunId={selected()}
          onSelectedRunIdChange={(runId) => {
            selectedCalls.push(runId);
            setSelected(runId);
          }}
        />
      ),
      container
    );

    await vi.waitFor(() => {
      expect(container.textContent).toContain("Latest useful transcript line");
    });

    expect(selectedCalls).toContain("visible-run");
    expect(container.textContent).toContain("RepoSetter");
    expect(container.textContent).toContain("Latest useful transcript line");
    expect(container.querySelector("[role='tablist']")).toBeNull();
    expect(getComputedStyle(
      container.querySelector(".agent-run-sidebar-scroll") as HTMLElement
    ).overflow).toBe("auto");
    expect(container.textContent).not.toContain("Refresh");
    expect(container.textContent).not.toContain("Raw logs");
  });

  it("shows a running run with no visible transcript and its Stop control", async () => {
    fetchRunsMock.mockResolvedValue({
      items: [
        run({
          id: "starting-run",
          label: "Worker",
          status: "running",
        }),
      ],
    });
    fetchLogsMock.mockResolvedValue({
      cursor: 1,
      events: [{ type: "stdout", text: '{"type":"thread.started"}' }],
    });
    const [selected, setSelected] = createSignal<string | undefined>();

    render(
      () => (
        <AgentRunChatPanel
          projectId="PRO-1"
          selectedRunId={selected()}
          onSelectedRunIdChange={setSelected}
        />
      ),
      container
    );

    await vi.waitFor(() => {
      expect(container.textContent).toContain("Worker");
      expect(container.textContent).toContain("No visible transcript");
      expect(container.textContent).toContain("Thinking");
    });

    expect(container.textContent).not.toContain("No agent runs yet.");
    const stopButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Stop"
    ) as HTMLButtonElement | undefined;
    expect(stopButton).toBeDefined();
    expect(stopButton?.disabled).toBe(false);
    const composerStop = container.querySelector<HTMLButtonElement>(
      ".board-chat-stop"
    );
    expect(composerStop).not.toBeNull();
    composerStop?.click();
    await vi.waitFor(() =>
      expect(interruptMock).toHaveBeenCalledWith("starting-run")
    );
  });

  it("expands archived deep links and clears selection after archive/delete", async () => {
    fetchRunsMock.mockResolvedValue({
      items: [
        run({ id: "active-run", label: "Worker" }),
        run({ id: "archived-run", label: "RepoSetter", archived: true }),
      ],
    });
    fetchLogsMock.mockImplementation(async (runId) => ({
      cursor: 1,
      events: [{ type: "assistant", text: `${runId} visible message` }],
    }));
    const [selected, setSelected] = createSignal<string | undefined>(
      "archived-run"
    );
    const selectedCalls: Array<string | undefined> = [];

    render(
      () => (
        <AgentRunChatPanel
          projectId="PRO-1"
          selectedRunId={selected()}
          onSelectedRunIdChange={(runId) => {
            selectedCalls.push(runId);
            setSelected(runId);
          }}
        />
      ),
      container
    );

    await vi.waitFor(() => {
      expect(container.textContent).toContain("archived-run visible message");
    });
    expect(container.textContent).toContain("Archived");
    expect(container.textContent).toContain("RepoSetter");

    (
      [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Archive"
      ) as HTMLButtonElement
    ).click();
    await vi.waitFor(() => expect(archiveMock).toHaveBeenCalledWith("archived-run"));
    expect(selectedCalls.at(-1)).toBeUndefined();

    setSelected("active-run");
    await vi.waitFor(() =>
      expect(container.textContent).toContain("active-run visible message")
    );
    (
      [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Delete"
      ) as HTMLButtonElement
    ).click();
    await vi.waitFor(() => expect(deleteMock).toHaveBeenCalledWith("active-run"));
    expect(selectedCalls.at(-1)).toBeUndefined();
  });

  it("queues a visible pending message when sending to a running run", async () => {
    fetchRunsMock.mockResolvedValue({
      items: [run({ id: "running-run", status: "running", label: "Worker" })],
    });
    fetchLogsMock.mockResolvedValue({
      cursor: 1,
      events: [{ type: "assistant", text: "Ready for follow up" }],
    });

    render(
      () => <AgentRunChatPanel projectId="PRO-1" selectedRunId="running-run" />,
      container
    );

    await vi.waitFor(() => {
      expect(container.textContent).toContain("Ready for follow up");
    });
    const input = container.querySelector(
      ".board-chat-input"
    ) as HTMLTextAreaElement;
    input.value = "Please continue";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    (
      container.querySelector(".board-chat-send") as HTMLButtonElement
    ).click();

    await vi.waitFor(() => {
      expect(container.textContent).toContain("Please continue");
      expect(container.textContent).toContain("You (queued)");
    });
    expect(resumeMock).not.toHaveBeenCalled();
  });

  it("reloads runs and logs when a subagent change event arrives", async () => {
    fetchRunsMock
      .mockResolvedValueOnce({
        items: [run({ id: "live-run", status: "done", label: "Worker" })],
      })
      .mockResolvedValueOnce({
        items: [run({ id: "live-run", status: "running", label: "Worker" })],
      });
    fetchLogsMock
      .mockResolvedValueOnce({
        cursor: 1,
        events: [{ type: "assistant", text: "Old transcript" }],
      })
      .mockResolvedValueOnce({
        cursor: 2,
        events: [{ type: "assistant", text: "Streaming update" }],
      });

    render(
      () => <AgentRunChatPanel projectId="PRO-1" selectedRunId="live-run" />,
      container
    );

    await vi.waitFor(() => {
      expect(container.textContent).toContain("Old transcript");
    });

    const callbacks = subscribeToSubagentChangesMock.mock.calls[0]?.[0];
    callbacks?.onSubagentChanged?.({ runId: "live-run", status: "running" });

    await vi.waitFor(() => {
      expect(container.textContent).toContain("Streaming update");
    });
    const stopButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Stop"
    ) as HTMLButtonElement | undefined;
    expect(stopButton?.disabled).toBe(false);
  });

  it("keeps the run list and conversation as independent scroll regions", async () => {
    fetchRunsMock.mockResolvedValue({
      items: [run({ id: "scroll-run", label: "Worker" })],
    });
    fetchLogsMock.mockResolvedValue({
      cursor: 1,
      events: [{ type: "assistant", text: "Long transcript" }],
    });

    render(
      () => <AgentRunChatPanel projectId="PRO-1" selectedRunId="scroll-run" />,
      container
    );

    await vi.waitFor(() => {
      expect(container.textContent).toContain("Long transcript");
    });

    const panel = container.querySelector(
      ".agent-run-chat-panel"
    ) as HTMLElement;
    const list = container.querySelector(
      ".agent-run-sidebar-scroll"
    ) as HTMLElement;
    const transcript = container.querySelector(
      ".agent-run-chat-messages"
    ) as HTMLElement;

    expect(panel.style.height).toBe("100%");
    expect(panel.style.overflow).toBe("hidden");
    expect(getComputedStyle(list).overflow).toBe("auto");
    expect(transcript.style.overflow).toBe("auto");
  });

  it("uses the board home composer structure and labels", async () => {
    fetchRunsMock.mockResolvedValue({
      items: [run({ id: "composer-run", label: "Worker" })],
    });
    fetchLogsMock.mockResolvedValue({
      cursor: 1,
      events: [{ type: "assistant", text: "Ready" }],
    });

    render(
      () => <AgentRunChatPanel projectId="PRO-1" selectedRunId="composer-run" />,
      container
    );

    await vi.waitFor(() => {
      expect(container.textContent).toContain("Ready");
    });

    const input = container.querySelector(
      ".board-chat-input"
    ) as HTMLTextAreaElement;
    const attach = container.querySelector(
      ".board-chat-attach"
    ) as HTMLButtonElement;
    const fileInput = container.querySelector(
      ".board-file-input"
    ) as HTMLInputElement;
    const send = container.querySelector(".board-chat-send") as HTMLButtonElement;

    expect(input.placeholder).toBe("Ask anything...");
    expect(input.rows).toBe(1);
    expect(attach.getAttribute("aria-label")).toBe("Attach files");
    expect(fileInput).not.toBeNull();
    expect(send.getAttribute("aria-label")).toBe("Send message");
    expect(send.textContent?.trim()).toBe("");
    expect(container.textContent).toContain(
      "Enter to send, Shift+Enter for new line"
    );
  });

  it("scrolls the selected conversation to the most recent message on load", async () => {
    const scrollHeightSpy = vi
      .spyOn(HTMLElement.prototype, "scrollHeight", "get")
      .mockImplementation(function scrollHeight(this: HTMLElement) {
        return this.classList.contains("agent-run-chat-messages") ? 900 : 0;
      });
    fetchRunsMock.mockResolvedValue({
      items: [run({ id: "history-run", label: "Worker" })],
    });
    fetchLogsMock.mockResolvedValue({
      cursor: 1,
      events: Array.from({ length: 20 }, (_, index) => ({
        type: "assistant",
        text: `Message ${index}`,
      })),
    });

    render(
      () => <AgentRunChatPanel projectId="PRO-1" selectedRunId="history-run" />,
      container
    );

    await vi.waitFor(() => {
      expect(container.textContent).toContain("Message 19");
    });

    const transcript = container.querySelector(
      ".agent-run-chat-messages"
    ) as HTMLElement;
    await vi.waitFor(() => {
      expect(transcript.scrollTop).toBe(900);
    });
    scrollHeightSpy.mockRestore();
  });
});
