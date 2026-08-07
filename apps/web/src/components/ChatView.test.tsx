// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSignal } from "solid-js";
import { delegateEvents, render } from "solid-js/web";
import { ChatView } from "./ChatView";
import {
  resetCapabilitiesForTests,
  setCapabilitiesForTests,
} from "../lib/capabilities";

const navigateMock = vi.fn();
const [routeVersion, setRouteVersion] = createSignal(0);

const {
  fetchAgentMock,
  fetchAgentSuggestionsMock,
  fetchSimpleHistoryMock,
  fetchFullHistoryMock,
  fetchAgentStatusesMock,
  fetchCapabilitiesMock,
  getSessionKeyMock,
  postAbortMock,
  postCompactMock,
  streamMessageMock,
  subscribeToSessionMock,
  subscribeToRealtimeMock,
  uploadFilesMock,
  routeState,
} = vi.hoisted(() => ({
  fetchAgentMock: vi.fn(),
  fetchAgentSuggestionsMock: vi.fn(),
  fetchSimpleHistoryMock: vi.fn(),
  fetchFullHistoryMock: vi.fn(),
  fetchAgentStatusesMock: vi.fn(),
  fetchCapabilitiesMock: vi.fn(),
  getSessionKeyMock: vi.fn(),
  postAbortMock: vi.fn(),
  postCompactMock: vi.fn(),
  streamMessageMock: vi.fn(),
  subscribeToSessionMock: vi.fn(),
  subscribeToRealtimeMock: vi.fn(),
  uploadFilesMock: vi.fn(),
  routeState: {
    view: undefined as string | undefined,
    session: undefined as string | undefined,
  },
}));

vi.mock("@solidjs/router", () => ({
  A: (props: Record<string, unknown>) => <a {...props} />,
  useNavigate: () => navigateMock,
  useParams: () => ({ agentId: "agent-1", view: routeState.view }),
  useSearchParams: () => [
    {
      get session() {
        routeVersion();
        return routeState.session;
      },
    },
    vi.fn(),
  ],
}));

vi.mock("../api", () => ({
  fetchAgent: fetchAgentMock,
  fetchAgentSuggestions: fetchAgentSuggestionsMock,
  fetchSimpleHistory: fetchSimpleHistoryMock,
  fetchFullHistory: fetchFullHistoryMock,
  fetchAgentStatuses: fetchAgentStatusesMock,
  fetchCapabilities: fetchCapabilitiesMock,
  getSessionKey: getSessionKeyMock,
  postAbort: postAbortMock,
  postCompact: postCompactMock,
  streamMessage: streamMessageMock,
  subscribeToSession: subscribeToSessionMock,
  subscribeToRealtime: subscribeToRealtimeMock,
  uploadFiles: uploadFilesMock,
}));

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function waitFor(assertion: () => void) {
  let lastError: unknown;
  for (let i = 0; i < 20; i += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await tick();
    }
  }
  throw lastError;
}

function createFileDragEvent(
  type: "dragenter" | "dragover" | "drop",
  files: File[]
) {
  const event = new Event(type, {
    bubbles: true,
    cancelable: true,
  }) as DragEvent;
  Object.defineProperty(event, "dataTransfer", {
    value: { files, types: ["Files"], dropEffect: "none" },
  });
  return event;
}

function renderView() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const dispose = render(() => <ChatView />, container);
  return { container, dispose };
}

