// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { delegateEvents, render } from "solid-js/web";
import { AgentChat, __resetAgentChatStateForTests } from "./AgentChat";

const {
  fetchFullHistoryMock,
  fetchSubagentsMock,
  fetchSubagentLogsMock,
  getSessionKeyMock,
  spawnSubagentMock,
  streamMessageMock,
  subscribeToSessionMock,
  uploadFilesMock,
  interruptSubagentMock,
  killSubagentMock,
  archiveSubagentMock,
} = vi.hoisted(() => ({
  fetchFullHistoryMock: vi.fn(),
  fetchSubagentsMock: vi.fn(),
  fetchSubagentLogsMock: vi.fn(),
  getSessionKeyMock: vi.fn(),
  spawnSubagentMock: vi.fn(),
  streamMessageMock: vi.fn(),
  subscribeToSessionMock: vi.fn(),
  uploadFilesMock: vi.fn(),
  interruptSubagentMock: vi.fn(),
  killSubagentMock: vi.fn(),
  archiveSubagentMock: vi.fn(),
}));

vi.mock("../api", () => ({
  fetchFullHistory: fetchFullHistoryMock,
  fetchSubagents: fetchSubagentsMock,
  fetchSubagentLogs: fetchSubagentLogsMock,
  getSessionKey: getSessionKeyMock,
  spawnSubagent: spawnSubagentMock,
  streamMessage: streamMessageMock,
  subscribeToSession: subscribeToSessionMock,
  uploadFiles: uploadFilesMock,
  interruptSubagent: interruptSubagentMock,
  killSubagent: killSubagentMock,
  archiveSubagent: archiveSubagentMock,
}));

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function renderLead(options?: {
  hidden?: boolean;
  sessionKey?: string;
  sessionNonce?: number | null;
}) {
  const container = document.createElement("div");
  if (options?.hidden) container.setAttribute("aria-hidden", "true");
  document.body.appendChild(container);
  const dispose = render(
    () => (
      <AgentChat
        agentId="lead-1"
        agentName="Lead"
        agentType="lead"
        sessionKey={options?.sessionKey}
        sessionNonce={options?.sessionNonce}
        onBack={() => {}}
      />
    ),
    container
  );
  return { container, dispose };
}

function renderSubagent(status: "running" | "idle" = "idle") {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const [currentStatus, setStatus] = createSignal(status);
  const dispose = render(
    () => (
      <AgentChat
        agentId={null}
        agentName="Worker"
        agentType="subagent"
        subagentInfo={{
          projectId: "PRO-1",
          slug: "worker-1",
          cli: "codex",
          runMode: "clone",
          status: currentStatus(),
        }}
        onBack={() => {}}
      />
    ),
    container
  );
  return { container, dispose, setStatus };
}

