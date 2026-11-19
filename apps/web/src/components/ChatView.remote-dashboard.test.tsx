// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, getByRole, getByTitle, queryByRole, queryByTitle, waitFor } from "@testing-library/dom";
import { Route, Router } from "@solidjs/router";
import { delegateEvents, render } from "solid-js/web";
import { ChatView } from "./ChatView";
import { resetCapabilitiesForTests, setCapabilitiesForTests } from "../lib/capabilities";

const api = vi.hoisted(() => ({
  fetchAgent: vi.fn(),
  fetchAgentSuggestions: vi.fn(),
  fetchAgentSessions: vi.fn(),
  fetchSimpleHistory: vi.fn(),
  fetchFullHistory: vi.fn(),
  getSessionKey: vi.fn(),
  startNewChat: vi.fn(),
  streamMessage: vi.fn(),
  subscribeToSession: vi.fn(),
  subscribeToRealtime: vi.fn(),
}));
vi.mock("../api", () => api);
vi.mock("../api/main-agent", () => ({
  fetchMainAgentPreference: vi.fn().mockResolvedValue({ mainAgentId: null, accessible: false, pickerDismissedAt: null }),
}));

const ID = "d".repeat(32);
const origin = window.location.origin;
const handleOf = (n: number) => String(n).padStart(43, "h");
const meta = { dashboardId: ID, agentId: "pom", canWrite: true, canEdit: true, chat: { sessionId: "sess-1" }, annotation: true };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let root: HTMLDivElement;
let dispose: (() => void) | undefined;
let prepareBodies: Array<Record<string, unknown>>;
let mcpAppPaths: string[];
let capturedExtra: Record<string, unknown>;

function mountChat() {
  dispose = render(() => <Router><Route path="/chat/:agentId/:view?" component={ChatView} /></Router>, root);
}
const shell = () => getByTitle(root, "Dashboard dashboard") as HTMLIFrameElement;
const fromShell = (event: string, extra: Record<string, unknown> = {}) =>
  window.dispatchEvent(new MessageEvent("message", { data: { channel: "yoplai-shell", instance: "instance-1", event, ...extra }, source: shell().contentWindow, origin }));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  prepareBodies = [];
  mcpAppPaths = [];
  capturedExtra = {};
  delegateEvents(["click", "input", "keydown"]);
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  setCapabilitiesForTests({ multiUser: false });
  api.fetchAgent.mockImplementation(async (id: string) => ({
    id, name: "Pom (remote)", ...(id === "pom@ams" ? { gateway: "ams" } : {}),
    model: { provider: "openai", model: "gpt-5" }, queueMode: "queue",
  }));
  api.fetchAgentSuggestions.mockResolvedValue([]);
  api.fetchAgentSessions.mockResolvedValue({ items: [] });
  const history = { messages: [], sessionId: "history-1", isStreaming: false, activeTurn: null };
  api.fetchSimpleHistory.mockResolvedValue(history);
  api.fetchFullHistory.mockResolvedValue(history);
  api.getSessionKey.mockReturnValue("main");
  api.streamMessage.mockImplementation(() => () => {});
  api.subscribeToSession.mockImplementation(() => Object.assign(() => {}, { send: vi.fn().mockReturnValue(true) }));
  api.subscribeToRealtime.mockImplementation(() => () => {});
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === "/api/relay/dashboard-views") {
      const body = JSON.parse(String(init!.body)) as Record<string, unknown>;
      prepareBodies.push(body);
      return json({
        handle: handleOf(1), instance: "instance-1", shellUrl: `/api/relay/dashboard-views/${handleOf(1)}/shell`,
        expiresAt: new Date(Date.now() + 60_000).toISOString(), gateway: body.gateway, dashboardId: body.dashboardId,
      }, 201);
    }
    if (path.endsWith("/mcp-apps/tool-1/data")) {
      mcpAppPaths.push(path);
      return json({ args: {}, result: { content: [], structuredContent: { id: ID, agentId: "pom", slug: "garden.html", title: "Garden", link: `/d/${ID}`, ...capturedExtra } } });
    }
    if (path === "/api/relay/dashboard-views/read") return json({ expiresAt: new Date(Date.now() + 60_000).toISOString(), state: "delivered", gateway: "ams", dashboardId: ID, meta });
    if (path === "/api/relay/device-links") return json([{ name: "ams", connected: true }]);
    if (path === "/api/relay/agent-settings") return json({ fullBackground: false });
    if (path === "/api/relay/device-settings") return json({ workspaceFolder: null, full: false, mode: "ask" });
    return json({});
  }));
  root = document.createElement("div");
  document.body.append(root);
});
afterEach(() => {
  dispose?.();
  root.remove();
  resetCapabilitiesForTests();
  vi.unstubAllGlobals();
});

const toolHistory = () => {
  const view = { server: "yoplai", tool: "dashboard", resourceUri: "ui://yoplai/dashboard" };
  return {
    messages: [
      { role: "assistant", timestamp: 1, content: [{ type: "toolCall", id: "tool-1", name: "dashboard_create", arguments: {}, viewCall: true, view }] },
      { role: "toolResult", timestamp: 2, toolCallId: "tool-1", toolName: "dashboard_create", content: [{ type: "text", text: "Created" }], view: { ...view, recordId: "record", key: ID } },
    ],
    sessionId: "history-1", isStreaming: false, activeTurn: null,
  };
};
const showToolHistory = () => {
  api.fetchSimpleHistory.mockResolvedValue(toolHistory());
  api.fetchFullHistory.mockResolvedValue(toolHistory());
};