describe("ChatView abort handling", () => {
  beforeEach(() => {
    delegateEvents(["click", "input", "keydown"]);
    Element.prototype.scrollIntoView = vi.fn();
    URL.createObjectURL = vi.fn(() => "blob:preview");
    URL.revokeObjectURL = vi.fn();

    fetchAgentMock.mockResolvedValue({
      id: "agent-1",
      name: "Agent",
      model: { provider: "openai", model: "gpt-5" },
      queueMode: "queue",
    });
    fetchAgentSuggestionsMock.mockResolvedValue([]);
    fetchSimpleHistoryMock.mockResolvedValue({
      messages: [],
      sessionId: "session-main",
      thinkingLevel: undefined,
      isStreaming: false,
      activeTurn: null,
    });
    fetchFullHistoryMock.mockResolvedValue({
      messages: [],
      sessionId: "session-main",
      thinkingLevel: undefined,
      isStreaming: false,
      activeTurn: null,
    });
    fetchAgentStatusesMock.mockResolvedValue({
      statuses: { "agent-1": "idle" },
    });
    fetchCapabilitiesMock.mockResolvedValue({
      version: 2,
      extensions: {},
      agents: ["agent-1"],
      multiUser: false,
      agentFab: false,
    });
    setCapabilitiesForTests({ multiUser: false });
    getSessionKeyMock.mockReturnValue("main");
    postAbortMock.mockResolvedValue(undefined);
    postCompactMock.mockResolvedValue(undefined);
    streamMessageMock.mockImplementation(() => () => {});
    subscribeToSessionMock.mockImplementation(() => () => {});
    subscribeToRealtimeMock.mockImplementation(() => () => {});
    uploadFilesMock.mockResolvedValue([]);
    routeState.view = undefined;
    routeState.session = undefined;
    setRouteVersion(0);
  });

  afterEach(() => {
    document.body.innerHTML = "";
    resetCapabilitiesForTests();
    vi.clearAllMocks();
  });

  it("prefills the composer when a starting suggestion is clicked", async () => {
    fetchAgentSuggestionsMock.mockResolvedValue([
      { title: "Plan work", prompt: "Plan this work" },
    ]);
    const { container, dispose } = renderView();

    await waitFor(() =>
      expect(container.querySelector(".suggestion-card")).not.toBeNull()
    );
    (container.querySelector(".suggestion-card") as HTMLButtonElement).click();

    expect(
      (container.querySelector("textarea") as HTMLTextAreaElement).value
    ).toBe("Plan this work");
    expect(streamMessageMock).not.toHaveBeenCalled();
    dispose();
  });

  it("refreshes suggestions for a new session with the same agent", async () => {
    fetchAgentSuggestionsMock
      .mockResolvedValueOnce([{ title: "First", prompt: "First prompt" }])
      .mockResolvedValueOnce([{ title: "Updated", prompt: "Updated prompt" }]);
    const { container, dispose } = renderView();

    await waitFor(() => expect(container.textContent).toContain("First"));
    routeState.session = "new-session";
    setRouteVersion((version) => version + 1);

    await waitFor(() => expect(container.textContent).toContain("Updated"));
    expect(fetchAgentSuggestionsMock).toHaveBeenCalledTimes(2);
    dispose();
  });

  it("renders thinking traces in simple history", async () => {
    fetchFullHistoryMock.mockResolvedValue({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "private chain summary" },
            { type: "text", text: "final answer" },
          ],
          timestamp: 123,
        },
      ],
      thinkingLevel: undefined,
      isStreaming: false,
      activeTurn: null,
    });

    const { container, dispose } = renderView();
    await tick();
    await tick();

    expect(container.textContent).toContain("Thinking");
    expect(container.textContent).toContain("final answer");

    const thinkingToggle = Array.from(
      container.querySelectorAll("button")
    ).find((button) => button.textContent?.includes("Thinking"));
    if (!(thinkingToggle instanceof HTMLButtonElement)) {
      throw new Error("Expected thinking toggle");
    }
    thinkingToggle.click();
    await tick();

    expect(container.textContent).toContain("private chain summary");

    dispose();
  });

  it("shows context usage even before any model usage is available", async () => {
    const { container, dispose } = renderView();
    await tick();
    await tick();

    expect(container.querySelector(".context-usage")?.textContent).toContain(
      "0% context used"
    );

    dispose();
  });

  it("shows cached input tokens in full model metadata", async () => {
    routeState.view = "full";
    fetchFullHistoryMock.mockResolvedValue({
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "answer" }],
          timestamp: 123,
          meta: {
            model: "gpt-5",
            usage: {
              input: 1023,
              output: 8,
              cacheRead: 3456,
              cacheWrite: 0,
              totalTokens: 4487,
            },
          },
        },
      ],
      thinkingLevel: undefined,
      isStreaming: false,
      activeTurn: null,
    });

    const { container, dispose } = renderView();
    await tick();
    await tick();

    expect(container.querySelector(".model-meta")?.textContent).toContain(
      "1023+3456 cache→8 tok"
    );

    dispose();
  });

  it("forces simple view and hides view toggle for non-admin users", async () => {
    routeState.view = "full";
    setCapabilitiesForTests({
      multiUser: true,
      user: { id: "user-1", role: "user" },
    });
    fetchFullHistoryMock.mockResolvedValue({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "simple trace" },
            { type: "text", text: "simple answer" },
          ],
          timestamp: 123,
        },
      ],
      thinkingLevel: undefined,
      isStreaming: false,
      activeTurn: null,
    });

    const { container, dispose } = renderView();
    await tick();
    await tick();

    expect(container.querySelector(".view-toggle")).toBeNull();
    expect(container.textContent).toContain("simple answer");
    expect(container.querySelector(".full-message")).toBeNull();

    dispose();
  });

  it("keeps streamed assistant text visible after Stop aborts the run", async () => {
    let onText: ((chunk: string) => void) | undefined;
    let onDone: (() => void) | undefined;
    const cleanupSpy = vi.fn();
    streamMessageMock.mockImplementation(
      (
        _agentId: string,
        _message: string,
        _sessionKey: string,
        nextOnText: (chunk: string) => void,
        nextOnDone: () => void
      ) => {
        onText = nextOnText;
        onDone = nextOnDone;
        return cleanupSpy;
      }
    );

    const { container, dispose } = renderView();
    await tick();
    await tick();

    const textarea = container.querySelector("textarea");
    if (!(textarea instanceof HTMLTextAreaElement)) {
      throw new Error("Expected chat textarea");
    }
    textarea.value = "hello";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();

    const sendBtn = container.querySelector(".send-btn");
    if (!(sendBtn instanceof HTMLButtonElement)) {
      throw new Error("Expected send button");
    }
    await waitFor(() => expect(sendBtn.disabled).toBe(false));
    sendBtn.click();
    await tick();

    onText?.("partial answer");
    await tick();

    const stopBtn = container.querySelector(".stop-btn");
    if (!(stopBtn instanceof HTMLButtonElement)) {
      throw new Error("Expected stop button");
    }
    stopBtn.click();
    await tick();

    expect(postAbortMock).toHaveBeenCalledWith("agent-1", "main");
    expect(cleanupSpy).not.toHaveBeenCalled();

    onDone?.();
    await tick();

    expect(container.textContent).toContain("partial answer");
    expect(container.textContent).toContain("Interrupted");

    dispose();
  });

  it("runs manual compaction without sending a chat message", async () => {
    const { container, dispose } = renderView();
    await tick();
    await tick();

    const textarea = container.querySelector("textarea");
    if (!(textarea instanceof HTMLTextAreaElement)) {
      throw new Error("Expected chat textarea");
    }
    textarea.value = "/compact";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();

    const sendBtn = container.querySelector(".send-btn");
    if (!(sendBtn instanceof HTMLButtonElement)) {
      throw new Error("Expected send button");
    }
    await waitFor(() => expect(sendBtn.disabled).toBe(false));
    sendBtn.click();
    await tick();
    await tick();

    expect(postCompactMock).toHaveBeenCalledWith("agent-1", "main", undefined);
    expect(streamMessageMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Context compacted.");

    dispose();
  });

  it("submits one compaction while the request is pending and allows retry after failure", async () => {
    let rejectCompact: (error: Error) => void = () => undefined;
    postCompactMock.mockImplementation(
      () =>
        new Promise<void>((_, reject) => {
          rejectCompact = reject;
        })
    );
    const { container, dispose } = renderView();
    await tick();
    await tick();

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    const sendBtn = container.querySelector(".send-btn") as HTMLButtonElement;
    textarea.value = "/compact";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    sendBtn.click();
    sendBtn.click();

    expect(postCompactMock).toHaveBeenCalledTimes(1);
    expect(sendBtn.disabled).toBe(true);
    expect(container.textContent).toContain("Compacting context...");

    rejectCompact(new Error("Compaction timed out. Try again."));
    await waitFor(() =>
      expect(container.textContent).toContain(
        "Compaction timed out. Try again."
      )
    );
    expect(container.textContent).toContain("Compaction timed out. Try again.");

    textarea.value = "/compact";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await waitFor(() => expect(sendBtn.disabled).toBe(false));
    sendBtn.click();
    await waitFor(() => expect(postCompactMock).toHaveBeenCalledTimes(2));
    dispose();
  });

  it("compacts different sessions independently", async () => {
    postCompactMock.mockImplementation(() => new Promise<void>(() => {}));
    const { container, dispose } = renderView();
    await tick();
    await tick();

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    const sendBtn = container.querySelector(".send-btn") as HTMLButtonElement;
    textarea.value = "/compact";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    sendBtn.click();

    routeState.session = "past-session";
    setRouteVersion((version) => version + 1);
    await tick();
    await tick();

    textarea.value = "/compact";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await waitFor(() => expect(sendBtn.disabled).toBe(false));
    sendBtn.click();

    expect(postCompactMock).toHaveBeenCalledTimes(2);
    expect(postCompactMock).toHaveBeenLastCalledWith(
      "agent-1",
      "main",
      "past-session"
    );

    routeState.session = undefined;
    setRouteVersion((version) => version + 1);
    await tick();
    await tick();

    textarea.value = "/compact";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    expect(container.textContent).toContain("Compacting context...");
    expect(sendBtn.disabled).toBe(true);
    sendBtn.click();
    expect(postCompactMock).toHaveBeenCalledTimes(2);
    dispose();
  });

  it("compacts explicit past session when present", async () => {
    routeState.session = "past-session";
    const { container, dispose } = renderView();
    await tick();
    await tick();

    const textarea = container.querySelector("textarea");
    if (!(textarea instanceof HTMLTextAreaElement))
      throw new Error("Expected chat textarea");
    textarea.value = "/compact";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();

    const sendBtn = container.querySelector(".send-btn");
    if (!(sendBtn instanceof HTMLButtonElement))
      throw new Error("Expected send button");
    await waitFor(() => expect(sendBtn.disabled).toBe(false));
    sendBtn.click();
    await tick();

    expect(postCompactMock).toHaveBeenCalledWith(
      "agent-1",
      "main",
      "past-session"
    );

    dispose();
  });

  it("auto-compacts before sending at eighty percent context usage", async () => {
    fetchFullHistoryMock
      .mockResolvedValueOnce({
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "large context" }],
            timestamp: 123,
            meta: {
              model: "gpt-5",
              usage: { input: 320000, output: 1, totalTokens: 320001 },
            },
          },
        ],
        thinkingLevel: undefined,
        isStreaming: false,
        activeTurn: null,
      })
      .mockResolvedValue({
        messages: [
          {
            role: "system",
            content: [
              {
                type: "text",
                text: "[COMPACTED CONTEXT SUMMARY]\nsummary",
              },
            ],
            timestamp: 124,
          },
        ],
        thinkingLevel: undefined,
        isStreaming: false,
        activeTurn: null,
      });

    const { container, dispose } = renderView();
    await tick();
    await tick();

    const textarea = container.querySelector("textarea");
    if (!(textarea instanceof HTMLTextAreaElement)) {
      throw new Error("Expected chat textarea");
    }
    textarea.value = "hello";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();

    const sendBtn = container.querySelector(".send-btn");
    if (!(sendBtn instanceof HTMLButtonElement)) {
      throw new Error("Expected send button");
    }
    await waitFor(() => expect(sendBtn.disabled).toBe(false));
    sendBtn.click();
    await tick();
    await tick();

    expect(postCompactMock).toHaveBeenCalledWith("agent-1", "main", undefined);
    expect(streamMessageMock).toHaveBeenCalledWith(
      "agent-1",
      "hello",
      "main",
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
      expect.any(Object),
      expect.any(Object)
    );
    await waitFor(() =>
      expect(container.querySelector(".context-usage")?.textContent).toContain(
        "0% context used"
      )
    );
    expect(container.querySelector(".context-usage")?.className).not.toContain(
      "danger"
    );
    expect(container.textContent).toContain("Context compacted.");

    dispose();
  });

  it("does not auto-compact reset commands above eighty percent context usage", async () => {
    fetchFullHistoryMock.mockResolvedValue({
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "large context" }],
          timestamp: 123,
          meta: {
            model: "gpt-5",
            usage: { input: 320000, output: 1, totalTokens: 320001 },
          },
        },
      ],
      thinkingLevel: undefined,
      isStreaming: false,
      activeTurn: null,
    });

    const { container, dispose } = renderView();
    await tick();
    await tick();

    const textarea = container.querySelector("textarea");
    if (!(textarea instanceof HTMLTextAreaElement)) {
      throw new Error("Expected chat textarea");
    }
    textarea.value = "/new";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();

    const sendBtn = container.querySelector(".send-btn");
    if (!(sendBtn instanceof HTMLButtonElement)) {
      throw new Error("Expected send button");
    }
    await waitFor(() => expect(sendBtn.disabled).toBe(false));
    sendBtn.click();
    await tick();

    expect(postCompactMock).not.toHaveBeenCalled();
    expect(streamMessageMock).toHaveBeenCalledWith(
      "agent-1",
      "/new",
      "main",
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
      expect.any(Object),
      expect.any(Object)
    );

    dispose();
  });

  it("sends /new through session key and navigates when viewing past session", async () => {
    routeState.session = "past-session";
    let resetHandler: ((sessionId: string) => void) | undefined;
    streamMessageMock.mockImplementation(
      (
        _agentId: string,
        _message: string,
        _sessionKey: string,
        _onText: (chunk: string) => void,
        _onDone: () => void,
        _onError: (error: string) => void,
        callbacks?: { onSessionReset?: (sessionId: string) => void }
      ) => {
        resetHandler = callbacks?.onSessionReset;
        return vi.fn();
      }
    );

    const { container, dispose } = renderView();
    await tick();
    await tick();

    const textarea = container.querySelector("textarea");
    if (!(textarea instanceof HTMLTextAreaElement))
      throw new Error("Expected chat textarea");
    textarea.value = "/new";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();

    const sendBtn = container.querySelector(".send-btn");
    if (!(sendBtn instanceof HTMLButtonElement))
      throw new Error("Expected send button");
    await waitFor(() => expect(sendBtn.disabled).toBe(false));
    sendBtn.click();
    await tick();

    const options = streamMessageMock.mock.calls[0]?.[7];
    expect(options).not.toHaveProperty("sessionId");

    resetHandler?.("fresh-session");
    expect(navigateMock).toHaveBeenCalledWith(
      "/chat/agent-1?session=fresh-session"
    );

    dispose();
  });

  it("refreshes context usage after a local turn without reloading visible history", async () => {
    let onText: ((chunk: string) => void) | undefined;
    let onDone: (() => void) | undefined;
    let subscriptionCallbacks:
      | {
          onHistoryUpdated?: () => void;
        }
      | undefined;

    fetchFullHistoryMock
      .mockResolvedValueOnce({
        messages: [],
        thinkingLevel: undefined,
        isStreaming: false,
        activeTurn: null,
      })
      .mockResolvedValueOnce({
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "hello" }],
            timestamp: 1,
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "answer" }],
            timestamp: 2,
            meta: {
              model: "gpt-5.2",
              usage: { input: 102400, output: 1, totalTokens: 102401 },
            },
          },
        ],
        thinkingLevel: undefined,
        isStreaming: false,
        activeTurn: null,
      });
    subscribeToSessionMock.mockImplementation(
      (_agentId: string, _sessionKey: string, callbacksArg) => {
        subscriptionCallbacks = callbacksArg;
        return vi.fn();
      }
    );
    streamMessageMock.mockImplementation(
      (
        _agentId: string,
        _message: string,
        _sessionKey: string,
        nextOnText: (chunk: string) => void,
        nextOnDone: () => void
      ) => {
        onText = nextOnText;
        onDone = nextOnDone;
        return vi.fn();
      }
    );

    const { container, dispose } = renderView();
    await tick();
    await tick();

    const textarea = container.querySelector("textarea");
    if (!(textarea instanceof HTMLTextAreaElement)) {
      throw new Error("Expected chat textarea");
    }
    textarea.value = "hello";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();

    const sendBtn = container.querySelector(".send-btn");
    if (!(sendBtn instanceof HTMLButtonElement)) {
      throw new Error("Expected send button");
    }
    await waitFor(() => expect(sendBtn.disabled).toBe(false));
    sendBtn.click();
    await tick();

    onText?.("answer");
    onDone?.();
    subscriptionCallbacks?.onHistoryUpdated?.();
    await waitFor(() =>
      expect(container.querySelector(".context-usage")?.textContent).toContain(
        "~80% context used"
      )
    );

    dispose();
  });

  it("renders full-mode stream blocks chronologically", async () => {
    let onText: ((chunk: string) => void) | undefined;
    let onDone: (() => void) | undefined;
    let callbacks:
      | {
          onToolCall?: (id: string, name: string, args: unknown) => void;
          onToolResult?: (
            id: string,
            name: string,
            content: string,
            isError: boolean
          ) => void;
        }
      | undefined;
    let subscriptionCallbacks:
      | {
          onDone?: () => void;
          onHistoryUpdated?: () => void;
        }
      | undefined;
    subscribeToSessionMock.mockImplementation(
      (_agentId: string, _sessionKey: string, callbacksArg) => {
        subscriptionCallbacks = callbacksArg;
        return vi.fn();
      }
    );
    streamMessageMock.mockImplementation(
      (
        _agentId: string,
        _message: string,
        _sessionKey: string,
        nextOnText: (chunk: string) => void,
        nextOnDone: () => void,
        _onError: (error: string) => void,
        nextCallbacks?: typeof callbacks
      ) => {
        onText = nextOnText;
        onDone = nextOnDone;
        callbacks = nextCallbacks;
        return vi.fn();
      }
    );

    routeState.view = "full";
    const { container, dispose } = renderView();
    await tick();
    await tick();

    const textarea = container.querySelector("textarea");
    if (!(textarea instanceof HTMLTextAreaElement)) {
      throw new Error("Expected chat textarea");
    }
    textarea.value = "hello";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();

    const sendBtn = container.querySelector(".send-btn");
    if (!(sendBtn instanceof HTMLButtonElement)) {
      throw new Error("Expected send button");
    }
    await waitFor(() => expect(sendBtn.disabled).toBe(false));
    sendBtn.click();
    await tick();

    const fetchesBeforeDone = fetchFullHistoryMock.mock.calls.length;
    onText?.("First text.");
    callbacks?.onToolCall?.("tool-1", "bash", { command: "date" });
    callbacks?.onToolResult?.("tool-1", "bash", "tool output", false);
    onText?.(" Last text.");
    await waitFor(() => {
      const text = container.textContent ?? "";
      expect(text).toContain("First text.");
      expect(text).toContain("bash");
      expect(text).toContain("tool output");
      expect(text).toContain("Last text.");
    });

    const liveText = container.textContent ?? "";
    expect(liveText.indexOf("First text.")).toBeLessThan(
      liveText.indexOf("bash")
    );
    expect(liveText.indexOf("tool output")).toBeLessThan(
      liveText.indexOf("Last text.")
    );

    onDone?.();
    await tick();

    const finalText = container.textContent ?? "";
    expect(finalText.indexOf("First text.")).toBeLessThan(
      finalText.indexOf("bash")
    );
    expect(finalText.indexOf("tool output")).toBeLessThan(
      finalText.indexOf("Last text.")
    );
    expect(fetchFullHistoryMock.mock.calls.length).toBe(fetchesBeforeDone);
    subscriptionCallbacks?.onDone?.();
    await tick();
    expect(container.textContent).toContain("tool output");
    subscriptionCallbacks?.onHistoryUpdated?.();
    await tick();
    expect(fetchFullHistoryMock.mock.calls.length).toBe(fetchesBeforeDone + 1);

    dispose();
  });

  it("adds pending files when dropped on the chat history", async () => {
    const { container, dispose } = renderView();
    await tick();
    await tick();

    const history = container.querySelector(".messages");
    if (!(history instanceof HTMLDivElement)) {
      throw new Error("Expected messages container");
    }

    history.dispatchEvent(
      createFileDragEvent("drop", [
        new File(["image"], "history-drop.png", { type: "image/png" }),
      ])
    );
    await tick();
    await tick();

    expect(container.querySelector(".attachment-name")?.textContent).toContain(
      "history-drop.png"
    );

    dispose();
  });

  it("adds pending files when dropped on the text input", async () => {
    const { container, dispose } = renderView();
    await tick();
    await tick();

    const textarea = container.querySelector("textarea");
    if (!(textarea instanceof HTMLTextAreaElement)) {
      throw new Error("Expected chat textarea");
    }

    textarea.dispatchEvent(
      createFileDragEvent("drop", [
        new File(["doc"], "notes.md", { type: "text/markdown" }),
      ])
    );
    await tick();
    await tick();

    expect(container.querySelector(".attachment-name")?.textContent).toContain(
      "notes.md"
    );

    dispose();
  });

  it("adds pending files when dropped on the attach button", async () => {
    const { container, dispose } = renderView();
    await tick();
    await tick();

    const attachButton = container.querySelector(".attach-btn");
    if (!(attachButton instanceof HTMLButtonElement)) {
      throw new Error("Expected attach button");
    }

    attachButton.dispatchEvent(
      createFileDragEvent("drop", [
        new File(["sheet"], "budget.csv", { type: "text/csv" }),
      ])
    );
    await tick();
    await tick();

    expect(container.querySelector(".attachment-name")?.textContent).toContain(
      "budget.csv"
    );

    dispose();
  });

  it("shows drag feedback for the composer while a file is over the input", async () => {
    const { container, dispose } = renderView();
    await tick();
    await tick();

    const textarea = container.querySelector("textarea");
    const chatView = container.querySelector(".chat-view");
    const inputWrapper = container.querySelector(".input-wrapper");
    if (
      !(textarea instanceof HTMLTextAreaElement) ||
      !(chatView instanceof HTMLDivElement) ||
      !(inputWrapper instanceof HTMLDivElement)
    ) {
      throw new Error("Expected chat composer elements");
    }

    const file = new File(["image"], "composer.png", { type: "image/png" });
    textarea.dispatchEvent(createFileDragEvent("dragenter", [file]));
    textarea.dispatchEvent(createFileDragEvent("dragover", [file]));
    await tick();

    expect(chatView.classList.contains("drop-active")).toBe(true);
    expect(inputWrapper.classList.contains("drop-target")).toBe(true);
    expect(container.textContent).toContain(
      "Drop files to attach them to your next message."
    );

    dispose();
  });
});

