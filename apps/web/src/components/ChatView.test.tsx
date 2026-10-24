// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryAllByRole, queryByRole } from "@testing-library/dom";
import { createSignal } from "solid-js";
import { delegateEvents, render } from "solid-js/web";
import { ChatView, ThinkingLine } from "./ChatView";
import { TurnNotifier } from "./TurnNotifier";
import type { SubscriptionCallbacks } from "../api/realtime";
import type { StreamCallbacks } from "../api/chat";
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
  fetchAgentSessionsMock,
  getSessionKeyMock,
  postAbortMock,
  postCompactMock,
  streamMessageMock,
  subscribeToSessionMock,
  subscribeToRealtimeMock,
  uploadFilesMock,
  fetchChatProjectMock,
  fetchMainAgentPreferenceMock,
  fetchMainAgentOptionsMock,
  fetchPoolActionsMock,
  routeState,
} = vi.hoisted(() => ({
  fetchMainAgentPreferenceMock: vi.fn(),
  fetchMainAgentOptionsMock: vi.fn(),
  fetchPoolActionsMock: vi.fn(),
  fetchAgentMock: vi.fn(),
  fetchAgentSuggestionsMock: vi.fn(),
  fetchSimpleHistoryMock: vi.fn(),
  fetchFullHistoryMock: vi.fn(),
  fetchAgentStatusesMock: vi.fn(),
  fetchCapabilitiesMock: vi.fn(),
  fetchAgentSessionsMock: vi.fn(),
  getSessionKeyMock: vi.fn(),
  postAbortMock: vi.fn(),
  postCompactMock: vi.fn(),
  streamMessageMock: vi.fn(),
  subscribeToSessionMock: vi.fn(),
  subscribeToRealtimeMock: vi.fn(),
  uploadFilesMock: vi.fn(),
  fetchChatProjectMock: vi.fn(),
  routeState: {
    view: undefined as string | undefined,
    session: undefined as string | undefined,
    project: undefined as string | undefined,
  },
}));