describe("captured dashboard in a chat", () => {
  it("opens the dashboard of a tool call for the gateway of the loaded remote agent, whatever the result names", async () => {
    capturedExtra = { gateway: "evil" };
    showToolHistory();
    history.replaceState({}, "", "/chat/pom%40ams?session=history-1");
    mountChat();
    await waitFor(() => expect(getByTitle(root, "Garden dashboard").getAttribute("src")).toBe(`/api/relay/dashboard-views/${handleOf(1)}/shell`));
    expect(mcpAppPaths[0]).toBe("/api/agents/pom%40ams/sessions/history-1/mcp-apps/tool-1/data");
    expect(prepareBodies).toEqual([expect.objectContaining({ gateway: "ams", dashboardId: ID })]);
    expect(getByRole(root, "link", { name: "Open in browser" }).getAttribute("href")).toBe(`/remote-dashboards/ams/${ID}`);
  });

  it("keeps a local agent with an @ in its ID on the local frame", async () => {
    showToolHistory();
    history.replaceState({}, "", "/chat/me%40home?session=history-1");
    mountChat();
    await waitFor(() => expect(getByTitle(root, "Garden dashboard").getAttribute("src")).toBe(`/d/${ID}`));
    expect(prepareBodies).toHaveLength(0);
  });
});

describe("remote dashboard in a chat", () => {
  it("offers secondary controls in the narrow chat toolbar", async () => {
    history.replaceState({}, "", "/chat/pom%40ams");
    setCapabilitiesForTests({ multiUser: false, extensions: { projects: true } });
    api.fetchAgent.mockResolvedValue({ id: "pom@ams", name: "Pom", gateway: "ams", authMode: "oauth" });
    let resize!: ResizeObserverCallback;
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) { resize = callback; }
      observe() {}
      disconnect() {}
    });
    mountChat();
    await waitFor(() => expect(getByRole(root, "combobox", { name: "Thinking level" })).toBeTruthy());
    const setWidth = (width: number) => resize([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver);
    setWidth(330);
    const more = getByRole(root, "button", { name: "More chat controls", expanded: false });
    expect(queryByRole(root, "combobox", { name: "Thinking level" })).toBeNull();
    expect(queryByRole(root, "link", { name: "Open taskboard" })).toBeNull();
    expect(queryByRole(root, "button", { name: /^Device:/ })).toBeNull();
    more.click();
    expect(getByRole(root, "link", { name: "Open taskboard" }).getAttribute("href")).toBe("/projects");
    const level = getByRole(root, "combobox", { name: "Thinking level" });
    getByRole(root, "button", { name: /^Device:/ }).click();
    expect(getByRole(root, "group", { name: "Device access" })).toBeTruthy();
    level.focus();
    fireEvent.keyDown(level, { key: "Escape" });
    expect(document.activeElement).toBe(more);
    expect(queryByRole(root, "combobox", { name: "Thinking level" })).toBeNull();
    setWidth(1024);
    expect(queryByRole(root, "button", { name: "More chat controls" })).toBeNull();
    expect(getByRole(root, "combobox", { name: "Thinking level" })).toBeTruthy();
  });

  it("opens the dashboard of a remote agent through the trusted host, with the gateway of the loaded agent", async () => {
    history.replaceState({}, "", `/chat/pom%40ams?dashboard=${ID}&new=1`);
    mountChat();
    await waitFor(() => expect(shell().getAttribute("src")).toBe(`/api/relay/dashboard-views/${handleOf(1)}/shell`));
    expect(prepareBodies).toEqual([expect.objectContaining({ gateway: "ams", dashboardId: ID })]);
    await waitFor(() => expect(location.search).toBe(""));
    expect(queryByTitle(root, "Dashboard dashboard")?.getAttribute("src")).not.toBe(`/d/${ID}`);
  });

  it("opens a local dashboard at once for a local agent, with no host request", async () => {
    history.replaceState({}, "", `/chat/sage?dashboard=${ID}&new=1`);
    mountChat();
    await waitFor(() => expect(getByTitle(root, "Dashboard dashboard").getAttribute("src")).toBe(`/d/${ID}`));
    expect(prepareBodies).toHaveLength(0);
  });

  it("stages notes for the checked agent and sends them only after the user sends the message", async () => {
    history.replaceState({}, "", `/chat/pom%40ams?dashboard=${ID}&new=1`);
    mountChat();
    await waitFor(() => expect(shell()).toBeTruthy());
    fromShell("renderer-loaded");
    fromShell("renderer-ready");
    fromShell("annotation", { message: { channel: "yoplai-annotate", type: "ready", id: "claimed", slug: "home.html", agentId: "evil@ams", title: "Home", params: {} } });
    const annotate = await waitFor(() => getByRole(root, "button", { name: "Annotate" }));
    annotate.click();
    fromShell("annotation", { message: { channel: "yoplai-annotate", type: "note", id: "n1", selector: "h1", tag: "h1", text: "Title", heading: "", ancestor: "main", note: "Larger please" } });
    await waitFor(() => expect(getByRole(root, "list", { name: "Dashboard notes" }).textContent).toContain("Larger please"));
    expect(api.streamMessage).not.toHaveBeenCalled();
    fireEvent.click(getByRole(root, "button", { name: "Send message" }));
    await waitFor(() => expect(api.streamMessage).toHaveBeenCalledOnce());
    const [agent, text] = api.streamMessage.mock.calls[0];
    expect(agent).toBe("pom@ams");
    expect(text).toContain(`id: ${ID}`);
    expect(text).toContain("Larger please");
    expect(text).not.toContain("claimed");
    expect(text).not.toContain("evil");
  });
});
