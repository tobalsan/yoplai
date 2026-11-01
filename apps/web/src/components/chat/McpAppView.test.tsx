// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getByText, getByTitle, queryByText, queryByTitle } from "@testing-library/dom";
import { render } from "solid-js/web";
import { createSignal } from "solid-js";
import { McpAppView } from "./McpAppView";

const { loadView, relay, log } = vi.hoisted(() => ({ loadView: vi.fn(), relay: vi.fn(), log: vi.fn() }));
vi.mock("../../api/mcp-apps", () => ({ loadMcpAppView: loadView, relayMcpAppRequest: relay, logMcpAppEvent: log }));

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
function mount(callId: () => string = () => "call-1", text: () => string = () => "Board created", agentId: () => string = () => "agent", sessionId: () => string = () => "chat") {
  container = document.createElement("div");
  document.body.append(container);
  dispose = render(() => <McpAppView agentId={agentId()} sessionId={sessionId()} toolCallId={callId()} text={text()} />, container);
}

describe("MCP App view host", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    loadView.mockReset().mockResolvedValue(view);
    relay.mockReset();
    log.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => { dispose?.(); container?.remove(); vi.useRealTimers(); vi.restoreAllMocks(); });

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
        hostContext: { displayMode: "inline", availableDisplayModes: ["inline"], containerDimensions: { width: expect.any(Number), maxHeight: 800 } },
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
  it.each(["acknowledged", "unanswered"])("retires a connected initialized frame on call change with %s bounded teardown", async (reply) => {
    const [callId, setCallId] = createSignal("call-1");
    mount(callId);
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
