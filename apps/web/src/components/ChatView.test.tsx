// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, queryAllByRole, queryByRole, queryByText, queryByTitle } from "@testing-library/dom";
import { createSignal } from "solid-js";
import { delegateEvents, render } from "solid-js/web";
import { ChatView, ThinkingLine } from "./ChatView";
import { TurnNotifier } from "./TurnNotifier";
import { setImpersonationStatus } from "./ImpersonationBanner";
import type { SubscriptionCallbacks } from "../api/realtime";
import type { StreamCallbacks } from "../api/chat";
import type { FullHistoryMessage } from "../api/types";
import type { McpAppFile } from "@yoplai/shared/types";
import { ToastHost } from "../lib/toast";
import {
  resetCapabilitiesForTests,
  setCapabilitiesForTests,
} from "../lib/capabilities";

const { loadMcpAppViewMock, loadMcpAppDataMock, relayMcpAppRequestMock } = vi.hoisted(() => ({ loadMcpAppViewMock: vi.fn(), loadMcpAppDataMock: vi.fn(), relayMcpAppRequestMock: vi.fn() }));
vi.mock("../api/mcp-apps", () => ({
  loadMcpAppView: loadMcpAppViewMock,
  loadMcpAppData: loadMcpAppDataMock,
  relayMcpAppRequest: relayMcpAppRequestMock,
  logMcpAppEvent: vi.fn().mockResolvedValue(undefined),
  openMcpAppFile: vi.fn(),
}));
const navigateMock = vi.fn();
const setSearchParamsMock = vi.fn();
const [routeVersion, setRouteVersion] = createSignal(0);
const [routeAgentVersion, setRouteAgentVersion] = createSignal(0);
const { archiveAgentSessionMock } = vi.hoisted(() => ({ archiveAgentSessionMock: vi.fn() }));

const {
  fetchAgentMock,
  fetchAgentSuggestionsMock,
  fetchSimpleHistoryMock,
  fetchFullHistoryMock,
  fetchAgentStatusesMock,
  fetchCapabilitiesMock,
  fetchAgentSessionsMock,
  getSessionKeyMock,
  startNewChatMock,
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
  startNewChatMock: vi.fn(),
  postAbortMock: vi.fn(),
  postCompactMock: vi.fn(),
  streamMessageMock: vi.fn(),
  subscribeToSessionMock: vi.fn(),
  subscribeToRealtimeMock: vi.fn(),
  uploadFilesMock: vi.fn(),
  fetchChatProjectMock: vi.fn(),
  routeState: {
    agentId: "agent-1",
    view: undefined as string | undefined,
    session: undefined as string | undefined,
    project: undefined as string | undefined,
    dashboard: undefined as string | undefined,
    new: undefined as string | undefined,
  },
}));

vi.mock("@solidjs/router", () => ({
  A: (props: Record<string, unknown>) => <a {...props} />,
  useNavigate: () => navigateMock,
  useLocation: () => ({ state: null }),
  useParams: () => ({ get agentId() { routeAgentVersion(); return routeState.agentId; }, get view() { routeVersion(); return routeState.view; } }),
  useSearchParams: () => [
    {
      get project() { return routeState.project; },
      get dashboard() { routeVersion(); return routeState.dashboard; },
      get new() { routeVersion(); return routeState.new; },
      get session() {
        routeVersion();
        return routeState.session;
      },
    },
    setSearchParamsMock,
  ],
}));

