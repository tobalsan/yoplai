// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, getByRole, queryByRole, waitFor } from "@testing-library/dom";
import { Route, Router, useLocation } from "@solidjs/router";
import { delegateEvents, render } from "solid-js/web";
import { ChatView } from "./ChatView";
import { ToolbarOnlyShell } from "./ChatView.test-shell";
import type { SubscriptionCallbacks } from "../api/realtime";
import type { StreamCallbacks } from "../api/chat";
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

const agentId = "pom@ams";
const freshKey = "fresh-key";
const mountedViews = new Set<() => void>();
let subscription: SubscriptionCallbacks;
let readRouteState: () => unknown;
let sessionKey: string;
let routeAtNewKey: { pathname: string; search: string };
const answer = vi.fn();
const settingsRequests: URL[] = [];

function mountChat() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const ChatRoute = () => {
    const location = useLocation();
    readRouteState = () => location.state;
    return <ChatView shell={ToolbarOnlyShell} />;
  };
  const stop = render(() => <Router><Route path="/chat/:agentId/:view?" component={ChatRoute} /></Router>, container);
  const dispose = () => {
    mountedViews.delete(dispose);
    stop();
    container.remove();
  };
  mountedViews.add(dispose);
  return { container, dispose };
}

const json = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { "content-type": "application/json" },
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  sessionKey = "main";
  settingsRequests.length = 0;
  subscription = {};
  delegateEvents(["click", "input", "keydown"]);
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  setCapabilitiesForTests({ multiUser: false });
  api.fetchAgent.mockResolvedValue({
    id: agentId, name: "Pom (remote)", gateway: "ams",
    model: { provider: "openai", model: "gpt-5" }, queueMode: "queue",
  });
  api.fetchAgentSuggestions.mockResolvedValue([]);
  api.fetchAgentSessions.mockResolvedValue({ items: [] });
  const history = { messages: [], sessionId: "history-ask", isStreaming: false, activeTurn: null };
  api.fetchSimpleHistory.mockResolvedValue(history);
  api.fetchFullHistory.mockResolvedValue(history);
  api.getSessionKey.mockImplementation(() => sessionKey);
  api.startNewChat.mockImplementation(() => {
    routeAtNewKey = { pathname: window.location.pathname, search: window.location.search };
    sessionKey = freshKey;
  });
  api.streamMessage.mockImplementation(() => () => {});
  answer.mockReturnValue(true);
  api.subscribeToSession.mockImplementation((_id, _key, callbacks) => {
    subscription = callbacks;
    return Object.assign(() => {}, { send: answer });
  });
  api.subscribeToRealtime.mockImplementation(() => () => {});
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), window.location.origin);
    if (url.pathname === "/api/relay/device-links") return json([{ name: "ams", connected: true }]);
    if (url.pathname === "/api/relay/agent-settings") return json({ fullBackground: false });
    if (url.pathname === "/api/relay/device-settings") {
      settingsRequests.push(url);
      const full = url.searchParams.get("chat") === "key:main";
      return json({ workspaceFolder: null, full, mode: full ? "full" : "ask" });
    }
    return json({});
  }));
});

afterEach(() => {
  mountedViews.forEach((dispose) => dispose());
  document.body.innerHTML = "";
  resetCapabilitiesForTests();
  vi.unstubAllGlobals();
});

