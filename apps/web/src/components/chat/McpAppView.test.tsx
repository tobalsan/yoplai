// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getByRole, getByText, getByTitle, queryByRole, queryByText, queryByTitle } from "@testing-library/dom";
import { render } from "solid-js/web";
import { createSignal } from "solid-js";
import { McpAppView } from "./McpAppView";

const { loadView, loadData, relay, log } = vi.hoisted(() => ({ loadView: vi.fn(), loadData: vi.fn(), relay: vi.fn(), log: vi.fn() }));
vi.mock("../../api/mcp-apps", () => ({ loadMcpAppView: loadView, loadMcpAppData: loadData, relayMcpAppRequest: relay, logMcpAppEvent: log }));

const origin = "https://apps.example.test";
const view = {
  available: true,
  sandboxUrl: `${origin}/sandbox/ticket`,
  appsOrigin: origin,
  server: "boards",
  toolName: "draw",
  args: { title: "Roadmap" },
  result: { content: [{ type: "text", text: "Board created" }], structuredContent: { board: 7 } },
  csp: { connectDomains: [], resourceDomains: [] },
  prefersBorder: true,
};
let container: HTMLDivElement;
let dispose: () => void;
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
function send(frame: HTMLIFrameElement, message: unknown, source = frame.contentWindow, messageOrigin = origin) {
  window.dispatchEvent(new MessageEvent("message", { data: message, source, origin: messageOrigin }));
}
function initialize(frame: HTMLIFrameElement) {
  send(frame, { jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready" });
  send(frame, { jsonrpc: "2.0", id: 1, method: "ui/initialize", params: { protocolVersion: "2026-01-26" } });
  send(frame, { jsonrpc: "2.0", method: "ui/notifications/initialized" });
}
function mount(callId: () => string = () => "call-1", text: () => string = () => "Board created", agentId: () => string = () => "agent", sessionId: () => string = () => "chat", options: { mode?: "inline" | "panel"; viewKey?: () => string; onDisplayMode?: (mode: "inline" | "fullscreen") => void } = {}) {
  container = document.createElement("div");
  document.body.append(container);
  dispose = render(() => <McpAppView agentId={agentId()} sessionId={sessionId()} viewKey={options.viewKey?.() ?? "boards\nui://boards/view"} callId={callId} mode={options.mode ?? "inline"} onDisplayMode={options.onDisplayMode} text={text()} />, container);
}

describe("MCP App view host", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    loadView.mockReset().mockResolvedValue(view);
    loadData.mockReset().mockResolvedValue({ args: { title: "Updated roadmap" }, result: { content: [{ type: "text", text: "Box added" }] } });
    relay.mockReset().mockResolvedValue({ jsonrpc: "2.0", id: 28, result: {} });
    log.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => { dispose?.(); container?.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("labels the isolated frame with its server and applies its restrictive outer frame attributes", async () => {
    mount();
    expect(getByText(container, "Loading view…")).toBeTruthy();
    await settle();
    expect(getByText(container, "boards")).toBeTruthy();
    expect(getByText(container, "MCP App")).toBeTruthy();
    const frame = getByTitle(container, "boards MCP App");
    expect(frame.getAttribute("src")).toBe("https://apps.example.test/sandbox/ticket");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");
    expect(frame.getAttribute("allow")).toBe("");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(queryByText(container, "View unavailable")).toBeNull();
  });
  it("waits for initialization, then delivers arguments followed by the raw result using the SDK handshake", async () => {
    mount();
    await settle();
    const frame = getByTitle(container, "boards MCP App") as HTMLIFrameElement;
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    expect(post).not.toHaveBeenCalled();
    send(frame, { jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready" });
    expect(post.mock.calls).toEqual([[{
      jsonrpc: "2.0", method: "ui/notifications/sandbox-resource-ready",
      params: { html: "", sandbox: "allow-scripts allow-same-origin allow-forms", csp: { connectDomains: [], resourceDomains: [] } },
    }, origin]]);
    send(frame, { jsonrpc: "2.0", id: 1, method: "ui/initialize", params: { protocolVersion: "2026-01-26" } });
    expect(post.mock.calls[1]).toEqual([{
      jsonrpc: "2.0", id: 1,
      result: {
        protocolVersion: "2026-01-26",
        hostInfo: { name: "Yoplai", version: "0.1.0" },
        hostCapabilities: {
          openLinks: {}, serverTools: {}, serverResources: {}, logging: {},
          sandbox: { permissions: {}, csp: { connectDomains: [], resourceDomains: [] } },
        },
        hostContext: { displayMode: "inline", availableDisplayModes: ["inline", "fullscreen"], containerDimensions: { width: expect.any(Number), maxHeight: 800 } },
      },
    }, origin]);
    expect(post).toHaveBeenCalledTimes(2);
    send(frame, { jsonrpc: "2.0", method: "ui/notifications/initialized" });
    expect(post.mock.calls.slice(2)).toEqual([
      [{ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: { title: "Roadmap" } } }, origin],
      [{ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { content: [{ type: "text", text: "Board created" }], structuredContent: { board: 7 } } }, origin],
    ]);
    expect(queryByText(container, "Loading view…")).toBeNull();
  });
  it("initializes a panel in fullscreen with the frame box dimensions", async () => {
    mount(undefined, undefined, undefined, undefined, { mode: "panel" });
    await settle();
    const frame = getByTitle(container, "boards MCP App") as HTMLIFrameElement;
    vi.spyOn(frame, "getBoundingClientRect").mockReturnValue({ width: 640, height: 900 } as DOMRect);
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    initialize(frame);
    expect(post.mock.calls[1][0].result.hostContext).toEqual({
      displayMode: "fullscreen", availableDisplayModes: ["inline", "fullscreen"], containerDimensions: { width: 640, height: 900 },
    });
  });
  it.each([["fullscreen"], ["pip"]])("refuses inline initialization when the app declares only %s", async (mode) => {
    const changeMode = vi.fn();
    mount(undefined, undefined, undefined, undefined, { onDisplayMode: changeMode });
    await settle();
    const frame = getByTitle(container, "boards MCP App") as HTMLIFrameElement;
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    send(frame, { jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready" });
    post.mockClear();
    send(frame, { jsonrpc: "2.0", id: 1, method: "ui/initialize", params: { appCapabilities: { availableDisplayModes: [mode] } } });
    expect(getByText(container, "View unavailable")).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
    expect(changeMode).not.toHaveBeenCalled();
  });
  it.each([
    ["request", "inline", "fullscreen"],
    ["Expand", "inline", "fullscreen"],
    ["Collapse", "panel", "inline"],
  ] as const)("switches via %s only after replying, notifying and retiring the old host", async (trigger, mode, target) => {
    const changeMode = vi.fn();
    mount(undefined, undefined, undefined, undefined, { mode, onDisplayMode: changeMode });
    await settle();
    const frame = getByTitle(container, "boards MCP App") as HTMLIFrameElement;
    initialize(frame);
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    if (trigger === "request") send(frame, { jsonrpc: "2.0", id: 8, method: "ui/request-display-mode", params: { mode: "fullscreen" } });
    else getByRole(container, "button", { name: trigger }).click();
    const messages = post.mock.calls.map(([message]) => message);
    if (trigger === "request") expect(messages.shift()).toEqual({ jsonrpc: "2.0", id: 8, result: { mode: "fullscreen" } });
    expect(messages).toEqual([
      { jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { displayMode: target } },
      { jsonrpc: "2.0", id: expect.any(String), method: "ui/resource-teardown", params: {} },
    ]);
    expect(frame.isConnected).toBe(true);
    expect(changeMode).not.toHaveBeenCalled();
    send(frame, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "draw" } });
    expect(relay).not.toHaveBeenCalled();
    send(frame, { jsonrpc: "2.0", id: messages[1].id, result: {} });
    expect(frame.isConnected).toBe(false);
    expect(changeMode.mock.calls).toEqual([[target]]);
  });
  it("delivers a later call's input then result to the same initialized frame and keeps the anchor for RPC", async () => {
    const [callId, setCallId] = createSignal("call-1");
    mount(callId);
    await settle();
    const frame = getByTitle(container, "boards MCP App") as HTMLIFrameElement;
    initialize(frame);
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    setCallId("call-2");
    await settle();
    expect(loadData.mock.calls.map((call) => call.slice(0, 3))).toEqual([["agent", "chat", "call-2"]]);
    expect(post.mock.calls).toEqual([
      [{ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: { title: "Updated roadmap" } } }, origin],
      [{ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { content: [{ type: "text", text: "Box added" }] } }, origin],
    ]);
    expect(loadView).toHaveBeenCalledTimes(1);
    expect(getByTitle(container, "boards MCP App")).toBe(frame);
    send(frame, { jsonrpc: "2.0", id: 28, method: "tools/call", params: { name: "edit_in_view", arguments: {} } });
    expect(relay.mock.calls[0].slice(0, 3)).toEqual(["agent", "chat", "call-1"]);
  });
  it("drops a superseded data response even if it arrives after the newest response", async () => {
    let answerB!: (data: unknown) => void;
    let answerC!: (data: unknown) => void;
    loadData.mockImplementationOnce(() => new Promise((resolve) => { answerB = resolve; }));
    loadData.mockImplementationOnce(() => new Promise((resolve) => { answerC = resolve; }));
    const [callId, setCallId] = createSignal("call-1");
    mount(callId);
    await settle();
    const frame = getByTitle(container, "boards MCP App") as HTMLIFrameElement;
    initialize(frame);
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    setCallId("call-B");
    setCallId("call-C");
    expect(loadData.mock.calls[0][3].aborted).toBe(true);
    answerC({ args: { box: "C" }, result: { structuredContent: { box: "C" } } });
    await settle();
    answerB({ args: { box: "B" }, result: { structuredContent: { box: "B" } } });
    await settle();
    expect(post.mock.calls.map(([message]) => message)).toEqual([
      { jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: { box: "C" } } },
      { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: { box: "C" } } },
    ]);
    expect(getByTitle(container, "boards MCP App")).toBe(frame);
  });
  it("times out a data fetch without losing the view and permits a newer call", async () => {
    let late!: (data: unknown) => void;
    loadData.mockImplementationOnce(() => new Promise((resolve) => { late = resolve; }));
    const [callId, setCallId] = createSignal("call-1");
    mount(callId);
    await settle();
    const frame = getByTitle(container, "boards MCP App") as HTMLIFrameElement;
    initialize(frame);
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    setCallId("call-B");
    await vi.advanceTimersByTimeAsync(32000);
    expect(loadData.mock.calls[0][3].aborted).toBe(true);
    expect(queryByText(container, "View unavailable")).toBeNull();
    expect(log.mock.calls[0].slice(0, 4)).toEqual(["agent", "chat", "call-1", { level: "warning", message: "MCP App update timed out; keeping the previous view data" }]);
    late({ args: { box: "late" }, result: { structuredContent: { box: "late" } } });
    await settle();
    expect(post).not.toHaveBeenCalled();
    setCallId("call-C");
    await settle();
    expect(post.mock.calls.map(([message]) => message.method)).toEqual(["ui/notifications/tool-input", "ui/notifications/tool-result"]);
    expect(getByTitle(container, "boards MCP App")).toBe(frame);
  });
  it("fills the panel and ignores app-requested heights", async () => {
    mount(undefined, undefined, undefined, undefined, { mode: "panel" });
    await settle();
    const frame = getByTitle(container, "boards MCP App") as HTMLIFrameElement;
    initialize(frame);
    expect(frame.style.height).toBe("100%");
    send(frame, { jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 40 } });
    expect(frame.style.height).toBe("100%");
  });
  it("reports changed frame dimensions once per animation frame after initialization", async () => {
    let resize!: () => void;
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { resize = callback; }
      observe() {}
      disconnect() {}
    });
    mount(undefined, undefined, undefined, undefined, { mode: "panel" });
    await settle();
    const frame = getByTitle(container, "boards MCP App") as HTMLIFrameElement;
    let box = { width: 640, height: 900 };
    vi.spyOn(frame, "getBoundingClientRect").mockImplementation(() => box as DOMRect);
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    resize();
    await vi.advanceTimersByTimeAsync(16);
    expect(post).not.toHaveBeenCalled();
    initialize(frame);
    post.mockClear();
    box = { width: 720, height: 880 };
    resize();
    resize();
    expect(post).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(16);
    expect(post.mock.calls).toEqual([[{ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { containerDimensions: { width: 720, height: 880 } } }, origin]]);
    dispose();
    resize();
    await vi.advanceTimersByTimeAsync(16);
    expect(post).toHaveBeenCalledTimes(2);
  });
  it.each(["loading", "failed"])("keeps panel Collapse usable while its view is %s", async (state) => {
    const changeMode = vi.fn();
    if (state === "loading") loadView.mockImplementationOnce(() => new Promise(() => {}));
    else loadView.mockRejectedValueOnce(new Error("offline"));
    mount(undefined, undefined, undefined, undefined, { mode: "panel", onDisplayMode: changeMode });
    await settle();
    getByRole(container, "button", { name: "Collapse" }).click();
    expect(changeMode.mock.calls).toEqual([["inline"]]);
    expect(loadView.mock.calls[0][3].aborted).toBe(true);
  });
  it("does not redeliver the same latest call when transcript text changes", async () => {
    const [call, setCall] = createSignal({ id: "call-1", text: "Created" });
    mount(() => call().id, () => call().text);
    await settle();
    const frame = getByTitle(container, "boards MCP App") as HTMLIFrameElement;
    initialize(frame);
    setCall({ id: "call-B", text: "Box added" });
    await settle();
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    setCall({ id: "call-B", text: "Box added with updated label" });
    await settle();
    expect(loadData).toHaveBeenCalledTimes(1);
    expect(post).not.toHaveBeenCalled();
  });
  it("coalesces pre-initialization call changes after the anchor input and result", async () => {
    const [callId, setCallId] = createSignal("call-1");
    mount(callId);
    await settle();
    const frame = getByTitle(container, "boards MCP App") as HTMLIFrameElement;
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    setCallId("call-B");
    setCallId("call-C");
    expect(loadData).not.toHaveBeenCalled();
    initialize(frame);
    await settle();
    expect(loadData.mock.calls.map((call) => call.slice(0, 3))).toEqual([["agent", "chat", "call-C"]]);
    expect(post.mock.calls.slice(2).map(([message]) => message)).toEqual([
      { jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: { title: "Roadmap" } } },
      { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { content: [{ type: "text", text: "Board created" }], structuredContent: { board: 7 } } },
      { jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: { title: "Updated roadmap" } } },
      { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { content: [{ type: "text", text: "Box added" }] } },
    ]);
  });
  it("keeps the initialized view usable after a failed data fetch", async () => {
    loadData.mockRejectedValueOnce(new Error("offline"));
    const [callId, setCallId] = createSignal("call-1");
    mount(callId);
    await settle();
    const frame = getByTitle(container, "boards MCP App") as HTMLIFrameElement;
    initialize(frame);
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    setCallId("call-B");
    await settle();
    expect(post).not.toHaveBeenCalled();
    expect(queryByText(container, "View unavailable")).toBeNull();
    expect(getByTitle(container, "boards MCP App")).toBe(frame);
    expect(log.mock.calls[0].slice(0, 4)).toEqual(["agent", "chat", "call-1", { level: "warning", message: "MCP App update failed; keeping the previous view data" }]);
    send(frame, { jsonrpc: "2.0", id: 44, method: "ping" });
    expect(post.mock.calls).toEqual([[{ jsonrpc: "2.0", id: 44, result: {} }, origin]]);
  });
  it("aborts data loading on disposal and ignores its late result", async () => {
    let answer!: (data: unknown) => void;
    loadData.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const [callId, setCallId] = createSignal("call-1");
    mount(callId);
    await settle();
    const frame = getByTitle(container, "boards MCP App") as HTMLIFrameElement;
    initialize(frame);
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    setCallId("call-B");
    dispose();
    expect(loadData.mock.calls[0][3].aborted).toBe(true);
    post.mockClear();
    answer({ args: { box: "late" }, result: { structuredContent: { box: "late" } } });
    await settle();
    await vi.advanceTimersByTimeAsync(32000);
    expect(post).not.toHaveBeenCalled();
  });
  it("hides Expand and declines fullscreen when the app declares inline only", async () => {
    const changeMode = vi.fn();
    mount(undefined, undefined, undefined, undefined, { onDisplayMode: changeMode });
    await settle();
    const frame = getByTitle(container, "boards MCP App") as HTMLIFrameElement;
    send(frame, { jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready" });
    send(frame, { jsonrpc: "2.0", id: 1, method: "ui/initialize", params: { appCapabilities: { availableDisplayModes: ["inline"] } } });
    send(frame, { jsonrpc: "2.0", method: "ui/notifications/initialized" });
    expect(queryByRole(container, "button", { name: "Expand" })).toBeNull();
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    send(frame, { jsonrpc: "2.0", id: 45, method: "ui/request-display-mode", params: { mode: "fullscreen" } });
    expect(post.mock.calls).toEqual([[{ jsonrpc: "2.0", id: 45, result: { mode: "inline" } }, origin]]);
    expect(changeMode).not.toHaveBeenCalled();
  });
  it("lets a newer call progress while an older data fetch never settles", async () => {
    loadData.mockImplementationOnce(() => new Promise(() => {}));
    const [callId, setCallId] = createSignal("call-1");
    mount(callId);
    await settle();
    const frame = getByTitle(container, "boards MCP App") as HTMLIFrameElement;
    initialize(frame);
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    setCallId("call-B");
    await vi.advanceTimersByTimeAsync(100);
    setCallId("call-C");
    await settle();
    expect(loadData.mock.calls[0][3].aborted).toBe(true);
    expect(post.mock.calls.map(([message]) => message)).toEqual([
      { jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: { title: "Updated roadmap" } } },
      { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { content: [{ type: "text", text: "Box added" }] } },
    ]);
    expect(getByTitle(container, "boards MCP App")).toBe(frame);
  });
  it.each(["timeout", "disposal"])("bounds mode retirement and suppresses callbacks on %s", async (outcome) => {
    const changeMode = vi.fn();
    mount(undefined, undefined, undefined, undefined, { onDisplayMode: changeMode });
    await settle();
    const frame = getByTitle(container, "boards MCP App") as HTMLIFrameElement;
    initialize(frame);
    getByRole(container, "button", { name: "Expand" }).click();
    await vi.advanceTimersByTimeAsync(249);
    expect(frame.isConnected).toBe(true);
    expect(changeMode).not.toHaveBeenCalled();
    if (outcome === "disposal") dispose();
    await vi.advanceTimersByTimeAsync(1);
    expect(frame.isConnected).toBe(false);
    expect(changeMode.mock.calls).toEqual(outcome === "timeout" ? [["fullscreen"]] : []);
  });
  it.each(["unavailable", "failed request"])("shows the text result when loading is %s", async (outcome) => {
    if (outcome === "unavailable") loadView.mockResolvedValueOnce({ available: false, reason: "gone" });
    else loadView.mockRejectedValueOnce(new Error("offline"));
    mount();
    await settle();
    expect(getByText(container, "View unavailable")).toBeTruthy();
    expect(getByText(container, "Board created")).toBeTruthy();
    expect(queryByTitle(container, "boards MCP App")).toBeNull();
  });
  it.each([
    "http://localhost:4001",
    "https://apps.example.test/path",
    "https://user:password@apps.example.test",
    "data:text/html,app",
  ])("refuses an unsafe or non-bare apps origin %s", async (appsOrigin) => {
    loadView.mockResolvedValueOnce({ ...view, appsOrigin, sandboxUrl: appsOrigin === "http://localhost:4001" ? "http://localhost:4001/sandbox/ticket" : view.sandboxUrl });
    mount();
    await settle();
    expect(getByText(container, "View unavailable")).toBeTruthy();
    expect(getByText(container, "Board created")).toBeTruthy();
    expect(queryByTitle(container, "boards MCP App")).toBeNull();
  });
  it.each(["loading the view", "waiting for initialized"])("limits %s to the same 15-second initialization budget", async (phase) => {
    let finish: ((value: typeof view) => void) | undefined;
    if (phase === "loading the view") loadView.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    mount();
    await settle();
    await vi.advanceTimersByTimeAsync(14999);
    expect(queryByText(container, "View unavailable")).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(getByText(container, "View unavailable")).toBeTruthy();
    expect(getByText(container, "Board created")).toBeTruthy();
    expect(loadView.mock.calls[0][3].aborted).toBe(true);
    finish?.(view);
    await settle();
    expect(queryByTitle(container, "boards MCP App")).toBeNull();
  });
  it.each([
    ["ping", {}, { result: {} }],
    ["ui/request-display-mode", { mode: "fullscreen" }, { result: { mode: "inline" } }],
    ["ui/request-display-mode", { mode: "pip" }, { result: { mode: "inline" } }],
    ["ui/request-display-mode", { mode: "unknown" }, { result: { mode: "inline" } }],
    ["ui/request-display-mode", { mode: "inline" }, { result: { mode: "inline" } }],
    ["ui/message", { role: "user", content: [] }, { error: { code: -32601, message: "Method not found" } }],
    ["ui/update-model-context", { content: [] }, { error: { code: -32601, message: "Method not found" } }],
  ])("answers %s within the inline host's supported interface", async (method, params, response) => {
    mount();
    await settle();
    const frame = getByTitle(container, "boards MCP App") as HTMLIFrameElement;
    initialize(frame);
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    send(frame, { jsonrpc: "2.0", id: "request-7", method, params });
    expect(post.mock.calls).toEqual([[{ jsonrpc: "2.0", id: "request-7", ...response }, origin]]);
    expect(relay).not.toHaveBeenCalled();
  });
  it("returns a server denial unchanged and allows another app call in the same frame", async () => {
    relay.mockResolvedValueOnce({ jsonrpc: "2.0", id: "denied", error: { code: -32000, message: "Refused", data: { reason: "model_only" } } });
    relay.mockResolvedValueOnce({ jsonrpc: "2.0", id: 9, result: { content: [{ type: "text", text: "clicked" }] } });
    mount();
    await settle();
    const frame = getByTitle(container, "boards MCP App") as HTMLIFrameElement;
    initialize(frame);
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    send(frame, { jsonrpc: "2.0", id: "denied", method: "tools/call", params: { name: "model_only", arguments: {} } });
    await settle();
    expect(post.mock.calls[0]).toEqual([{ jsonrpc: "2.0", id: "denied", error: { code: -32000, message: "Refused", data: { reason: "model_only" } } }, origin]);
    send(frame, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "app_click", arguments: { board: 7 } } });
    await settle();
    expect(relay.mock.calls.map((call) => call.slice(0, 4))).toEqual([
      ["agent", "chat", "call-1", { jsonrpc: "2.0", id: "denied", method: "tools/call", params: { name: "model_only", arguments: {} } }],
      ["agent", "chat", "call-1", { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "app_click", arguments: { board: 7 } } }],
    ]);
    expect(post.mock.calls[1]).toEqual([{ jsonrpc: "2.0", id: 9, result: { content: [{ type: "text", text: "clicked" }] } }, origin]);
    expect(getByTitle(container, "boards MCP App")).toBe(frame);
    expect(queryByText(container, "View unavailable")).toBeNull();
  });
  it("drops forged and malformed messages and records their rejection only once", async () => {
    mount();
    await settle();
    const frame = getByTitle(container, "boards MCP App") as HTMLIFrameElement;
    initialize(frame);
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    const ping = { jsonrpc: "2.0", id: 12, method: "ping" };
    send(frame, ping, window);
    send(frame, ping, frame.contentWindow, "https://attacker.example.test");
    for (const malformed of [null, [], { ...ping, jsonrpc: "1.0" }, { ...ping, id: {} }, { ...ping, params: 4 }, { ...ping, result: {} }, { ...ping, method: undefined }]) send(frame, malformed);
    await settle();
    expect(post).not.toHaveBeenCalled();
    expect(relay).not.toHaveBeenCalled();
    expect(log.mock.calls).toEqual([["agent", "chat", "call-1", { level: "warning", message: "Ignored invalid MCP App message" }, expect.any(AbortSignal)]]);
    send(frame, ping);
    expect(post.mock.calls).toEqual([[{ jsonrpc: "2.0", id: 12, result: {} }, origin]]);
  });
  it("opens only HTTP(S) links in a separate tab and refuses executable schemes", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    mount();
    await settle();
    const frame = getByTitle(container, "boards MCP App") as HTMLIFrameElement;
    initialize(frame);
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    send(frame, { jsonrpc: "2.0", id: 4, method: "ui/open-link", params: { url: "javascript:alert(1)" } });
    expect(open).not.toHaveBeenCalled();
    expect(post.mock.calls[0]).toEqual([{ jsonrpc: "2.0", id: 4, error: { code: -32602, message: "Only HTTP and HTTPS links are allowed" } }, origin]);
    send(frame, { jsonrpc: "2.0", id: 5, method: "ui/open-link", params: { url: "https://example.test/board" } });
    expect(open.mock.calls).toEqual([["https://example.test/board", "_blank", "noopener,noreferrer"]]);
    expect(post.mock.calls[1]).toEqual([{ jsonrpc: "2.0", id: 5, result: {} }, origin]);
    expect(log.mock.calls[0].slice(0, 4)).toEqual(["agent", "chat", "call-1", { level: "info", message: "Opened HTTP(S) link" }]);
  });
  it("follows finite reported heights within 40–800 pixels and keeps width controlled by the host", async () => {
    mount();
    await settle();
    const frame = getByTitle(container, "boards MCP App") as HTMLIFrameElement;
    initialize(frame);
    send(frame, { jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 600, width: 9999 } });
    expect(frame.style.height).toBe("600px");
    expect(frame.style.width).not.toBe("9999px");
    send(frame, { jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 1200 } });
    expect(frame.style.height).toBe("800px");
    send(frame, { jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: -4 } });
    expect(frame.style.height).toBe("40px");
    for (const height of [Infinity, NaN, "600"]) send(frame, { jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height } });
    expect(frame.style.height).toBe("40px");
  });
  it("forwards bounded app logging notifications without waiting for logging to finish", async () => {
    log.mockImplementation(() => new Promise(() => {}));
    mount();
    await settle();
    const frame = getByTitle(container, "boards MCP App") as HTMLIFrameElement;
    initialize(frame);
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    send(frame, { jsonrpc: "2.0", method: "notifications/message", params: { level: "warning", data: "x".repeat(700) } });
    expect(log.mock.calls[0].slice(0, 4)).toEqual(["agent", "chat", "call-1", { level: "warning", message: "x".repeat(500) }]);
    send(frame, { jsonrpc: "2.0", id: 13, method: "ping" });
    expect(post.mock.calls).toEqual([[{ jsonrpc: "2.0", id: 13, result: {} }, origin]]);
    expect(queryByText(container, "View unavailable")).toBeNull();
  });
  it("times out an unanswered server relay after 32 seconds and drops a late response", async () => {
    let answer: ((value: unknown) => void) | undefined;
    relay.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    mount();
    await settle();
    const frame = getByTitle(container, "boards MCP App") as HTMLIFrameElement;
    initialize(frame);
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    send(frame, { jsonrpc: "2.0", id: 15, method: "resources/read", params: { uri: "ui://boards/hang" } });
    expect(relay.mock.calls[0].slice(0, 4)).toEqual(["agent", "chat", "call-1", { jsonrpc: "2.0", id: 15, method: "resources/read", params: { uri: "ui://boards/hang" } }]);
    await vi.advanceTimersByTimeAsync(31999);
    expect(queryByText(container, "View unavailable")).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(getByText(container, "View unavailable")).toBeTruthy();
    expect(relay.mock.calls[0][4].aborted).toBe(true);
    expect(post.mock.calls.at(-1)).toEqual([{ jsonrpc: "2.0", id: expect.any(String), method: "ui/resource-teardown", params: {} }, origin]);
    expect(frame.isConnected).toBe(true);
    await vi.advanceTimersByTimeAsync(249);
    expect(frame.isConnected).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(frame.isConnected).toBe(false);
    post.mockClear();
    answer?.({ jsonrpc: "2.0", id: 15, result: { contents: [] } });
    await settle();
    expect(post).not.toHaveBeenCalled();
  });
  it.each(["acknowledged", "unanswered"])("retires a connected initialized frame on view key change with %s bounded teardown", async (reply) => {
    const [callId, setCallId] = createSignal("call-1");
    mount(callId, undefined, undefined, undefined, { viewKey: callId });
    await settle();
    const frame = getByTitle(container, "boards MCP App") as HTMLIFrameElement;
    initialize(frame);
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    setCallId("call-2");
    await settle();
    expect(post.mock.calls).toEqual([[{ jsonrpc: "2.0", id: expect.any(String), method: "ui/resource-teardown", params: {} }, origin]]);
    expect(frame.isConnected).toBe(true);
    send(frame, { jsonrpc: "2.0", id: 22, method: "ping" });
    expect(post).toHaveBeenCalledTimes(1);
    if (reply === "acknowledged") send(frame, { jsonrpc: "2.0", id: post.mock.calls[0][0].id, result: {} });
    else {
      await vi.advanceTimersByTimeAsync(249);
      expect(frame.isConnected).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(frame.isConnected).toBe(false);
    expect(loadView.mock.calls.map((call) => call.slice(0, 3))).toEqual([["agent", "chat", "call-1"], ["agent", "chat", "call-2"]]);
    expect(getByTitle(container, "boards MCP App")).not.toBe(frame);
    expect(loadView.mock.calls[0][3].aborted).toBe(true);
  });
  it.each(["agent", "session"])("removes the old initialized frame immediately when %s identity changes", async (identity) => {
    const [agentId, setAgentId] = createSignal("agent");
    const [sessionId, setSessionId] = createSignal("chat");
    mount(undefined, undefined, agentId, sessionId);
    await settle();
    const frame = getByTitle(container, "boards MCP App") as HTMLIFrameElement;
    initialize(frame);
    if (identity === "agent") setAgentId("other-agent");
    else setSessionId("other-chat");
    expect(frame.isConnected).toBe(false);
    await settle();
    expect(getByTitle(container, "boards MCP App")).not.toBe(frame);
  });
  it.each(["agent", "session", "view key"])("drops a data response from the previous %s identity", async (changed) => {
    let answer!: (data: unknown) => void;
    loadData.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const [identity, setIdentity] = createSignal("old");
    const [callId, setCallId] = createSignal("call-1");
    mount(callId, undefined, () => changed === "agent" ? identity() : "agent", () => changed === "session" ? identity() : "chat", { viewKey: () => changed === "view key" ? identity() : "boards\nui://boards/view" });
    await settle();
    const frame = getByTitle(container, "boards MCP App") as HTMLIFrameElement;
    initialize(frame);
    const oldPost = vi.spyOn(frame.contentWindow!, "postMessage");
    setCallId("call-B");
    setIdentity("new");
    await settle();
    await vi.advanceTimersByTimeAsync(250);
    expect(loadData.mock.calls[0][3].aborted).toBe(true);
    const replacement = getByTitle(container, "boards MCP App") as HTMLIFrameElement;
    expect(replacement).not.toBe(frame);
    initialize(replacement);
    oldPost.mockClear();
    const newPost = vi.spyOn(replacement.contentWindow!, "postMessage");
    answer({ args: { box: "old" }, result: { structuredContent: { box: "old" } } });
    await settle();
    expect(oldPost).not.toHaveBeenCalled();
    expect(newPost).not.toHaveBeenCalled();
  });
  it("removes a retiring frame immediately and cancels its mode callback when the session changes", async () => {
    const [sessionId, setSessionId] = createSignal("chat");
    const changeMode = vi.fn();
    mount(undefined, undefined, undefined, sessionId, { onDisplayMode: changeMode });
    await settle();
    const frame = getByTitle(container, "boards MCP App") as HTMLIFrameElement;
    initialize(frame);
    getByRole(container, "button", { name: "Expand" }).click();
    expect(frame.isConnected).toBe(true);
    setSessionId("other-chat");
    expect(frame.isConnected).toBe(false);
    await vi.advanceTimersByTimeAsync(250);
    expect(changeMode).not.toHaveBeenCalled();
  });
  it.each(["uninitialized disposal", "initialized disposal", "page hide"])("clears lifetime work immediately on %s", async (cause) => {
    mount();
    await settle();
    const frame = getByTitle(container, "boards MCP App") as HTMLIFrameElement;
    const post = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
    if (cause !== "uninitialized disposal") initialize(frame);
    post.mockClear();
    if (cause === "page hide") window.dispatchEvent(new Event("pagehide"));
    else dispose();
    expect(frame.isConnected).toBe(false);
    expect(loadView.mock.calls[0][3].aborted).toBe(true);
    if (cause === "uninitialized disposal") expect(post).not.toHaveBeenCalled();
    else expect(post.mock.calls).toEqual([[{ jsonrpc: "2.0", id: expect.any(String), method: "ui/resource-teardown", params: {} }, origin]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts a pending view load on disposal and never mounts its late response", async () => {
    let finish: ((value: typeof view) => void) | undefined;
    loadView.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    mount();
    dispose();
    expect(loadView.mock.calls[0][3].aborted).toBe(true);
    finish?.(view);
    await settle();
    expect(queryByTitle(document.body, "boards MCP App")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores requests before initialized and treats notifications with IDs as unsupported requests", async () => {
    mount();
    await settle();
    const frame = getByTitle(container, "boards MCP App") as HTMLIFrameElement;
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    send(frame, { jsonrpc: "2.0", id: 31, method: "ping" });
    send(frame, { jsonrpc: "2.0", method: "ui/notifications/initialized" });
    expect(post).not.toHaveBeenCalled();
    initialize(frame);
    post.mockClear();
    send(frame, { jsonrpc: "2.0", id: 32, method: "ui/notifications/size-changed", params: { height: 777 } });
    expect(frame.style.height).toBe("300px");
    expect(post.mock.calls).toEqual([[{ jsonrpc: "2.0", id: 32, error: { code: -32601, message: "Method not found" } }, origin]]);
  });
  it("keeps the same frame when reactive call data changes without changing its identity", async () => {
    const [call, setCall] = createSignal({ agentId: "agent", sessionId: "chat", toolCallId: "call-1", text: "Board created" });
    mount(() => call().toolCallId, () => call().text, () => call().agentId, () => call().sessionId);
    await settle();
    const frame = getByTitle(container, "boards MCP App") as HTMLIFrameElement;
    initialize(frame);
    setCall({ agentId: "agent", sessionId: "chat", toolCallId: "call-1", text: "Updated transcript text" });
    await settle();
    expect(loadView).toHaveBeenCalledTimes(1);
    expect(getByTitle(container, "boards MCP App")).toBe(frame);
    expect(frame.isConnected).toBe(true);
  });
});