vi.mock("../api", () => ({
  archiveAgentSession: archiveAgentSessionMock,
  fetchAgent: fetchAgentMock,
  fetchAgentSuggestions: fetchAgentSuggestionsMock,
  fetchSimpleHistory: fetchSimpleHistoryMock,
  fetchFullHistory: fetchFullHistoryMock,
  fetchAgentStatuses: fetchAgentStatusesMock,
  fetchCapabilities: fetchCapabilitiesMock,
  fetchAgentSessions: fetchAgentSessionsMock,
  getSessionKey: getSessionKeyMock,
  startNewChat: startNewChatMock,
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

const mountedViews = new Set<() => void>();

function renderView() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const stop = render(() => <ChatView />, container);
  const dispose = () => { mountedViews.delete(dispose); stop(); };
  mountedViews.add(dispose);
  return { container, dispose };
}

describe("ChatView abort handling", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    delegateEvents(["click", "input", "keydown"]);
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    URL.createObjectURL = vi.fn(() => "blob:preview");
    URL.revokeObjectURL = vi.fn();

    loadMcpAppViewMock.mockResolvedValue({
      available: true, sandboxUrl: "https://apps.test/sandbox", appsOrigin: "https://apps.test",
      server: "fixture", toolName: "draw", args: { title: "Sketch" },
      result: { content: [{ type: "text", text: "Drawn" }] }, csp: {}, prefersBorder: true,
    });
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
    startNewChatMock.mockImplementation(() => { getSessionKeyMock.mockReturnValue("fresh-key"); });
    postAbortMock.mockResolvedValue(undefined);
    postCompactMock.mockResolvedValue(undefined);
    streamMessageMock.mockImplementation(() => () => {});
    subscribeToSessionMock.mockImplementation(() => () => {});
    subscribeToRealtimeMock.mockImplementation(() => () => {});
    uploadFilesMock.mockResolvedValue([]);
    archiveAgentSessionMock.mockResolvedValue(undefined);
    routeState.view = undefined;
    routeState.agentId = "agent-1";
    routeState.session = undefined;
    routeState.project = undefined;
    routeState.dashboard = undefined;
    routeState.new = undefined;
    setSearchParamsMock.mockImplementation((changes) => { Object.assign(routeState, changes); setRouteVersion((value) => value + 1); });
    fetchMainAgentPreferenceMock.mockResolvedValue({ mainAgentId: null, accessible: false, pickerDismissedAt: null });
    fetchMainAgentOptionsMock.mockResolvedValue({ preference: null, agents: [{ id: "agent-1", name: "Agent" }, { id: "agent-2", name: "Other" }] });
    fetchPoolActionsMock.mockResolvedValue([]);
    setRouteVersion(0);
    setRouteAgentVersion(0);
  });

  afterEach(() => {
    mountedViews.forEach((dispose) => dispose());
    setImpersonationStatus(null);
    document.body.innerHTML = "";
    resetCapabilitiesForTests();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("starts fresh before opening a dashboard and keeps it through the first message and session resolution", async () => {
    routeState.dashboard = "garden";
    routeState.new = "1";
    fetchSimpleHistoryMock.mockResolvedValue({ messages: [], isStreaming: false, activeTurn: null });
    fetchFullHistoryMock.mockResolvedValue({ messages: [], isStreaming: false, activeTurn: null });
    const view = await startFullStream();
    try {
      expect(startNewChatMock).toHaveBeenCalledOnce();
      expect(queryByTitle(view.container, "Dashboard dashboard")).not.toBeNull();
      expect(streamMessageMock.mock.calls.at(-1)?.[2]).toBe("fresh-key");
      fetchFullHistoryMock.mockResolvedValue({ sessionId: "first-session", messages: [], isStreaming: false, activeTurn: null });
      const marker = { server: "yoplai", tool: "dashboard", resourceUri: "ui://yoplai/dashboard" };
      loadMcpAppDataMock.mockResolvedValue({ args: {}, result: { content: [], structuredContent: { id: "garden", title: "Garden overview" } } });
      view.callbacks()?.onToolCall?.("first-dashboard", "dashboard_update", {}, undefined, marker);
      view.callbacks()?.onToolResult?.("first-dashboard", "dashboard_update", "Updated", false, undefined, undefined, { ...marker, recordId: "record-1", key: "garden" });
      view.onText("Garden is ready.");
      await waitFor(() => expect(queryByTitle(view.container, "Garden overview dashboard")).not.toBeNull());
      const panel = queryByRole(view.container, "complementary")!;
      expect(queryByTitle(panel, "Garden overview dashboard")?.getAttribute("src")).toBe("/d/garden");
      expect(loadMcpAppDataMock).toHaveBeenCalledWith("agent-1", "first-session", "first-dashboard", expect.any(AbortSignal));
      expect(view.container.textContent).toContain("Garden is ready.");
    } finally { view.dispose(); }
  });

  async function annotateLinkedDashboard() {
    routeState.session = "origin-session";
    routeState.dashboard = "garden";
    const view = renderView();
    await waitFor(() => expect(queryByTitle(view.container, "Dashboard dashboard")).not.toBeNull());
    const frame = queryByTitle(view.container, "Dashboard dashboard") as HTMLIFrameElement;
    const toFrame: unknown[] = [];
    vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation((message: unknown) => { toFrame.push(message); });
    const fromFrame = (data: Record<string, unknown>) =>
      window.dispatchEvent(new MessageEvent("message", { data: { channel: "yoplai-annotate", ...data }, source: frame.contentWindow }));
    const announce = (page: Record<string, unknown> = {}) =>
      fromFrame({ type: "ready", id: "garden", slug: "garden.html", agentId: "agent-1", title: "Garden overview", params: { bed: "north" }, ...page });
    announce();
    queryByRole(view.container, "button", { name: "Annotate" })!.click();
    const note = (id: string, hint: Record<string, string>, note: string) =>
      fromFrame({ type: "note", id, selector: "", tag: "", text: "", heading: "", ancestor: "", ...hint, note });
    const chips = () => queryAllByRole(view.container, "listitem").filter((item) => item.closest('[aria-label="Dashboard notes"]')).map((item) => item.textContent);
    const send = () => queryByRole(view.container, "button", { name: "Send message" }) as HTMLButtonElement;
    return { ...view, toFrame, announce, note, chips, send };
  }

  it("sends staged dashboard notes as one chat message carrying the page and element context, then clears them", async () => {
    const view = await annotateLinkedDashboard();
    try {
      await waitFor(() => expect(view.send().disabled).toBe(true));
      view.note("n1", { selector: "section#beds > p.bed", tag: "p", text: "Tomatoes 12", heading: "Beds", ancestor: "section#beds" }, "Show kilos");
      view.note("n2", { selector: "a#go", tag: "a", text: "Seed catalog", heading: "Beds", ancestor: "section#beds" }, "Link to the spring catalog");
      view.note("n3", { selector: "h2", tag: "h2", text: "Beds" }, "Rename to Plots");
      await waitFor(() => expect(view.chips()).toHaveLength(3));
      expect(view.chips()[0]).toContain("Garden overview");
      expect(view.chips()[0]).toContain("Show kilos");
      expect(view.send().disabled).toBe(false);
      queryByRole(view.container, "button", { name: "Remove note 3" })!.click();
      expect(view.chips()).toHaveLength(2);
      expect(view.toFrame).toContainEqual({ channel: "yoplai-annotate", type: "remove", id: "n3" });
      const input = queryByRole(view.container, "textbox") as HTMLTextAreaElement;
      input.value = "Keep the colors.";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      view.send().click();
      await waitFor(() => expect(streamMessageMock).toHaveBeenCalledOnce());
      expect(streamMessageMock.mock.calls[0][1]).toBe([
        'Dashboard annotations for "Garden overview" (page: garden.html, id: garden, params: {"bed":"north"}).',
        "Edit this dashboard as the notes below ask, then publish with dashboard_update.",
        "",
        '1. <section#beds > p.bed> "Tomatoes 12" (under "Beds") - Show kilos',
        '2. <a#go> "Seed catalog" (under "Beds"; in <section#beds>) - Link to the spring catalog',
        "",
        "Keep the colors.",
      ].join("\n"));
      await waitFor(() => expect(view.chips()).toEqual([]));
      expect(view.toFrame.slice(-2)).toEqual([
        { channel: "yoplai-annotate", type: "remove", id: "n1" },
        { channel: "yoplai-annotate", type: "remove", id: "n2" },
      ]);
    } finally { view.dispose(); }
  });

  it("keeps notes attributed to the page and parameters shown when they were made, grouped per page at send", async () => {
    const view = await annotateLinkedDashboard();
    try {
      view.note("n1", { selector: "p", tag: "p", text: "North bed" }, "Add watering days");
      view.announce({ id: "orchard", slug: "orchard.html", title: "Orchard", params: {} });
      view.note("n2", { selector: "td:nth-of-type(2)", tag: "td", text: "Apples" }, "Sort by harvest");
      view.announce({ params: { bed: "south" } });
      view.note("n3", { selector: "p", tag: "p", text: "South bed" }, "Hide when empty");
      view.announce();
      view.note("n4", { selector: "h1", tag: "h1", text: "Garden" }, "Shorter title");
      await waitFor(() => expect(view.chips()).toHaveLength(4));
      view.send().click();
      await waitFor(() => expect(streamMessageMock).toHaveBeenCalledOnce());
      expect(streamMessageMock.mock.calls[0][1]).toBe([
        'Dashboard annotations for "Garden overview" (page: garden.html, id: garden, params: {"bed":"north"}).',
        "Edit this dashboard as the notes below ask, then publish with dashboard_update.",
        "",
        '1. <p> "North bed" - Add watering days',
        '2. <h1> "Garden" - Shorter title',
        "",
        'Dashboard annotations for "Orchard" (page: orchard.html, id: orchard).',
        "Edit this dashboard as the notes below ask, then publish with dashboard_update.",
        "",
        '3. <td:nth-of-type(2)> "Apples" - Sort by harvest',
        "",
        'Dashboard annotations for "Garden overview" (page: garden.html, id: garden, params: {"bed":"south"}).',
        "Edit this dashboard as the notes below ask, then publish with dashboard_update.",
        "",
        '4. <p> "South bed" - Hide when empty',
      ].join("\n"));
    } finally { view.dispose(); }
  });

  it("keeps notes added while an earlier send is still uploading, for the next message", async () => {
    const view = await annotateLinkedDashboard();
    try {
      let finishUpload!: (files: unknown[]) => void;
      uploadFilesMock.mockImplementationOnce(() => new Promise((resolve) => { finishUpload = resolve; }));
      view.note("n1", { selector: "p", tag: "p", text: "North bed" }, "Add watering days");
      await waitFor(() => expect(view.chips()).toHaveLength(1));
      view.container.querySelector("textarea")!.dispatchEvent(createFileDragEvent("drop", [new File(["plan"], "plan.txt", { type: "text/plain" })]));
      view.send().click();
      await waitFor(() => expect(uploadFilesMock).toHaveBeenCalledTimes(1));
      view.note("n2", { selector: "h1", tag: "h1", text: "Garden" }, "Shorter title");
      await waitFor(() => expect(view.chips()).toHaveLength(2));
      finishUpload([]);
      await waitFor(() => expect(streamMessageMock).toHaveBeenCalledTimes(1));
      expect(streamMessageMock.mock.calls[0][1]).toContain("Add watering days");
      expect(streamMessageMock.mock.calls[0][1]).not.toContain("Shorter title");
      await waitFor(() => expect(view.chips()).toHaveLength(1));
      expect(view.chips()[0]).toContain("Shorter title");
      expect(view.toFrame).toContainEqual({ channel: "yoplai-annotate", type: "remove", id: "n1" });
      expect(view.toFrame).not.toContainEqual({ channel: "yoplai-annotate", type: "remove", id: "n2" });
    } finally { view.dispose(); }
  });

  it("drops staged dashboard notes when the user switches to another chat", async () => {
    const view = await annotateLinkedDashboard();
    try {
      view.note("n1", { selector: "p", tag: "p", text: "North bed" }, "Add watering days");
      await waitFor(() => expect(view.chips()).toHaveLength(1));
      routeState.session = "other-session";
      setRouteVersion((value) => value + 1);
      await waitFor(() => expect(view.chips()).toEqual([]));
    } finally { view.dispose(); }
  });

  it("opens a linked dashboard once, preserving the requested session", async () => {
    routeState.session = "origin-session";
    routeState.dashboard = "garden";
    routeState.new = "1";
    const { container, dispose } = renderView();
    try {
      expect(setSearchParamsMock).toHaveBeenCalledOnce();
      await waitFor(() => expect(queryByTitle(container, "Dashboard dashboard")).not.toBeNull());
      const panel = queryByRole(container, "complementary")!;
      expect(queryByTitle(panel, "Dashboard dashboard")?.getAttribute("src")).toBe("/d/garden");
      expect(startNewChatMock).not.toHaveBeenCalled();
      expect(setSearchParamsMock).toHaveBeenCalledOnce();
      expect(setSearchParamsMock).toHaveBeenCalledWith({ dashboard: undefined, new: undefined }, { replace: true });
      expect(routeState.session).toBe("origin-session");
      queryByRole(panel, "button", { name: "Collapse" })!.click();
      setRouteVersion((value) => value + 1);
      expect(queryByRole(container, "complementary")).toBeNull();
    } finally { dispose(); }
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

  function pasteFiles(target: HTMLElement, files: File[]) {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { files, getData: () => "" } });
    target.dispatchEvent(event);
    return event;
  }

  it("attaches an image pasted in the composer", async () => {
    const { container, dispose } = renderView();
    await tick();
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    const event = pasteFiles(textarea, [new File(["png"], "image.png", { type: "image/png" })]);
    await tick();
    expect(event.defaultPrevented).toBe(true);
    expect(container.textContent).toContain("image.png");
    dispose();
  });

  it("rejects a pasted image over the upload limit with a clear error", async () => {
    const { container, dispose } = renderView();
    await tick();
    const big = new File(["png"], "image.png", { type: "image/png" });
    Object.defineProperty(big, "size", { value: 30 * 1024 * 1024 });
    pasteFiles(container.querySelector("textarea") as HTMLTextAreaElement, [big]);
    await tick();
    expect(container.textContent).toContain("image.png is too large (30.0 MB). The limit is 25 MB.");
    expect(container.querySelector("img.attachment-thumb")).toBeNull();
    dispose();
  });

  it("keeps the default paste for text", async () => {
    const { container, dispose } = renderView();
    await tick();
    const event = pasteFiles(container.querySelector("textarea") as HTMLTextAreaElement, []);
    expect(event.defaultPrevented).toBe(false);
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
    expect(disclosures[0].textContent).toContain("First complete summary");
    expect(disclosures[0].textContent).toContain("Second line");
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

  it("prepends a deferred earlier page while live text continues", async () => {
    let resolveEarlier: ((page: { messages: FullHistoryMessage[]; historyOffset: number }) => void) | undefined;
    let appendText: StreamCallbacks["onText"] | undefined;
    fetchFullHistoryMock
      .mockResolvedValueOnce({
        messages: [{ role: "user", content: [{ type: "text", text: "Recent question" }], timestamp: 100 }],
        sessionId: "session-main", nextCursor: "before-recent", historyOffset: 100,
      })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveEarlier = resolve; }));
    streamMessageMock.mockImplementation((_agent, _text, _key, onText) => {
      appendText = onText;
      return vi.fn();
    });
    const { container, dispose } = renderView();
    await waitFor(() => expect(container.querySelector(".load-earlier")).not.toBeNull());
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
    textarea.value = "Current question";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    container.querySelector<HTMLButtonElement>(".send-btn")!.click();
    appendText!("Live answer");
    container.querySelector<HTMLButtonElement>(".load-earlier")!.click();
    appendText!(" during fetch");
    expect(container.textContent).toContain("Live answer during fetch");
    resolveEarlier!({
      messages: [{ role: "user", content: [{ type: "text", text: "Earlier question" }], timestamp: 1 }],
      historyOffset: 99,
    });
    await waitFor(() => expect(container.textContent).toContain("Earlier question"));
    appendText!(" and after prepend");
    expect(container.textContent).toContain("Live answer during fetch and after prepend");
    expect(Array.from(container.querySelectorAll(".message.user .content"), (node) => node.textContent)).toEqual([
      "Earlier question", "Recent question", "Current question",
    ]);
    expect(queryByRole(container, "button", { name: "Stop agent" })).not.toBeNull();
    dispose();
  });

  it("drops a deferred earlier page and old live chunks after switching sessions", async () => {
    let resolveEarlier: ((page: { messages: FullHistoryMessage[] }) => void) | undefined;
    let appendText: StreamCallbacks["onText"] | undefined;
    fetchFullHistoryMock
      .mockResolvedValueOnce({
        messages: [{ role: "user", content: [{ type: "text", text: "Old session question" }], timestamp: 100 }],
        sessionId: "session-main", nextCursor: "before-old", historyOffset: 100,
      })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveEarlier = resolve; }))
      .mockResolvedValue({
        messages: [{ role: "user", content: [{ type: "text", text: "Other session question" }], timestamp: 200 }],
        sessionId: "other-session", nextCursor: "before-old",
      });
    streamMessageMock.mockImplementation((_agent, _text, _key, onText) => {
      appendText = onText;
      return vi.fn();
    });
    const { container, dispose } = renderView();
    await waitFor(() => expect(container.querySelector(".load-earlier")).not.toBeNull());
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
    textarea.value = "Old stream request";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    container.querySelector<HTMLButtonElement>(".send-btn")!.click();
    appendText!("Old live answer");
    container.querySelector<HTMLButtonElement>(".load-earlier")!.click();
    routeState.session = "other-session";
    setRouteVersion((version) => version + 1);
    await waitFor(() => expect(container.textContent).toContain("Other session question"));
    resolveEarlier!({
      messages: [{ role: "user", content: [{ type: "text", text: "Stale earlier question" }], timestamp: 1 }],
    });
    appendText!("Stale later chunk");
    await tick();
    expect(container.textContent).toContain("Other session question");
    expect(container.textContent).not.toContain("Stale earlier question");
    expect(container.textContent).not.toContain("Old live answer");
    expect(container.textContent).not.toContain("Stale later chunk");
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

  it("shows the restored toast before beginning the pending upload", async () => {
    routeState.session = "archived-session";
    fetchAgentSessionsMock
      .mockResolvedValueOnce({ items: [{ agentId: "agent-1", sessionId: "archived-session", archived: 1 }] })
      .mockResolvedValue({ items: [] });
    let finishRestore: (() => void) | undefined;
    archiveAgentSessionMock.mockImplementationOnce(() => new Promise<void>((resolve) => { finishRestore = resolve; }));
    const toasts = document.createElement("div");
    document.body.appendChild(toasts);
    const disposeToasts = render(() => <ToastHost />, toasts);
    const toastAtUpload: string[] = [];
    uploadFilesMock.mockImplementationOnce(async () => {
      toastAtUpload.push(toasts.textContent ?? "");
      return [{ path: "/media/restored.md", filename: "restore.md", mimeType: "text/markdown" }];
    });
    const { container, dispose } = renderView();
    await waitFor(() => expect(container.querySelector(".archived-banner")).not.toBeNull());
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
    textarea.value = "Send after restore";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(createFileDragEvent("drop", [
      new File(["Restored attachment"], "restore.md", { type: "text/markdown" }),
    ]));
    container.querySelector<HTMLButtonElement>(".send-btn")!.click();
    await waitFor(() => expect(archiveAgentSessionMock).toHaveBeenCalledWith("agent-1", "archived-session", false));
    expect(uploadFilesMock).not.toHaveBeenCalled();
    finishRestore!();
    await waitFor(() => expect(streamMessageMock).toHaveBeenCalledTimes(1));
    expect(toastAtUpload).toHaveLength(1);
    expect(toastAtUpload[0]).toContain("Chat restored");
    expect(toasts.textContent).toContain("Chat restored");
    expect(textarea.value).toBe("");
    toasts.querySelector<HTMLButtonElement>('[data-testid="toast-close"]')!.click();
    dispose();
    disposeToasts();
  });

  it("shows a failed restore notice and keeps the unsent draft and attachment", async () => {
    routeState.session = "archived-session";
    fetchAgentSessionsMock.mockResolvedValue({ items: [
      { agentId: "agent-1", sessionId: "archived-session", archived: 1 },
    ] });
    archiveAgentSessionMock.mockRejectedValueOnce(new Error("Restore denied"));
    const { container, dispose } = renderView();
    await waitFor(() => expect(container.querySelector(".archived-banner")).not.toBeNull());
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
    textarea.value = "Keep this archived draft";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(createFileDragEvent("drop", [
      new File(["Not uploaded"], "restore-failure.md", { type: "text/markdown" }),
    ]));
    container.querySelector<HTMLButtonElement>(".send-btn")!.click();
    await waitFor(() => expect(container.querySelector(".messages")?.textContent).toContain("Error: Restore denied"));
    expect(textarea.value).toBe("Keep this archived draft");
    expect(queryByRole(container, "button", { name: "Remove restore-failure.md" })).not.toBeNull();
    expect(container.querySelector(".messages")?.textContent).not.toContain("Keep this archived draft");
    expect(container.querySelector(".archived-banner")).not.toBeNull();
    expect(uploadFilesMock).not.toHaveBeenCalled();
    expect(streamMessageMock).not.toHaveBeenCalled();
    dispose();
  });

  it("keeps the draft and pending file when upload fails without sending", async () => {
    uploadFilesMock.mockRejectedValueOnce(new Error("Upload unavailable"));
    const { container, dispose } = renderView();
    await tick();
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
    textarea.value = "Keep this draft";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(createFileDragEvent("drop", [
      new File(["Attachment contents"], "upload-failure.md", { type: "text/markdown" }),
    ]));
    await waitFor(() => expect(queryByRole(container, "button", { name: "Remove upload-failure.md" })).not.toBeNull());
    container.querySelector<HTMLButtonElement>(".send-btn")!.click();
    await waitFor(() => expect(container.querySelector(".upload-error")?.textContent).toBe("Upload unavailable"));
    expect(textarea.value).toBe("Keep this draft");
    expect(queryByRole(container, "button", { name: "Remove upload-failure.md" })).not.toBeNull();
    expect(container.querySelector(".messages")?.textContent).not.toContain("Keep this draft");
    expect(streamMessageMock).not.toHaveBeenCalled();
    expect(queryByRole(container, "button", { name: "Send message" })?.hasAttribute("disabled")).toBe(false);
    dispose();
  });

  it("clears pending files and navigates when a queued stream resets its session", async () => {
    const streams: Array<{
      onText: StreamCallbacks["onText"];
      onDone: StreamCallbacks["onDone"];
      callbacks: Partial<StreamCallbacks>;
    }> = [];
    streamMessageMock.mockImplementation((_agent, _text, _key, onText, onDone, _onError, callbacks) => {
      streams.push({ onText, onDone, callbacks });
      return vi.fn();
    });
    const { container, dispose } = renderView();
    await tick();
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
    textarea.value = "First request";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    container.querySelector<HTMLButtonElement>(".send-btn")!.click();
    await waitFor(() => expect(streams).toHaveLength(1));
    streams[0].onText("First reply");
    textarea.value = "Queued request";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await waitFor(() => expect(streams).toHaveLength(2));
    streams[0].onDone();
    await waitFor(() => expect(container.querySelector<HTMLButtonElement>(".attach-btn")!.disabled).toBe(false));
    textarea.dispatchEvent(createFileDragEvent("drop", [
      new File(["For the next turn"], "after-queue.md", { type: "text/markdown" }),
    ]));
    await waitFor(() => expect(queryByRole(container, "button", { name: "Remove after-queue.md" })).not.toBeNull());

    streams[1].callbacks.onSessionReset!("fresh-queued-session");
    expect(navigateMock).toHaveBeenCalledWith("/chat/agent-1?session=fresh-queued-session");
    expect(queryByRole(container, "button", { name: "Remove after-queue.md" })).toBeNull();
    expect(container.textContent).not.toContain("First request");
    expect(container.textContent).not.toContain("Queued request");
    streams[1].onText("Fresh queued reply");
    streams[1].onDone();
    await waitFor(() => expect(container.textContent).toContain("Fresh queued reply"));
    dispose();
  });

  it("clears a file staged during auto-compaction when the direct stream resets its session", async () => {
    let finishCompaction: (() => void) | undefined;
    let resetSession: StreamCallbacks["onSessionReset"];
    fetchFullHistoryMock
      .mockResolvedValueOnce({
        messages: [{ role: "assistant", content: [{ type: "text", text: "Previous reply" }], timestamp: 1 }],
        sessionId: "session-main",
        activeContextUsage: { inputTokens: 102400, model: "gpt-5.2" },
        isStreaming: false,
        activeTurn: null,
      })
      .mockResolvedValue({
        messages: [{ role: "assistant", content: [{ type: "text", text: "Previous reply" }], timestamp: 1 }],
        sessionId: "session-main",
        activeContextUsage: { inputTokens: 0, model: "gpt-5" },
        isStreaming: false,
        activeTurn: null,
      });
    postCompactMock.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishCompaction = resolve;
    }));
    streamMessageMock.mockImplementation((_agent, _text, _key, _onText, _onDone, _onError, callbacks: Partial<StreamCallbacks>) => {
      resetSession = callbacks.onSessionReset;
      return vi.fn();
    });

    const { container, dispose } = renderView();
    await waitFor(() => expect(container.textContent).toContain("~80% context used"));
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
    textarea.value = "Continue the conversation";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    container.querySelector<HTMLButtonElement>(".send-btn")!.click();
    await waitFor(() => expect(container.textContent).toContain("Compacting context..."));
    expect(container.querySelector<HTMLButtonElement>(".attach-btn")!.disabled).toBe(false);
    textarea.dispatchEvent(createFileDragEvent("drop", [
      new File(["Keep for the next message"], "next-message.md", { type: "text/markdown" }),
    ]));
    await waitFor(() => expect(queryByRole(container, "button", { name: "Remove next-message.md" })).not.toBeNull());

    finishCompaction!();
    await waitFor(() => expect(queryByRole(container, "button", { name: "Stop agent" })).not.toBeNull());
    expect(uploadFilesMock).not.toHaveBeenCalled();
    expect(queryByRole(container, "button", { name: "Remove next-message.md" })).not.toBeNull();
    expect(container.textContent).toContain("Continue the conversation");

    resetSession!("fresh-direct-session");
    expect(navigateMock).toHaveBeenCalledWith("/chat/agent-1?session=fresh-direct-session");
    expect(queryByRole(container, "button", { name: "Remove next-message.md" })).toBeNull();
    expect(container.textContent).not.toContain("Continue the conversation");
    expect(container.textContent).not.toContain("Previous reply");
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

  function enableAppViews() {
    setCapabilitiesForTests({ apps: { available: true } });
    fetchCapabilitiesMock.mockResolvedValue({ version: 2, extensions: {}, agents: [], apps: { available: true } });
    loadMcpAppDataMock.mockResolvedValue({ args: { shape: "box" }, result: { content: [{ type: "text", text: "Box added" }] } });
  }

  function appMessage(frame: HTMLIFrameElement, message: unknown) {
    window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow, origin: "https://apps.test", data: message }));
  }

  function initializeApp(frame: HTMLIFrameElement) {
    appMessage(frame, { jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready" });
    appMessage(frame, { jsonrpc: "2.0", id: 1, method: "ui/initialize", params: {} });
    appMessage(frame, { jsonrpc: "2.0", method: "ui/notifications/initialized" });
  }

  function sendViewFile(callbacks: Partial<StreamCallbacks> | undefined, id: string, file: McpAppFile) {
    const marker = { server: "yoplai", tool: "send_file", resourceUri: "ui://yoplai/file-viewer" };
    callbacks?.onToolCall?.(id, "send_file", { path: file.filename }, undefined, marker);
    callbacks?.onFileOutput?.(file);
    callbacks?.onToolResult?.(id, "send_file", "File sent to user", false, undefined, undefined, { ...marker, recordId: `record-${id}`, file });
  }

  function measureChatSpace(viewportWidth = 1280, rowWidth = 1000) {
    vi.stubGlobal("innerWidth", viewportWidth);
    const measure = HTMLElement.prototype.getBoundingClientRect;
    return vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("chat-view") ? { width: rowWidth, right: rowWidth } as DOMRect : measure.call(this);
    });
  }

  function seedPanelHistory() {
    const dashboard = { server: "yoplai", tool: "dashboard", resourceUri: "ui://yoplai/dashboard", key: "garden", title: "Garden overview", recordId: "garden-record" };
    const file = { server: "yoplai", tool: "send_file", resourceUri: "ui://yoplai/file-viewer", recordId: "notes-record", file: { fileId: "notes-file", filename: "notes.md", mimeType: "text/markdown", size: 42 } };
    fetchFullHistoryMock.mockResolvedValue({ sessionId: "session-main", messages: [
      { role: "assistant", timestamp: 1, content: [
        { type: "toolCall", id: "garden-call", name: "dashboard_create", arguments: {} },
        { type: "toolCall", id: "notes-call", name: "send_file", arguments: {} },
      ] },
      { role: "toolResult", timestamp: 2, toolCallId: "garden-call", toolName: "dashboard_create", content: [{ type: "text", text: "Created garden" }], view: dashboard },
      { role: "toolResult", timestamp: 3, toolCallId: "notes-call", toolName: "send_file", content: [{ type: "text", text: "Sent notes" }], view: file },
    ] });
    loadMcpAppDataMock.mockResolvedValue({ args: {}, result: { content: [], structuredContent: { id: "garden", title: "Garden overview" } } });
    sessionStorage.setItem("yoplai.chat-panel-tabs.v1:agent-1:session-main", JSON.stringify({
      tabs: [{ key: "yoplai\nui://yoplai/file-viewer\nnotes.md" }, { key: "yoplai\nui://yoplai/dashboard\ngarden" }],
      active: "yoplai\nui://yoplai/file-viewer\nnotes.md",
    }));
  }

  it("restores saved dashboard and file tabs after history with saved order and selection", async () => {
    const measure = measureChatSpace();
    enableAppViews();
    seedPanelHistory();
    const view = renderView();
    try {
      await waitFor(() => expect(queryAllByRole(view.container, "tab").map((tab) => tab.getAttribute("aria-label"))).toEqual(["notes.md", "Garden overview"]));
      expect(queryByRole(view.container, "tab", { name: "notes.md" })?.getAttribute("aria-selected")).toBe("true");
      expect(queryByTitle(queryByRole(view.container, "complementary")!, "Garden overview dashboard")).not.toBeNull();
    } finally { view.dispose(); measure.mockRestore(); }
  });

  it("does not restore again on reconnect or a simple/full history reload", async () => {
    const measure = measureChatSpace();
    enableAppViews();
    seedPanelHistory();
    const view = renderView();
    try {
      await waitFor(() => expect(queryAllByRole(view.container, "tab")).toHaveLength(2));
      queryByRole(view.container, "button", { name: "Close notes.md" })!.click();
      sessionStorage.setItem("yoplai.chat-panel-tabs.v1:agent-1:session-main", JSON.stringify({ tabs: [{ key: "yoplai\nui://yoplai/file-viewer\nnotes.md" }] }));
      const reconnect = subscribeToRealtimeMock.mock.calls.map(([options]) => options).find((options) => options.onReconnect)!.onReconnect;
      const before = fetchFullHistoryMock.mock.calls.length;
      reconnect();
      await waitFor(() => expect(fetchFullHistoryMock.mock.calls.length).toBeGreaterThan(before));
      await tick();
      expect(queryAllByRole(view.container, "tab")).toHaveLength(0);
      expect(queryByRole(view.container, "tabpanel", { name: "Garden overview" })).not.toBeNull();
      routeState.view = "full";
      setRouteVersion((version) => version + 1);
      await tick();
      await tick();
      expect(queryByRole(view.container, "tabpanel", { name: "Garden overview" })).not.toBeNull();
      expect(queryByRole(view.container, "tab", { name: "notes.md" })).toBeNull();
    } finally { view.dispose(); measure.mockRestore(); }
  });

  it.each([[768, 1000], [1280, 725]])("skips restoration without erasing saved tabs when the layout cannot split (%i/%i)", async (viewport, row) => {
    const measure = measureChatSpace(viewport, row);
    enableAppViews();
    seedPanelHistory();
    const saved = sessionStorage.getItem("yoplai.chat-panel-tabs.v1:agent-1:session-main");
    const view = renderView();
    try {
      await waitFor(() => expect(queryByTitle(view.container, "Garden overview dashboard")).not.toBeNull());
      expect(queryByRole(view.container, "complementary")).toBeNull();
      expect(sessionStorage.getItem("yoplai.chat-panel-tabs.v1:agent-1:session-main")).toBe(saved);
    } finally { view.dispose(); measure.mockRestore(); }
  });

  it("restores dashboards while apps capability is unresolved", async () => {
    const measure = measureChatSpace();
    seedPanelHistory();
    fetchCapabilitiesMock.mockReturnValue(new Promise(() => {}));
    sessionStorage.setItem("yoplai.chat-panel-tabs.v1:agent-1:session-main", JSON.stringify({ tabs: [{ key: "yoplai\nui://yoplai/dashboard\ngarden" }] }));
    const view = renderView();
    try {
      await waitFor(() => expect(queryByRole(view.container, "tabpanel", { name: "Garden overview" })).not.toBeNull());
      expect(queryByTitle(queryByRole(view.container, "complementary")!, "Garden overview dashboard")).not.toBeNull();
    } finally { view.dispose(); measure.mockRestore(); }
  });

  it("preserves both sessions' saved tabs without restoring during chat switches", async () => {
    const measure = measureChatSpace();
    enableAppViews();
    seedPanelHistory();
    const savedOther = JSON.stringify({ tabs: [{ key: "yoplai\nui://yoplai/dashboard\nweather", frame: { id: "weather", title: "Weather" } }] });
    sessionStorage.setItem("yoplai.chat-panel-tabs.v1:agent-1:other-session", savedOther);
    const view = renderView();
    try {
      await waitFor(() => expect(queryAllByRole(view.container, "tab")).toHaveLength(2));
      const savedMain = sessionStorage.getItem("yoplai.chat-panel-tabs.v1:agent-1:session-main");
      routeState.session = "other-session";
      setRouteVersion((version) => version + 1);
      await tick();
      await tick();
      expect(queryByRole(view.container, "complementary")).toBeNull();
      expect(sessionStorage.getItem("yoplai.chat-panel-tabs.v1:agent-1:other-session")).toBe(savedOther);
      expect(sessionStorage.getItem("yoplai.chat-panel-tabs.v1:agent-1:session-main")).toBe(savedMain);
      routeState.session = undefined;
      setRouteVersion((version) => version + 1);
      await tick();
      await tick();
      expect(queryByRole(view.container, "complementary")).toBeNull();
      view.dispose();
      const remount = renderView();
      try { await waitFor(() => expect(queryAllByRole(remount.container, "tab")).toHaveLength(2)); }
      finally { remount.dispose(); }
    } finally { view.dispose(); measure.mockRestore(); }
  });

  it.each([700, 1280])("keeps saved and reconnect dashboards inline, with live opening only on a wide viewport (%i)", async (viewport) => {
    const measure = measureChatSpace(viewport);
    let subscription: SubscriptionCallbacks = {};
    subscribeToSessionMock.mockImplementation((_agent, _key, callbacks) => { subscription = callbacks; return () => {}; });
    const marker = { server: "yoplai", tool: "dashboard", resourceUri: "ui://yoplai/dashboard" };
    const reference = { ...marker, recordId: "saved-record", key: "garden" };
    fetchFullHistoryMock.mockResolvedValue({ sessionId: "session-main", messages: [
      { role: "assistant", timestamp: 1, content: [{ type: "toolCall", id: "saved-dashboard", name: "dashboard_create", arguments: {}, viewCall: true, view: marker }] },
      { role: "toolResult", timestamp: 2, toolCallId: "saved-dashboard", toolName: "dashboard_create", content: [{ type: "text", text: "Created" }], view: reference },
    ] });
    loadMcpAppDataMock.mockImplementation(async (_agent, _session, id) => ({ args: {}, result: { content: [], structuredContent: { id: "garden", title: id } } }));
    const view = renderView();
    try {
      await waitFor(() => expect(queryByTitle(view.container, "saved-dashboard dashboard")).not.toBeNull());
      expect(queryByRole(view.container, "complementary")).toBeNull();
      subscription.onActiveTurn?.({ userText: "Update", userTimestamp: 3, startedAt: 3, thinking: "", text: "",
        toolCalls: [{ id: "reconnect-dashboard", name: "dashboard_update", arguments: {}, status: "done", view: marker }],
        toolResults: [{ id: "reconnect-dashboard", name: "dashboard_update", content: "Updated", isError: false, view: { ...reference, recordId: "reconnect-record" } }],
      });
      await waitFor(() => expect(queryByTitle(view.container, "reconnect-dashboard dashboard")).not.toBeNull());
      expect(queryByRole(view.container, "complementary")).toBeNull();
      subscription.onToolCall?.("live-dashboard", "dashboard_update", {}, undefined, marker);
      subscription.onToolResult?.("live-dashboard", "dashboard_update", "Updated", false, undefined, undefined, { ...reference, recordId: "live-record" });
      await waitFor(() => expect(queryByTitle(view.container, "live-dashboard dashboard")).not.toBeNull());
      expect(!!queryByRole(view.container, "complementary")).toBe(viewport > 768);
    } finally { view.dispose(); measure.mockRestore(); }
  });

  it.each(["failure", "timeout"])("keeps chat progressing and the last dashboard visible after a data %s", async (failure) => {
    const measure = measureChatSpace();
    loadMcpAppDataMock.mockResolvedValue({ args: {}, result: { content: [], structuredContent: { id: "garden", title: "Garden overview" } } });
    const view = await startFullStream();
    const marker = { server: "yoplai", tool: "dashboard", resourceUri: "ui://yoplai/dashboard" };
    let finish: ((data: unknown) => void) | undefined;
    try {
      view.callbacks()?.onToolCall?.("created-dashboard", "dashboard_create", {}, undefined, marker);
      view.callbacks()?.onToolResult?.("created-dashboard", "dashboard_create", "Created", false, undefined, undefined, { ...marker, recordId: "created-record", key: "garden" });
      await waitFor(() => expect(queryByTitle(view.container, "Garden overview dashboard")).not.toBeNull());
      const frame = queryByTitle(view.container, "Garden overview dashboard");
      if (failure === "timeout") {
        vi.useFakeTimers();
        loadMcpAppDataMock.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
      } else loadMcpAppDataMock.mockRejectedValueOnce(new Error("offline"));
      view.callbacks()?.onToolCall?.("updated-dashboard", "dashboard_update", {}, undefined, marker);
      view.callbacks()?.onToolResult?.("updated-dashboard", "dashboard_update", "Updated", false, undefined, undefined, { ...marker, recordId: "updated-record", key: "garden" });
      view.onText("Chat keeps going.");
      if (failure === "timeout") await vi.advanceTimersByTimeAsync(10000);
      else await tick();
      expect(queryByText(view.container, "Dashboard update unavailable")).not.toBeNull();
      expect(queryByTitle(view.container, "Garden overview dashboard")).toBe(frame);
      expect(view.container.textContent).toContain("Chat keeps going.");
      finish?.({ args: {}, result: { content: [], structuredContent: { id: "garden", title: "Too late" } } });
      if (failure === "timeout") await vi.advanceTimersByTimeAsync(0);
      expect(queryByTitle(view.container, "Too late dashboard")).toBeNull();
    } finally { vi.useRealTimers(); view.dispose(); measure.mockRestore(); }
  });

  it("keeps the panel's call after collapse, even when the next update fails", async () => {
    const measure = measureChatSpace(700);
    let subscription: SubscriptionCallbacks = {};
    subscribeToSessionMock.mockImplementation((_agent, _key, callbacks) => { subscription = callbacks; return () => {}; });
    const marker = { server: "yoplai", tool: "dashboard", resourceUri: "ui://yoplai/dashboard" };
    const reference = { ...marker, recordId: "saved-record", key: "garden" };
    fetchFullHistoryMock.mockResolvedValue({ sessionId: "session-main", messages: [
      { role: "assistant", timestamp: 1, content: [{ type: "toolCall", id: "v1", name: "dashboard_create", arguments: {}, viewCall: true, view: marker }] },
      { role: "toolResult", timestamp: 2, toolCallId: "v1", toolName: "dashboard_create", content: [{ type: "text", text: "Created" }], view: reference },
    ] });
    loadMcpAppDataMock.mockImplementation(async (_agent, _session, id) => {
      if (id === "v3") throw new Error("offline");
      return { args: {}, result: { content: [], structuredContent: { id: "garden", title: id } } };
    });
    const view = renderView();
    try {
      await waitFor(() => expect(queryByTitle(view.container, "v1 dashboard")).not.toBeNull());
      queryByRole(view.container, "button", { name: "Expand" })!.click();
      await waitFor(() => expect(queryByRole(view.container, "complementary")).not.toBeNull());
      const panel = queryByRole(view.container, "complementary")!;
      subscription.onToolCall?.("v2", "dashboard_update", {}, undefined, marker);
      subscription.onToolResult?.("v2", "dashboard_update", "Updated", false, undefined, undefined, { ...reference, recordId: "v2-record" });
      await waitFor(() => expect(queryByTitle(panel, "v2 dashboard")).not.toBeNull());
      loadMcpAppDataMock.mockClear();
      queryByRole(panel, "button", { name: "Collapse" })!.click();
      await waitFor(() => expect(queryByTitle(view.container, "v2 dashboard")).not.toBeNull());
      expect(loadMcpAppDataMock.mock.calls.map((call) => call[2])).not.toContain("v1");
      subscription.onToolCall?.("v3", "dashboard_update", {}, undefined, marker);
      subscription.onToolResult?.("v3", "dashboard_update", "Updated", false, undefined, undefined, { ...reference, recordId: "v3-record" });
      await waitFor(() => expect(queryByText(view.container, "Dashboard update unavailable")).not.toBeNull());
      expect(queryByTitle(view.container, "v2 dashboard")).not.toBeNull();
    } finally { view.dispose(); measure.mockRestore(); }
  });

  it("expands the last good dashboard when the latest update failed", async () => {
    const measure = measureChatSpace(700);
    let subscription: SubscriptionCallbacks = {};
    subscribeToSessionMock.mockImplementation((_agent, _key, callbacks) => { subscription = callbacks; return () => {}; });
    const marker = { server: "yoplai", tool: "dashboard", resourceUri: "ui://yoplai/dashboard" };
    const reference = { ...marker, recordId: "saved-record", key: "garden" };
    fetchFullHistoryMock.mockResolvedValue({ sessionId: "session-main", messages: [
      { role: "assistant", timestamp: 1, content: [{ type: "toolCall", id: "v1", name: "dashboard_create", arguments: {}, viewCall: true, view: marker }] },
      { role: "toolResult", timestamp: 2, toolCallId: "v1", toolName: "dashboard_create", content: [{ type: "text", text: "Created" }], view: reference },
    ] });
    loadMcpAppDataMock.mockImplementation(async (_agent, _session, id) => {
      if (id === "v2") throw new Error("offline");
      return { args: {}, result: { content: [], structuredContent: { id: "garden", title: id } } };
    });
    const view = renderView();
    try {
      await waitFor(() => expect(queryByTitle(view.container, "v1 dashboard")).not.toBeNull());
      subscription.onToolCall?.("v2", "dashboard_update", {}, undefined, marker);
      subscription.onToolResult?.("v2", "dashboard_update", "Updated", false, undefined, undefined, { ...reference, recordId: "v2-record" });
      await waitFor(() => expect(queryByText(view.container, "Dashboard update unavailable")).not.toBeNull());
      queryByRole(view.container, "button", { name: "Expand" })!.click();
      await waitFor(() => expect(queryByRole(view.container, "complementary")).not.toBeNull());
      await waitFor(() => expect(queryByTitle(queryByRole(view.container, "complementary")!, "v1 dashboard")).not.toBeNull());
    } finally { view.dispose(); measure.mockRestore(); }
  });

  it.each([false, undefined])("auto-opens a live dashboard with appsAvailable %s, then reloads its updated record", async (available) => {
    if (available === undefined) {
      resetCapabilitiesForTests();
      fetchCapabilitiesMock.mockImplementation(() => new Promise(() => {}));
    } else {
      setCapabilitiesForTests({ apps: { available } });
      fetchCapabilitiesMock.mockResolvedValue({ version: 2, extensions: {}, agents: [], apps: { available } });
    }
    const measure = measureChatSpace();
    fetchSimpleHistoryMock.mockResolvedValue({ messages: [], isStreaming: false, activeTurn: null });
    fetchFullHistoryMock.mockResolvedValue({ messages: [], isStreaming: false, activeTurn: null });
    loadMcpAppDataMock.mockResolvedValue({ args: {}, result: { content: [], structuredContent: { id: "garden", title: "Garden overview" } } });
    const view = await startFullStream();
    fetchFullHistoryMock.mockResolvedValue({ sessionId: "first-session", messages: [], isStreaming: false, activeTurn: null });
    const marker = { server: "yoplai", tool: "dashboard", resourceUri: "ui://yoplai/dashboard" };
    try {
      view.callbacks()?.onToolCall?.("created-dashboard", "dashboard_create", {}, undefined, marker);
      view.callbacks()?.onToolResult?.("created-dashboard", "dashboard_create", "Created", false, undefined, undefined, { ...marker, recordId: "created-record", key: "garden" });
      await waitFor(() => expect(queryByRole(view.container, "complementary")).not.toBeNull());
      const panel = queryByRole(view.container, "complementary")!;
      await waitFor(() => expect(queryByTitle(panel, "Garden overview dashboard")).not.toBeNull());
      const frame = queryByTitle(panel, "Garden overview dashboard") as HTMLIFrameElement;
      expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
      expect(queryByRole(view.container, "button", { name: "Dashboard · shown in the side panel" })).not.toBeNull();
      frame.src = "/d/garden?old=1";
      loadMcpAppDataMock.mockResolvedValue({ args: {}, result: { content: [], structuredContent: { id: "garden", title: "Garden revised" } } });
      view.callbacks()?.onToolCall?.("updated-dashboard", "dashboard_update", {}, undefined, marker);
      view.callbacks()?.onToolResult?.("updated-dashboard", "dashboard_update", "Updated", false, undefined, undefined, { ...marker, recordId: "updated-record", key: "garden" });
      await waitFor(() => expect(queryByTitle(panel, "Garden revised dashboard")).toBe(frame));
      expect(frame.getAttribute("src")).toBe("/d/garden");
    } finally { view.dispose(); measure.mockRestore(); }
  });

  it("labels the compact dashboard card and focuses its panel", async () => {
    const measure = measureChatSpace();
    loadMcpAppDataMock.mockResolvedValue({ args: {}, result: { content: [], structuredContent: { id: "garden", title: "Garden overview" } } });
    const { container, dispose, callbacks } = await startFullStream();
    try {
      const marker = { server: "yoplai", tool: "dashboard", resourceUri: "ui://yoplai/dashboard" };
      callbacks()?.onToolCall?.("live-dashboard", "dashboard_create", {}, undefined, marker);
      callbacks()?.onToolResult?.("live-dashboard", "dashboard_create", "Dashboard created", false, undefined, undefined, { ...marker, recordId: "dashboard-record", key: "garden" });
      await waitFor(() => expect(queryByRole(container, "complementary", { name: "App view" })).not.toBeNull());
      const panel = queryByRole(container, "complementary", { name: "App view" })!;
      await waitFor(() => expect(queryByTitle(panel, "Garden overview dashboard")).not.toBeNull());
      const card = queryByRole(container, "button", { name: "Dashboard · shown in the side panel" });
      expect(card).not.toBeNull();
      expect(card!.querySelector(".fa-table-columns")).not.toBeNull();
      card!.click();
      expect(document.activeElement).toBe(panel);
      queryByRole(panel, "button", { name: "Collapse" })!.click();
      await waitFor(() => expect(queryByRole(container, "complementary")).toBeNull());
      expect(queryByTitle(container, "Garden overview dashboard")).not.toBeNull();
    } finally { dispose(); measure.mockRestore(); }
  });

  it.each([
    [1280, 1000, true],
    [769, 726, true],
    [768, 1000, false],
    [1280, 725, false],
    [700, 1000, false],
  ] as const)("opens live dashboards only when the split fits (%i, %i => %s)", async (viewport, row, opens) => {
    const measure = measureChatSpace(viewport, row);
    loadMcpAppDataMock.mockResolvedValue({ args: {}, result: { content: [], structuredContent: { id: "garden", title: "Garden overview" } } });
    const { container, dispose, callbacks } = await startFullStream();
    try {
      const marker = { server: "yoplai", tool: "dashboard", resourceUri: "ui://yoplai/dashboard" };
      callbacks()?.onToolCall?.("guarded", "dashboard_create", {}, undefined, marker);
      callbacks()?.onToolResult?.("guarded", "dashboard_create", "Dashboard created", false, undefined, undefined, { ...marker, recordId: "guarded-record", key: "garden" });
      await waitFor(() => expect(queryByTitle(container, "Garden overview dashboard")).not.toBeNull());
      expect(!!queryByRole(container, "complementary")).toBe(opens);
    } finally { dispose(); measure.mockRestore(); }
  });

  it("opens the side panel for an HTML file sent in a live direct stream", async () => {
    enableAppViews();
    const measure = measureChatSpace();
    const { container, dispose, callbacks } = await startFullStream();
    try {
      sendViewFile(callbacks(), "live-report", { fileId: "live-html", filename: "report.html", mimeType: "text/html", size: 64, title: "Live report" });
      await waitFor(() => expect(queryByRole(container, "complementary", { name: "App view" })).not.toBeNull());
      const panel = queryByRole(container, "complementary", { name: "App view" })!;
      await waitFor(() => expect(queryByTitle(panel, "Live report file view")).not.toBeNull());
      expect(queryByRole(panel, "link", { name: "Download" })?.getAttribute("href")).toBe("/api/media/download/live-html");
    } finally { dispose(); measure.mockRestore(); }
  });

  it("shows the file icon on the compact panel button and focuses its panel", async () => {
    enableAppViews();
    const measure = measureChatSpace();
    const { container, dispose, callbacks } = await startFullStream();
    try {
      sendViewFile(callbacks(), "panel-report", { fileId: "panel-pdf", filename: "report.pdf", mimeType: "application/pdf", size: 64, title: "Live report" });
      await waitFor(() => expect(queryByRole(container, "complementary", { name: "App view" })).not.toBeNull());
      const panel = queryByRole(container, "complementary", { name: "App view" })!;
      const card = queryByRole(container, "button", { name: "Live report · shown in the side panel" });
      expect(card).not.toBeNull();
      expect(card!.textContent).toContain("PDF");
      card!.click();
      expect(document.activeElement).toBe(panel);
    } finally { dispose(); measure.mockRestore(); }
  });

  it.each([
    ["notes.md", "text/markdown", 1280, 1000, true],
    ["report.pdf", "application/octet-stream", 1280, 1000, true],
    ["report.htm", "application/octet-stream", 1280, 1000, true],
    ["picture.png", "image/png", 1280, 1000, false],
    ["notes.txt", "text/plain", 1280, 1000, false],
    ["data.json", "application/json", 1280, 1000, false],
    ["report.html", "application/zip", 1280, 1000, false],
    ["report.html", "text/html", 769, 726, true],
    ["report.html", "text/html", 768, 1000, false],
    ["report.html", "text/html", 1280, 725, false],
    ["report.html", "text/html", 700, 1000, false],
  ] as const)("auto-opens live %s (%s), viewport %i, row %i: %s", async (filename, mimeType, viewport, row, opens) => {
    enableAppViews();
    const measure = measureChatSpace(viewport, row);
    const { container, dispose, callbacks } = await startFullStream();
    try {
      sendViewFile(callbacks(), "live-file", { fileId: "file", filename, mimeType, size: 64, title: "Sent file" });
      await waitFor(() => expect(queryByTitle(container, "Sent file file view")).not.toBeNull());
      expect(!!queryByRole(container, "complementary", { name: "App view" })).toBe(opens);
    } finally { dispose(); measure.mockRestore(); }
  });

  it("auto-opens a live subscription document while external app results stay inline", async () => {
    enableAppViews();
    const measure = measureChatSpace();
    let subscription: SubscriptionCallbacks = {};
    subscribeToSessionMock.mockImplementation((_agent, _key, callbacks) => { subscription = callbacks; return () => {}; });
    const { container, dispose } = renderView();
    try {
      await tick();
      await tick();
      const marker = { server: "fixture", tool: "draw", resourceUri: "ui://fixture/drawing.html" };
      subscription.onToolCall?.("external-view", "fixture_draw", {}, undefined, marker);
      subscription.onToolResult?.("external-view", "fixture_draw", "Drawn", false, undefined, undefined, { ...marker, recordId: "external-record", file: { fileId: "external", filename: "external.html", mimeType: "text/html", size: 64 } });
      await waitFor(() => expect(queryByTitle(container, "external.html file view")).not.toBeNull());
      expect(queryByRole(container, "complementary")).toBeNull();
      sendViewFile(subscription, "sub-report", { fileId: "subscription-html", filename: "report.html", mimeType: "text/html", size: 64 });
      await waitFor(() => expect(queryByRole(container, "complementary")).not.toBeNull());
      expect(queryByRole(queryByRole(container, "complementary")!, "link", { name: "Download" })?.getAttribute("href")).toBe("/api/media/download/subscription-html");
    } finally { dispose(); measure.mockRestore(); }
  });

  it("keeps historical and reconnect documents inline on a wide screen", async () => {
    enableAppViews();
    const measure = measureChatSpace();
    let subscription: SubscriptionCallbacks = {};
    subscribeToSessionMock.mockImplementation((_agent, _key, callbacks) => { subscription = callbacks; return () => {}; });
    const marker = { server: "yoplai", tool: "send_file", resourceUri: "ui://yoplai/file-viewer" };
    const file = { fileId: "saved-html", filename: "saved.html", mimeType: "text/html", size: 64, title: "Saved report" };
    fetchFullHistoryMock.mockResolvedValue({ sessionId: "session-main", messages: [
      { role: "assistant", timestamp: 1, content: [{ type: "toolCall", id: "saved-call", name: "send_file", arguments: {}, viewCall: true, view: marker }] },
      { role: "toolResult", timestamp: 2, toolCallId: "saved-call", toolName: "send_file", content: [{ type: "text", text: "File sent to user" }], view: { ...marker, recordId: "saved-record", file } },
    ] });
    const { container, dispose } = renderView();
    try {
      await waitFor(() => expect(queryByTitle(container, "Saved report file view")).not.toBeNull());
      expect(queryByRole(container, "complementary")).toBeNull();
      subscription.onActiveTurn?.({
        userText: "Report", userTimestamp: 3, startedAt: 3, thinking: "", text: "",
        toolCalls: [{ id: "reconnect-call", name: "send_file", arguments: {}, status: "done", view: marker }],
        toolResults: [{ id: "reconnect-call", name: "send_file", content: "File sent to user", isError: false, view: { ...marker, recordId: "reconnect-record", file: { ...file, fileId: "reconnected", filename: "reconnected.html", title: "Reconnected report" } } }],
      });
      await waitFor(() => expect(queryByTitle(container, "Reconnected report file view")).not.toBeNull());
      expect(queryByRole(container, "complementary")).toBeNull();
    } finally { dispose(); measure.mockRestore(); }
  });

  it("keeps live documents in tabs and collapses only the active tab", async () => {
    enableAppViews();
    const measure = measureChatSpace();
    const { container, dispose, callbacks } = await startFullStream();
    try {
      sendViewFile(callbacks(), "first-doc", { fileId: "report", filename: "report.html", mimeType: "text/html", size: 64, title: "Report" });
      await waitFor(() => expect(queryByTitle(queryByRole(container, "complementary")!, "Report file view")).not.toBeNull());
      const first = queryByTitle(container, "Report file view") as HTMLIFrameElement;
      expect(queryByRole(container, "tablist")).toBeNull();
      sendViewFile(callbacks(), "second-doc", { fileId: "plan", filename: "plan.md", mimeType: "text/markdown", size: 64, title: "Plan" });
      await waitFor(() => expect(queryByTitle(queryByRole(container, "complementary")!, "Plan file view")).not.toBeNull());
      const panel = queryByRole(container, "complementary")!;
      expect(first.isConnected).toBe(true);
      expect(queryAllByRole(panel, "tab").map((tab) => tab.getAttribute("title"))).toEqual(["Report", "Plan"]);
      expect(queryByRole(panel, "tab", { name: "Plan" })?.getAttribute("aria-selected")).toBe("true");
      const second = queryByTitle(queryByRole(container, "complementary")!, "Plan file view") as HTMLIFrameElement;
      queryByRole(panel, "tab", { name: "Report" })!.click();
      expect(queryByTitle(panel, "Report file view")).toBe(first);
      expect(second.isConnected).toBe(true);
      queryByRole(panel, "tab", { name: "Plan" })!.click();
      initializeApp(second);
      queryByRole(queryByRole(container, "complementary")!, "button", { name: "Collapse" })!.click();
      appMessage(second, { jsonrpc: "2.0", id: "yoplai-resource-teardown", result: {} });
      await waitFor(() => expect(second.isConnected).toBe(false));
      expect(queryByRole(container, "complementary")).toBe(panel);
      expect(queryByTitle(panel, "Report file view")).toBe(first);
      expect(queryByRole(panel, "tablist")).toBeNull();
      sendViewFile(callbacks(), "revised-doc", { fileId: "revised-plan", filename: "plan.md", mimeType: "text/markdown", size: 128, title: "Revised plan" });
      // The reopened panel starts at the last shown version, then updates to the revision once connected.
      await waitFor(() => expect(queryByTitle(queryByRole(container, "complementary")!, "Plan file view")).not.toBeNull());
      initializeApp(queryByTitle(queryByRole(container, "complementary")!, "Plan file view") as HTMLIFrameElement);
      await waitFor(() => expect(queryByTitle(queryByRole(container, "complementary")!, "Revised plan file view")).not.toBeNull());
      expect(queryByRole(queryByRole(container, "complementary")!, "link", { name: "Download" })?.getAttribute("href")).toBe("/api/media/download/revised-plan");
    } finally { dispose(); measure.mockRestore(); }
  });

  it("keeps the first view loaded when a second tab opens and bootstraps it again if its sandbox restarts", async () => {
    enableAppViews();
    loadMcpAppViewMock.mockImplementation(async (_agent, _session, callId) => ({
      available: true, sandboxUrl: "https://apps.test/sandbox", appsOrigin: "https://apps.test", server: "yoplai",
      toolName: "send_file", args: { path: `${callId}.file` }, result: { content: [{ type: "text", text: `${callId} sent` }] }, csp: {}, prefersBorder: false,
    }));
    const measure = measureChatSpace();
    const { container, dispose, callbacks } = await startFullStream();
    try {
      sendViewFile(callbacks(), "spec-doc", { fileId: "spec", filename: "spec.md", mimeType: "text/markdown", size: 64, title: "Spec" });
      await waitFor(() => expect(queryByTitle(queryByRole(container, "complementary")!, "Spec file view")).not.toBeNull());
      const spec = queryByTitle(container, "Spec file view") as HTMLIFrameElement;
      initializeApp(spec);
      const specDocument = spec.contentWindow;
      sendViewFile(callbacks(), "flow-doc", { fileId: "flow", filename: "flow.html", mimeType: "text/html", size: 64, title: "Flow" });
      const panel = queryByRole(container, "complementary")!;
      await waitFor(() => expect(queryByTitle(panel, "Flow file view")).not.toBeNull());
      queryByRole(panel, "tab", { name: "Spec" })!.click();
      expect(queryByTitle(panel, "Spec file view")).toBe(spec);
      // A moved iframe gets a new document, which is what blanked the first view in the browser.
      expect(spec.contentWindow === specDocument).toBe(true);
      const post = vi.spyOn(spec.contentWindow!, "postMessage");
      appMessage(spec, { jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready" });
      appMessage(spec, { jsonrpc: "2.0", id: 2, method: "ui/initialize", params: {} });
      appMessage(spec, { jsonrpc: "2.0", method: "ui/notifications/initialized" });
      expect(post.mock.calls.map(([message]) => message.method ?? `reply ${message.id}`)).toEqual([
        "ui/notifications/sandbox-resource-ready", "reply 2", "ui/notifications/tool-input", "ui/notifications/tool-result",
      ]);
      expect(post.mock.calls.slice(2).map(([message]) => message.params)).toEqual([
        { arguments: { path: "spec-doc.file" } },
        { content: [{ type: "text", text: "spec-doc sent" }] },
      ]);
      expect(queryByText(panel, "View unavailable")).toBeNull();
    } finally { dispose(); measure.mockRestore(); }
  });

  it("navigates and reorders panel tabs with the keyboard without replacing their frames", async () => {
    enableAppViews();
    const measure = measureChatSpace();
    const { container, dispose, callbacks } = await startFullStream();
    try {
      sendViewFile(callbacks(), "cedar", { fileId: "cedar", filename: "cedar.html", mimeType: "text/html", size: 64, title: "Cedar map" });
      await waitFor(() => expect(queryByTitle(queryByRole(container, "complementary")!, "Cedar map file view")).not.toBeNull());
      sendViewFile(callbacks(), "finch", { fileId: "finch", filename: "finch.md", mimeType: "text/markdown", size: 64, title: "Finch notes" });
      const panel = queryByRole(container, "complementary")!;
      await waitFor(() => expect(queryByTitle(panel, "Finch notes file view")).not.toBeNull());
      const cedar = queryByTitle(panel, "Cedar map file view");
      const finch = queryByTitle(panel, "Finch notes file view");
      const finchTab = queryByRole(panel, "tab", { name: "Finch notes" })!;
      finchTab.focus();
      fireEvent.keyDown(finchTab, { key: "ArrowLeft" });
      expect(queryByRole(panel, "tab", { name: "Cedar map" })?.getAttribute("aria-selected")).toBe("true");
      expect(document.activeElement).toBe(queryByRole(panel, "tab", { name: "Cedar map" }));
      fireEvent.keyDown(document.activeElement!, { key: "End" });
      expect(document.activeElement).toBe(finchTab);
      fireEvent.keyDown(finchTab, { key: "ArrowLeft", ctrlKey: true, shiftKey: true });
      await tick();
      expect(queryAllByRole(panel, "tab").map((tab) => tab.getAttribute("title"))).toEqual(["Finch notes", "Cedar map"]);
      expect(finchTab.getAttribute("aria-selected")).toBe("true");
      expect(document.activeElement).toBe(finchTab);
      expect(queryByTitle(panel, "Cedar map file view")).toBe(cedar);
      expect(queryByTitle(panel, "Finch notes file view")).toBe(finch);
      queryByRole(panel, "button", { name: "Close Finch notes" })!.click();
      expect(finch?.isConnected).toBe(false);
      expect(queryByTitle(panel, "Cedar map file view")).toBe(cedar);
      expect(queryByRole(panel, "tablist")).toBeNull();
    } finally { dispose(); measure.mockRestore(); }
  });

  it("drags a tab to a new position while keeping both panel frames mounted", async () => {
    enableAppViews();
    const measure = measureChatSpace();
    const { container, dispose, callbacks } = await startFullStream();
    try {
      sendViewFile(callbacks(), "map", { fileId: "map", filename: "map.html", mimeType: "text/html", size: 64, title: "Cedar map" });
      await waitFor(() => expect(queryByTitle(queryByRole(container, "complementary")!, "Cedar map file view")).not.toBeNull());
      sendViewFile(callbacks(), "notes", { fileId: "notes", filename: "notes.md", mimeType: "text/markdown", size: 64, title: "Finch notes" });
      const panel = queryByRole(container, "complementary")!;
      await waitFor(() => expect(queryByTitle(panel, "Finch notes file view")).not.toBeNull());
      const cedar = queryByTitle(panel, "Cedar map file view");
      const finch = queryByTitle(panel, "Finch notes file view");
      const source = queryByRole(panel, "tab", { name: "Finch notes" })!;
      const target = queryByRole(panel, "tab", { name: "Cedar map" })!;
      vi.spyOn(target, "getBoundingClientRect").mockReturnValue({ left: 100, width: 100 } as DOMRect);
      const transfer = new Map<string, string>();
      const dataTransfer = { effectAllowed: "", dropEffect: "", setData: (type: string, value: string) => transfer.set(type, value), getData: (type: string) => transfer.get(type) ?? "" };
      const dragAt = (type: string, element: HTMLElement, clientX: number) => {
        const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX });
        Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
        fireEvent(element, event);
      };
      fireEvent.dragStart(source, { dataTransfer });
      dragAt("dragover", target, 110);
      dragAt("drop", target, 110);
      fireEvent.dragEnd(source, { dataTransfer });
      expect(queryAllByRole(panel, "tab").map((tab) => tab.getAttribute("title"))).toEqual(["Finch notes", "Cedar map"]);
      expect(source.getAttribute("aria-selected")).toBe("true");
      expect(queryByTitle(panel, "Cedar map file view")).toBe(cedar);
      expect(queryByTitle(panel, "Finch notes file view")).toBe(finch);
      fireEvent.dragStart(source, { dataTransfer });
      dragAt("dragover", target, 190);
      dragAt("drop", target, 190);
      fireEvent.dragEnd(source, { dataTransfer });
      expect(queryAllByRole(panel, "tab").map((tab) => tab.getAttribute("title"))).toEqual(["Cedar map", "Finch notes"]);
      expect(queryByTitle(panel, "Cedar map file view")).toBe(cedar);
      expect(queryByTitle(panel, "Finch notes file view")).toBe(finch);
    } finally { dispose(); measure.mockRestore(); }
  });

  it("delivers an update to its inactive tab and hides only that tab's delivered file card", async () => {
    enableAppViews();
    const measure = measureChatSpace();
    const { container, dispose, callbacks } = await startFullStream();
    try {
      sendViewFile(callbacks(), "copper-v1", { fileId: "copper-v1", filename: "copper.html", mimeType: "text/html", size: 64, title: "Copper notes" });
      await waitFor(() => expect(queryByTitle(queryByRole(container, "complementary")!, "Copper notes file view")).not.toBeNull());
      const panel = queryByRole(container, "complementary")!;
      const copper = queryByTitle(panel, "Copper notes file view") as HTMLIFrameElement;
      initializeApp(copper);
      sendViewFile(callbacks(), "cedar-v1", { fileId: "cedar-v1", filename: "cedar.md", mimeType: "text/markdown", size: 64, title: "Cedar brief" });
      await waitFor(() => expect(queryByTitle(panel, "Cedar brief file view")).not.toBeNull());
      const cedar = queryByTitle(panel, "Cedar brief file view") as HTMLIFrameElement;
      initializeApp(cedar);
      expect(queryByText(container, "copper.html", { exact: true })).toBeNull();
      expect(queryByText(container, "cedar.md", { exact: true })).toBeNull();
      let finish!: (data: { args: object; result: { content: never[] } }) => void;
      loadMcpAppDataMock.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
      sendViewFile(callbacks(), "copper-v2", { fileId: "copper-v2", filename: "copper.html", mimeType: "text/html", size: 128, title: "Copper revision" });
      queryByRole(panel, "tab", { name: "Cedar brief" })!.click();
      await waitFor(() => expect(finish).toBeTypeOf("function"));
      finish({ args: {}, result: { content: [] } });
      await waitFor(() => expect(queryByTitle(panel, "Copper revision file view")).toBe(copper));
      expect(queryByRole(panel, "tab", { name: "Cedar brief" })?.getAttribute("aria-selected")).toBe("true");
      expect(queryByTitle(panel, "Cedar brief file view")).toBe(cedar);
      expect(queryByRole(container, "button", { name: "Copper revision · open in a side panel tab" })).not.toBeNull();
      expect(queryByText(container, "cedar.md", { exact: true })).toBeNull();
      expect(queryAllByRole(container, "link", { name: "Download", hidden: true }).filter((link) => link.getAttribute("href") === "/api/media/download/copper-v2")).toHaveLength(1);
      initializeApp(copper);
      queryByRole(panel, "button", { name: "Close Copper revision" })!.click();
      expect(copper.isConnected).toBe(false);
      initializeApp(cedar);
      queryByRole(queryByRole(panel, "tabpanel")!, "button", { name: "Collapse" })!.click();
      appMessage(cedar, { jsonrpc: "2.0", id: "yoplai-resource-teardown", result: {} });
      await waitFor(() => expect(queryByRole(container, "complementary")).toBeNull());
    } finally { dispose(); measure.mockRestore(); }
  });

  it.each(["failed", "hung"])("keeps an inactive tab's last good version after a %s update while another tab and chat progress", async (outcome) => {
    enableAppViews();
    const measure = measureChatSpace();
    const { container, dispose, callbacks, onText } = await startFullStream();
    try {
      sendViewFile(callbacks(), "stable", { fileId: "stable", filename: "copper.html", mimeType: "text/html", size: 64, title: "Copper notes" });
      await waitFor(() => expect(queryByTitle(queryByRole(container, "complementary")!, "Copper notes file view")).not.toBeNull());
      const panel = queryByRole(container, "complementary")!;
      const copper = queryByTitle(panel, "Copper notes file view") as HTMLIFrameElement;
      initializeApp(copper);
      sendViewFile(callbacks(), "other", { fileId: "other", filename: "cedar.md", mimeType: "text/markdown", size: 64, title: "Cedar brief" });
      await waitFor(() => expect(queryByTitle(panel, "Cedar brief file view")).not.toBeNull());
      const cedar = queryByTitle(panel, "Cedar brief file view") as HTMLIFrameElement;
      initializeApp(cedar);
      if (outcome === "failed") loadMcpAppDataMock.mockRejectedValueOnce(new Error("offline"));
      else loadMcpAppDataMock.mockImplementationOnce(() => new Promise(() => {}));
      vi.useFakeTimers();
      sendViewFile(callbacks(), "blocked", { fileId: "blocked", filename: "copper.html", mimeType: "text/html", size: 128, title: "Copper revision" });
      queryByRole(panel, "tab", { name: "Cedar brief" })!.click();
      onText("The garden plan is still progressing");
      await vi.advanceTimersByTimeAsync(32001);
      expect(queryByTitle(panel, "Copper notes file view")).toBe(copper);
      expect(queryByTitle(panel, "Copper revision file view")).toBeNull();
      expect(queryByTitle(panel, "Cedar brief file view")).toBe(cedar);
      expect(queryByRole(panel, "tab", { name: "Cedar brief" })?.getAttribute("aria-selected")).toBe("true");
      expect(queryByText(container, "The garden plan is still progressing")).not.toBeNull();
      expect(queryAllByRole(panel, "link", { name: "Download", hidden: true }).map((link) => link.getAttribute("href"))).toEqual(["/api/media/download/stable", "/api/media/download/other"]);
    } finally { dispose(); vi.useRealTimers(); measure.mockRestore(); }
  });

  // ALG-600's rendered host/chat seam approved in Linear comment
  // 9de9b656-b0db-413c-8e8f-6707c6aece4d; transport is the external adapter.
  async function openMessageApp(contextTokens = 0) {
    enableAppViews();
    fetchFullHistoryMock.mockResolvedValue({ sessionId: "session-main", messages: [
      { role: "assistant", timestamp: 1, meta: { model: "gpt-5", usage: { input: contextTokens } }, content: [
        { type: "toolCall", id: "message-app", name: "fixture_draw", arguments: {} },
      ] },
      { role: "toolResult", timestamp: 2, toolCallId: "message-app", toolName: "fixture_draw", content: [{ type: "text", text: "Saved drawing" }],
        view: { server: "fixture", tool: "draw", resourceUri: "ui://fixture/view.html", recordId: "message-record" } },
    ] });
    const view = renderView();
    await waitFor(() => expect(view.container.querySelector("iframe")).not.toBeNull());
    const frame = view.container.querySelector("iframe")!;
    initializeApp(frame);
    const replies = vi.spyOn(frame.contentWindow!, "postMessage");
    const send = (text: string, id = "view-message") => {
      appMessage(frame, { jsonrpc: "2.0", id, method: "ui/message", params: { role: "user", content: [{ type: "text", text }] } });
    };
    return { ...view, frame, replies, send };
  }

  it("sends an MCP App message as a visible normal user message", async () => {
    const { container, replies, send } = await openMessageApp();
    send("Build the selected rectangle");
    await waitFor(() => expect(streamMessageMock).toHaveBeenCalledTimes(1));
    expect(streamMessageMock.mock.calls[0].slice(0, 3)).toEqual(["agent-1", "Build the selected rectangle", "main"]);
    expect(container.querySelector(".message.user")?.textContent).toContain("Build the selected rectangle");
    await waitFor(() => expect(replies).toHaveBeenCalledWith({ jsonrpc: "2.0", id: "view-message", result: {} }, "https://apps.test"));
  });

  it.each(["   ", "x".repeat(4001)])("refuses an empty or oversized MCP App message (%#)", async (text) => {
    const { replies, send } = await openMessageApp();
    send(text);
    await waitFor(() => expect(replies).toHaveBeenCalledWith(expect.objectContaining({ id: "view-message", error: expect.objectContaining({ code: -32000 }) }), "https://apps.test"));
    expect(streamMessageMock).not.toHaveBeenCalled();
  });

  it("reserves MCP App rate slots synchronously and allows another after two seconds", async () => {
    let now = 1000000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const { replies, send } = await openMessageApp();
      send("First selection", "first");
      send("Parallel selection", "parallel");
      await waitFor(() => expect(replies).toHaveBeenCalledWith(expect.objectContaining({ id: "parallel", error: expect.objectContaining({ code: -32000 }) }), "https://apps.test"));
      expect(streamMessageMock).toHaveBeenCalledTimes(1);
      now += 1999;
      send("Too fast", "fast");
      await waitFor(() => expect(replies).toHaveBeenCalledWith(expect.objectContaining({ id: "fast", error: expect.objectContaining({ code: -32000 }) }), "https://apps.test"));
      now += 1;
      send("Next selection", "next");
      await waitFor(() => expect(streamMessageMock).toHaveBeenCalledTimes(2));
    } finally { clock.mockRestore(); }
  });

  it("limits an MCP App to ten messages in ten minutes and then expires slots", async () => {
    let now = 1000000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const { replies, send } = await openMessageApp();
      for (let i = 0; i < 10; i++) {
        send(`Selection ${i}`, `allowed-${i}`);
        await waitFor(() => expect(streamMessageMock).toHaveBeenCalledTimes(i + 1));
        now += 2000;
      }
      send("Eleventh selection", "eleventh");
      await waitFor(() => expect(replies).toHaveBeenCalledWith(expect.objectContaining({ id: "eleventh", error: expect.objectContaining({ code: -32000 }) }), "https://apps.test"));
      expect(streamMessageMock).toHaveBeenCalledTimes(10);
      now = 1600000;
      send("Expired window", "expired");
      await waitFor(() => expect(streamMessageMock).toHaveBeenCalledTimes(11));
    } finally { clock.mockRestore(); }
  });

  it("keeps rate reservations across panel remounts and drops them on session change", async () => {
    const { container, frame, send } = await openMessageApp();
    send("Initial selection");
    await waitFor(() => expect(streamMessageMock).toHaveBeenCalledTimes(1));
    const panel = await expandApp(container, frame);
    initializeApp(panel);
    const replies = vi.spyOn(panel.contentWindow!, "postMessage");
    appMessage(panel, { jsonrpc: "2.0", id: "remounted", method: "ui/message", params: { role: "user", content: [{ type: "text", text: "Too soon after expand" }] } });
    await waitFor(() => expect(replies).toHaveBeenCalledWith(expect.objectContaining({ id: "remounted", error: expect.objectContaining({ code: -32000 }) }), "https://apps.test"));
    routeState.session = "session-next";
    setRouteVersion((version) => version + 1);
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    await waitFor(() => expect(container.querySelector("iframe")).not.toBe(panel));
    const next = container.querySelector("iframe")!;
    initializeApp(next);
    appMessage(next, { jsonrpc: "2.0", id: "new-session", method: "ui/message", params: { role: "user", content: [{ type: "text", text: "New session selection" }] } });
    await waitFor(() => expect(streamMessageMock).toHaveBeenCalledTimes(2));
  });

  it("refuses slash commands from an MCP App without resetting the session", async () => {
    routeState.session = "session-main";
    const { replies, send } = await openMessageApp();
    send("  /reset  ");
    await waitFor(() => expect(replies).toHaveBeenCalledWith(expect.objectContaining({ id: "view-message", error: expect.objectContaining({ code: -32000 }) }), "https://apps.test"));
    expect(streamMessageMock).not.toHaveBeenCalled();
    expect(startNewChatMock).not.toHaveBeenCalled();
    expect(routeState.session).toBe("session-main");
  });

  it("refuses MCP App messages during impersonation", async () => {
    const { replies, send } = await openMessageApp();
    setImpersonationStatus({ active: true, admin: { id: "admin" }, target: { id: "viewer", name: "Viewer", email: null } });
    send("Impersonated selection");
    await waitFor(() => expect(replies).toHaveBeenCalledWith(expect.objectContaining({ id: "view-message", error: expect.objectContaining({ code: -32000 }) }), "https://apps.test"));
    expect(streamMessageMock).not.toHaveBeenCalled();
  });

  it("refuses MCP App messages while a composer upload is pending", async () => {
    const { container, replies, send } = await openMessageApp();
    let finishUpload!: (files: unknown[]) => void;
    uploadFilesMock.mockImplementationOnce(() => new Promise((resolve) => { finishUpload = resolve; }));
    container.querySelector("textarea")!.dispatchEvent(createFileDragEvent("drop", [new File(["draw"], "drawing.txt", { type: "text/plain" })]));
    container.querySelector<HTMLButtonElement>(".send-btn")!.click();
    await waitFor(() => expect(uploadFilesMock).toHaveBeenCalledTimes(1));
    send("Selection during upload");
    await waitFor(() => expect(replies).toHaveBeenCalledWith(expect.objectContaining({ id: "view-message", error: expect.objectContaining({ code: -32000 }) }), "https://apps.test"));
    expect(streamMessageMock).not.toHaveBeenCalled();
    finishUpload([]);
    await waitFor(() => expect(streamMessageMock).toHaveBeenCalledTimes(1));
  });

  it.each(["queue", "interrupt"])("handles an MCP App message during %s streaming without interrupting", async (queueMode) => {
    fetchAgentMock.mockResolvedValue({ id: "agent-1", name: "Agent", queueMode });
    const cleanup = vi.fn();
    streamMessageMock.mockReturnValue(cleanup);
    const { container, replies, send } = await openMessageApp();
    const input = container.querySelector("textarea")!;
    input.value = "Current turn";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    container.querySelector<HTMLButtonElement>(".send-btn")!.click();
    await waitFor(() => expect(streamMessageMock).toHaveBeenCalledTimes(1));
    send("Selected object");
    if (queueMode === "queue") {
      await waitFor(() => expect(replies).toHaveBeenCalledWith({ jsonrpc: "2.0", id: "view-message", result: {} }, "https://apps.test"));
      expect(streamMessageMock).toHaveBeenCalledTimes(2);
    } else {
      await waitFor(() => expect(replies).toHaveBeenCalledWith(expect.objectContaining({ id: "view-message", error: expect.objectContaining({ code: -32000 }) }), "https://apps.test"));
      expect(streamMessageMock).toHaveBeenCalledTimes(1);
    }
    expect(cleanup).not.toHaveBeenCalled();
    expect(postAbortMock).not.toHaveBeenCalled();
  });

  it("refuses an MCP App message while the composer prepares an archived send", async () => {
    routeState.session = "session-main";
    fetchAgentSessionsMock.mockResolvedValue({ items: [{ agentId: "agent-1", sessionId: "session-main", archived: 1 }] });
    let restored!: () => void;
    archiveAgentSessionMock.mockImplementationOnce(() => new Promise<void>((resolve) => { restored = resolve; }));
    const { container, replies, send } = await openMessageApp();
    const input = container.querySelector("textarea")!;
    input.value = "Composer restoring";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    container.querySelector<HTMLButtonElement>(".send-btn")!.click();
    await waitFor(() => expect(archiveAgentSessionMock).toHaveBeenCalledTimes(1));
    send("View while preparing");
    await waitFor(() => expect(replies).toHaveBeenCalledWith(expect.objectContaining({ id: "view-message", error: expect.objectContaining({ code: -32000 }) }), "https://apps.test"));
    expect(archiveAgentSessionMock).toHaveBeenCalledTimes(1);
    restored();
    await waitFor(() => expect(streamMessageMock).toHaveBeenCalledTimes(1));
    expect(streamMessageMock.mock.calls[0][1]).toBe("Composer restoring");
  });

  it("refuses panel messages while history is loading", async () => {
    const { container, frame } = await openMessageApp();
    const panel = await expandApp(container, frame);
    initializeApp(panel);
    const replies = vi.spyOn(panel.contentWindow!, "postMessage");
    fetchFullHistoryMock.mockImplementationOnce(() => new Promise(() => {}));
    routeState.view = "full";
    setRouteVersion((version) => version + 1);
    appMessage(panel, { jsonrpc: "2.0", id: "loading", method: "ui/message", params: { role: "user", content: [{ type: "text", text: "During history load" }] } });
    await waitFor(() => expect(replies).toHaveBeenCalledWith(expect.objectContaining({ id: "loading", error: expect.objectContaining({ code: -32000 }) }), "https://apps.test"));
    expect(streamMessageMock).not.toHaveBeenCalled();
  });

  it("does not submit a view message if the session switches during restore", async () => {
    routeState.session = "session-main";
    fetchAgentSessionsMock.mockResolvedValue({ items: [{ agentId: "agent-1", sessionId: "session-main", archived: 1 }] });
    let restored!: () => void;
    archiveAgentSessionMock.mockImplementationOnce(() => new Promise<void>((resolve) => { restored = resolve; }));
    const { container, send } = await openMessageApp();
    send("Old session selection");
    await waitFor(() => expect(archiveAgentSessionMock).toHaveBeenCalledTimes(1));
    routeState.session = "session-next";
    setRouteVersion((version) => version + 1);
    await tick();
    restored();
    await tick();
    await tick();
    expect(streamMessageMock).not.toHaveBeenCalled();
    expect(container.querySelector(".messages")?.textContent).not.toContain("Old session selection");
  });

  it.each(["restore", "compact"])("rechecks impersonation after a view awaits %s", async (preparation) => {
    routeState.session = "session-main";
    let prepared!: () => void;
    if (preparation === "restore") {
      fetchAgentSessionsMock.mockResolvedValue({ items: [{ agentId: "agent-1", sessionId: "session-main", archived: 1 }] });
      archiveAgentSessionMock.mockImplementationOnce(() => new Promise<void>((resolve) => { prepared = resolve; }));
    } else {
      postCompactMock.mockImplementationOnce(() => new Promise<void>((resolve) => { prepared = resolve; }));
    }
    const { container, frame } = await openMessageApp(preparation === "compact" ? 320000 : 0);
    const panel = await expandApp(container, frame);
    initializeApp(panel);
    const replies = vi.spyOn(panel.contentWindow!, "postMessage");
    appMessage(panel, { jsonrpc: "2.0", id: "late-guard", method: "ui/message", params: { role: "user", content: [{ type: "text", text: "Selection before impersonation" }] } });
    await waitFor(() => expect(prepared).toBeTypeOf("function"));
    setImpersonationStatus({ active: true, admin: { id: "admin" }, target: { id: "viewer", name: "Viewer", email: null } });
    prepared();
    await waitFor(() => expect(replies).toHaveBeenCalledWith(expect.objectContaining({ id: "late-guard", error: expect.objectContaining({ code: -32000 }) }), "https://apps.test"));
    expect(streamMessageMock).not.toHaveBeenCalled();
    expect(container.querySelector(".messages")?.textContent).not.toContain("Selection before impersonation");
  });

  it.each(["restore", "compact"])("refuses a newly busy interrupt agent after a view awaits %s", async (preparation) => {
    routeState.session = "session-main";
    fetchAgentMock.mockResolvedValue({ id: "agent-1", name: "Agent", queueMode: "interrupt" });
    let subscription!: SubscriptionCallbacks;
    subscribeToSessionMock.mockImplementation((_agent, _key, callbacks) => { subscription = callbacks; return () => {}; });
    let prepared!: () => void;
    if (preparation === "restore") {
      fetchAgentSessionsMock.mockResolvedValue({ items: [{ agentId: "agent-1", sessionId: "session-main", archived: 1 }] });
      archiveAgentSessionMock.mockImplementationOnce(() => new Promise<void>((resolve) => { prepared = resolve; }));
    } else {
      postCompactMock.mockImplementationOnce(() => new Promise<void>((resolve) => { prepared = resolve; }));
    }
    const { container, frame } = await openMessageApp(preparation === "compact" ? 320000 : 0);
    const panel = await expandApp(container, frame);
    initializeApp(panel);
    const replies = vi.spyOn(panel.contentWindow!, "postMessage");
    appMessage(panel, { jsonrpc: "2.0", id: "late-busy", method: "ui/message", params: { role: "user", content: [{ type: "text", text: "Selection before another run" }] } });
    await waitFor(() => expect(prepared).toBeTypeOf("function"));
    subscription.onText?.("Background run continues");
    const history = await fetchFullHistoryMock.mock.results[0].value;
    fetchFullHistoryMock.mockResolvedValue({ ...history, isStreaming: true, activeTurn: { userText: "Background question", userTimestamp: 3, text: "Background run continues", blocks: [] } });
    prepared();
    await waitFor(() => expect(replies).toHaveBeenCalledWith(expect.objectContaining({ id: "late-busy", error: expect.objectContaining({ code: -32000 }) }), "https://apps.test"));
    expect(streamMessageMock).not.toHaveBeenCalled();
    expect(postAbortMock).not.toHaveBeenCalled();
    expect(container.querySelector(".messages")?.textContent).not.toContain("Selection before another run");
  });

  it.each(["restore", "compact"])("rejects an MCP App send when %s is blocked and releases preparation", async (preparation) => {
    routeState.session = "session-main";
    if (preparation === "restore") {
      fetchAgentSessionsMock.mockResolvedValue({ items: [{ agentId: "agent-1", sessionId: "session-main", archived: 1 }] });
      archiveAgentSessionMock.mockRejectedValueOnce(new Error("Restore unavailable"));
    } else {
      postCompactMock.mockRejectedValueOnce(new Error("Compaction unavailable"));
    }
    const { container, frame } = await openMessageApp(preparation === "compact" ? 320000 : 0);
    const panel = await expandApp(container, frame);
    initializeApp(panel);
    const replies = vi.spyOn(panel.contentWindow!, "postMessage");
    appMessage(panel, { jsonrpc: "2.0", id: "blocked", method: "ui/message", params: { role: "user", content: [{ type: "text", text: "Blocked selection" }] } });
    await waitFor(() => expect(replies).toHaveBeenCalledWith(expect.objectContaining({ id: "blocked", error: expect.objectContaining({ code: -32000 }) }), "https://apps.test"));
    expect(streamMessageMock).not.toHaveBeenCalled();
    expect(container.querySelector(".messages")?.textContent).not.toContain("Blocked selection");
    const input = container.querySelector("textarea")!;
    input.value = "Composer retry";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    container.querySelector<HTMLButtonElement>(".send-btn")!.click();
    await waitFor(() => expect(streamMessageMock).toHaveBeenCalledTimes(1));
    expect(streamMessageMock.mock.calls[0][1]).toBe("Composer retry");
  });

  it("keeps a finished assistant response visible when the view sends again", async () => {
    routeState.view = "full";
    const { container, send } = await openMessageApp();
    const input = container.querySelector("textarea")!;
    input.value = "First question";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    container.querySelector<HTMLButtonElement>(".send-btn")!.click();
    const first = streamMessageMock.mock.calls[0];
    first[3]("Finished assistant response");
    first[4]();
    send("Next selection");
    await waitFor(() => expect(streamMessageMock).toHaveBeenCalledTimes(2));
    expect(container.querySelector(".messages")?.textContent).toContain("Finished assistant response");
  });

  it("acknowledges a local view send and shows later transport errors in chat", async () => {
    const { container, replies, send } = await openMessageApp();
    send("Transport selection");
    await waitFor(() => expect(replies).toHaveBeenCalledWith({ jsonrpc: "2.0", id: "view-message", result: {} }, "https://apps.test"));
    streamMessageMock.mock.calls[0][5]("Transport disconnected");
    expect(container.querySelector(".messages")?.textContent).toContain("Transport disconnected");
  });

  async function expandApp(container: HTMLElement, frame: HTMLIFrameElement) {
    const previousPanelFrame = queryByRole(container, "tabpanel") && queryByTitle(queryByRole(container, "tabpanel")!, frame.title);
    initializeApp(frame);
    queryByRole(frame.closest(".mcp-app-view")!, "button", { name: "Expand" })!.click();
    appMessage(frame, { jsonrpc: "2.0", id: "yoplai-resource-teardown", result: {} });
    await waitFor(() => {
      const panel = queryByRole(container, "complementary");
      expect(panel).not.toBeNull();
      const active = queryByRole(panel!, "tabpanel")!;
      expect(queryByTitle(active, frame.title)).not.toBeNull();
      expect(queryByTitle(active, frame.title)).not.toBe(previousPanelFrame);
    });
    return queryByTitle(queryByRole(container, "tabpanel")!, frame.title) as HTMLIFrameElement;
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

  it.each(["simple", "full"])("shows a marked MCP App row as soon as the call starts in %s mode", async (mode) => {
    routeState.view = mode;
    const { container, dispose, callbacks } = await startFullStream();
    callbacks()?.onToolCall?.("app-a", "fixture_draw", { title: "Sketch" }, undefined,
      { server: "fixture", tool: "draw", resourceUri: "ui://fixture/view.html" });
    await tick();
    expect(container.textContent).toContain("Loading view…");
    const row = container.querySelector("#mcp-app-app-a");
    expect(row).not.toBeNull();
    expect(row?.closest(".activity-group")).toBeNull();
    dispose();
  });

  // ALG-615's current prompt explicitly specifies the rendered ChatView seam
  // with real transcript/state/panel/host and public stream/HTTP adapters.
  it.each(["simple", "full"])("hides an outbound file card only after its %s view delivers the file", async (mode) => {
    enableAppViews();
    routeState.view = mode;
    const { container, dispose, callbacks } = await startFullStream();
    const marker = { server: "yoplai", tool: "send_file", resourceUri: "ui://yoplai/file-viewer" };
    const file = { fileId: "report-v1", filename: "a.md", mimeType: "text/markdown", size: 957, title: "Report" };
    callbacks()?.onToolCall?.("report-call", "send_file", { path: "a.md" }, undefined, marker);
    callbacks()?.onFileOutput?.(file);
    callbacks()?.onToolResult?.("report-call", "send_file", "File sent to user", false, undefined, undefined, { ...marker, recordId: "report-record", file });
    await waitFor(() => expect(queryByTitle(container, "Report file view")).not.toBeNull());
    expect(queryByText(container, "a.md", { exact: true })).not.toBeNull();
    const frame = queryByTitle(container, "Report file view") as HTMLIFrameElement;
    initializeApp(frame);
    expect(queryByText(container, "a.md", { exact: true })).toBeNull();
    const download = queryByRole(container, "link", { name: "Download" });
    expect(download?.getAttribute("href")).toBe("/api/media/download/report-v1");
    dispose();
  });

  it.each(["no apps origin", "unavailable", "load error", "capture failed"])("keeps the outbound image card when its view has %s", async (failure) => {
    enableAppViews();
    if (failure === "no apps origin") {
      setCapabilitiesForTests({ apps: { available: false } });
      fetchCapabilitiesMock.mockResolvedValue({ version: 2, extensions: {}, agents: [], apps: { available: false } });
    } else if (failure === "unavailable") loadMcpAppViewMock.mockResolvedValueOnce({ available: false });
    else if (failure === "load error") loadMcpAppViewMock.mockRejectedValueOnce(new Error("View fetch failed"));
    const { container, dispose, callbacks } = await startFullStream();
    const marker = { server: "yoplai", tool: "send_file", resourceUri: "ui://yoplai/file-viewer" };
    const file = { fileId: "diagram-file", filename: "diagram.png", mimeType: "image/png", size: 68 };
    callbacks()?.onToolCall?.("diagram-call", "send_file", { path: "diagram.png" }, undefined, marker);
    callbacks()?.onFileOutput?.(file);
    callbacks()?.onToolResult?.("diagram-call", "send_file", "File sent to user", false, undefined, undefined,
      failure === "capture failed" ? undefined : { ...marker, recordId: "diagram-record", file });
    await waitFor(() => expect(queryByText(container, "View unavailable")).not.toBeNull());
    expect(queryByRole(container, "button", { name: "Open diagram.png" })).not.toBeNull();
    expect(queryByText(container, "diagram.png", { exact: true })).not.toBeNull();
    expect(queryByRole(container, "link", { name: "Download" })?.getAttribute("href")).toBe("/api/media/download/diagram-file");
    dispose();
  });

  it.each(["simple", "full"])("replays %s history cards until delivery while retaining uploaded files", async (mode) => {
    enableAppViews();
    routeState.view = mode;
    const marker = { server: "yoplai", tool: "send_file", resourceUri: "ui://yoplai/file-viewer" };
    const file = { fileId: "saved-report", filename: "a.md", mimeType: "text/markdown", size: 957, title: "Saved report" };
    fetchFullHistoryMock.mockResolvedValue({ sessionId: "session-main", messages: [
      { role: "user", timestamp: 1, content: [{ type: "text", text: "Read my upload" }, { ...file, filename: "upload.md", type: "file", direction: "inbound" }] },
      { role: "assistant", timestamp: 2, content: [{ type: "toolCall", id: "saved-call", name: "send_file", arguments: { path: "a.md" }, viewCall: true, view: marker }] },
      { role: "toolResult", timestamp: 3, toolCallId: "saved-call", toolName: "send_file", content: [{ type: "text", text: "File sent to user" }], view: { ...marker, recordId: "saved-record", file } },
      { role: "assistant", timestamp: 4, content: [{ ...file, type: "file", direction: "outbound" }] },
    ] });
    const { container, dispose } = renderView();
    await waitFor(() => expect(queryByTitle(container, "Saved report file view")).not.toBeNull());
    expect(queryByText(container, "a.md", { exact: true })).not.toBeNull();
    expect(queryByText(container, "upload.md", { exact: true })).not.toBeNull();
    initializeApp(queryByTitle(container, "Saved report file view") as HTMLIFrameElement);
    expect(queryByText(container, "a.md", { exact: true })).toBeNull();
    expect(queryByText(container, "upload.md", { exact: true })).not.toBeNull();
    expect(queryAllByRole(container, "link", { name: "Download" })).toHaveLength(1);
    dispose();
  });

  it.each(["simple", "full"])("keeps two filenames in separate %s views and restores the superseded version's card", async (mode) => {
    enableAppViews();
    routeState.view = mode;
    const { container, dispose, callbacks } = await startFullStream();
    sendViewFile(callbacks(), "a-first", { fileId: "a-v1", filename: "a.md", mimeType: "text/markdown", size: 957, title: "Report A" });
    sendViewFile(callbacks(), "b-first", { fileId: "b-v1", filename: "b.md", mimeType: "text/markdown", size: 80, title: "Report B" });
    await waitFor(() => expect(queryByTitle(container, "Report B file view")).not.toBeNull());
    const frameA = queryByTitle(container, "Report A file view") as HTMLIFrameElement;
    const frameB = queryByTitle(container, "Report B file view") as HTMLIFrameElement;
    initializeApp(frameA);
    initializeApp(frameB);
    expect(queryByText(container, "a.md", { exact: true })).toBeNull();
    expect(queryByText(container, "b.md", { exact: true })).toBeNull();
    sendViewFile(callbacks(), "a-second", { fileId: "a-v2", filename: "a.md", mimeType: "text/markdown", size: 2048, title: "Revised report A" });
    // The new host starts at the shown v1, then updates in place to v2.
    await waitFor(() => expect(queryByTitle(container, "Report A file view")).not.toBe(frameA));
    const movedA = queryByTitle(container, "Report A file view") as HTMLIFrameElement;
    expect(movedA).not.toBeNull();
    expect(frameA.isConnected).toBe(false);
    expect(frameB.isConnected).toBe(true);
    expect(queryByRole(container, "button", { name: "Revised report A updated. Click to see it" })).not.toBeNull();
    expect(queryByText(container, "b.md", { exact: true })).toBeNull();
    expect(loadMcpAppViewMock).toHaveBeenCalledTimes(3);
    expect(loadMcpAppViewMock.mock.calls[2].slice(0, 3)).toEqual(["agent-1", "session-main", "a-first"]);
    // Once the view delivers its file, the superseded v1 card comes back.
    initializeApp(movedA);
    await waitFor(() => expect(loadMcpAppDataMock).toHaveBeenCalledTimes(1));
    expect(queryByText(container, "a.md", { exact: true })).not.toBeNull();
    expect(queryByText(container, "text/markdown · 957 B", { exact: true })).not.toBeNull();
    expect(queryByText(container, "text/markdown · 2.0 KB", { exact: true })).toBeNull();
    expect(queryAllByRole(container, "link", { name: "Download" }).map((link) => link.getAttribute("href")).sort()).toEqual([
      "/api/media/download/a-v1", "/api/media/download/a-v2", "/api/media/download/b-v1",
    ]);
    dispose();
  });

  it.each(["failed", "hung"])("keeps v1 shown and v2 downloadable after a %s update while chat progresses", async (outcome) => {
    enableAppViews();
    const { container, dispose, callbacks, onText } = await startFullStream();
    sendViewFile(callbacks(), "first-version", { fileId: "version-one", filename: "report.md", mimeType: "text/markdown", size: 957, title: "Version one" });
    await waitFor(() => expect(queryByTitle(container, "Version one file view")).not.toBeNull());
    const frame = queryByTitle(container, "Version one file view") as HTMLIFrameElement;
    initializeApp(frame);
    if (outcome === "failed") loadMcpAppDataMock.mockRejectedValueOnce(new Error("Update fetch failed"));
    else loadMcpAppDataMock.mockImplementationOnce(() => new Promise(() => {}));
    sendViewFile(callbacks(), "second-version", { fileId: "version-two", filename: "report.md", mimeType: "text/markdown", size: 2048, title: "Version two" });
    // The view moves to the newest row, starts at v1, then tries the update in place.
    await waitFor(() => expect(queryByTitle(container, "Version one file view")).not.toBe(frame));
    const moved = queryByTitle(container, "Version one file view") as HTMLIFrameElement;
    expect(frame.isConnected).toBe(false);
    initializeApp(moved);
    await waitFor(() => expect(loadMcpAppDataMock).toHaveBeenCalledTimes(1));
    await tick();
    expect(queryByTitle(container, "Version one file view")).toBe(moved);
    expect(queryByTitle(container, "Version one")).not.toBeNull();
    expect(queryByText(container, "MD · 957 B", { exact: true })).not.toBeNull();
    expect(queryByTitle(container, "Version two")).toBeNull();
    expect(queryByText(container, "report.md", { exact: true })).not.toBeNull();
    expect(queryAllByRole(container, "link", { name: "Download" }).map((link) => link.getAttribute("href")).sort()).toEqual([
      "/api/media/download/version-one", "/api/media/download/version-two",
    ]);
    onText("Chat continues after the update");
    expect(queryByText(container, "Chat continues after the update")).not.toBeNull();
    expect(queryByRole(container, "button", { name: "Stop agent" })).not.toBeNull();
    dispose();
  });

  it.each(["simple", "full"])("preserves the %s file header and hidden card through Expand and Collapse remounts", async (mode) => {
    enableAppViews();
    routeState.view = mode;
    const { container, dispose, callbacks } = await startFullStream();
    sendViewFile(callbacks(), "expand-file", { fileId: "expand-report", filename: "report.md", mimeType: "text/markdown", size: 957, title: "Report" });
    await waitFor(() => expect(queryByTitle(container, "Report file view")).not.toBeNull());
    const inline = queryByTitle(container, "Report file view") as HTMLIFrameElement;
    initializeApp(inline);
    queryByRole(container, "button", { name: "Expand" })!.click();
    expect(queryByText(container, "report.md", { exact: true })).toBeNull();
    appMessage(inline, { jsonrpc: "2.0", id: "yoplai-resource-teardown", result: {} });
    await waitFor(() => expect(queryByRole(container, "complementary")).not.toBeNull());
    const panel = queryByRole(container, "complementary")!;
    expect(queryByText(container, "Report · shown in the side panel", { exact: true })).not.toBeNull();
    expect(queryByText(container, "report.md", { exact: true })).toBeNull();
    expect(queryByTitle(panel, "Report")).not.toBeNull();
    expect(queryByRole(panel, "link", { name: "Download" })?.getAttribute("href")).toBe("/api/media/download/expand-report");
    await waitFor(() => expect(queryByTitle(panel, "Report file view")).not.toBeNull());
    const expanded = queryByTitle(panel, "Report file view") as HTMLIFrameElement;
    expect(expanded).not.toBe(inline);
    initializeApp(expanded);
    queryByRole(panel, "button", { name: "Collapse" })!.click();
    expect(queryByText(container, "report.md", { exact: true })).toBeNull();
    appMessage(expanded, { jsonrpc: "2.0", id: "yoplai-resource-teardown", result: {} });
    await waitFor(() => expect(queryByRole(container, "complementary")).toBeNull());
    await waitFor(() => expect(queryByTitle(container, "Report file view")).not.toBeNull());
    expect(queryByText(container, "report.md", { exact: true })).toBeNull();
    expect(queryByRole(container, "link", { name: "Download" })?.getAttribute("href")).toBe("/api/media/download/expand-report");
    dispose();
  });

  it.each(["pagehide", "relay failure"])("restores a shown file's image card after %s", async (failure) => {
    enableAppViews();
    const { container, dispose, callbacks } = await startFullStream();
    sendViewFile(callbacks(), "restore-file", { fileId: "restored-diagram", filename: "diagram.png", mimeType: "image/png", size: 68, title: "Diagram" });
    await waitFor(() => expect(queryByTitle(container, "Diagram file view")).not.toBeNull());
    const frame = queryByTitle(container, "Diagram file view") as HTMLIFrameElement;
    initializeApp(frame);
    expect(queryByRole(container, "button", { name: "Open diagram.png" })).toBeNull();
    if (failure === "pagehide") window.dispatchEvent(new Event("pagehide"));
    else {
      relayMcpAppRequestMock.mockRejectedValueOnce(new Error("Read failed"));
      appMessage(frame, { jsonrpc: "2.0", id: "read-file", method: "resources/read", params: { uri: "yoplai-file://restored-diagram" } });
    }
    await waitFor(() => expect(queryByText(container, "View unavailable")).not.toBeNull());
    expect(queryByRole(container, "button", { name: "Open diagram.png" })).not.toBeNull();
    expect(queryByText(container, "diagram.png", { exact: true })).not.toBeNull();
    expect(queryByRole(container, "link", { name: "Download" })?.getAttribute("href")).toBe("/api/media/download/restored-diagram");
    dispose();
  });

  it("expands a view beside the chat and leaves its host row as a panel card", async () => {
    setCapabilitiesForTests({ apps: { available: true } });
    fetchCapabilitiesMock.mockResolvedValue({ version: 2, extensions: {}, agents: [], apps: { available: true } });
    const { container, dispose, callbacks } = await startFullStream();
    expect(queryByRole(container, "complementary")).toBeNull();
    const marker = { server: "fixture", tool: "draw", resourceUri: "ui://fixture/view.html" };
    callbacks()?.onToolCall?.("panel-a", "fixture_draw", {}, undefined, marker);
    callbacks()?.onToolResult?.("panel-a", "fixture_draw", "Saved drawing", false, undefined, undefined, { ...marker, recordId: "panel-record" });
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    const frame = container.querySelector("iframe")!;
    const send = (message: unknown) => window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow, origin: "https://apps.test", data: message }));
    send({ jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready" });
    send({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: {} });
    send({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
    queryByRole(container, "button", { name: "Expand" })!.click();
    send({ jsonrpc: "2.0", id: "yoplai-resource-teardown", result: {} });
    await waitFor(() => expect(queryByRole(container, "complementary")?.querySelector("iframe")).not.toBeNull());
    expect(container.querySelector(".chat-main textarea")).not.toBeNull();
    expect(container.textContent).toContain("fixture · shown in the side panel");
    expect(container.querySelectorAll("iframe")).toHaveLength(1);
    expect(queryByRole(container, "complementary")!.querySelector("iframe")).not.toBeNull();
    dispose();
  });

  it("keeps a later pending call associated with its view when the turn becomes history", async () => {
    setCapabilitiesForTests({ apps: { available: true } });
    fetchCapabilitiesMock.mockResolvedValue({ version: 2, extensions: {}, agents: [], apps: { available: true } });
    const { container, dispose, callbacks, onDone } = await startFullStream();
    const marker = { server: "fixture", tool: "draw", resourceUri: "ui://fixture/view.html" };
    callbacks()?.onToolCall?.("first", "fixture_draw", {}, undefined, marker);
    callbacks()?.onToolResult?.("first", "fixture_draw", "Drawing", false, undefined, undefined, { ...marker, recordId: "first-record" });
    callbacks()?.onToolCall?.("pending", "fixture_draw", {}, undefined, marker);
    expect(container.textContent).toContain("Updating view…");
    onDone();
    await tick();
    expect(container.textContent).toContain("Updating view…");
    expect(container.querySelectorAll("iframe")).toHaveLength(1);
    dispose();
  });

  // Thinh approved rendered ChatView with real transcript/state/panel/host in
  // ALG-599 comment f0b31b16-5802-41d7-aa24-72d7e959dd59. These tests observe
  // rows, wire delivery and frame lifetime; real browser geometry is covered E2E.
  it("keeps the panel frame connected through completion, reconnect and simple/full history reloads", async () => {
    enableAppViews();
    const { container, dispose, callbacks, onDone } = await startFullStream();
    const marker = { server: "fixture", tool: "draw", resourceUri: "ui://fixture/view.html" };
    callbacks()?.onToolCall?.("persistent-app", "fixture_draw", {}, undefined, marker);
    callbacks()?.onToolResult?.("persistent-app", "fixture_draw", "Saved drawing", false, undefined, undefined, { ...marker, recordId: "persistent-record" });
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    const panelFrame = await expandApp(container, container.querySelector("iframe")!);
    initializeApp(panelFrame);
    const viewLoads = loadMcpAppViewMock.mock.calls.length;
    onDone();
    await tick();
    expect(panelFrame.isConnected).toBe(true);
    const history: FullHistoryMessage[] = [
      { role: "user", timestamp: 1, content: [{ type: "text", text: "Reloaded request" }] },
      { role: "assistant", timestamp: 2, content: [{ type: "toolCall", id: "persistent-app", name: "fixture_draw", arguments: {} }] },
      { role: "toolResult", timestamp: 3, toolCallId: "persistent-app", toolName: "fixture_draw", content: [{ type: "text", text: "Saved drawing" }], isError: false, view: { ...marker, recordId: "persistent-record" } },
    ];
    fetchFullHistoryMock.mockResolvedValue({ messages: history, sessionId: "session-main", isStreaming: false, activeTurn: null });
    const reconnect = subscribeToRealtimeMock.mock.calls.map(([options]) => options).find((options) => options.onReconnect)?.onReconnect;
    expect(reconnect).toBeTypeOf("function");
    reconnect();
    await waitFor(() => expect(container.textContent).toContain("Reloaded request"));
    expect(panelFrame.isConnected).toBe(true);
    const beforeFull = fetchFullHistoryMock.mock.calls.length;
    queryByRole(container, "button", { name: "Full" })!.click();
    expect(navigateMock).toHaveBeenLastCalledWith("/chat/agent-1/full", { replace: true });
    routeState.view = "full";
    setRouteVersion((version) => version + 1);
    await waitFor(() => expect(fetchFullHistoryMock.mock.calls.length).toBeGreaterThan(beforeFull));
    await tick();
    expect(panelFrame.isConnected).toBe(true);
    const beforeSimple = fetchFullHistoryMock.mock.calls.length;
    queryByRole(container, "button", { name: "Simple" })!.click();
    expect(navigateMock).toHaveBeenLastCalledWith("/chat/agent-1", { replace: true });
    routeState.view = undefined;
    setRouteVersion((version) => version + 1);
    await waitFor(() => expect(fetchFullHistoryMock.mock.calls.length).toBeGreaterThan(beforeSimple));
    await tick();
    expect(panelFrame.isConnected).toBe(true);
    expect(queryByRole(container, "complementary")!.querySelector("iframe")).toBe(panelFrame);
    expect(container.querySelectorAll("iframe")).toHaveLength(1);
    expect(loadMcpAppViewMock).toHaveBeenCalledTimes(viewLoads);
    dispose();
  });

  it("adds a panel tab when the user expands a different app", async () => {
    enableAppViews();
    loadMcpAppViewMock.mockImplementation(async (_agent, _session, callId) => ({
      available: true, sandboxUrl: "https://apps.test/sandbox", appsOrigin: "https://apps.test", server: callId,
      toolName: "draw", args: {}, result: { content: [] }, csp: {}, prefersBorder: true,
    }));
    const { container, dispose, callbacks } = await startFullStream();
    for (const id of ["a", "b"]) {
      const marker = { server: "fixture", tool: `draw_${id}`, resourceUri: `ui://fixture/${id}.html` };
      callbacks()?.onToolCall?.(`app-${id}`, `fixture_draw_${id}`, {}, undefined, marker);
      callbacks()?.onToolResult?.(`app-${id}`, `fixture_draw_${id}`, `Drawing ${id}`, false, undefined, undefined, { ...marker, recordId: `record-${id}` });
    }
    await waitFor(() => expect(queryByTitle(container, "app-b MCP App")).not.toBeNull());
    const firstInline = queryByTitle(container, "app-a MCP App") as HTMLIFrameElement;
    const panelA = await expandApp(container, firstInline);
    const secondInline = queryByTitle(container, "app-b MCP App") as HTMLIFrameElement;
    const panelB = await expandApp(container, secondInline);
    expect(panelB).not.toBe(panelA);
    expect(panelA.isConnected).toBe(true);
    expect(panelB.isConnected).toBe(true);
    const panel = queryByRole(container, "complementary")!;
    expect(queryAllByRole(panel, "tabpanel", { hidden: true })).toHaveLength(2);
    expect(queryByTitle(panel, "app-a MCP App")).toBe(panelA);
    expect(queryByTitle(panel, "app-b MCP App")).toBe(panelB);
    dispose();
  });

  it("moves the iframe to the later call and links the earlier row", async () => {
    enableAppViews();
    const { container, dispose, callbacks } = await startFullStream();
    const marker = { server: "fixture", tool: "draw", resourceUri: "ui://fixture/view.html" };
    callbacks()?.onToolCall?.("first", "fixture_draw", {}, undefined, marker);
    callbacks()?.onToolResult?.("first", "fixture_draw", "Initial drawing", false, undefined, undefined, { ...marker, recordId: "first-record" });
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    const frame = container.querySelector("iframe")!;
    initializeApp(frame);
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    callbacks()?.onToolCall?.("second", "fixture_draw", { shape: "box" }, undefined, marker);
    expect(container.textContent).toContain("Updating view…");
    callbacks()?.onToolResult?.("second", "fixture_draw", "Box added", false, undefined, undefined, { ...marker, recordId: "second-record" });
    await waitFor(() => expect(loadMcpAppViewMock).toHaveBeenCalledTimes(2));
    await tick();
    expect(frame.isConnected).toBe(false);
    expect(container.querySelectorAll("iframe")).toHaveLength(1);
    // The moved host starts at the shown call, then updates in place to the latest.
    expect(loadMcpAppViewMock.mock.calls[1].slice(0, 3)).toEqual(["agent-1", "session-main", "first"]);
    expect(post.mock.calls.some(([message]) => message.method !== "ui/resource-teardown")).toBe(false);
    const moved = container.querySelector("iframe")!;
    expect(moved).not.toBe(frame);
    initializeApp(moved);
    await waitFor(() => expect(loadMcpAppDataMock).toHaveBeenCalledTimes(1));
    expect(loadMcpAppDataMock.mock.calls[0].slice(0, 3)).toEqual(["agent-1", "session-main", "second"]);
    expect(loadMcpAppViewMock).toHaveBeenCalledTimes(2);
    queryByRole(container, "button", { name: "fixture updated. Click to see it" })!.click();
    expect(document.activeElement).toBe(moved.closest(".mcp-app-tool-row"));
    post.mockRestore();
    dispose();
  });

  it("disables the updated link while the side panel shows that view", async () => {
    enableAppViews();
    const { container, dispose, callbacks } = await startFullStream();
    const marker = { server: "fixture", tool: "draw", resourceUri: "ui://fixture/view.html" };
    for (const id of ["first", "second"]) {
      callbacks()?.onToolCall?.(id, "fixture_draw", {}, undefined, marker);
      callbacks()?.onToolResult?.(id, "fixture_draw", `Drawing ${id}`, false, undefined, undefined, { ...marker, recordId: `${id}-record` });
    }
    await waitFor(() => expect(container.querySelectorAll("iframe")).toHaveLength(1));
    const link = () => queryByRole(container, "button", { name: /updated\. (Click to see it|Displayed in side panel)$/ }) as HTMLButtonElement;
    expect(link().textContent).toMatch(/updated\. Click to see it$/);
    expect(link().disabled).toBe(false);
    const panelFrame = await expandApp(container, container.querySelector("iframe")!);
    await waitFor(() => expect(link().disabled).toBe(true));
    expect(link().textContent).toMatch(/updated\. Displayed in side panel$/);
    initializeApp(panelFrame);
    queryByRole(queryByRole(container, "complementary")!, "button", { name: "Collapse" })!.click();
    appMessage(panelFrame, { jsonrpc: "2.0", id: "yoplai-resource-teardown", result: {} });
    await waitFor(() => expect(queryByRole(container, "complementary")).toBeNull());
    expect(link().disabled).toBe(false);
    expect(link().textContent).toMatch(/updated\. Click to see it$/);
    dispose();
  });

  it("closes the panel when navigating to another agent with the same raw session id", async () => {
    enableAppViews();
    routeState.session = "shared-session";
    const marker = { server: "fixture", tool: "draw", resourceUri: "ui://fixture/view.html" };
    fetchFullHistoryMock.mockResolvedValue({ sessionId: "shared-session", messages: [
      { role: "assistant", timestamp: 1, content: [{ type: "toolCall", id: "shared-call", name: "fixture_draw", arguments: {} }] },
      { role: "toolResult", timestamp: 2, toolCallId: "shared-call", toolName: "fixture_draw", content: [{ type: "text", text: "Drawing" }], view: { ...marker, recordId: "shared-record" } },
    ] });
    const { container, dispose } = renderView();
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    const panelFrame = await expandApp(container, container.querySelector("iframe")!);
    routeState.agentId = "agent-2";
    setRouteAgentVersion((version) => version + 1);
    await waitFor(() => expect(fetchAgentMock.mock.calls.some(([id]) => id === "agent-2")).toBe(true));
    await waitFor(() => expect(queryByRole(container, "complementary")).toBeNull());
    expect(panelFrame.isConnected).toBe(false);
    dispose();
  });

  it("updates the accessible resize range and overlays narrow chat areas or viewports", async () => {
    enableAppViews();
    const stylesheet = document.createElement("style");
    const fs = await import("node:fs/promises");
    stylesheet.textContent = await fs.readFile("apps/web/src/components/chat/ChatView.css", "utf8");
    document.head.appendChild(stylesheet);
    vi.stubGlobal("innerWidth", 1280);
    let availableWidth = 1200;
    const measurements = HTMLElement.prototype.getBoundingClientRect;
    const measure = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("chat-view") ? { width: availableWidth, right: availableWidth } as DOMRect : measurements.call(this);
    });
    const resizeCallbacks: ResizeObserverCallback[] = [];
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) { resizeCallbacks.push(callback); }
      observe() {}
      disconnect() {}
    });
    const { container, dispose, callbacks } = await startFullStream();
    try {
      const marker = { server: "fixture", tool: "draw", resourceUri: "ui://fixture/view.html" };
      callbacks()?.onToolCall?.("responsive-app", "fixture_draw", {}, undefined, marker);
      callbacks()?.onToolResult?.("responsive-app", "fixture_draw", "Drawing", false, undefined, undefined, { ...marker, recordId: "responsive-record" });
      await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
      await expandApp(container, container.querySelector("iframe")!);
      const panel = queryByRole(container, "complementary")!;
      const separator = queryByRole(panel, "separator", { name: "Resize app view" })!;
      expect(separator.getAttribute("aria-valuemax")).toBe("794");
      expect(separator.getAttribute("aria-valuenow")).toBe("597");
      expect(getComputedStyle(panel).position).toBe("relative");
      availableWidth = 1000;
      resizeCallbacks.forEach((callback) => callback([], {} as ResizeObserver));
      expect(separator.getAttribute("aria-valuemax")).toBe("594");
      separator.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
      expect(separator.getAttribute("aria-valuenow")).toBe("517");
      separator.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      expect(separator.getAttribute("aria-valuenow")).toBe("497");
      availableWidth = 700;
      resizeCallbacks.forEach((callback) => callback([], {} as ResizeObserver));
      expect(getComputedStyle(panel).position).toBe("fixed");
      expect(queryByRole(panel, "button", { name: "Collapse" })).not.toBeNull();
      availableWidth = 1200;
      vi.stubGlobal("innerWidth", 390);
      window.dispatchEvent(new Event("resize"));
      expect(getComputedStyle(panel).position).toBe("fixed");
      expect(queryByRole(panel, "button", { name: "Collapse" })).not.toBeNull();
    } finally { dispose(); measure.mockRestore(); stylesheet.remove(); }
  });

  it.each([
    ["simple", "captured"], ["full", "captured"], ["simple", "pending"], ["full", "pending"],
  ] as const)("deduplicates one call present in %s %s history and the active snapshot", async (mode, historyState) => {
    enableAppViews();
    routeState.view = mode;
    const marker = { server: "fixture", tool: "draw", resourceUri: "ui://fixture/view.html" };
    const view = { ...marker, recordId: "same-record" };
    fetchFullHistoryMock.mockResolvedValue({ sessionId: "session-main", isStreaming: true, messages: [
      { role: "assistant", timestamp: 1, content: [{ type: "toolCall", id: "same-call", name: "fixture_draw", arguments: {}, viewCall: true, view: marker }] },
      ...(historyState === "captured" ? [{ role: "toolResult", timestamp: 2, toolCallId: "same-call", toolName: "fixture_draw", content: [{ type: "text", text: "Drawing" }], view }] : []),
    ], activeTurn: {
      userText: "Draw", userTimestamp: 1, startedAt: 2, thinking: "", text: "",
      toolCalls: [{ id: "same-call", name: "fixture_draw", arguments: {}, status: "done", view: marker }],
      toolResults: [{ id: "same-call", name: "fixture_draw", content: "Drawing", isError: false, view }],
    } });
    const { container, dispose } = renderView();
    try {
      await waitFor(() => expect(container.querySelectorAll("iframe")).toHaveLength(1));
      expect(loadMcpAppViewMock).toHaveBeenCalledTimes(1);
      if (historyState === "pending") {
        await expandApp(container, container.querySelector("iframe")!);
        expect(container.textContent).toContain("fixture · shown in the side panel");
      }
    } finally { dispose(); }
  });

  it.each([false, true])("replays latest data once and paginates another app with panel open=%s", async (panelOpen) => {
    enableAppViews();
    const markerB = { server: "fixture", tool: "draw_b", resourceUri: "ui://fixture/b.html" };
    fetchFullHistoryMock.mockResolvedValueOnce({ sessionId: "session-main", nextCursor: "earlier", messages: [
      { role: "assistant", timestamp: 10, content: [{ type: "toolCall", id: "b-first", name: "fixture_draw_b", arguments: {} }] },
      { role: "toolResult", timestamp: 11, toolCallId: "b-first", toolName: "fixture_draw_b", content: [{ type: "text", text: "First drawing" }], view: { ...markerB, recordId: "b-first-record" } },
      { role: "assistant", timestamp: 12, content: [{ type: "toolCall", id: "b-latest", name: "fixture_draw_b", arguments: {} }] },
      { role: "toolResult", timestamp: 13, toolCallId: "b-latest", toolName: "fixture_draw_b", content: [{ type: "text", text: "Latest drawing" }], view: { ...markerB, recordId: "b-latest-record" } },
    ] });
    const { container, dispose } = renderView();
    try {
      await waitFor(() => expect(container.querySelectorAll("iframe")).toHaveLength(1));
      const initialFrame = container.querySelector("iframe")!;
      expect(loadMcpAppViewMock.mock.calls[0].slice(0, 3)).toEqual(["agent-1", "session-main", "b-latest"]);
      queryByRole(container, "button", { name: "fixture updated. Click to see it" })!.click();
      expect(document.activeElement).toBe(initialFrame.closest(".mcp-app-tool-row"));
      const panelFrame = panelOpen ? await expandApp(container, initialFrame) : undefined;
      const markerA = { server: "fixture", tool: "draw_a", resourceUri: "ui://fixture/a.html" };
      fetchFullHistoryMock.mockResolvedValueOnce({ sessionId: "session-main", messages: [
        { role: "assistant", timestamp: 1, content: [{ type: "toolCall", id: "a-older", name: "fixture_draw_a", arguments: {} }] },
        { role: "toolResult", timestamp: 2, toolCallId: "a-older", toolName: "fixture_draw_a", content: [{ type: "text", text: "Older app" }], view: { ...markerA, recordId: "a-older-record" } },
      ] });
      queryByRole(container, "button", { name: "Load earlier messages" })!.click();
      await waitFor(() => expect(container.querySelector("#mcp-app-a-older")).not.toBeNull());
      await waitFor(() => expect(container.querySelectorAll("iframe")).toHaveLength(2));
      const olderFrame = container.querySelector("#mcp-app-a-older")!.querySelector("iframe")!;
      expect(olderFrame).not.toBe(initialFrame);
      expect(olderFrame.isConnected).toBe(true);
      if (panelFrame) {
        expect(panelFrame.isConnected).toBe(true);
        expect(queryByRole(container, "complementary")!.querySelector("iframe")).toBe(panelFrame);
      } else expect(initialFrame.isConnected).toBe(false);
    } finally { dispose(); }
  });

  it.each(["session switch", "new chat"])("closes the panel on %s", async (action) => {
    enableAppViews();
    const { container, dispose, callbacks, onDone } = await startFullStream();
    try {
      const marker = { server: "fixture", tool: "draw", resourceUri: "ui://fixture/view.html" };
      callbacks()?.onToolCall?.("closing-app", "fixture_draw", {}, undefined, marker);
      callbacks()?.onToolResult?.("closing-app", "fixture_draw", "Drawing", false, undefined, undefined, { ...marker, recordId: "closing-record" });
      await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
      const panelFrame = await expandApp(container, container.querySelector("iframe")!);
      onDone();
      await tick();
      if (action === "new chat") queryByRole(container, "button", { name: "Start a new chat" })!.click();
      else {
        routeState.session = "other-session";
        setRouteVersion((version) => version + 1);
      }
      await waitFor(() => expect(queryByRole(container, "complementary")).toBeNull());
      expect(panelFrame.isConnected).toBe(false);
      expect(queryByRole(container, "textbox")).not.toBeNull();
    } finally { dispose(); }
  });

  it.each(["simple", "full"])("mounts a live MCP App result without its tool label in %s mode", async (mode) => {
    routeState.view = mode;
    fetchCapabilitiesMock.mockResolvedValue({ version: 2, extensions: {}, agents: [], apps: { available: true } });
    setCapabilitiesForTests({ apps: { available: true } });
    const { container, dispose, callbacks } = await startFullStream();
    const view = { server: "fixture", tool: "draw", resourceUri: "ui://fixture/view.html" };
    callbacks()?.onToolCall?.("app-a", "fixture_draw", { title: "Sketch" }, undefined, view);
    callbacks()?.onToolResult?.("app-a", "fixture_draw", "Drawn", false, undefined, undefined, { ...view, recordId: "record-a" });
    await waitFor(() => expect(container.querySelector('iframe[title="fixture MCP App"]')).not.toBeNull());
    const frame = container.querySelector('iframe[title="fixture MCP App"]')!;
    expect(frame.closest(".mcp-app-tool-row")).not.toBeNull();
    expect(queryByTitle(container, "fixture_draw")).toBeNull();
    expect(frame.closest(".activity-group")).toBeNull();
    expect(loadMcpAppViewMock.mock.calls[0]?.slice(0, 3)).toEqual(["agent-1", "session-main", "app-a"]);
    dispose();
  });

  it.each(["simple", "full"])("replays a historical MCP App outside collapsed activity in %s mode", async (mode) => {
    routeState.view = mode;
    fetchCapabilitiesMock.mockResolvedValue({ version: 2, extensions: {}, agents: [], apps: { available: true } });
    setCapabilitiesForTests({ apps: { available: true } });
    fetchFullHistoryMock.mockResolvedValue({ sessionId: "session-main", messages: [
      { role: "assistant", timestamp: 1, content: [
        { type: "toolCall", id: "ordinary", name: "bash", arguments: { command: "date" } },
        { type: "toolCall", id: "app-history", name: "fixture_draw", arguments: {} },
      ] },
      { role: "toolResult", timestamp: 2, toolCallId: "app-history", toolName: "fixture_draw", content: [{ type: "text", text: "Saved drawing" }],
        view: { server: "fixture", tool: "draw", resourceUri: "ui://fixture/view.html", recordId: "record-history" } },
    ] });
    const { container, dispose } = renderView();
    await waitFor(() => expect(container.querySelector('iframe[title="fixture MCP App"]')).not.toBeNull());
    const frame = container.querySelector('iframe[title="fixture MCP App"]')!;
    const activity = queryByRole(container, "button", { name: /Worked.*1 tool call/ })!;
    expect(activity).not.toBeNull();
    activity.click();
    activity.click();
    expect(frame.isConnected).toBe(true);
    expect(frame.closest(".activity-group")).toBeNull();
    expect(loadMcpAppViewMock.mock.calls[0]?.slice(0, 3)).toEqual(["agent-1", "session-main", "app-history"]);
    dispose();
  });

  it.each([
    ["simple", "success"], ["full", "success"], ["simple", "capture-failure"], ["full", "capture-failure"],
  ] as const)("keeps one live MCP App through out-of-order %s updates and %s", async (mode, earlierResult) => {
    routeState.view = mode;
    fetchCapabilitiesMock.mockResolvedValue({ version: 2, extensions: {}, agents: [], apps: { available: true } });
    setCapabilitiesForTests({ apps: { available: true } });
    const { container, dispose, callbacks, onText } = await startFullStream();
    const marker = { server: "fixture", tool: "draw", resourceUri: "ui://fixture/view.html" };
    callbacks()?.onToolCall?.("ordinary-parent", "codemode", {});
    callbacks()?.onToolCall?.("app-a", "fixture_draw", {}, undefined, marker);
    callbacks()?.onToolCall?.("app-b", "fixture_draw", {}, "ordinary-parent", marker);
    callbacks()?.onToolResult?.("app-b", "fixture_draw", "B drawing", false, undefined, "ordinary-parent", { ...marker, recordId: "record-b" });
    await waitFor(() => expect(container.querySelectorAll('iframe[title="fixture MCP App"]')).toHaveLength(1));
    const frameB = container.querySelector('iframe[title="fixture MCP App"]')!;
    let currentFrame = frameB;
    const expectCurrent = () => {
      expect(currentFrame.isConnected).toBe(true);
      expect(container.querySelectorAll('iframe[title="fixture MCP App"]')).toContain(currentFrame);
    };
    onText("Text keeps streaming");
    await tick(); expectCurrent();
    callbacks()?.onToolCall?.("later-ordinary", "bash", { command: "pwd" });
    await tick(); expectCurrent();
    callbacks()?.onToolResult?.("later-ordinary", "bash", "working directory", false, undefined, undefined, { ...marker, recordId: "not-marked" });
    await tick(); expectCurrent();
    expect(container.querySelectorAll('iframe[title="fixture MCP App"]')).toHaveLength(1);
    callbacks()?.onToolResult?.("app-a", "fixture_draw", earlierResult === "success" ? "A drawing" : "Capture failed", false,
      undefined, undefined, earlierResult === "success" ? { ...marker, recordId: "record-a" } : undefined);
    await tick();
    // B is still the newest successful call, so the late earlier result never moves or reloads the live view.
    if (earlierResult !== "success") expect(container.textContent).toContain("View unavailable");
    expectCurrent();
    expect(loadMcpAppViewMock).toHaveBeenCalledTimes(1);
    callbacks()?.onToolCall?.("app-c", "fixture_draw", {}, "app-b", marker);
    callbacks()?.onToolResult?.("app-c", "fixture_draw", "Nested drawing", false, undefined, "app-b", { ...marker, recordId: "record-c" });
    // The newer nested call C takes over the inline view; the app stays single and live.
    await waitFor(() => expect(frameB.isConnected).toBe(false));
    await waitFor(() => expect(container.querySelectorAll('iframe[title="fixture MCP App"]')).toHaveLength(1));
    currentFrame = container.querySelector('iframe[title="fixture MCP App"]')!;
    expect(currentFrame).not.toBe(frameB);
    expect(loadMcpAppViewMock.mock.calls.at(-1)?.slice(0, 3)).toEqual(["agent-1", "session-main", "app-c"]);
    await tick(); expectCurrent();
    const activity = queryAllByRole(container, "button", { name: /Worked.*1 tool call/ })[0];
    activity?.click();
    expectCurrent();
    dispose();
  });

  it.each(["simple", "full"])("keeps ordinary children visible when an MCP App splits their tool run in %s mode", async (mode) => {
    routeState.view = mode;
    const { container, dispose, callbacks } = await startFullStream();
    const marker = { server: "fixture", tool: "draw", resourceUri: "ui://fixture/view.html" };
    callbacks()?.onToolCall?.("parent", "ordinary_parent", {});
    callbacks()?.onToolCall?.("view-child", "fixture_draw", {}, "parent", marker);
    callbacks()?.onToolCall?.("ordinary-child", "ordinary_child", {}, "parent");
    callbacks()?.onToolCall?.("view-parent-child", "view_parent_child", {}, "view-child");
    await tick();
    const groups = queryAllByRole(container, "button", { name: /Working|Worked/ });
    expect(groups).toHaveLength(2);
    for (const toggle of queryAllByRole(container, "button", { name: /Calling tools|Called tools/ })) toggle.click();
    expect(container.querySelector('[title="ordinary_parent"]')).not.toBeNull();
    expect(container.querySelector('[title="ordinary_child"]')).not.toBeNull();
    expect(container.querySelector('[title="view_parent_child"]')).not.toBeNull();
    expect(container.textContent).toContain("Loading view…");
    dispose();
  });

  it.each(["simple", "full"])("hydrates and reconnects marked MCP App calls and results in %s mode", async (mode) => {
    routeState.view = mode;
    fetchCapabilitiesMock.mockResolvedValue({ version: 2, extensions: {}, agents: [], apps: { available: true } });
    setCapabilitiesForTests({ apps: { available: true } });
    let subscription: SubscriptionCallbacks | undefined;
    subscribeToSessionMock.mockImplementation((_agent, _key, callbacks) => { subscription = callbacks; return () => {}; });
    const marker = { server: "fixture", tool: "draw", resourceUri: "ui://fixture/view.html" };
    const activeTurn = {
      userText: "Draw", userTimestamp: 1, startedAt: 2, thinking: "", text: "",
      toolCalls: [{ id: "app-hydrated", name: "fixture_draw", arguments: {}, status: "done" as const, view: marker }],
      toolResults: [{ id: "app-hydrated", name: "fixture_draw", content: "Persisted drawing", isError: true, view: { ...marker, recordId: "record-hydrated" } }],
    };
    fetchFullHistoryMock.mockResolvedValue({ messages: [], sessionId: "session-main", isStreaming: true, activeTurn });
    const { container, dispose } = renderView();
    await waitFor(() => expect(container.querySelector('iframe[title="fixture MCP App"]')).not.toBeNull());
    expect(container.querySelector('iframe[title="fixture MCP App"]')?.closest(".activity-group")).toBeNull();
    subscription?.onActiveTurn?.({ ...activeTurn, text: "Reconnect text" });
    await tick();
    expect(container.textContent).toContain("Reconnect text");
    expect(container.querySelector('iframe[title="fixture MCP App"]')).not.toBeNull();
    expect(loadMcpAppViewMock.mock.calls.every((call) => call[2] === "app-hydrated")).toBe(true);
    dispose();
  });

  it("resolves a new chat session before mounting its live MCP App", async () => {
    fetchCapabilitiesMock.mockResolvedValue({ version: 2, extensions: {}, agents: [], apps: { available: true } });
    setCapabilitiesForTests({ apps: { available: true } });
    fetchFullHistoryMock.mockResolvedValueOnce({ messages: [] });
    const { container, dispose, callbacks } = await startFullStream();
    let resolveSession: ((value: { messages: never[]; sessionId: string }) => void) | undefined;
    fetchFullHistoryMock.mockImplementationOnce(() => new Promise((resolve) => { resolveSession = resolve; }));
    const marker = { server: "fixture", tool: "draw", resourceUri: "ui://fixture/view.html" };
    callbacks()?.onToolCall?.("first-app", "fixture_draw", {}, undefined, marker);
    callbacks()?.onToolResult?.("first-app", "fixture_draw", "First drawing", false, undefined, undefined, { ...marker, recordId: "first-record" });
    await tick();
    expect(container.textContent).toContain("Loading view…");
    expect(container.textContent).not.toContain("View unavailable");
    expect(resolveSession).toBeDefined();
    resolveSession!({ messages: [], sessionId: "fresh-session" });
    await waitFor(() => expect(container.querySelector('iframe[title="fixture MCP App"]')).not.toBeNull());
    expect(loadMcpAppViewMock.mock.calls[0]?.slice(0, 3)).toEqual(["agent-1", "fresh-session", "first-app"]);
    dispose();
  });

  it.each(["simple", "full"])("keeps fixed MCP App classification when the turn completes in %s mode", async (mode) => {
    routeState.view = mode;
    fetchCapabilitiesMock.mockResolvedValue({ version: 2, extensions: {}, agents: [], apps: { available: true } });
    setCapabilitiesForTests({ apps: { available: true } });
    const { container, dispose, callbacks, onText, onDone } = await startFullStream();
    const marker = { server: "fixture", tool: "draw", resourceUri: "ui://fixture/view.html" };
    callbacks()?.onToolCall?.("captured-failed", "fixture_draw", {}, undefined, marker);
    callbacks()?.onToolResult?.("captured-failed", "fixture_draw", "Capture failed text", true);
    callbacks()?.onToolCall?.("unmarked", "ordinary_tool", {});
    callbacks()?.onToolResult?.("unmarked", "ordinary_tool", "Unmarked text", false, undefined, undefined, { ...marker, recordId: "late-ref" });
    onText("Done");
    onDone();
    await tick();
    expect(container.textContent).toContain("Capture failed text");
    expect(container.textContent).toContain("View unavailable");
    expect(container.querySelector('iframe[title="fixture MCP App"]')).toBeNull();
    expect(loadMcpAppViewMock).not.toHaveBeenCalled();
    dispose();
  });

  it.each(["simple", "full"])("keeps MCP App markers and references in queued completion in %s mode", async (mode) => {
    routeState.view = mode;
    fetchCapabilitiesMock.mockResolvedValue({ version: 2, extensions: {}, agents: [], apps: { available: true } });
    setCapabilitiesForTests({ apps: { available: true } });
    const { container, dispose, callbacks, onText, onDone } = await startFullStream();
    onText("First turn");
    const input = queryByRole(container, "textbox") as HTMLTextAreaElement;
    input.value = "Queued draw";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await tick();
    const marker = { server: "fixture", tool: "draw", resourceUri: "ui://fixture/view.html" };
    callbacks()?.onToolCall?.("queued-app", "fixture_draw", {}, undefined, marker);
    callbacks()?.onToolResult?.("queued-app", "fixture_draw", "Queued drawing", false, undefined, undefined, { ...marker, recordId: "queued-record" });
    onText("Queued done");
    onDone();
    await waitFor(() => expect(container.querySelector('iframe[title="fixture MCP App"]')).not.toBeNull());
    expect(loadMcpAppViewMock.mock.calls[0]?.slice(0, 3)).toEqual(["agent-1", "session-main", "queued-app"]);
    dispose();
  });

  it.each(["simple", "full"])("attaches a late MCP App result after a queued message flushes the live call in %s mode", async (mode) => {
    routeState.view = mode;
    fetchCapabilitiesMock.mockResolvedValue({ version: 2, extensions: {}, agents: [], apps: { available: true } });
    setCapabilitiesForTests({ apps: { available: true } });
    const { container, dispose, callbacks } = await startFullStream();
    const firstCallbacks = callbacks();
    const marker = { server: "fixture", tool: "draw", resourceUri: "ui://fixture/view.html" };
    firstCallbacks?.onToolCall?.("late-app", "fixture_draw", {}, undefined, marker);
    const input = queryByRole(container, "textbox") as HTMLTextAreaElement;
    input.value = "Another request";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await tick();
    firstCallbacks?.onToolResult?.("late-app", "fixture_draw", "Late drawing", false, undefined, undefined, { ...marker, recordId: "late-record" });
    await waitFor(() => expect(container.querySelector('iframe[title="fixture MCP App"]')).not.toBeNull());
    expect(loadMcpAppViewMock.mock.calls[0]?.slice(0, 3)).toEqual(["agent-1", "session-main", "late-app"]);
    dispose();
  });

  it.each(["rejected", "missing", "hung"])("falls back from a %s MCP App session lookup without blocking the live chat", async (outcome) => {
    fetchCapabilitiesMock.mockResolvedValue({ version: 2, extensions: {}, agents: [], apps: { available: true } });
    setCapabilitiesForTests({ apps: { available: true } });
    fetchFullHistoryMock.mockResolvedValueOnce({ messages: [] });
    const { container, dispose, callbacks, onText } = await startFullStream();
    let lookupSignal: AbortSignal | undefined;
    fetchFullHistoryMock.mockImplementationOnce((_agent, _key, _id, _page, signal) => {
      lookupSignal = signal;
      if (outcome === "rejected") return Promise.reject(new Error("Offline"));
      if (outcome === "missing") return Promise.resolve({ messages: [] });
      return new Promise(() => {});
    });
    vi.useFakeTimers();
    try {
      const marker = { server: "fixture", tool: "draw", resourceUri: "ui://fixture/view.html" };
      callbacks()?.onToolCall?.("unresolved-app", "fixture_draw", {}, undefined, marker);
      callbacks()?.onToolResult?.("unresolved-app", "fixture_draw", "Usable text", false, undefined, undefined, { ...marker, recordId: "record-unresolved" });
      onText("Chat still progresses");
      queryByRole(container, "button", { name: "Stop agent" })!.click();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(container.textContent).toContain("Chat still progresses");
      expect(container.textContent).toContain("Usable text");
      expect(container.textContent).toContain("View unavailable");
      expect(postAbortMock).toHaveBeenCalled();
      expect(loadMcpAppViewMock).not.toHaveBeenCalled();
      if (outcome === "hung") expect(lookupSignal?.aborted).toBe(true);
    } finally { dispose(); vi.useRealTimers(); }
  });

  it.each([
    ["simple", "loading"], ["full", "loading"], ["simple", "disabled"], ["full", "disabled"],
    ["simple", "capture-failure"], ["full", "capture-failure"], ["simple", "unavailable-response"], ["full", "unavailable-response"],
    ["simple", "failed-request"], ["full", "failed-request"], ["simple", "same-hostname"], ["full", "same-hostname"],
    ["simple", "error-result"], ["full", "error-result"],
  ] as const)("handles MCP App %s row state %s", async (mode, state) => {
    routeState.view = mode;
    fetchCapabilitiesMock.mockResolvedValue({ version: 2, extensions: {}, agents: [], apps: { available: true } });
    setCapabilitiesForTests({ apps: { available: true } });
    const { container, dispose, callbacks } = await startFullStream();
    if (state === "loading") resetCapabilitiesForTests();
    if (state === "disabled") setCapabilitiesForTests({ apps: { available: false } });
    if (state === "unavailable-response") loadMcpAppViewMock.mockResolvedValueOnce({ available: false, reason: "resource gone" });
    if (state === "failed-request") loadMcpAppViewMock.mockRejectedValueOnce(new Error("offline"));
    if (state === "same-hostname") loadMcpAppViewMock.mockResolvedValueOnce({
      available: true, sandboxUrl: "https://apps.test/sandbox", appsOrigin: window.location.origin,
      server: "fixture", toolName: "draw", args: {}, result: {}, csp: {}, prefersBorder: false,
    });
    const marker = { server: "fixture", tool: "draw", resourceUri: "ui://fixture/view.html" };
    callbacks()?.onToolCall?.("state-app", "fixture_draw", {}, undefined, marker);
    callbacks()?.onToolResult?.("state-app", "fixture_draw", "Result text survives", state === "error-result", undefined, undefined,
      state === "capture-failure" ? undefined : { ...marker, recordId: "state-record" });
    await tick();
    if (state === "loading") {
      expect(container.textContent).toContain("Loading view…");
      expect(loadMcpAppViewMock).not.toHaveBeenCalled();
      setCapabilitiesForTests({ apps: { available: true } });
    }
    if (state === "loading" || state === "error-result") {
      await waitFor(() => expect(container.querySelector('iframe[title="fixture MCP App"]')).not.toBeNull());
    } else {
      await waitFor(() => expect(container.textContent).toContain("View unavailable"));
      expect(container.textContent).toContain("Result text survives");
      expect(container.querySelector("iframe")).toBeNull();
    }
    dispose();
  });

  it.each(["simple", "full"])("resolves the new session for an MCP App after New chat in %s mode", async (mode) => {
    routeState.view = mode;
    fetchCapabilitiesMock.mockResolvedValue({ version: 2, extensions: {}, agents: [], apps: { available: true } });
    setCapabilitiesForTests({ apps: { available: true } });
    const { container, dispose, callbacks, onText, onDone } = await startFullStream();
    onText("Prior conversation");
    onDone();
    await tick();
    queryByRole(container, "button", { name: "Start a new chat" })!.click();
    await tick();
    const input = queryByRole(container, "textbox") as HTMLTextAreaElement;
    input.value = "Draw in the fresh chat";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    queryByRole(container, "button", { name: "Send message" })!.click();
    await tick();
    fetchFullHistoryMock.mockResolvedValueOnce({ messages: [], sessionId: "session-fresh" });
    const marker = { server: "fixture", tool: "draw", resourceUri: "ui://fixture/view.html" };
    callbacks()?.onToolCall?.("fresh-app", "fixture_draw", {}, undefined, marker);
    callbacks()?.onToolResult?.("fresh-app", "fixture_draw", "Fresh drawing", false, undefined, undefined, { ...marker, recordId: "fresh-record" });
    await waitFor(() => expect(container.querySelector('iframe[title="fixture MCP App"]')).not.toBeNull());
    expect(loadMcpAppViewMock.mock.calls[0]?.slice(0, 3)).toEqual(["agent-1", "session-fresh", "fresh-app"]);
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