describe("AgentChat stop/send behavior", () => {
  beforeEach(() => {
    __resetAgentChatStateForTests();
    delegateEvents(["click", "input", "keydown"]);
    fetchFullHistoryMock.mockResolvedValue({ messages: [] });
    fetchSubagentsMock.mockResolvedValue({ ok: true, data: { items: [] } });
    fetchSubagentLogsMock.mockResolvedValue({
      ok: true,
      data: { cursor: 0, events: [] },
    });
    getSessionKeyMock.mockReturnValue("main");
    spawnSubagentMock.mockResolvedValue({
      ok: true,
      data: { slug: "worker-1" },
    });
    streamMessageMock.mockImplementation(
      (
        _agentId: string,
        _message: string,
        _sessionKey: string,
        _onText: (text: string) => void,
        _onDone: () => void,
        _onError: (error: string) => void
      ) =>
        () => {}
    );
    subscribeToSessionMock.mockImplementation(() => () => {});
    uploadFilesMock.mockResolvedValue([]);
    interruptSubagentMock.mockResolvedValue({
      ok: true,
      data: { slug: "worker-1" },
    });
    killSubagentMock.mockResolvedValue({
      ok: true,
      data: { slug: "worker-1" },
    });
    archiveSubagentMock.mockResolvedValue({
      ok: true,
      data: { slug: "worker-1", archived: true },
    });
  });

  afterEach(() => {
    __resetAgentChatStateForTests();
    vi.useRealTimers();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("shows Stop when subagent status is running", async () => {
    const { container, dispose } = renderSubagent("running");
    await tick();

    expect(container.querySelector(".stop-btn")).not.toBeNull();
    expect(container.querySelector(".send-btn")).not.toBeNull();
    expect(
      (container.querySelector("textarea") as HTMLTextAreaElement).disabled
    ).toBe(false);

    dispose();
  });

  it("focuses the textarea on mount", async () => {
    const { container, dispose } = renderLead();
    await tick();
    await tick();

    expect(document.activeElement).toBe(
      container.querySelector("textarea") as HTMLTextAreaElement
    );

    dispose();
  });

  it("starts a new session on Cmd+K", async () => {
    const { dispose } = renderLead();
    await tick();
    await tick();

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", metaKey: true })
    );
    await tick();

    expect(streamMessageMock).toHaveBeenCalledWith(
      "lead-1",
      "/new",
      "main",
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
      expect.any(Object),
      expect.anything()
    );

    dispose();
  });

  it("ignores global shortcuts while hidden", async () => {
    const { dispose } = renderLead({ hidden: true });
    await tick();
    await tick();

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", metaKey: true })
    );
    await tick();

    expect(streamMessageMock).not.toHaveBeenCalled();

    dispose();
  });

  it("includes cache tokens in lead context usage estimate", async () => {
    fetchFullHistoryMock.mockResolvedValue({
      messages: [
        {
          role: "assistant",
          timestamp: Date.now(),
          content: [{ type: "text", text: "done" }],
          meta: {
            model: "claude-3-5-sonnet",
            usage: {
              input: 1000,
              output: 50,
              cacheRead: 39000,
              cacheWrite: 0,
              totalTokens: 40050,
            },
          },
        },
      ],
    });

    const { container, dispose } = renderLead();
    await tick();
    await tick();

    expect(container.querySelector(".context-usage")?.textContent).toContain(
      "~20% context used"
    );

    dispose();
  });

  it("renders shorter lead histories without virtualization", async () => {
    fetchFullHistoryMock.mockResolvedValue({
      messages: Array.from({ length: 50 }, (_, index) => ({
        role: "user",
        timestamp: index + 1,
        content: [{ type: "text", text: `message ${index}` }],
      })),
    });

    const { container, dispose } = renderLead();
    await tick();
    await tick();

    expect(container.querySelectorAll(".log-virtual-row")).toHaveLength(0);

    dispose();
  });

  it("virtualizes long lead histories", async () => {
    fetchFullHistoryMock.mockResolvedValue({
      messages: Array.from({ length: 200 }, (_, index) => ({
        role: "user",
        timestamp: index + 1,
        content: [{ type: "text", text: `message ${index}` }],
      })),
    });

    const { container, dispose } = renderLead();
    await tick();
    await tick();

    expect(container.querySelectorAll(".log-virtual-row").length).toBeLessThan(
      200
    );

    dispose();
  });

  it("shows pending spinner and live updates for a fresh lead session", async () => {
    let callbacks:
      | {
          onToolCall?: (id: string, name: string, args: unknown) => void;
          onText?: (text: string) => void;
        }
      | undefined;
    subscribeToSessionMock.mockImplementation(
      (_agentId: string, _sessionKey: string, nextCallbacks) => {
        callbacks = nextCallbacks;
        return () => {};
      }
    );
    fetchFullHistoryMock.mockResolvedValue({ messages: [] });

    const { container, dispose } = renderLead({
      sessionKey: "project:PRO-1:lead-1",
      sessionNonce: Date.now(),
    });
    await tick();
    await tick();

    expect(container.querySelector(".log-line.pending")).not.toBeNull();

    callbacks?.onToolCall?.("tool-1", "read", { path: "README.md" });
    callbacks?.onText?.("Working...");
    await tick();
    await tick();

    expect(fetchFullHistoryMock).toHaveBeenCalledWith(
      "lead-1",
      "project:PRO-1:lead-1"
    );
    expect(container.textContent).toContain("Working...");
    expect(container.querySelector(".log-line.pending")).toBeNull();

    dispose();
  });

  it("does not duplicate streamed lead text when mid-run history already has assistant output", async () => {
    let historyCallCount = 0;
    fetchFullHistoryMock.mockImplementation(async () => {
      historyCallCount += 1;
      if (historyCallCount === 1) {
        return { messages: [] };
      }
      return {
        messages: [
          {
            role: "user",
            timestamp: 1,
            content: [{ type: "text", text: "Investigate" }],
          },
          {
            role: "assistant",
            timestamp: 2,
            content: [{ type: "text", text: "Working..." }],
          },
        ],
      };
    });

    let callbacks:
      | {
          onText?: (text: string) => void;
        }
      | undefined;
    subscribeToSessionMock.mockImplementation(
      (
        _agentId: string,
        _sessionKey: string,
        nextCallbacks: typeof callbacks
      ) => {
        callbacks = nextCallbacks;
        return () => {};
      }
    );

    const { container, dispose } = renderLead({
      sessionKey: "project:PRO-1:lead-1",
      sessionNonce: Date.now(),
    });

    await tick();
    await tick();

    callbacks?.onText?.("Working...");
    await tick();
    await tick();

    const assistantBodies = Array.from(
      container.querySelectorAll(".log-line.assistant .log-text")
    ).map((node) => node.textContent ?? "");
    expect(assistantBodies).toEqual(["Working..."]);

    dispose();
  });

  it("reloads lead history when sessionKey changes", async () => {
    fetchFullHistoryMock
      .mockResolvedValueOnce({
        messages: [
          {
            role: "user",
            timestamp: 1,
            content: [{ type: "text", text: "old history" }],
          },
        ],
      })
      .mockResolvedValueOnce({ messages: [] });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const [sessionKey, setSessionKey] = createSignal("project:PRO-1:lead");
    const dispose = render(
      () => (
        <AgentChat
          agentId="lead-1"
          agentName="Lead"
          sessionKey={sessionKey()}
          agentType="lead"
          onBack={() => {}}
        />
      ),
      container
    );

    await tick();
    await tick();
    expect(container.textContent).toContain("old history");

    setSessionKey("project:PRO-1:lead:new");
    await tick();
    await tick();

    expect(fetchFullHistoryMock).toHaveBeenNthCalledWith(
      1,
      "lead-1",
      "project:PRO-1:lead"
    );
    expect(fetchFullHistoryMock).toHaveBeenNthCalledWith(
      2,
      "lead-1",
      "project:PRO-1:lead:new"
    );
    expect(container.textContent).not.toContain("old history");

    dispose();
  });

  it("shows lead context warning at 80% or higher", async () => {
    fetchFullHistoryMock.mockResolvedValue({
      messages: [
        {
          role: "assistant",
          timestamp: Date.now(),
          content: [{ type: "text", text: "done" }],
          meta: {
            model: "claude-3-5-sonnet",
            usage: {
              input: 160000,
              output: 50,
              totalTokens: 160050,
            },
          },
        },
      ],
    });

    const { container, dispose } = renderLead();
    await tick();
    await tick();

    expect(container.querySelector(".context-warning")?.textContent).toContain(
      "Context usage is high (~80%)"
    );
    expect(container.querySelector(".context-warning")?.textContent).toContain(
      "creating a handoff document"
    );

    dispose();
  });

  it("renders subagent context usage percent from latest estimate", async () => {
    fetchSubagentLogsMock.mockResolvedValueOnce({
      ok: true,
      data: {
        cursor: 1,
        events: [],
        latestContextEstimate: {
          usedTokens: 60000,
          maxTokens: 200000,
          pct: 30,
          basis: "claude_prompt_tokens",
          available: true,
        },
      },
    });

    const { container, dispose } = renderSubagent("idle");
    await tick();
    await tick();

    expect(container.querySelector(".context-usage")?.textContent).toContain(
      "~30% context used"
    );

    dispose();
  });

  it("shows subagent context warning when estimate is high", async () => {
    fetchSubagentLogsMock.mockResolvedValueOnce({
      ok: true,
      data: {
        cursor: 1,
        events: [],
        latestContextEstimate: {
          usedTokens: 170000,
          maxTokens: 200000,
          pct: 85,
          basis: "claude_prompt_tokens",
          available: true,
        },
      },
    });

    const { container, dispose } = renderSubagent("idle");
    await tick();
    await tick();

    expect(container.querySelector(".context-warning")?.textContent).toContain(
      "Context usage is high (~85%)"
    );

    dispose();
  });

  it("renders subagent context usage unavailable when estimate is unavailable", async () => {
    fetchSubagentLogsMock.mockResolvedValueOnce({
      ok: true,
      data: {
        cursor: 1,
        events: [],
        latestContextEstimate: {
          usedTokens: 0,
          maxTokens: 200000,
          pct: 0,
          basis: "codex_cumulative",
          available: false,
          reason: "codex_cumulative_only",
        },
      },
    });

    const { container, dispose } = renderSubagent("idle");
    await tick();
    await tick();

    expect(container.querySelector(".context-usage")?.textContent).toContain(
      "Context usage unavailable"
    );

    dispose();
  });

  it("hides context usage when no estimate is available yet", async () => {
    const { container, dispose } = renderSubagent("idle");
    await tick();
    await tick();

    expect(container.querySelector(".context-usage")).toBeNull();
    expect(container.querySelector(".context-warning")).toBeNull();

    dispose();
  });

  it("shows Stop while subagent message is sending", async () => {
    spawnSubagentMock.mockImplementation(
      () => new Promise(() => undefined) as Promise<never>
    );
    const { container, dispose } = renderSubagent("idle");
    await tick();

    const input = container.querySelector("textarea") as HTMLTextAreaElement;
    input.value = "hello";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    const sendBtn = container.querySelector(".send-btn") as HTMLButtonElement;
    sendBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();

    expect(container.querySelector(".stop-btn")).not.toBeNull();
    expect(container.querySelector(".send-btn")).not.toBeNull();

    dispose();
  });

  it("keeps Stop visible after spawn resolves while awaiting response", async () => {
    const { container, dispose } = renderSubagent("idle");
    await tick();

    const input = container.querySelector("textarea") as HTMLTextAreaElement;
    input.value = "hello";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    const sendBtn = container.querySelector(".send-btn") as HTMLButtonElement;
    sendBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await tick();
    await tick();

    expect(container.querySelector(".stop-btn")).not.toBeNull();
    expect(container.querySelector(".send-btn")).not.toBeNull();
    expect(
      (container.querySelector("textarea") as HTMLTextAreaElement).disabled
    ).toBe(false);

    dispose();
  });

  it("keeps lead input enabled while a run is active", async () => {
    const { container, dispose } = renderLead();
    await tick();

    const input = container.querySelector("textarea") as HTMLTextAreaElement;
    input.value = "hello";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    const sendBtn = container.querySelector(".send-btn") as HTMLButtonElement;
    sendBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();

    expect(
      (container.querySelector("textarea") as HTMLTextAreaElement).disabled
    ).toBe(false);
    expect(container.querySelector(".stop-btn")).not.toBeNull();

    dispose();
  });

  it("clears lead Sending status on first stream chunk", async () => {
    let onText: ((text: string) => void) | undefined;
    streamMessageMock.mockImplementation(
      (
        _agentId: string,
        _message: string,
        _sessionKey: string,
        handleText: (text: string) => void
      ) => {
        onText = handleText;
        return () => {};
      }
    );
    const { container, dispose } = renderLead();
    await tick();

    const input = container.querySelector("textarea") as HTMLTextAreaElement;
    input.value = "hello";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    const sendBtn = container.querySelector(".send-btn") as HTMLButtonElement;
    sendBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    await tick();

    expect(container.textContent).toContain("Sending...");

    onText?.("reply");
    await tick();

    expect(container.textContent).not.toContain("Sending...");

    dispose();
  });

  it("stays detached after a small upward scroll near the bottom", async () => {
    let onText: ((text: string) => void) | undefined;
    streamMessageMock.mockImplementation(
      (
        _agentId: string,
        _message: string,
        _sessionKey: string,
        handleText: (text: string) => void
      ) => {
        onText = handleText;
        return () => {};
      }
    );

    const { container, dispose } = renderLead();
    await tick();
    await tick();

    const input = container.querySelector("textarea") as HTMLTextAreaElement;
    input.value = "hello";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    const sendBtn = container.querySelector(".send-btn") as HTMLButtonElement;
    sendBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    await tick();

    const logPane = container.querySelector(".log-pane") as HTMLDivElement;
    let scrollTop = 900;
    Object.defineProperty(logPane, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(logPane, "clientHeight", { value: 100, configurable: true });
    Object.defineProperty(logPane, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });

    logPane.dispatchEvent(new WheelEvent("wheel", { deltaY: -60, bubbles: true }));
    scrollTop = 840;
    logPane.dispatchEvent(new Event("scroll", { bubbles: true }));
    onText?.("reply");
    await tick();

    expect(scrollTop).toBe(840);

    dispose();
  });

  it("queues subagent messages during active runs and flushes them when idle", async () => {
    const { container, dispose, setStatus } = renderSubagent("running");
    await tick();

    const input = container.querySelector("textarea") as HTMLTextAreaElement;
    input.value = "queued follow-up";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    const sendBtn = container.querySelector(".send-btn") as HTMLButtonElement;
    sendBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();

    expect(spawnSubagentMock).not.toHaveBeenCalled();
    expect(
      Array.from(container.querySelectorAll(".log-status")).some((node) =>
        node.textContent?.includes("Queued")
      )
    ).toBe(true);
    expect(input.disabled).toBe(false);
    expect(container.querySelector(".stop-btn")).not.toBeNull();

    setStatus("idle");
    await tick();
    await tick();

    expect(spawnSubagentMock).toHaveBeenCalledWith("PRO-1", {
      slug: "worker-1",
      cli: "codex",
      prompt: "queued follow-up",
      mode: "clone",
      resume: true,
      attachments: undefined,
    });

    dispose();
  });

  it("clears subagent Sending status after spawn succeeds", async () => {
    let resolveSpawn: (() => void) | undefined;
    spawnSubagentMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSpawn = () =>
            resolve({
              ok: true,
              data: { slug: "worker-1" },
            });
        })
    );
    const { container, dispose } = renderSubagent("idle");
    await tick();

    const input = container.querySelector("textarea") as HTMLTextAreaElement;
    input.value = "hello";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    const sendBtn = container.querySelector(".send-btn") as HTMLButtonElement;
    sendBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();

    expect(container.textContent).toContain("Sending...");

    resolveSpawn?.();
    await tick();

    expect(container.textContent).not.toContain("Sending...");
    expect(container.textContent).toContain("hello");

    dispose();
  });

  it("adds pending files when dropped on the chat log pane", async () => {
    const { container, dispose } = renderLead();
    await tick();
    await tick();

    const logPane = container.querySelector(".log-pane") as HTMLDivElement;
    const file = new File(["image"], "diagram.png", { type: "image/png" });
    const dropEvent = new Event("drop", {
      bubbles: true,
      cancelable: true,
    }) as DragEvent;
    Object.defineProperty(dropEvent, "dataTransfer", {
      value: { files: [file] },
    });

    logPane.dispatchEvent(dropEvent);
    await tick();
    await tick();

    expect(container.querySelector(".attachment-name")?.textContent).toContain(
      "diagram.png"
    );

    dispose();
  });

  it("keeps loading spinner through session events until real response arrives", async () => {
    vi.useFakeTimers();
    fetchSubagentLogsMock
      .mockResolvedValueOnce({
        ok: true,
        data: { cursor: 0, events: [] },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          cursor: 1,
          events: [
            { type: "session", text: "session started" },
            { type: "user", text: "hello" },
          ],
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          cursor: 2,
          events: [{ type: "assistant", text: "on it" }],
        },
      });

    const { container, dispose } = renderSubagent("idle");
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    const input = container.querySelector("textarea") as HTMLTextAreaElement;
    input.value = "hello";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    const sendBtn = container.querySelector(".send-btn") as HTMLButtonElement;
    sendBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();

    expect(container.querySelector(".log-line.pending")).not.toBeNull();

    await vi.advanceTimersByTimeAsync(2100);
    await Promise.resolve();
    expect(container.querySelector(".log-line.pending")).not.toBeNull();

    await vi.advanceTimersByTimeAsync(2100);
    await Promise.resolve();
    expect(container.querySelector(".log-line.pending")).toBeNull();

    dispose();
    vi.useRealTimers();
  });

  it("keeps loading spinner through message events until real response arrives", async () => {
    vi.useFakeTimers();
    fetchSubagentLogsMock
      .mockResolvedValueOnce({
        ok: true,
        data: { cursor: 0, events: [] },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          cursor: 1,
          events: [
            { type: "message", text: "internal event" },
            { type: "user", text: "hello" },
          ],
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          cursor: 2,
          events: [{ type: "assistant", text: "on it" }],
        },
      });

    const { container, dispose } = renderSubagent("idle");
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    const input = container.querySelector("textarea") as HTMLTextAreaElement;
    input.value = "hello";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    const sendBtn = container.querySelector(".send-btn") as HTMLButtonElement;
    sendBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();

    expect(container.querySelector(".log-line.pending")).not.toBeNull();

    await vi.advanceTimersByTimeAsync(2100);
    await Promise.resolve();
    expect(container.querySelector(".log-line.pending")).not.toBeNull();

    await vi.advanceTimersByTimeAsync(2100);
    await Promise.resolve();
    expect(container.querySelector(".log-line.pending")).toBeNull();

    dispose();
    vi.useRealTimers();
  });

  it("keeps loading spinner when assistant events are empty", async () => {
    vi.useFakeTimers();
    fetchSubagentLogsMock
      .mockResolvedValueOnce({
        ok: true,
        data: { cursor: 0, events: [] },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          cursor: 1,
          events: [
            { type: "user", text: "hello" },
            { type: "assistant", text: "" },
          ],
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          cursor: 2,
          events: [{ type: "assistant", text: "done" }],
        },
      });

    const { container, dispose } = renderSubagent("idle");
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    const input = container.querySelector("textarea") as HTMLTextAreaElement;
    input.value = "hello";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    const sendBtn = container.querySelector(".send-btn") as HTMLButtonElement;
    sendBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();

    expect(container.querySelector(".log-line.pending")).not.toBeNull();

    await vi.advanceTimersByTimeAsync(2100);
    await Promise.resolve();
    expect(container.querySelector(".log-line.pending")).not.toBeNull();

    await vi.advanceTimersByTimeAsync(2100);
    await Promise.resolve();
    expect(container.querySelector(".log-line.pending")).toBeNull();

    dispose();
  });

  it("keeps loading spinner through tool output until assistant text arrives", async () => {
    vi.useFakeTimers();
    fetchSubagentLogsMock
      .mockResolvedValueOnce({
        ok: true,
        data: { cursor: 0, events: [] },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          cursor: 1,
          events: [{ type: "tool_output", text: "tool ran" }],
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          cursor: 2,
          events: [{ type: "assistant", text: "final reply" }],
        },
      });

    const { container, dispose } = renderSubagent("idle");
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    const input = container.querySelector("textarea") as HTMLTextAreaElement;
    input.value = "hello";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    const sendBtn = container.querySelector(".send-btn") as HTMLButtonElement;
    sendBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();

    expect(container.querySelector(".log-line.pending")).not.toBeNull();

    await vi.advanceTimersByTimeAsync(2100);
    await Promise.resolve();
    expect(container.querySelector(".log-line.pending")).not.toBeNull();

    await vi.advanceTimersByTimeAsync(2100);
    await Promise.resolve();
    expect(container.querySelector(".log-line.pending")).toBeNull();

    dispose();
  });

  it("renders warning callout for shell tool calls with empty output", async () => {
    fetchSubagentLogsMock.mockResolvedValueOnce({
      ok: true,
      data: {
        cursor: 1,
        events: [
          {
            type: "tool_call",
            tool: { id: "t1", name: "exec_command" },
            text: JSON.stringify({ cmd: "yoplai projects start PRO-1 --subagent Worker" }),
          },
          {
            type: "tool_output",
            tool: { id: "t1", name: "exec_command" },
            text: "",
          },
        ],
      },
    });

    const { container, dispose } = renderSubagent("idle");
    await tick();
    await tick();
    await tick();

    const warning = container.querySelector(".log-line.warning");
    expect(warning).not.toBeNull();
    expect(warning?.textContent).toContain("No output captured.");
    expect(warning?.textContent).toContain("yoplai projects start PRO-1 --subagent Worker");

    dispose();
  });

  it("keeps collapsible tool rows open after toggling", async () => {
    fetchSubagentLogsMock.mockResolvedValueOnce({
      ok: true,
      data: {
        cursor: 1,
        events: [
          {
            type: "tool_call",
            tool: { id: "t1", name: "exec_command" },
            text: JSON.stringify({ cmd: "git status" }),
          },
          {
            type: "tool_output",
            tool: { id: "t1", name: "exec_command" },
            text: "line 1\nline 2\nline 3",
          },
        ],
      },
    });

    const { container, dispose } = renderSubagent("idle");
    await tick();
    await tick();
    await tick();

    const details = container.querySelector(
      ".log-line.collapsible"
    ) as HTMLDetailsElement | null;
    const summary = details?.querySelector("summary") as HTMLElement | null;
    expect(details).not.toBeNull();
    expect(summary).not.toBeNull();
    expect(details?.open).toBe(false);

    summary?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();

    expect(details?.open).toBe(true);

    dispose();
  });

  it("shows Stop while lead agent is streaming", async () => {
    const { container, dispose } = renderLead();
    await tick();

    const input = container.querySelector("textarea") as HTMLTextAreaElement;
    input.value = "hello";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    const sendBtn = container.querySelector(".send-btn") as HTMLButtonElement;
    sendBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();

    expect(container.querySelector(".stop-btn")).not.toBeNull();

    dispose();
  });

  it("does not auto-scroll lead logs while reading older output", async () => {
    let onText: ((text: string) => void) | undefined;
    streamMessageMock.mockImplementation(
      (
        _agentId: string,
        _message: string,
        _sessionKey: string,
        handleText: (text: string) => void
      ) => {
        onText = handleText;
        return () => {};
      }
    );
    const { container, dispose } = renderLead();
    await tick();

    const input = container.querySelector("textarea") as HTMLTextAreaElement;
    input.value = "hello";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    const sendBtn = container.querySelector(".send-btn") as HTMLButtonElement;
    sendBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();

    const logPane = container.querySelector(".log-pane") as HTMLDivElement;
    let scrollTop = 200;
    Object.defineProperty(logPane, "scrollHeight", {
      configurable: true,
      get: () => 1000,
    });
    Object.defineProperty(logPane, "clientHeight", {
      configurable: true,
      get: () => 500,
    });
    Object.defineProperty(logPane, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });

    logPane.dispatchEvent(new Event("scroll"));
    onText?.("reply");
    await tick();

    expect(scrollTop).toBe(200);

    dispose();
  });

  it("resumes lead auto-scroll when the reader returns near the bottom", async () => {
    let onText: ((text: string) => void) | undefined;
    streamMessageMock.mockImplementation(
      (
        _agentId: string,
        _message: string,
        _sessionKey: string,
        handleText: (text: string) => void
      ) => {
        onText = handleText;
        return () => {};
      }
    );
    const { container, dispose } = renderLead();
    await tick();

    const input = container.querySelector("textarea") as HTMLTextAreaElement;
    input.value = "hello";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    const sendBtn = container.querySelector(".send-btn") as HTMLButtonElement;
    sendBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();

    const logPane = container.querySelector(".log-pane") as HTMLDivElement;
    let scrollTop = 405;
    Object.defineProperty(logPane, "scrollHeight", {
      configurable: true,
      get: () => 1000,
    });
    Object.defineProperty(logPane, "clientHeight", {
      configurable: true,
      get: () => 500,
    });
    Object.defineProperty(logPane, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });

    logPane.dispatchEvent(new Event("scroll"));
    onText?.("reply");
    await tick();

    expect(scrollTop).toBe(1000);

    dispose();
  });

  it("calls interruptSubagent when subagent Stop is clicked", async () => {
    const { container, dispose } = renderSubagent("running");
    await tick();

    const stopBtn = container.querySelector(".stop-btn") as HTMLButtonElement;
    stopBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();

    expect(interruptSubagentMock).toHaveBeenCalledWith("PRO-1", "worker-1");

    dispose();
  });

  it("shows stopping state while subagent interrupt is in flight", async () => {
    interruptSubagentMock.mockImplementation(
      () => new Promise(() => undefined) as Promise<never>
    );
    const { container, dispose } = renderSubagent("running");
    await tick();

    const stopBtn = container.querySelector(".stop-btn") as HTMLButtonElement;
    stopBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();

    const stoppingBtn = container.querySelector(
      ".stop-btn"
    ) as HTMLButtonElement;
    expect(stoppingBtn.disabled).toBe(true);
    expect(stoppingBtn.textContent).toContain("Stopping...");

    dispose();
  });

  it("sends /abort when lead Stop is clicked", async () => {
    const { container, dispose } = renderLead();
    await tick();

    const input = container.querySelector("textarea") as HTMLTextAreaElement;
    input.value = "hello";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    const sendBtn = container.querySelector(".send-btn") as HTMLButtonElement;
    sendBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();

    const stopBtn = container.querySelector(".stop-btn") as HTMLButtonElement;
    stopBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();

    expect(streamMessageMock).toHaveBeenNthCalledWith(
      2,
      "lead-1",
      "/abort",
      "main",
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
      expect.any(Object),
      expect.any(Object)
    );

    dispose();
  });

  it("shows Send again after lead agent stops", async () => {
    streamMessageMock.mockImplementationOnce(
      (
        _agentId: string,
        _message: string,
        _sessionKey: string,
        _onText: (text: string) => void,
        onDone: () => void,
        _onError: (error: string) => void
      ) => {
        setTimeout(() => onDone(), 0);
        return () => {};
      }
    );
    const { container, dispose } = renderLead();
    await tick();

    const input = container.querySelector("textarea") as HTMLTextAreaElement;
    input.value = "hello";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    const sendBtn = container.querySelector(".send-btn") as HTMLButtonElement;
    sendBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(container.querySelector(".stop-btn")).not.toBeNull();

    await tick();
    await tick();

    expect(container.querySelector(".send-btn")).not.toBeNull();
    expect(container.querySelector(".stop-btn")).toBeNull();

    dispose();
  });
});
