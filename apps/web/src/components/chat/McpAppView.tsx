import { createEffect, createSignal, on, onCleanup, Show } from "solid-js";
import { version } from "../../../package.json";
import { loadMcpAppView, relayMcpAppRequest, logMcpAppEvent, type McpAppViewData } from "../../api/mcp-apps";

type RpcMessage = { jsonrpc: "2.0"; id?: string | number | null; method?: string; params?: Record<string, unknown> | unknown[]; result?: unknown; error?: { code: number; message: string; data?: unknown } };

function isRpcMessage(value: unknown): value is RpcMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  if (message.jsonrpc !== "2.0") return false;
  if ("id" in message && message.id !== null && typeof message.id !== "string" && !(typeof message.id === "number" && Number.isFinite(message.id))) return false;
  if (typeof message.method === "string") return !("result" in message) && !("error" in message) && (message.params === undefined || (message.params !== null && typeof message.params === "object"));
  if ("method" in message || !("id" in message) || ("result" in message) === ("error" in message)) return false;
  if ("result" in message) return true;
  const error = message.error as Record<string, unknown> | null;
  return !!error && typeof error === "object" && !Array.isArray(error) && Number.isInteger(error.code) && typeof error.message === "string";
}

export function McpAppView(props: { agentId: string; sessionId: string; toolCallId: string; text: string }) {
  const [view, setView] = createSignal<McpAppViewData>();
  const [ready, setReady] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const retiring = new Set<() => void>();
  let frameContainer!: HTMLDivElement;
  let stopCurrent: ((wait: boolean) => void) | undefined;

  function start(agentId: string, sessionId: string, toolCallId: string) {
    const controller = new AbortController();
    const relayTimers = new Set<ReturnType<typeof setTimeout>>();
    let data: McpAppViewData | undefined;
    let frame: HTMLIFrameElement | undefined;
    let active = true;
    let bootstrapped = false;
    let initializing = false;
    let initialized = false;
    let rejectedMessageLogged = false;
    const initTimer = setTimeout(fail, 15000);

    function post(message: unknown) {
      if (data) frame?.contentWindow?.postMessage(message, data.appsOrigin);
    }
    function log(level: string, message: string) {
      void logMcpAppEvent(agentId, sessionId, toolCallId, { level, message: message.slice(0, 500) }, controller.signal).catch(() => {});
    }
    function stop(wait: boolean) {
      if (!active) return;
      active = false;
      clearTimeout(initTimer);
      for (const timer of relayTimers) clearTimeout(timer);
      relayTimers.clear();
      controller.abort();
      window.removeEventListener("message", receive);
      if (!frame || !initialized || !frame.isConnected) { frame?.remove(); return; }
      const retiringFrame = frame;
      const origin = data!.appsOrigin;
      const id = "yoplai-resource-teardown";
      if (!wait) {
        post({ jsonrpc: "2.0", id, method: "ui/resource-teardown", params: {} });
        retiringFrame.remove();
        return;
      }
      retiringFrame.hidden = true;
      const timer = setTimeout(remove, 250);
      function remove() {
        clearTimeout(timer);
        window.removeEventListener("message", acknowledge);
        retiring.delete(remove);
        retiringFrame.remove();
      }
      function acknowledge(event: MessageEvent) {
        if (event.source === retiringFrame.contentWindow && event.origin === origin && isRpcMessage(event.data) && event.data.method === undefined && event.data.id === id) remove();
      }
      retiring.add(remove);
      window.addEventListener("message", acknowledge);
      post({ jsonrpc: "2.0", id, method: "ui/resource-teardown", params: {} });
    }
    function fail() {
      if (!active) return;
      stop(true);
      setView(undefined);
      setFailed(true);
    }
    function receive(event: MessageEvent) {
      if (!active || !data) return;
      if (event.source !== frame?.contentWindow || event.origin !== data.appsOrigin || !isRpcMessage(event.data)) {
        if (!rejectedMessageLogged) { rejectedMessageLogged = true; log("warning", "Ignored invalid MCP App message"); }
        return;
      }
      const message = event.data;
      const params = message.params as Record<string, unknown> | undefined;
      const notification = message.id === undefined;
      const reply = (result: unknown) => post({ jsonrpc: "2.0", id: message.id, result });
      const error = (code: number, text: string) => post({ jsonrpc: "2.0", id: message.id, error: { code, message: text } });
      if (notification && message.method === "ui/notifications/sandbox-proxy-ready" && !bootstrapped) {
        bootstrapped = true;
        post({ jsonrpc: "2.0", method: "ui/notifications/sandbox-resource-ready", params: { html: "", sandbox: "allow-scripts allow-same-origin allow-forms", csp: data.csp } });
      } else if (message.method === "ui/initialize" && !notification && bootstrapped && !initializing) {
        initializing = true;
        reply({
          protocolVersion: "2026-01-26",
          hostInfo: { name: "Yoplai", version },
          hostCapabilities: { openLinks: {}, serverTools: {}, serverResources: {}, logging: {}, sandbox: { permissions: {}, csp: data.csp } },
          hostContext: { displayMode: "inline", availableDisplayModes: ["inline"], containerDimensions: { width: frame?.getBoundingClientRect().width ?? 0, maxHeight: 800 } },
        });
      } else if (notification && message.method === "ui/notifications/initialized" && initializing && !initialized) {
        initialized = true;
        clearTimeout(initTimer);
        setReady(true);
        post({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: data.args } });
        post({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: data.result });
      } else if (initialized && notification && message.method === "ui/notifications/size-changed") {
        if (frame && typeof params?.height === "number" && Number.isFinite(params.height)) frame.style.height = Math.max(40, Math.min(800, params.height)) + "px";
      } else if (initialized && notification && message.method === "notifications/message") {
        if (typeof params?.level !== "string" || !["debug", "info", "notice", "warning", "warn", "error", "critical", "alert", "emergency"].includes(params.level)) return;
        let text: string;
        try { text = typeof params.data === "string" ? params.data : JSON.stringify(params.data) ?? ""; }
        catch { return; }
        log(params.level, text);
      } else if (initialized && !notification && typeof message.method === "string") {
        if (message.method === "tools/call" || message.method === "resources/read") {
          const timer = setTimeout(fail, 32000);
          relayTimers.add(timer);
          void relayMcpAppRequest(agentId, sessionId, toolCallId, message, controller.signal).then((response) => {
            if (active) post({ ...response, id: message.id });
          }).catch(() => { if (active) fail(); }).finally(() => { clearTimeout(timer); relayTimers.delete(timer); });
        } else if (message.method === "ping") reply({});
        else if (message.method === "ui/request-display-mode") reply({ mode: "inline" });
        else if (message.method === "ui/open-link") {
          try {
            const url = new URL(typeof params?.url === "string" ? params.url : "");
            if (!["http:", "https:"].includes(url.protocol)) throw new Error("Unsupported scheme");
            window.open(url.href, "_blank", "noopener,noreferrer");
            log("info", "Opened HTTP(S) link");
            reply({});
          } catch { error(-32602, "Only HTTP and HTTPS links are allowed"); }
        } else error(-32601, "Method not found");
      }
    }
    window.addEventListener("message", receive);
    void loadMcpAppView(agentId, sessionId, toolCallId, controller.signal).then((response) => {
      if (!active) return;
      if (!response.available) { fail(); return; }
      const apps = new URL(response.appsOrigin);
      if (!["http:", "https:"].includes(apps.protocol) || apps.origin !== response.appsOrigin || apps.hostname === location.hostname || new URL(response.sandboxUrl).origin !== apps.origin) { fail(); return; }
      data = response;
      frame = document.createElement("iframe");
      frame.title = `${data.server} MCP App`;
      frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
      frame.setAttribute("allow", "");
      frame.setAttribute("referrerpolicy", "no-referrer");
      frame.style.cssText = "display:block;width:100%;height:300px;border:0";
      frame.src = data.sandboxUrl;
      frameContainer.append(frame);
      setView(data);
    }).catch(() => { if (active) fail(); });
    return stop;
  }

  createEffect(on(() => [props.agentId, props.sessionId, props.toolCallId] as const, ([agentId, sessionId, toolCallId], previous) => {
    if (previous && previous[0] === agentId && previous[1] === sessionId && previous[2] === toolCallId) return;
    stopCurrent?.(true);
    setView(undefined);
    setReady(false);
    setFailed(false);
    stopCurrent = start(agentId, sessionId, toolCallId);
  }));
  function pageHide() {
    stopCurrent?.(false);
    for (const remove of retiring) remove();
    setView(undefined);
    setFailed(true);
  }
  window.addEventListener("pagehide", pageHide);
  onCleanup(() => {
    stopCurrent?.(false);
    for (const remove of retiring) remove();
    window.removeEventListener("pagehide", pageHide);
  });
  return <section class="mcp-app-view" style={{ "min-width": "0", overflow: "hidden", border: view()?.prefersBorder ? "1px solid var(--border-subtle)" : "none", "border-radius": "8px" }}>
    <Show when={!!view()}><header style={{ display: "flex", gap: "8px", padding: "8px", "font-size": "0.75rem", color: "var(--text-secondary)" }}><strong>{view()?.server}</strong><span>MCP App</span></header></Show>
    <Show when={failed()}><p role="status">View unavailable</p><pre style={{ "white-space": "pre-wrap", "overflow-wrap": "anywhere" }}>{props.text}</pre></Show>
    <Show when={!ready() && !failed()}><p role="status">Loading view…</p></Show>
    <div ref={frameContainer} />
  </section>;
}