describe("ChatView remote reset with the installed router", () => {
  it.each([
    { name: "only session", path: "/chat/pom%40ams", extra: "", hash: "" },
    { name: "only session before a hash", path: "/chat/pom%40ams", extra: "", hash: "#keep-hash" },
    { name: "a remaining query and full view", path: "/chat/pom%40ams/full", extra: "&keep=value", hash: "#keep-hash" },
  ])("keeps the chat and its approval after reset and remount with $name", async ({ path, extra, hash }) => {
    const state = { backTo: "/agents" };
    window.history.replaceState(state, "", `${path}?session=history-ask${extra}${hash}`);
    const historyLength = window.history.length;
    const first = mountChat();
    await waitFor(() => expect(queryByRole(first.container, "button", { name: /Device: Ask/ })).not.toBeNull());
    expect(settingsRequests.some(url => url.searchParams.get("chat") === "session:history-ask")).toBe(true);
    let pathAtSend: string | undefined;
    let searchAtSend: string | undefined;
    api.streamMessage.mockImplementation(() => {
      pathAtSend = window.location.pathname;
      searchAtSend = window.location.search;
      return () => {};
    });
    const text = "/reset synthetic command";
    fireEvent.input(getByRole(first.container, "textbox"), { target: { value: text } });
    fireEvent.click(getByRole(first.container, "button", { name: "Send message" }));
    await waitFor(() => expect(api.streamMessage).toHaveBeenCalledOnce());
    const sent = api.streamMessage.mock.calls[0];
    expect(pathAtSend).toBe(path);
    expect(sent[0]).toBe(agentId);
    expect(sent[1]).toBe(text);
    expect(sent[2]).toBe(freshKey);
    expect(sent[7]?.sessionId).toBeUndefined();
    expect(searchAtSend).toBe(extra ? "?keep=value" : "");
    expect(routeAtNewKey).toEqual({ pathname: path, search: extra ? "?keep=value" : "" });
    expect(api.startNewChat).toHaveBeenCalledOnce();
    expect(api.startNewChat).toHaveBeenCalledWith(agentId);
    const assertRoute = () => {
      expect(window.location.pathname).toBe(path);
      expect(window.location.search).toBe(extra ? "?keep=value" : "");
      expect(window.location.hash).toBe(hash);
      expect(readRouteState()).toMatchObject(state);
      expect(window.history.length).toBe(historyLength);
    };
    assertRoute();
    const pending = {
      type: "device_approval_request" as const,
      approvalId: "reset-pending", gateway: "ams", agentId, chat: `key:${freshKey}`,
      toolCallId: "call-1", tool: "device_bash", arguments: { command: "ls -la" },
    };
    const messageAnswer = vi.fn().mockReturnValue(true);
    const callbacks = sent[6] as StreamCallbacks;
    callbacks.onSessionReset?.("remote-reset-session");
    assertRoute();
    callbacks.onDeviceApprovalRequest?.(pending, messageAnswer);
    await waitFor(() => expect(queryByRole(first.container, "button", { name: "Approve" })).not.toBeNull());
    expect(api.fetchAgent).toHaveBeenCalledOnce();
    first.dispose();

    const second = mountChat();
    await waitFor(() => expect(queryByRole(second.container, "button", { name: /Device: Ask/ })).not.toBeNull());
    assertRoute();
    expect(api.getSessionKey()).toBe(freshKey);
    expect(api.subscribeToSession.mock.calls.at(-1)?.slice(0, 2)).toEqual([agentId, freshKey]);
    expect(api.subscribeToSession.mock.calls.at(-1)?.[3]).toBeUndefined();
    expect(settingsRequests.at(-1)?.searchParams.get("agentId")).toBe(agentId);
    expect(settingsRequests.at(-1)?.searchParams.get("chat")).toBe(`key:${freshKey}`);
    subscription.onDeviceApprovalRequest?.(pending);
    await waitFor(() => expect(queryByRole(second.container, "button", { name: "Approve" })).not.toBeNull());
    expect(second.container.textContent).toContain("ls -la");
    fireEvent.click(getByRole(second.container, "button", { name: "Approve" }));
    expect(answer).toHaveBeenCalledWith({ type: "device_approval_answer", approvalId: "reset-pending", approve: true });
    expect(messageAnswer).not.toHaveBeenCalled();
    subscription.onDeviceApprovalResolved?.({
      type: "device_approval_resolved", approvalId: "reset-pending", agentId,
      chat: `key:${freshKey}`, outcome: "approved",
    });
    await waitFor(() => expect(queryByRole(second.container, "button", { name: "Approve" })).toBeNull());
    second.dispose();
  });
});