describe("ChatView stale-thinking reconciliation", () => {
  beforeEach(() => {
    delegateEvents(["click", "input", "keydown"]);
    Element.prototype.scrollIntoView = vi.fn();

    fetchAgentMock.mockResolvedValue({
      id: "agent-1",
      name: "Agent",
      model: { provider: "openai", model: "gpt-5" },
      queueMode: "queue",
    });
    fetchCapabilitiesMock.mockResolvedValue({
      version: 2,
      extensions: {},
      agents: ["agent-1"],
      multiUser: false,
      agentFab: false,
    });
    setCapabilitiesForTests({ multiUser: false });
    getSessionKeyMock.mockReturnValue("main");
    streamMessageMock.mockImplementation(() => () => {});
    postAbortMock.mockResolvedValue(undefined);
    routeState.view = undefined;
    routeState.session = undefined;
  });

  afterEach(() => {
    document.body.innerHTML = "";
    resetCapabilitiesForTests();
    vi.clearAllMocks();
  });

  it("clears stale thinking state via subscription history_updated when no direct stream is active", async () => {
    // Simulate backend still appearing as streaming on initial load
    fetchAgentStatusesMock.mockResolvedValue({
      statuses: { "agent-1": "streaming" },
    });
    fetchFullHistoryMock.mockResolvedValue({
      messages: [],
      isStreaming: true,
      activeTurn: {
        userText: "do you have linear tools?",
        userTimestamp: Date.now() - 3600000,
        startedAt: Date.now() - 3600000,
        thinking: "",
        text: "",
        toolCalls: [],
      },
    });

    let capturedHistoryUpdated: (() => void) | undefined;
    subscribeToSessionMock.mockImplementation(
      (
        _agentId: string,
        _key: string,
        callbacks: { onHistoryUpdated?: () => void }
      ) => {
        capturedHistoryUpdated = callbacks.onHistoryUpdated;
        return () => {};
      }
    );
    subscribeToRealtimeMock.mockImplementation(() => () => {});

    const { container, dispose } = renderView();
    await tick();
    await tick();

    // UI should be in thinking state (stop button visible)
    expect(container.querySelector(".stop-btn")).toBeTruthy();

    // Backend finishes: history is now available and isStreaming is false
    fetchFullHistoryMock.mockResolvedValue({
      messages: [
        {
          role: "user" as const,
          content: [
            { type: "text" as const, text: "do you have linear tools?" },
          ],
          timestamp: 100,
        },
        {
          role: "assistant" as const,
          content: [{ type: "text" as const, text: "Yes I do!" }],
          timestamp: 200,
        },
      ],
      isStreaming: false,
      activeTurn: null,
    });

    // Subscription delivers history_updated — should clear stale state and reload
    capturedHistoryUpdated?.();
    await tick();
    await tick();

    expect(container.querySelector(".stop-btn")).toBeFalsy();
    expect(container.textContent).toContain("Yes I do!");

    dispose();
  });

  it("clears stale thinking state via status idle event when no direct stream is active", async () => {
    fetchAgentStatusesMock.mockResolvedValue({
      statuses: { "agent-1": "idle" },
    });
    fetchFullHistoryMock.mockResolvedValue({
      messages: [],
      sessionId: "session-main",
      isStreaming: false,
      activeTurn: null,
    });

    let capturedOnEvent:
      | ((event: {
          type: string;
          agentId?: string;
          status?: string;
          sessionId?: string;
          sessionStatus?: string;
        }) => void)
      | undefined;
    subscribeToRealtimeMock.mockImplementation(
      ({ onEvent }: { onEvent: (event: unknown) => void }) => {
        capturedOnEvent = onEvent as typeof capturedOnEvent;
        return () => {};
      }
    );
    subscribeToSessionMock.mockImplementation(() => () => {});

    const { container, dispose } = renderView();
    await tick();
    await tick();

    // Simulate backend starting to stream (e.g. page was loaded mid-run)
    capturedOnEvent?.({
      type: "status",
      agentId: "agent-1",
      status: "streaming",
      sessionId: "session-main",
      sessionStatus: "streaming",
    });
    await tick();

    expect(container.querySelector(".stop-btn")).toBeTruthy();

    // Backend goes idle — no active streamMessage cleanup, so state should clear
    fetchFullHistoryMock.mockResolvedValue({
      messages: [
        {
          role: "assistant" as const,
          content: [{ type: "text" as const, text: "Done!" }],
          timestamp: 100,
        },
      ],
      sessionId: "session-main",
      isStreaming: false,
      activeTurn: null,
    });
    capturedOnEvent?.({
      type: "status",
      agentId: "agent-1",
      status: "idle",
      sessionId: "session-main",
      sessionStatus: "idle",
    });
    await tick();
    await tick();

    expect(container.querySelector(".stop-btn")).toBeFalsy();
    expect(container.textContent).toContain("Done!");

    dispose();
  });

  it("ignores status events from background sessions (ALG-278)", async () => {
    fetchAgentStatusesMock.mockResolvedValue({
      statuses: { "agent-1": "idle" },
    });
    fetchFullHistoryMock.mockResolvedValue({
      messages: [],
      sessionId: "session-main",
      isStreaming: false,
      activeTurn: null,
    });

    let capturedOnEvent:
      | ((event: {
          type: string;
          agentId?: string;
          status?: string;
          sessionId?: string;
          sessionStatus?: string;
        }) => void)
      | undefined;
    subscribeToRealtimeMock.mockImplementation(
      ({ onEvent }: { onEvent: (event: unknown) => void }) => {
        capturedOnEvent = onEvent as typeof capturedOnEvent;
        return () => {};
      }
    );
    subscribeToSessionMock.mockImplementation(() => () => {});

    const { container, dispose } = renderView();
    await tick();
    await tick();

    // The web UI owns "session-main" (idle). A background session (e.g. a
    // Discord forum thread) starts streaming: the agent-wide aggregate flips
    // to "streaming" but the per-session status is for a different session.
    capturedOnEvent?.({
      type: "status",
      agentId: "agent-1",
      status: "streaming",
      sessionId: "forum-thread-123",
      sessionStatus: "streaming",
    });
    await tick();

    // The main chat must stay idle (send button), NOT flip to the Stop button.
    expect(container.querySelector(".stop-btn")).toBeFalsy();

    dispose();
  });
});