vi.mock("@solidjs/router", () => ({
  A: (props: Record<string, unknown>) => <a {...props} />,
  useNavigate: () => navigateMock,
  useLocation: () => ({ state: null }),
  useParams: () => ({ agentId: "agent-1", view: routeState.view }),
  useSearchParams: () => [
    {
      get project() { return routeState.project; },
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
  fetchAgentSessions: fetchAgentSessionsMock,
  getSessionKey: getSessionKeyMock,
  postAbort: postAbortMock,
  postCompact: postCompactMock,
  streamMessage: streamMessageMock,
  subscribeToSession: subscribeToSessionMock,
  subscribeToRealtime: subscribeToRealtimeMock,
  uploadFiles: uploadFilesMock,
}));

vi.mock("../api/main-agent", () => ({
  fetchMainAgentPreference: fetchMainAgentPreferenceMock,
  fetchMainAgentOptions: fetchMainAgentOptionsMock,
  saveMainAgentPreference: vi.fn(),
}));

vi.mock("../api/teams", () => ({ fetchPoolActions: fetchPoolActionsMock }));

vi.mock("../api/chat-projects", () => ({
  fetchChatProject: fetchChatProjectMock,
}));

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

class NotificationSocket {
  static OPEN = 1;
  static instances: NotificationSocket[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor() { NotificationSocket.instances.push(this); }
  send() {}
  close() { this.readyState = 3; this.onclose?.(); }
  complete(id: string, endedAt: number, sessionId = "session-main") {
    this.onmessage?.({ data: JSON.stringify({
      type: "status", agentId: "agent-1", sessionId,
      status: "idle", sessionStatus: "idle", completion: { id, endedAt },
    }) });
  }
}

function mountNotifications() {
  NotificationSocket.instances = [];
  localStorage.setItem("yoplai:chat-read-init:local", "1");
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.stubGlobal("WebSocket", NotificationSocket);
  vi.stubGlobal("Audio", class { volume = 0; play() { return Promise.resolve(); } });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items: [
    { agentId: "agent-1", agentName: "Agent", sessionId: "session-main", sessionKey: "main", lastActivity: 1 },
    { agentId: "agent-1", agentName: "Agent", sessionId: "session-other", sessionKey: "main", lastActivity: 1 },
  ] }), { status: 200, headers: { "content-type": "application/json" } })));
  const container = document.createElement("div");
  document.body.appendChild(container);
  const dispose = render(() => <TurnNotifier enabled={true} />, container);
  return () => { dispose(); visibility.mockRestore(); focus.mockRestore(); };
}
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
    localStorage.clear();
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
    routeState.project = undefined;
    fetchMainAgentPreferenceMock.mockResolvedValue({ mainAgentId: null, accessible: false, pickerDismissedAt: null });
    fetchMainAgentOptionsMock.mockResolvedValue({ preference: null, agents: [{ id: "agent-1", name: "Agent" }, { id: "agent-2", name: "Other" }] });
    fetchPoolActionsMock.mockResolvedValue([]);
    setRouteVersion(0);
  });

  afterEach(() => {
    document.body.innerHTML = "";
    resetCapabilitiesForTests();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("toggles notification sound beside the agent and follows other tabs", async () => {
    const view = renderView();
    await waitFor(() => expect(queryByRole(view.container, "button", { name: "Notification sound on" })).not.toBeNull());
    const bell = queryByRole(view.container, "button", { name: "Notification sound on" })!;
    expect(bell.getAttribute("aria-pressed")).toBe("true");
    expect(bell.closest("header")?.textContent).toContain("Agent");

    bell.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(localStorage.getItem("yoplai:notify-sound")).toBe("off");
    expect(queryByRole(view.container, "button", { name: "Notification sound off" })?.getAttribute("aria-pressed")).toBe("false");

    localStorage.setItem("yoplai:notify-sound", "on");
    window.dispatchEvent(new StorageEvent("storage", { key: "yoplai:notify-sound", newValue: "on" }));
    expect(queryByRole(view.container, "button", { name: "Notification sound on" })?.getAttribute("aria-pressed")).toBe("true");
    view.dispose();
  });

  it("reads its resolved chat without a session URL and stops reading on navigation", async () => {
    const disposeNotifier = mountNotifications();
    const view = renderView();
    await tick();
    const socket = NotificationSocket.instances[0];
    socket.complete("viewed-answer-1", 101);
    expect(localStorage.getItem("yoplai:chat-read:local:agent-1:session-main")).toBe("viewed-answer-1");

    fetchFullHistoryMock.mockImplementationOnce(() => new Promise(() => {}));
    routeState.session = "session-other";
    setRouteVersion((value) => value + 1);
    socket.complete("viewed-answer-2", 102);
    expect(localStorage.getItem("yoplai:chat-read:local:agent-1:session-main")).toBe("viewed-answer-1");
    view.dispose();
    disposeNotifier();
  });

  it("reads the first answer after sending from a blank chat without a persisted session", async () => {
    fetchFullHistoryMock.mockResolvedValueOnce({ messages: [] });
    let finish: (() => void) | undefined;
    streamMessageMock.mockImplementation((_agent, _message, _key, onText, onDone) => {
      finish = () => { onText("First answer"); onDone(); };
      return () => {};
    });
    const disposeNotifier = mountNotifications();
    const view = renderView();
    await tick();
    const input = view.container.querySelector("textarea")!;
    input.value = "First question";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    view.container.querySelector<HTMLButtonElement>(".send-btn")!.click();
    finish!();
    await tick();
    NotificationSocket.instances[0].complete("first-answer", 2001);
    expect(localStorage.getItem("yoplai:chat-read:local:agent-1:session-main")).toBe("first-answer");
    view.dispose();
    disposeNotifier();
  });

  it("keeps a reset session viewed while its history is loading", async () => {
    let reset: ((sessionId: string) => void) | undefined;
    streamMessageMock.mockImplementation((_agent, _message, _key, _onText, _onDone, _onError, callbacks) => {
      reset = callbacks.onSessionReset;
      return () => {};
    });
    const disposeNotifier = mountNotifications();
    const view = renderView();
    await tick();
    fetchFullHistoryMock.mockImplementationOnce(() => new Promise(() => {}));
    const input = view.container.querySelector("textarea")!;
    input.value = "/new";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    view.container.querySelector<HTMLButtonElement>(".send-btn")!.click();
    reset!("session-other");
    routeState.session = "session-other";
    setRouteVersion((value) => value + 1);
    NotificationSocket.instances[0].complete("reset-answer", 3001, "session-other");
    expect(localStorage.getItem("yoplai:chat-read:local:agent-1:session-other")).toBe("reset-answer");
    view.dispose();
    disposeNotifier();
  });

  it.each(["simple", "full"])("copies all eligible turn text in %s view with rich feedback", async (mode) => {
    routeState.view = mode;
    const write = vi.fn().mockResolvedValue(undefined);
    const writeText = vi.fn().mockResolvedValue(undefined);
    class Item {
      constructor(public data: Record<string, Blob>) {}
    }
    vi.stubGlobal("ClipboardItem", Item);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { write, writeText } });
    fetchFullHistoryMock.mockResolvedValue({ messages: [
      { role: "user", timestamp: 1, content: [{ type: "text", text: "Question" }] },
      { role: "assistant", timestamp: 2, content: [
        { type: "text", text: "## Before" },
        { type: "thinking", thinking: "private thinking" },
        { type: "toolCall", id: "tool-1", name: "tool-secret", arguments: {} },
      ] },
      { role: "toolResult", timestamp: 3, toolCallId: "tool-1", toolName: "tool-secret", content: [{ type: "text", text: "private result" }] },
      { role: "assistant", timestamp: 4, content: [{ type: "text", text: "**After**" }] },
    ] });
    const { container, dispose } = renderView();
    const buttons = () => queryAllByRole(container, "button", { name: "Copy reply" });
    await waitFor(() => expect(buttons()).toHaveLength(1));
    buttons()[0].click();
    await waitFor(() => expect(container.textContent).toContain("Copied"));
    const item = write.mock.calls[0][0][0] as Item;
    const read = (blob: Blob) => new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(blob);
    });
    expect(await read(item.data["text/plain"])).toBe("Before\n\nAfter");
    const html = await read(item.data["text/html"]);
    expect(html).toContain("<h2>Before</h2>");
    expect(html).toContain("<strong>After</strong>");
    expect(html).not.toContain("private");
    expect(html).not.toContain("tool-secret");
    expect(writeText).not.toHaveBeenCalled();
    dispose();
    vi.unstubAllGlobals();
  });

  it("falls back to clean text when rich clipboard APIs are absent", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("ClipboardItem", undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    fetchFullHistoryMock.mockResolvedValue({ messages: [
      { role: "user", timestamp: 1, content: [{ type: "text", text: "Question" }] },
      { role: "assistant", timestamp: 2, content: [{ type: "text", text: "**Answer**" }] },
    ] });
    const { container, dispose } = renderView();
    const button = () => queryByRole(container, "button", { name: "Copy reply" });
    await waitFor(() => expect(button()).not.toBeNull());
    button()!.click();
    await waitFor(() => expect(container.textContent).toContain("Copied"));
    expect(writeText).toHaveBeenCalledWith("Answer");
    dispose();
  });

  it.each(["rich rejects", "both reject"])("reports clipboard outcome when %s", async (outcome) => {
    const write = vi.fn().mockRejectedValue(new Error("blocked"));
    const writeText = outcome === "both reject" ? vi.fn().mockRejectedValue(new Error("blocked")) : vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("ClipboardItem", class { constructor(public data: Record<string, Blob>) {} });
    vi.stubGlobal("navigator", { ...navigator, clipboard: { write, writeText } });
    fetchFullHistoryMock.mockResolvedValue({ messages: [
      { role: "user", timestamp: 1, content: [{ type: "text", text: "Question" }] },
      { role: "assistant", timestamp: 2, content: [{ type: "text", text: "**Answer**" }] },
    ] });
    const { container, dispose } = renderView();
    const button = () => queryByRole(container, "button", { name: "Copy reply" });
    await waitFor(() => expect(button()).not.toBeNull());
    button()!.click();
    await waitFor(() => expect(button()!.textContent).toContain(outcome === "both reject" ? "Copy failed" : "Copied"));
    expect(write).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith("Answer");
    dispose();
  });

  it.each(["simple", "full"])("hides copying of the active %s turn even with a pending user", async (mode) => {
    routeState.view = mode;
    fetchFullHistoryMock.mockResolvedValue({ messages: [
      { role: "user", timestamp: 1, content: [{ type: "text", text: "Question" }] },
      { role: "assistant", timestamp: 2, content: [{ type: "text", text: "Partial reply" }] },
      { role: "user", timestamp: 5, content: [{ type: "text", text: "Pending question" }] },
    ], isStreaming: true, activeTurn: { userText: "Question", userTimestamp: 1, startedAt: 2, text: "more", thinking: "", toolCalls: [] } });
    const { container, dispose } = renderView();
    await waitFor(() => expect(container.textContent).toContain("Partial reply"));
    expect(queryAllByRole(container, "button", { name: "Copy reply" })).toHaveLength(0);
    dispose();
  });

  it.each(["simple", "full"])("does not copy an incomplete first history turn in %s view", async (mode) => {
    routeState.view = mode;
    fetchFullHistoryMock.mockResolvedValue({ messages: [
      { role: "assistant", timestamp: 2, content: [{ type: "text", text: "Incomplete earlier turn" }] },
      { role: "user", timestamp: 3, content: [{ type: "text", text: "New question" }] },
      { role: "assistant", timestamp: 4, content: [{ type: "text", text: "Complete answer" }] },
    ], nextCursor: "earlier", historyOffset: 100 });
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("ClipboardItem", undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const { container, dispose } = renderView();
    const buttons = () => queryAllByRole(container, "button", { name: "Copy reply" });
    await waitFor(() => expect(buttons()).toHaveLength(1));
    buttons()[0].click();
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Complete answer"));
    dispose();
  });

  it.each(["simple", "full"])("copies exact code in %s view after streamed HTML is replaced", async (mode) => {
    routeState.view = mode;
    let callbacks: SubscriptionCallbacks = {};
    subscribeToSessionMock.mockImplementation((_id, _key, next) => { callbacks = next; return () => {}; });
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const { container, dispose } = renderView();
    await tick(); await tick();
    callbacks.onText?.("```sh\n  echo '**raw**'\n\t<x>\n");
    await tick();
    callbacks.onText?.("\n```");
    const button = () => queryByRole(container, "button", { name: "Copy code" });
    await waitFor(() => expect(button()).not.toBeNull());
    button()!.click();
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("  echo '**raw**'\n\t<x>\n\n"));
    expect(button()!.textContent).toContain("Copied");
    dispose();
  });

  it("keeps chat usable while a clipboard write hangs", async () => {
    const write = vi.fn(() => new Promise<void>(() => {}));
    vi.stubGlobal("ClipboardItem", class { constructor(public data: Record<string, Blob>) {} });
    vi.stubGlobal("navigator", { ...navigator, clipboard: { write, writeText: vi.fn() } });
    fetchFullHistoryMock.mockResolvedValue({ messages: [
      { role: "user", timestamp: 1, content: [{ type: "text", text: "Question" }] },
      { role: "assistant", timestamp: 2, content: [{ type: "text", text: "Answer" }] },
    ] });
    const { container, dispose } = renderView();
    await waitFor(() => expect(queryByRole(container, "button", { name: "Copy reply" })).not.toBeNull());
    queryByRole(container, "button", { name: "Copy reply" })!.click();
    const input = queryByRole(container, "textbox") as HTMLTextAreaElement;
    input.value = "Next question";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    queryByRole(container, "button", { name: "Send message" })!.click();
    await waitFor(() => expect(streamMessageMock).toHaveBeenCalledWith("agent-1", "Next question", "main", expect.any(Function), expect.any(Function), expect.any(Function), expect.any(Object), expect.any(Object)));
    expect(write).toHaveBeenCalledOnce();
    dispose();
  });

  it.each(["simple", "full"])("does not offer copying a failed %s turn while history reload is delayed", async (mode) => {
    routeState.view = mode;
    let onError: ((text: string) => void) | undefined;
    streamMessageMock.mockImplementation((_id, _message, _key, _onText, _onDone, callback) => {
      onError = callback;
      return () => {};
    });
    const { container, dispose } = renderView();
    await tick(); await tick();
    const input = queryByRole(container, "textbox") as HTMLTextAreaElement;
    input.value = "Question";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    queryByRole(container, "button", { name: "Send message" })!.click();
    await waitFor(() => expect(onError).toBeDefined());
    fetchFullHistoryMock.mockImplementation(() => new Promise(() => {}));
    onError!("The AI service is temporarily unavailable.");
    await waitFor(() => expect(container.textContent).toContain("The AI service is temporarily unavailable."));
    expect(queryByRole(container, "button", { name: "Copy reply" })).toBeNull();
    dispose();
  });

  it("links the settings cog to the agent edit page", async () => {
    const { container, dispose } = renderView();
    await waitFor(() => expect(container.querySelector('a[aria-label="Agent settings"]')).not.toBeNull());
    expect(container.querySelector('a[aria-label="Agent settings"]')?.getAttribute("href")).toBe("/agents/agent-1/edit");
    dispose();
  });

  it("links the settings cog to the pool agent in forked mode and hides it without a match", async () => {
    setCapabilitiesForTests({ multiUser: false, forkedAgents: true });
    fetchPoolActionsMock.mockResolvedValue([{ poolId: "pool-1", action: "chat", chatAgentId: "agent-1", forked: true, reason: null, teamName: null }]);
    const first = renderView();
    await waitFor(() => expect(first.container.querySelector('a[aria-label="Agent settings"]')?.getAttribute("href")).toBe("/agents/pool-1/edit"));
    first.dispose();
    fetchPoolActionsMock.mockResolvedValue([]);
    const second = renderView();
    await tick();
    await tick();
    expect(second.container.querySelector('a[aria-label="Agent settings"]')).toBeNull();
    second.dispose();
  });

  it("shows an unpressed star for a non-main agent and opens the picker", async () => {
    const { container, dispose } = renderView();
    await waitFor(() => expect(container.querySelector('button[aria-label="Choose main agent"]')).not.toBeNull());
    const star = container.querySelector<HTMLButtonElement>('button[aria-label="Choose main agent"]')!;
    expect(star.getAttribute("aria-pressed")).toBe("false");
    star.click();
    await waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
    dispose();
  });

  it("shows a pressed star when the chat agent is the main agent", async () => {
    fetchMainAgentPreferenceMock.mockResolvedValue({ mainAgentId: "agent-1", accessible: true, pickerDismissedAt: null });
    const { container, dispose } = renderView();
    await waitFor(() => expect(container.querySelector('button[aria-label="Agent is your main agent. Change main agent"]')).not.toBeNull());
    expect(container.querySelector('button[aria-label="Agent is your main agent. Change main agent"]')?.getAttribute("aria-pressed")).toBe("true");
    dispose();
  });

  it.each(["full", "simple"] as const)("nests history tool calls once, collapsed in %s mode", async (mode) => {
    routeState.view = mode;
    fetchFullHistoryMock.mockResolvedValue({ messages: [
      { role: "assistant", timestamp: 1, content: [
        { type: "toolCall", id: "code-1", name: "codemode", arguments: {} },
        { type: "toolCall", id: "code-1/1", parentToolCallId: "code-1", name: "scheduler_list_jobs", arguments: {} },
        { type: "toolCall", id: "ordinary", name: "ordinary_tool", arguments: {} },
      ] },
      { role: "toolResult", toolCallId: "code-1/1", parentToolCallId: "code-1", toolName: "scheduler_list_jobs", content: [{ type: "text", text: "child result" }], timestamp: 2 },
    ] });
    const { container, dispose } = renderView();
    await waitFor(() => expect(container.querySelector(".activity-group-header")).not.toBeNull());
    (container.querySelector(".activity-group-header") as HTMLButtonElement).click();
    (container.querySelector("button.activity-line") as HTMLButtonElement).click();
    const group = container.querySelector<HTMLDetailsElement>(".nested-tool-calls");
    expect(group).not.toBeNull();
    expect(group!.open).toBe(false);
    expect(group!.parentElement!.querySelector('[title="codemode"]')).not.toBeNull();
    expect(group!.querySelector('[title="ordinary_tool"]')).toBeNull();
    expect(container.querySelectorAll('[title="scheduler_list_jobs"]')).toHaveLength(1);
    group!.open = true;
    (group!.querySelector(".tool-header") as HTMLButtonElement).click();
    expect(group!.textContent).toContain("child result");
    dispose();
  });

  it.each([
    ["full", "live"], ["simple", "live"], ["full", "reconnect"], ["simple", "reconnect"],
  ] as const)("nests %s %s child calls with inspectable results", async (mode, source) => {
    routeState.view = mode;
    let callbacks: SubscriptionCallbacks = {};
    subscribeToSessionMock.mockImplementation((_id, _key, next) => {
      callbacks = next;
      return () => {};
    });
    const { container, dispose } = renderView();
    await tick();
    await tick();
    if (source === "live") {
      callbacks.onToolCall?.("code-1", "codemode", {});
      callbacks.onToolCall?.("code-1/1", "scheduler_list_jobs", {}, "code-1");
      callbacks.onToolCall?.("code-1/1", "scheduler_list_jobs", {}, "code-1");
    } else {
      callbacks.onActiveTurn?.({ userText: null, userTimestamp: 1, startedAt: 1, thinking: "", text: "", toolCalls: [
        { id: "code-1", name: "codemode", arguments: {}, status: "running" },
        { id: "code-1/1", name: "scheduler_list_jobs", arguments: {}, parentToolCallId: "code-1", status: "done" },
      ] });
    }
    callbacks.onToolResult?.("code-1/1", "scheduler_list_jobs", "live child result", false, undefined, "code-1");
    await waitFor(() => expect(container.querySelector("button.activity-line")).not.toBeNull());
    (container.querySelector("button.activity-line") as HTMLButtonElement).click();
    const group = container.querySelector<HTMLDetailsElement>(".nested-tool-calls");
    expect(group).not.toBeNull();
    expect(group!.open).toBe(false);
    expect(group!.parentElement!.querySelector('[title="codemode"]')).not.toBeNull();
    expect(container.querySelectorAll('[title="scheduler_list_jobs"]')).toHaveLength(1);
    group!.open = true;
    (group!.querySelector(".tool-header") as HTMLButtonElement).click();
    expect(group!.textContent).toContain("live child result");
    dispose();
  });

  it.each([
    ["full", "reconnect"], ["simple", "reconnect"], ["full", "refresh"], ["simple", "refresh"],
  ] as const)("keeps completed %s child results on %s without another result event", async (mode, source) => {
    routeState.view = mode;
    let callbacks: SubscriptionCallbacks = {};
    subscribeToSessionMock.mockImplementation((_id, _key, next) => {
      callbacks = next;
      return () => {};
    });
    const { container, dispose } = renderView();
    await tick();
    await tick();
    if (source === "refresh") {
      callbacks.onToolCall?.("code-1", "codemode", {});
      callbacks.onToolCall?.("code-1/1", "scheduler_list_jobs", {}, "code-1");
      callbacks.onToolResult?.("code-1/1", "scheduler_list_jobs", "completed child result", false, undefined, "code-1");
    }
    callbacks.onActiveTurn?.({ userText: null, userTimestamp: 1, startedAt: 1, thinking: "", text: "", toolCalls: [
      { id: "code-1", name: "codemode", arguments: {}, status: "running" },
      { id: "code-1/1", name: "scheduler_list_jobs", arguments: {}, parentToolCallId: "code-1", status: "done" },
    ], ...(source === "reconnect" ? { toolResults: [
      { id: "code-1/1", name: "scheduler_list_jobs", content: "completed child result", isError: false, parentToolCallId: "code-1" },
    ] } : {}) });
    (container.querySelector("button.activity-line") as HTMLButtonElement).click();
    const group = container.querySelector<HTMLDetailsElement>(".nested-tool-calls");
    expect(group).not.toBeNull();
    expect(group!.open).toBe(false);
    group!.open = true;
    (group!.querySelector(".tool-header") as HTMLButtonElement).click();
    expect(group!.textContent).toContain("completed child result");
    expect(container.querySelectorAll('[title="scheduler_list_jobs"]')).toHaveLength(1);
    dispose();
  });

  it("resets a subscribed failed turn and renders its persisted notice once", async () => {
    let subscription: { onText?: (text: string) => void; onError?: (text: string) => void; onHistoryUpdated?: () => void } = {};
    subscribeToSessionMock.mockImplementation((_agentId, _key, callbacks) => {
      subscription = callbacks;
      return () => {};
    });
    const { container, dispose } = renderView();
    await tick();
    subscription.onText?.("partial output");
    await tick();
    const text = "Le service IA est temporairement saturé. Merci de réessayer dans quelques minutes.";
    fetchFullHistoryMock.mockResolvedValue({
      messages: [{ role: "assistant", content: [{ type: "text", text }], timestamp: Date.now(), meta: { failure: { kind: "rate_limit" } } }],
      sessionId: "session-main", isStreaming: false, activeTurn: null,
    });
    subscription.onError?.("provider secret request-id");
    subscription.onHistoryUpdated?.();
    await waitFor(() => expect(container.textContent).toContain(text));
    expect(container.querySelectorAll(".system-message")).toHaveLength(1);
    expect(container.textContent).not.toContain("provider secret");
    expect(container.querySelector(".message.streaming")).toBeNull();
    dispose();
  });

  it("reconciles a direct stream notice with persisted history without duplicates", async () => {
    let onError: ((text: string) => void) | undefined;
    streamMessageMock.mockImplementation((_agentId, _message, _key, _onText, _onDone, callback) => {
      onError = callback;
      return () => {};
    });
    const { container, dispose } = renderView();
    await tick();
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    textarea.value = "hello";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    (container.querySelector(".send-btn") as HTMLButtonElement).click();
    await tick();
    const text = "The AI service is temporarily rate-limited. Please try again in a few minutes.";
    fetchFullHistoryMock.mockResolvedValue({
      messages: [{ role: "assistant", content: [{ type: "text", text }], timestamp: Date.now(), meta: { failure: { kind: "rate_limit" } } }],
      sessionId: "session-main", isStreaming: false, activeTurn: null,
    });
    onError?.(text);
    await waitFor(() => expect(container.querySelector(".system-message")).not.toBeNull());
    expect(container.textContent?.split(text)).toHaveLength(2);
    expect(container.textContent).not.toContain("Error:");
    dispose();
  });

  it("passes the project query to the first run", async () => {
    routeState.project = "project-1";
    const { container, dispose } = renderView();
    await tick();
    await tick();
    const textarea = container.querySelector("textarea")!;
    textarea.value = "Hello project";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    const button = container.querySelector<HTMLButtonElement>(".send-btn")!;
    await waitFor(() => expect(button.disabled).toBe(false));
    button.click();
    await tick();
    expect(streamMessageMock.mock.calls[0]?.[7]).toMatchObject({ projectId: "project-1" });
    dispose();
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

  it("does not render generic progress text during a stream", async () => {
    let onProgress: ((progress: { label: string }) => void) | undefined;
    streamMessageMock.mockImplementation((...args: unknown[]) => {
      onProgress = (args[6] as { onProgress?: typeof onProgress }).onProgress;
      return () => {};
    });
    const { container, dispose } = renderView();
    await tick();
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    textarea.value = "hello";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    (container.querySelector(".send-btn") as HTMLButtonElement).click();
    await tick();
    onProgress?.({ label: "Progress updated." });
    await tick();
    expect(container.textContent).not.toContain("Progress updated.");
    dispose();
  });

  it("shows the hero with a one-liner and a note when no suggestions exist", async () => {
    fetchAgentSuggestionsMock.mockResolvedValue([]);
    const { container, dispose } = renderView();

    await waitFor(() =>
      expect(container.querySelector(".chat-view")?.classList).toContain(
        "hero-mode"
      )
    );
    expect(container.querySelector(".hero-avatar")).not.toBeNull();
    expect(
      container.querySelector(".hero-no-suggestions")?.textContent
    ).toContain("No prompt suggestions");
    expect(container.querySelector(".suggestion-card")).toBeNull();
    dispose();
  });

  it("refreshes suggestions for a new session with the same agent", async () => {
    fetchAgentSuggestionsMock
      .mockResolvedValueOnce([{ title: "First", prompt: "First prompt" }])
      .mockResolvedValueOnce([{ title: "Updated", prompt: "Updated prompt" }])
      .mockImplementation(async () => { console.log("DBG callN"); return []; });
    const { container, dispose } = renderView();

    await waitFor(() => expect(container.textContent).toContain("First"));
    routeState.session = "new-session";
    setRouteVersion((version) => version + 1);

    await waitFor(() => expect(container.textContent).toContain("Updated"));
    expect(fetchAgentSuggestionsMock).toHaveBeenCalledTimes(2);
    dispose();
  });

  it("keeps a direct stream scoped when switching conversations", async () => {
    let onText: ((chunk: string) => void) | undefined;
    let onDone: (() => void) | undefined;
    let onError: ((error: string) => void) | undefined;
    let callbacks:
      | {
          onThinking?: (chunk: string) => void;
          onToolCall?: (id: string, name: string, args: unknown) => void;
        }
      | undefined;
    const detach = vi.fn();
    const sessionSubscriptions = new Map<
      string | undefined,
      { onText?: (chunk: string) => void; onHistoryUpdated?: () => void }
    >();
    let sessionALoads = 0;

    routeState.session = "session-a";
    fetchFullHistoryMock.mockImplementation(
      async (_agentId: string, _key: string, sessionId?: string) => {
        if (sessionId === "session-b") {
          return {
            messages: [
              {
                role: "assistant" as const,
                content: [{ type: "text" as const, text: "B history" }],
                timestamp: 20,
              },
            ],
            sessionId,
            isStreaming: false,
            activeTurn: null,
          };
        }
        sessionALoads += 1;
        if (sessionALoads > 2) {
          return {
            messages: [
              {
                role: "assistant" as const,
                content: [{ type: "text" as const, text: "A final reply" }],
                timestamp: 30,
              },
            ],
            sessionId: "session-a",
            isStreaming: false,
            activeTurn: null,
          };
        }
        return {
          messages: [],
          sessionId: "session-a",
          isStreaming: sessionALoads > 1,
          activeTurn:
            sessionALoads > 1
              ? {
                  userText: "hello A",
                  userTimestamp: 10,
                  startedAt: 11,
                  thinking: "rehydrated thinking",
                  text: "rehydrated A",
                  toolCalls: [],
                }
              : null,
        };
      }
    );
    streamMessageMock.mockImplementation(
      (
        _agentId: string,
        _message: string,
        _sessionKey: string,
        nextOnText: (chunk: string) => void,
        nextOnDone: () => void,
        nextOnError: (error: string) => void,
        nextCallbacks?: typeof callbacks
      ) => {
        onText = nextOnText;
        onDone = nextOnDone;
        onError = nextOnError;
        callbacks = nextCallbacks;
        return detach;
      }
    );
    subscribeToSessionMock.mockImplementation(
      (
        _agentId: string,
        _key: string,
        subscriptionCallbacks,
        sessionId?: string
      ) => {
        sessionSubscriptions.set(sessionId, subscriptionCallbacks);
        return vi.fn();
      }
    );

    const { container, dispose } = renderView();
    await waitFor(() =>
      expect(container.querySelector("textarea")).not.toBeNull()
    );
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    textarea.value = "hello A";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    (container.querySelector(".send-btn") as HTMLButtonElement).click();
    await tick();
    onText?.("A live text");
    await waitFor(() => expect(container.textContent).toContain("A live text"));

    routeState.session = "session-b";
    setRouteVersion((version) => version + 1);
    await waitFor(() => expect(container.textContent).toContain("B history"));
    expect(detach).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain("A live text");

    onText?.("foreign text");
    callbacks?.onThinking?.("foreign thinking");
    callbacks?.onToolCall?.("tool-a", "foreign-tool", {});
    onError?.("foreign error");
    onDone?.();
    sessionSubscriptions.get("session-a")?.onText?.("foreign subscription");
    sessionSubscriptions.get("session-a")?.onHistoryUpdated?.();
    await tick();
    expect(container.textContent).toContain("B history");
    expect(container.textContent).not.toContain("foreign");

    routeState.session = "session-a";
    setRouteVersion((version) => version + 1);
    await waitFor(() =>
      expect(container.textContent).toContain("rehydrated A")
    );
    expect(container.textContent).not.toContain("B history");

    sessionSubscriptions.get("session-a")?.onHistoryUpdated?.();
    await waitFor(() => expect(container.textContent).toContain("A final reply"));
    routeState.session = "session-b";
    setRouteVersion((version) => version + 1);
    await waitFor(() => expect(container.textContent).toContain("B history"));
    expect(container.textContent).not.toContain("A final reply");
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

    expect(container.textContent).toContain("Worked");
    expect(container.textContent).toContain("final answer");

    const groupToggle = container.querySelector(".activity-group-header");
    if (!(groupToggle instanceof HTMLButtonElement))
      throw new Error("Expected activity group toggle");
    groupToggle.click();
    await tick();
    const thinkingToggle = container.querySelector("button.activity-line");
    if (!(thinkingToggle instanceof HTMLButtonElement))
      throw new Error("Expected thinking toggle");
    thinkingToggle.click();
    await tick();

    expect(container.textContent).toContain("private chain summary");

    dispose();
  });

  it("groups full-history activity across assistant and tool-result messages", async () => {
    routeState.view = "full";
    fetchFullHistoryMock.mockResolvedValue({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "first thought" },
            { type: "toolCall", id: "tool-a", name: "bash", arguments: {} },
          ],
          timestamp: 100,
        },
        {
          role: "toolResult",
          toolCallId: "tool-a",
          toolName: "bash",
          content: [{ type: "text", text: "A result" }],
          isError: false,
          timestamp: 110,
        },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "second thought" },
            { type: "toolCall", id: "tool-b", name: "read", arguments: {} },
            { type: "text", text: "answer" },
          ],
          timestamp: 120,
        },
        {
          role: "user",
          content: [{ type: "text", text: "next turn" }],
          timestamp: 130,
        },
      ],
      thinkingLevel: undefined,
      isStreaming: false,
      activeTurn: null,
    });

    const { container, dispose } = renderView();
    await waitFor(() => expect(container.textContent).toContain("next turn"));

    expect(container.querySelectorAll(".activity-group")).toHaveLength(1);
    expect(
      container.querySelector(".activity-group-header")?.textContent
    ).toContain("2 tool calls");
    expect((container.textContent ?? "").indexOf("2 tool calls")).toBeLessThan(
      (container.textContent ?? "").indexOf("answer")
    );
    expect((container.textContent ?? "").indexOf("answer")).toBeLessThan(
      (container.textContent ?? "").indexOf("next turn")
    );
    dispose();
  });

  describe("tool run sections", () => {
    const history = (calls: { name: string; arguments: unknown }[]) => ({
      messages: [
        {
          role: "assistant",
          content: [
            ...calls.map((c, i) => ({
              type: "toolCall",
              id: `t${i}`,
              name: c.name,
              arguments: c.arguments,
            })),
            { type: "text", text: "done" },
          ],
          timestamp: 100,
        },
        ...calls.map((c, i) => ({
          role: "toolResult",
          toolCallId: `t${i}`,
          toolName: c.name,
          content: [{ type: "text", text: `out-${i}` }],
          isError: false,
          timestamp: 110,
        })),
      ],
      thinkingLevel: undefined,
      isStreaming: false,
      activeTurn: null,
    });
    const open = async (
      calls: { name: string; arguments: unknown }[],
      view: "simple" | "full" = "simple"
    ) => {
      routeState.view = view;
      fetchFullHistoryMock.mockResolvedValue(history(calls));
      const r = renderView();
      await waitFor(() => expect(r.container.textContent).toContain("done"));
      return r;
    };
    const click = async (el: Element | null) => {
      if (!(el instanceof HTMLButtonElement)) throw new Error("no button");
      el.click();
      await tick();
    };

    it.each([
      [[{ name: "bash", arguments: { command: "ls" } }], "Ran commands"],
      [[{ name: "read", arguments: {} }], "Called tools"],
      [
        [
          { name: "bash", arguments: { command: "ls" } },
          { name: "read", arguments: {} },
        ],
        "Ran commands, called tools",
      ],
    ])("labels section %#", async (calls, label) => {
      const { container, dispose } = await open(calls);
      await click(container.querySelector(".activity-group-header"));
      const line = container.querySelector("button.activity-line");
      expect(line?.textContent).toBe(label);
      expect(container.querySelector(".activity-tool-run")).toBeNull();
      dispose();
    });

    it("expands to show calls with command in code", async () => {
      const { container, dispose } = await open([
        { name: "bash", arguments: { command: "ls -la" } },
      ]);
      await click(container.querySelector(".activity-group-header"));
      await click(container.querySelector("button.activity-line"));
      const code = container.querySelector(".activity-tool-run code");
      expect(code?.textContent).toBe("ls -la");
      expect(container.querySelector(".activity-tool-run")?.textContent).toContain(
        "Ran ls -la"
      );
      dispose();
    });

    it("renders full-view bash output in a code block", async () => {
      const { container, dispose } = await open(
        [{ name: "bash", arguments: { command: "ls" } }],
        "full"
      );
      await click(container.querySelector(".activity-group-header"));
      await click(container.querySelector("button.activity-line"));
      await click(container.querySelector(".tool-header"));
      const block = container.querySelector("pre.tool-terminal");
      expect(block?.textContent).toContain("$ ls");
      expect(block?.textContent).toContain("out-0");
      dispose();
    });
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

  it("shows raw NO_REPLY in full view", async () => {
    routeState.view = "full";
    fetchFullHistoryMock.mockResolvedValue({
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "**NO_REPLY**" }],
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

    expect(container.textContent).toContain("NO_REPLY");

    dispose();
  });

  it("hides a no-reply assistant turn in simple view", async () => {
    routeState.view = "simple";
    fetchFullHistoryMock.mockResolvedValue({
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "**NO_REPLY**" }],
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

    expect(container.querySelector(".message.assistant")).toBeNull();
    expect(container.textContent).not.toContain("NO_REPLY");

    dispose();
  });

  it("forces simple view and hides view toggle for non-admin users", async () => {
    routeState.view = "full";
    const nonAdmin = { multiUser: true, user: { id: "user-1", role: "user" } };
    fetchCapabilitiesMock.mockResolvedValue({ version: 2, extensions: {}, agents: ["agent-1"], ...nonAdmin });
    setCapabilitiesForTests(nonAdmin);
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

  it.each([undefined, "full"])("shows every summary collapsed in %s mode after reopen", async (mode) => {
    routeState.view = mode;
    fetchFullHistoryMock.mockResolvedValue({
      messages: [
        { role: "user", content: [{ type: "text", text: "original conversation" }], timestamp: 1 },
        { role: "system", content: [{ type: "text", text: "[COMPACTED CONTEXT SUMMARY]\nFirst complete summary\nSecond line" }], timestamp: 2 },
        { role: "system", content: [{ type: "text", text: "[COMPACTED CONTEXT SUMMARY]\nLater summary" }], timestamp: 3 },
      ],
      activeContextUsage: { inputTokens: 0 },
    });
    let view = renderView();
    await waitFor(() => expect(view.container.querySelectorAll("details summary").length).toBe(2));
    expect(view.container.textContent).toContain("original conversation");
    const disclosures = view.container.querySelectorAll(".compaction-summary details");
    expect([...disclosures].every((element) => !element.hasAttribute("open"))).toBe(true);
    expect(disclosures[0].querySelector("summary")?.tagName).toBe("SUMMARY");
    disclosures[0].setAttribute("open", "");
    expect(disclosures[0].textContent).toContain("First complete summary\nSecond line");
    view.dispose();
    view.container.remove();
    view = renderView();
    await waitFor(() => expect(view.container.querySelectorAll(".compaction-summary details").length).toBe(2));
    expect(view.container.querySelector(".compaction-summary details")?.hasAttribute("open")).toBe(false);
    view.dispose();
  });

  it("loads earlier history in bounded pages and keeps chronological duplicates", async () => {
    fetchFullHistoryMock.mockResolvedValueOnce({
      messages: [{ role: "assistant", content: [{ type: "text", text: "recent message" }], timestamp: 5 }],
      nextCursor: "before-recent",
      activeContextUsage: { inputTokens: 0 },
    }).mockResolvedValueOnce({
      messages: [
        { role: "user", content: [{ type: "text", text: "earliest message" }], timestamp: 1 },
        { role: "user", content: [{ type: "text", text: "earliest message" }], timestamp: 1 },
      ],
    });
    const { container, dispose } = renderView();
    await waitFor(() => expect(container.querySelector(".load-earlier")).not.toBeNull());
    (container.querySelector(".load-earlier") as HTMLButtonElement).click();
    await waitFor(() => expect(container.querySelectorAll(".message.user").length).toBe(2));
    expect(fetchFullHistoryMock).toHaveBeenCalledWith("agent-1", "main", undefined, { limit: 100, before: "before-recent" });
    expect(container.querySelector(".load-earlier")).toBeNull();
    expect(container.textContent?.indexOf("earliest message")).toBeLessThan(container.textContent?.indexOf("recent message") ?? 0);
    dispose();
  });

  it("retries failed earlier-page loads without losing the visible tail", async () => {
    const recent = { role: "user", content: [{ type: "text", text: "visible tail" }], timestamp: 5 };
    fetchFullHistoryMock.mockResolvedValueOnce({ messages: [recent], nextCursor: "older", historyOffset: 1 })
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ messages: [{ role: "user", content: [{ type: "text", text: "oldest" }], timestamp: 1 }], historyOffset: 0 });
    const { container, dispose } = renderView();
    await waitFor(() => expect(container.querySelector(".load-earlier")).not.toBeNull());
    (container.querySelector(".load-earlier") as HTMLButtonElement).click();
    await waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain("Please retry"));
    expect(container.textContent).toContain("visible tail");
    (container.querySelector(".load-earlier") as HTMLButtonElement).click();
    await waitFor(() => expect(container.textContent).toContain("oldest"));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    dispose();
  });

  it("ignores archived high usage when active context has been compacted", async () => {
    fetchFullHistoryMock.mockResolvedValue({
      messages: [{ role: "assistant", content: [{ type: "text", text: "archived response" }], timestamp: 1, meta: { model: "gpt-5", usage: { input: 390000 } } }],
      activeContextUsage: { inputTokens: 0, model: "gpt-5" },
    });
    const { container, dispose } = renderView();
    await waitFor(() => expect(container.textContent).toContain("0% context used"));
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    textarea.value = "new turn";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await tick();
    expect(postCompactMock).not.toHaveBeenCalled();
    dispose();
  });

  it.each([undefined, "full"])("runs manual compaction with a persisted summary in %s view", async (view) => {
    routeState.view = view;
    fetchFullHistoryMock.mockResolvedValue({
      messages: [
        { role: "assistant", content: [
          { type: "thinking", thinking: "archived reasoning" },
          { type: "text", text: "archived answer" },
          { type: "text", text: "another archived block" },
        ], timestamp: 1 },
        { role: "system", content: [{ type: "text", text: "[COMPACTED CONTEXT SUMMARY]\nEarlier summary" }], timestamp: 2 },
        { role: "system", content: [{ type: "text", text: "[COMPACTED CONTEXT SUMMARY]\nLatest summary" }], timestamp: 3 },
        { role: "assistant", content: [{ type: "thinking", thinking: "retained reasoning" }], timestamp: 4 },
      ],
      sessionId: "session-main",
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
    expect(container.querySelectorAll(".compact-status")).toHaveLength(1);
    const latestSummary = container.querySelectorAll(".compaction-summary")[1];
    expect(latestSummary.textContent).toContain("Latest summary");
    expect(
      latestSummary.compareDocumentPosition(container.querySelector(".compact-status")!) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

    // Later messages flow below the status instead of above it.
    await new Promise((resolve) => setTimeout(resolve, 2));
    textarea.value = "after compact";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    await waitFor(() => expect(sendBtn.disabled).toBe(false));
    sendBtn.click();
    await tick();

    const status = container.querySelector(".compact-status");
    expect(container.querySelectorAll(".compact-status")).toHaveLength(1);
    const userMessages = container.querySelectorAll(".message.user");
    const lastUser = userMessages[userMessages.length - 1];
    expect(lastUser?.textContent).toContain("after compact");
    expect(
      status!.compareDocumentPosition(lastUser!) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

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
    let onText: ((chunk: string) => void) | undefined;
    let onDone: (() => void) | undefined;
    streamMessageMock.mockImplementation(
      (
        _agentId: string,
        _message: string,
        _sessionKey: string,
        nextOnText: (chunk: string) => void,
        nextOnDone: () => void,
        _onError: (error: string) => void,
        callbacks?: { onSessionReset?: (sessionId: string) => void }
      ) => {
        onText = nextOnText;
        onDone = nextOnDone;
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
    routeState.session = "fresh-session";
    setRouteVersion((version) => version + 1);
    await tick();
    onText?.("Started a fresh session");
    onDone?.();
    await tick();
    expect(container.textContent).toContain("Started a fresh session");

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

  it("loads a silent turn from history after a live full-view completion", async () => {
    routeState.view = "full";
    let onDone: (() => void) | undefined;
    let onThinking: ((chunk: string) => void) | undefined;
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
            role: "assistant",
            content: [{ type: "text", text: "NO_REPLY" }],
            timestamp: 2,
          },
        ],
        thinkingLevel: undefined,
        isStreaming: false,
        activeTurn: null,
      });
    streamMessageMock.mockImplementation(
      (_agentId, _message, _sessionKey, _onText, nextOnDone, _onError, callbacks) => {
        onDone = nextOnDone;
        onThinking = callbacks?.onThinking;
        return vi.fn();
      }
    );

    const { container, dispose } = renderView();
    await tick();
    await tick();
    const textarea = container.querySelector("textarea");
    const sendBtn = container.querySelector(".send-btn");
    if (!(textarea instanceof HTMLTextAreaElement) || !(sendBtn instanceof HTMLButtonElement)) {
      throw new Error("Expected chat controls");
    }
    textarea.value = "don't reply";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await waitFor(() => expect(sendBtn.disabled).toBe(false));
    sendBtn.click();
    await tick();

    onThinking?.("User asked for silence.");
    onDone?.();
    await waitFor(() => expect(container.textContent).toContain("NO_REPLY"));
    dispose();
  });

  it("preserves thinking duration when a live stream completes", async () => {
    let onDone: (() => void) | undefined;
    let onThinking: ((chunk: string) => void) | undefined;
    streamMessageMock.mockImplementation(
      (
        _agentId: string,
        _message: string,
        _sessionKey: string,
        _onText: (chunk: string) => void,
        nextOnDone: () => void,
        _onError: (error: string) => void,
        callbacks?: { onThinking?: (chunk: string) => void }
      ) => {
        onDone = nextOnDone;
        onThinking = callbacks?.onThinking;
        return vi.fn();
      }
    );

    const { container, dispose } = renderView();
    await tick();
    await tick();
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    textarea.value = "hello";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    const sendBtn = container.querySelector(".send-btn") as HTMLButtonElement;
    await waitFor(() => expect(sendBtn.disabled).toBe(false));
    sendBtn.click();
    await tick();

    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    onThinking?.("working through problem");
    await tick();
    expect(
      container.querySelector(".activity-group-header")?.textContent
    ).toContain("Working");
    now.mockReturnValue(7_000);
    onDone?.();
    await tick();
    now.mockRestore();

    expect(
      container.querySelector(".activity-group-header")?.textContent
    ).toContain("Worked for 6s");
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
    await waitFor(() =>
      expect(container.textContent).toContain("Ran commands")
    );
    (
      container.querySelector("button.activity-line") as HTMLButtonElement
    ).click();
    await waitFor(() => expect(container.querySelector(".tool-header")).toBeTruthy());
    const toolToggle = container.querySelector(".tool-header");
    if (!(toolToggle instanceof HTMLButtonElement))
      throw new Error("Expected tool toggle");
    toolToggle.click();
    await waitFor(() => {
      const text = container.textContent ?? "";
      expect(text).toContain("First text.");
      expect(text).toContain("Ran date");
      expect(text).toContain("tool output");
      expect(text).toContain("Last text.");
    });

    const liveText = container.textContent ?? "";
    expect(liveText.indexOf("First text.")).toBeLessThan(
      liveText.indexOf("Ran date")
    );
    expect(liveText.indexOf("tool output")).toBeLessThan(
      liveText.indexOf("Last text.")
    );

    onDone?.();
    await tick();

    const finalText = container.textContent ?? "";
    expect(finalText.indexOf("First text.")).toBeLessThan(
      finalText.indexOf("1 tool call")
    );
    expect(finalText.indexOf("1 tool call")).toBeLessThan(
      finalText.indexOf("Last text.")
    );
    expect(finalText).not.toContain("tool output");
    expect(fetchFullHistoryMock.mock.calls.length).toBe(fetchesBeforeDone);
    subscriptionCallbacks?.onDone?.();
    await tick();
    expect(container.textContent).toContain("1 tool call");
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
    const inputWrapper = container.querySelector(".input-pill");
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

  async function startFullStream() {
    let callbacks: Partial<StreamCallbacks> | undefined;
    let onText: ((chunk: string) => void) | undefined;
    let onDone: (() => void) | undefined;
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
    const view = renderView();
    await tick();
    await tick();
    const textarea = view.container.querySelector(
      "textarea"
    ) as HTMLTextAreaElement;
    textarea.value = "hello";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    const sendBtn = view.container.querySelector(
      ".send-btn"
    ) as HTMLButtonElement;
    await waitFor(() => expect(sendBtn.disabled).toBe(false));
    sendBtn.click();
    await tick();
    return {
      ...view,
      onText: (c: string) => onText?.(c),
      onDone: () => onDone?.(),
      callbacks: () => callbacks,
    };
  }

  it("does not offer copying a queued failure while history reload is delayed", async () => {
    const { container, dispose } = await startFullStream();
    let onError: ((text: string) => void) | undefined;
    streamMessageMock.mockImplementation((_id, _message, _key, _onText, _onDone, callback) => {
      onError = callback;
      return () => {};
    });
    const input = queryByRole(container, "textbox") as HTMLTextAreaElement;
    input.value = "Pending question";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await waitFor(() => expect(onError).toBeDefined());
    fetchFullHistoryMock.mockImplementation(() => new Promise(() => {}));
    onError!("The queued request failed.");
    await waitFor(() => expect(container.textContent).toContain("The queued request failed."));
    expect(queryByRole(container, "button", { name: "Copy reply" })).toBeNull();
    dispose();
  });

  it.each(["simple", "full"])("copies one complete %s reply when a user queued a message mid-turn", async (mode) => {
    routeState.view = mode;
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("ClipboardItem", undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const { container, dispose, onText, onDone } = await startFullStream();
    onText("Before queue");
    await tick();
    streamMessageMock.mockImplementation(() => vi.fn());
    const input = container.querySelector("textarea")!;
    input.value = "Pending question";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await tick();
    onText("After queue");
    const buttons = () => queryAllByRole(container, "button", { name: "Copy reply" });
    expect(buttons()).toHaveLength(0);
    onDone();
    await waitFor(() => expect(buttons()).toHaveLength(1));
    buttons()[0].click();
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Before queue\n\nAfter queue"));
    dispose();
  });

  it.each([
    ["simple", "completed"], ["simple", "running"],
    ["full", "completed"], ["full", "running"],
  ] as const)("keeps %s %s tool activity grouped after queueing", async (mode, status) => {
    routeState.view = mode;
    const { container, dispose, callbacks } = await startFullStream();
    callbacks()!.onToolStart!("bash");
    callbacks()!.onToolCall!("before-queue", "bash", { command: "pwd" });
    if (status === "completed") {
      callbacks()!.onToolResult!("before-queue", "bash", "before queue result", false);
      callbacks()!.onToolEnd!("bash", false);
    }
    await tick();
    expect(queryByRole(container, "button", { name: "Working · 1 tool call" })).not.toBeNull();

    streamMessageMock.mockImplementation(() => vi.fn());
    const input = container.querySelector("textarea")!;
    input.value = "Pending question";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await tick();

    expect(container.textContent).toContain("Pending question");
    const group = queryByRole(container, "button", { name: /Worked.* · 1 tool call/ });
    expect(group).not.toBeNull();
    expect(group!.parentElement!.querySelector(".activity-group-items")).toBeNull();
    expect(container.querySelector(".active-tools, .active-tool")).toBeNull();
    expect(container.querySelector(".thinking-dots")).not.toBeNull();

    if (status === "running") {
      callbacks()!.onToolResult!("before-queue", "bash", "before queue result", false);
      callbacks()!.onToolEnd!("bash", false);
      await tick();
      expect(container.querySelector(".active-tools, .active-tool")).toBeNull();
      expect(container.querySelector(".thinking-dots")).not.toBeNull();
    }
    group!.click();
    queryByRole(container, "button", { name: /Ran commands|Running commands/ })!.click();
    expect(container.querySelectorAll('[title="bash"]')).toHaveLength(1);
    if (mode === "full") {
      (container.querySelector(".tool-header") as HTMLButtonElement).click();
      expect(container.textContent).toContain("before queue result");
    }

    callbacks()!.onToolStart!("read");
    callbacks()!.onToolCall!("after-queue", "read", { path: "README.md" });
    await tick();
    expect(queryByRole(container, "button", { name: "Working · 1 tool call" })).not.toBeNull();
    queryByRole(container, "button", { name: "Calling tools" })!.click();
    expect(container.querySelectorAll(".activity-group")).toHaveLength(2);
    expect(container.querySelectorAll('[title="bash"]')).toHaveLength(1);
    expect(container.querySelectorAll('[title="read"]')).toHaveLength(1);
    expect(container.querySelector(".active-tools, .active-tool")).toBeNull();
    expect(container.querySelector(".thinking-dots")).toBeNull();
    dispose();
  });

  it.each(["simple", "full"])("copies a stopped reply after the %s turn finishes", async (mode) => {
    routeState.view = mode;
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("ClipboardItem", undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const { container, dispose, onText, onDone } = await startFullStream();
    onText("Stopped answer");
    queryByRole(container, "button", { name: "Stop agent" })!.click();
    await tick();
    onDone();
    await waitFor(() => expect(queryByRole(container, "button", { name: "Copy reply" })).not.toBeNull());
    queryByRole(container, "button", { name: "Copy reply" })!.click();
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Stopped answer"));
    dispose();
  });

  it.each([
    ["full", "direct"], ["simple", "direct"], ["full", "queued"], ["simple", "queued"],
  ] as const)("preserves %s %s nested calls through completion", async (mode, source) => {
    routeState.view = mode;
    const { container, dispose, callbacks, onText, onDone } = await startFullStream();
    if (source === "queued") {
      const input = container.querySelector("textarea") as HTMLTextAreaElement;
      input.value = "next request";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await tick();
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await tick();
    }
    callbacks()?.onToolCall?.("code-1", "codemode", {});
    callbacks()?.onToolCall?.("code-1/1", "scheduler_list_jobs", {}, "code-1");
    callbacks()?.onToolResult?.("code-1/1", "scheduler_list_jobs", "direct child result", false, undefined, "code-1");
    onText("batch complete");
    onDone();
    await tick();
    (container.querySelector(".activity-group-header") as HTMLButtonElement).click();
    (container.querySelector("button.activity-line") as HTMLButtonElement).click();
    const group = container.querySelector<HTMLDetailsElement>(".nested-tool-calls");
    expect(group).not.toBeNull();
    expect(group!.open).toBe(false);
    expect(container.querySelectorAll('[title="scheduler_list_jobs"]')).toHaveLength(1);
    group!.open = true;
    (group!.querySelector(".tool-header") as HTMLButtonElement).click();
    expect(group!.textContent).toContain("direct child result");
    dispose();
  });

  it.each(["full", "simple"] as const)(
    "retains streamed text nodes and collapsed activity across chunks in %s view",
    async (mode) => {
      routeState.view = mode;
      const { container, dispose, callbacks, onText } = await startFullStream();
      callbacks()?.onThinking?.("Check the inputs ");
      await tick();
      const activity = container.querySelector<HTMLElement>(".activity-group")!;
      expect(activity.querySelector(".activity-group-items")).not.toBeNull();
      activity.querySelector<HTMLButtonElement>(".activity-group-header")!.click();
      callbacks()?.onThinking?.("and choose a result.");
      await tick();
      expect(container.querySelector(".activity-group")).toBe(activity);
      expect(activity.isConnected).toBe(true);
      expect(activity.querySelector(".activity-group-items")).toBeNull();

      const textNodes = () => container.querySelectorAll<HTMLElement>(
        mode === "full" ? ".streaming .block-text" : ".message.streaming .content"
      );
      onText("First answer");
      await tick();
      const first = textNodes()[0];
      expect(first.textContent?.trim()).toBe("First answer");
      onText(" grows.");
      await tick();
      expect(textNodes()[0]).toBe(first);
      expect(first.isConnected).toBe(true);
      expect(first.textContent?.trim()).toBe("First answer grows.");
      expect(container.querySelector(".activity-group")).toBe(activity);
      expect(activity.querySelector(".activity-group-items")).toBeNull();

      callbacks()?.onToolCall?.("node-tool", "bash", { command: "pwd" });
      await tick();
      const toolActivity = container.querySelectorAll<HTMLElement>(".activity-group")[1];
      expect(toolActivity.querySelector(".activity-group-items")).not.toBeNull();
      toolActivity.querySelector<HTMLButtonElement>(".activity-group-header")!.click();
      callbacks()?.onToolResult?.("node-tool", "bash", "/conversation", false);
      onText("Later answer");
      await tick();
      const later = textNodes()[1];
      expect(later.textContent?.trim()).toBe("Later answer");
      onText(" also grows.");
      await tick();
      expect(textNodes()[1]).toBe(later);
      expect(later.isConnected).toBe(true);
      expect(later.textContent?.trim()).toBe("Later answer also grows.");
      expect(textNodes()[0]).toBe(first);
      expect(first.isConnected).toBe(true);
      expect(container.querySelectorAll(".activity-group")[1]).toBe(toolActivity);
      expect(toolActivity.isConnected).toBe(true);
      expect(toolActivity.querySelector(".activity-group-items")).toBeNull();
      dispose();
    }
  );

  it.each(["full", "simple"] as const)(
    "re-renders streamed text chunks in %s view",
    async (mode) => {
      routeState.view = mode;
      const { container, dispose, onText } = await startFullStream();
      onText("Hello");
      await tick();
      onText(" world");
      await waitFor(() =>
        expect(container.textContent).toContain("Hello world")
      );
      dispose();
    }
  );

  it.each(["full", "simple"] as const)(
    "keeps thinking before tool call while streaming in %s view",
    async (mode) => {
      routeState.view = mode;
      const { container, dispose, callbacks } = await startFullStream();
      callbacks()?.onThinking?.("plan it");
      await tick();
      callbacks()?.onToolCall?.("t1", "bash", {});
      await tick();
      await waitFor(() =>
        expect(
          container.querySelectorAll(
            ".activity-item,.tool-block,.activity-line"
          ).length
        ).toBeGreaterThan(1)
      );
      const text = container.textContent ?? "";
      const thought = text.search(/plan it|Thinking|Thought/);
      const tool = text.indexOf("Running commands");
      expect(thought).toBeGreaterThanOrEqual(0);
      expect(thought).toBeLessThan(tool);
      dispose();
    }
  );

  it("keeps an expanded history activity group expanded when a message is appended", async () => {
    routeState.view = "full";
    const history = (extra: unknown[]) => ({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "t" },
            { type: "toolCall", id: "a", name: "bash", arguments: {} },
            { type: "text", text: "answer" },
          ],
          timestamp: 100,
        },
        ...extra,
      ],
      thinkingLevel: undefined,
      isStreaming: false,
      activeTurn: null,
    });
    fetchFullHistoryMock.mockResolvedValue(history([]));
    let subscription: { onHistoryUpdated?: () => void } | undefined;
    subscribeToSessionMock.mockImplementation(
      (_agentId: string, _sessionKey: string, callbacksArg) => {
        subscription = callbacksArg;
        return vi.fn();
      }
    );
    const { container, dispose } = renderView();
    await waitFor(() => expect(container.textContent).toContain("answer"));
    (
      container.querySelector(".activity-group-header") as HTMLButtonElement
    ).click();
    await tick();
    expect(container.querySelector(".activity-group-items")).not.toBeNull();

    fetchFullHistoryMock.mockResolvedValue(
      history([
        {
          role: "user",
          content: [{ type: "text", text: "appended" }],
          timestamp: 200,
        },
      ])
    );
    subscription?.onHistoryUpdated?.();
    await waitFor(() => expect(container.textContent).toContain("appended"));
    expect(container.querySelector(".activity-group-items")).not.toBeNull();
    dispose();
  });
});

describe("ThinkingLine ticker", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("samples streamed content every five seconds and clears its interval", () => {
    vi.useFakeTimers();
    const [content, setContent] = createSignal("one two three four five ");
    const [active, setActive] = createSignal(true);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(
      () => (
        <ThinkingLine type="thinking" content={content()} active={active()} />
      ),
      container
    );

    expect(container.textContent).toContain("one two three four five…");
    setContent("six seven eight nine ten ");
    vi.advanceTimersByTime(4999);
    expect(container.textContent).toContain("one two three four five…");
    vi.advanceTimersByTime(1);
    expect(container.textContent).toContain("six seven eight nine ten…");

    setActive(false);
    expect(container.textContent).toContain("Thought");
    expect(vi.getTimerCount()).toBe(0);
    setActive(true);
    expect(vi.getTimerCount()).toBe(1);
    dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("ThinkingLine ticker (shared item source)", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("does not resample per token when content and active share a source", () => {
    vi.useFakeTimers();
    const [item, setItem] = createSignal({
      content: "one two three four five ",
      active: true,
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(
      () => (
        <ThinkingLine
          type="thinking"
          content={item().content}
          active={item().active}
        />
      ),
      container
    );

    setItem({ content: "six seven eight nine ten ", active: true });
    vi.advanceTimersByTime(2000);
    setItem({
      content: "eleven twelve thirteen fourteen fifteen ",
      active: true,
    });
    expect(container.textContent).toContain("one two three four five…");
    vi.advanceTimersByTime(3000);
    expect(container.textContent).toContain(
      "eleven twelve thirteen fourteen fifteen…"
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

describe("ChatView project chip", () => {
  beforeEach(() => {
    delegateEvents(["click", "input", "keydown"]);
    Element.prototype.scrollIntoView = vi.fn();

    fetchAgentMock.mockResolvedValue({
      id: "agent-1",
      name: "Agent",
      model: { provider: "openai", model: "gpt-5" },
    });
    fetchAgentSuggestionsMock.mockResolvedValue([]);
    fetchFullHistoryMock.mockResolvedValue({
      messages: [],
      sessionId: "session-123",
      thinkingLevel: undefined,
      isStreaming: false,
      activeTurn: null,
    });
    fetchCapabilitiesMock.mockResolvedValue({
      version: 2,
      extensions: {},
      agents: ["agent-1"],
      multiUser: false,
    });
    setCapabilitiesForTests({ multiUser: false });
    getSessionKeyMock.mockReturnValue("main");
    subscribeToSessionMock.mockImplementation(() => () => {});
    subscribeToRealtimeMock.mockImplementation(() => () => {});
    fetchAgentSessionsMock.mockResolvedValue({ items: [] });
    routeState.view = undefined;
    routeState.session = undefined;
    routeState.project = undefined;
  });

  afterEach(() => {
    vi.clearAllMocks();
    routeState.project = undefined;
    resetCapabilitiesForTests();
  });

  it("renders project chip with project name when ?project= is present and links to /p/:id", async () => {
    routeState.project = "project-123";
    fetchChatProjectMock.mockResolvedValue({
      id: "project-123",
      name: "My Project",
      instructions: "Some instructions",
    });

    const { container, dispose } = renderView();
    await tick();
    await tick();
    await tick();

    const chip = container.querySelector(".chat-project-chip");
    expect(chip).toBeTruthy();
    expect(chip?.textContent?.trim()).toContain("My Project");
    expect(chip?.getAttribute("href")).toBe("/p/project-123");
    expect(fetchChatProjectMock).toHaveBeenCalledWith("project-123");
    expect(container.querySelector(".back-btn")?.getAttribute("href")).toBe("/p/project-123");

    routeState.project = undefined;
    dispose();
  });

  it("back button returns to the agent list outside a project", async () => {
    const { container, dispose } = renderView();
    await tick();

    expect(container.querySelector(".back-btn")?.getAttribute("href")).toBe("/agents");
    dispose();
  });
});
