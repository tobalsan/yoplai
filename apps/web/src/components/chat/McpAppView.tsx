import { createEffect, createSignal, on, onCleanup, Show } from "solid-js";
import type { McpAppFile } from "@yoplai/shared/types";
import { Button } from "../ui/Button";
import { formatFileSize, getFileIcon } from "../../lib/attachments";
import { version } from "../../../package.json";
import { loadMcpAppView, loadMcpAppData, relayMcpAppRequest, logMcpAppEvent, type McpAppViewData } from "../../api/mcp-apps";

type RpcMessage = { jsonrpc: "2.0"; id?: string | number | null; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } };

function isRpcMessage(value: unknown): value is RpcMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  if (message.jsonrpc !== "2.0") return false;
  if ("id" in message && message.id !== null && typeof message.id !== "string" && !(typeof message.id === "number" && Number.isFinite(message.id))) return false;
  if (typeof message.method === "string") return !("result" in message) && !("error" in message) && (message.method === "ui/message" || message.method === "ui/update-model-context" || message.params === undefined || (message.params !== null && typeof message.params === "object"));
  if ("method" in message || !("id" in message) || ("result" in message) === ("error" in message)) return false;
  if ("result" in message) return true;
  const error = message.error as Record<string, unknown> | null;
  return !!error && typeof error === "object" && !Array.isArray(error) && Number.isInteger(error.code) && typeof error.message === "string";
}

export function McpAppView(props: { agentId: string; sessionId: string; viewKey: string; callId: () => string; text: string; mode: "inline" | "panel"; onDisplayMode?: (mode: "inline" | "fullscreen") => void; onUserMessage?: (text: string) => Promise<void>; fileOf?: (callId: string) => McpAppFile | undefined; onShown?: (callId: string | undefined) => void }) {
  const [view, setView] = createSignal<McpAppViewData>();
  const [shownCallId, setShownCallId] = createSignal(props.callId());
  const file = () => props.fileOf?.(shownCallId());
  const fileName = () => file()?.title ?? file()?.filename;
  const fileDescription = () => {
    const current = file();
    if (!current) return "";
    const type = current.filename.match(/\.([^.]+)$/)?.[1] || current.mimeType.split("/")[1]?.split(";")[0] || "FILE";
    return [type.toUpperCase(), formatFileSize(current.size)].filter(Boolean).join(" · ");
  };
  const [ready, setReady] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const [allowedModes, setAllowedModes] = createSignal<string[]>(["inline", "fullscreen"]);
  const retiring = new Set<() => void>();
  let frameContainer!: HTMLDivElement;
  let stopCurrent: ((wait: boolean, after?: () => void) => void) | undefined;
  let updateCurrent: ((callId: string) => void) | undefined;
  let switchCurrent: ((mode: "inline" | "fullscreen", reply?: (result: unknown) => void) => void) | undefined;

  function start(agentId: string, sessionId: string, toolCallId: string) {
    const displayMode = props.mode === "panel" ? "fullscreen" : "inline";
    function dimensions() {
      const box = frame?.getBoundingClientRect();
      return displayMode === "fullscreen" ? { width: box?.width ?? 0, height: box?.height ?? 0 } : { width: box?.width ?? 0, maxHeight: 800 };
    }
    const controller = new AbortController();
    const relayTimers = new Set<ReturnType<typeof setTimeout>>();
    let data: McpAppViewData | undefined;
    let frame: HTMLIFrameElement | undefined;
    let active = true;
    let bootstrapped = false;
    let initializing = false;
    let initialized = false;
    let latestCallId = toolCallId;
    let deliveredCallId = toolCallId;
    let dataController: AbortController | undefined;
    let generation = 0;
    let dataTimer: ReturnType<typeof setTimeout> | undefined;
    let resizeObserver: ResizeObserver | undefined;
    let resizeFrame: number | undefined;
    let rejectedMessageLogged = false;
    const initTimer = setTimeout(fail, 15000);

    function post(message: unknown) {
      if (data) frame?.contentWindow?.postMessage(message, data.appsOrigin);
    }
    function reportShown(callId: string) {
      deliveredCallId = callId;
      setShownCallId(callId);
      if (frame) frame.title = fileName() ? `${fileName()} file view` : `${data!.server} MCP App`;
      props.onShown?.(callId);
    }
    function log(level: string, message: string) {
      void logMcpAppEvent(agentId, sessionId, toolCallId, { level, message: message.slice(0, 500) }, controller.signal).catch(() => {});
    }
    function update(callId: string, initial = false) {
      if (callId === latestCallId && !initial) return;
      latestCallId = callId;
      const requestGeneration = ++generation;
      dataController?.abort();
      clearTimeout(dataTimer);
      if (!active || !initialized || callId === toolCallId) return;
      const requestController = new AbortController();
      dataController = requestController;
      const timer = setTimeout(() => {
        if (!active || requestGeneration !== generation) return;
        generation++;
        requestController.abort();
        log("warning", "MCP App update timed out; keeping the previous view data");
      }, 32000);
      dataTimer = timer;
      void loadMcpAppData(agentId, sessionId, callId, requestController.signal).then((result) => {
        if (!active || requestGeneration !== generation) return;
        post({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: result.args } });
        post({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: result.result });
        reportShown(callId);
      }).catch(() => { if (active && requestGeneration === generation) log("warning", "MCP App update failed; keeping the previous view data"); }).finally(() => { clearTimeout(timer); });
    }
    updateCurrent = update;
    function stop(wait: boolean, after?: () => void) {
      if (!active) return;
      active = false;
      clearTimeout(initTimer);
      for (const timer of relayTimers) clearTimeout(timer);
      relayTimers.clear();
      controller.abort();
      dataController?.abort();
      generation++;
      clearTimeout(dataTimer);
      resizeObserver?.disconnect();
      if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
      window.removeEventListener("message", receive);
      if (!frame || !initialized || !frame.isConnected) { frame?.remove(); after?.(); return; }
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
        after?.();
      }
      function acknowledge(event: MessageEvent) {
        if (event.source === retiringFrame.contentWindow && event.origin === origin && isRpcMessage(event.data) && event.data.method === undefined && event.data.id === id) remove();
      }
      retiring.add(remove);
      window.addEventListener("message", acknowledge);
      post({ jsonrpc: "2.0", id, method: "ui/resource-teardown", params: {} });
    }
    function switchMode(mode: "inline" | "fullscreen", reply?: (result: unknown) => void) {
      if (displayMode === "fullscreen" && mode === "inline" && (!initialized || failed())) {
        stop(false);
        if (stopCurrent === stop) props.onDisplayMode?.(mode);
        return;
      }
      if (!active || !initialized) return;
      if (mode === displayMode || !allowedModes().includes(mode) || !props.onDisplayMode) { reply?.({ mode: displayMode }); return; }
      reply?.({ mode });
      post({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { displayMode: mode } });
      stop(true, () => { if (stopCurrent === stop) props.onDisplayMode?.(mode); });
    }
    switchCurrent = switchMode;
    function fail() {
      if (!active) return;
      stop(true);
      setView(undefined);
      setFailed(true);
      props.onShown?.(undefined);
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
        const appCapabilities = params?.appCapabilities as { availableDisplayModes?: unknown } | undefined;
        const declaredModes = appCapabilities?.availableDisplayModes;
        setAllowedModes(Array.isArray(declaredModes) ? ["inline", "fullscreen"].filter((mode) => declaredModes.includes(mode)) : ["inline", "fullscreen"]);
        if (!allowedModes().includes(displayMode)) { fail(); return; }
        initializing = true;
        reply({
          protocolVersion: "2026-01-26",
          hostInfo: { name: "Yoplai", version },
          hostCapabilities: { openLinks: {}, serverTools: {}, serverResources: {}, logging: {}, ...(props.onUserMessage ? { message: { text: {} } } : {}), updateModelContext: { text: {}, structuredContent: {} }, sandbox: { permissions: {}, csp: data.csp } },
          hostContext: { displayMode, availableDisplayModes: ["inline", "fullscreen"], containerDimensions: dimensions() },
        });
      } else if (notification && message.method === "ui/notifications/initialized" && initializing && !initialized) {
        initialized = true;
        clearTimeout(initTimer);
        setReady(true);
        post({ jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: data.args } });
        post({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: data.result });
        reportShown(toolCallId);
        update(latestCallId, true);
      } else if (initialized && notification && message.method === "ui/notifications/size-changed") {
        if (displayMode === "inline" && frame && typeof params?.height === "number" && Number.isFinite(params.height)) frame.style.height = Math.max(40, Math.min(800, params.height)) + "px";
      } else if (initialized && notification && message.method === "notifications/message") {
        if (typeof params?.level !== "string" || !["debug", "info", "notice", "warning", "warn", "error", "critical", "alert", "emergency"].includes(params.level)) return;
        let text: string;
        try { text = typeof params.data === "string" ? params.data : JSON.stringify(params.data) ?? ""; }
        catch { return; }
        log(params.level, text);
      } else if (initialized && !notification && typeof message.method === "string") {
        if (message.method === "tools/call" || message.method === "resources/read" || message.method === "ui/update-model-context") {
          const timer = setTimeout(fail, 32000);
          relayTimers.add(timer);
          const relayCallId = data.server === "yoplai" && message.method === "resources/read" ? deliveredCallId : toolCallId;
          void relayMcpAppRequest(agentId, sessionId, relayCallId, message, controller.signal).then((response) => {
            if (active) post({ ...response, id: message.id });
          }).catch(() => { if (active) fail(); }).finally(() => { clearTimeout(timer); relayTimers.delete(timer); });
        } else if (message.method === "ui/message") {
          const content = Array.isArray(params?.content) ? params.content : [];
          const text = content.filter((block) => block && typeof block === "object" && typeof block.text === "string").map((block) => block.text).join("\n\n");
          const audit = (accepted: boolean) => {
            void logMcpAppEvent(agentId, sessionId, toolCallId, {
              level: accepted ? "info" : "warning",
              message: `ui/message length=${text.length} outcome=${accepted ? "accepted" : "refused"}`,
            }).catch(() => {});
          };
          if (!props.onUserMessage) { audit(false); error(-32601, "Method not found"); return; }
          if (!params || Array.isArray(params) || params.role !== "user" || !Array.isArray(params.content) || !content.every((block) => block && typeof block === "object" && !Array.isArray(block) && block.type === "text" && typeof block.text === "string")) {
            audit(false);
            error(-32602, "Expected user message with text blocks");
            return;
          }
          const refused = (reason: unknown) => {
            audit(false);
            if (active) error(-32000, reason instanceof Error ? reason.message.slice(0, 200) : "Message refused");
          };
          try {
            void props.onUserMessage(text).then(() => { audit(true); if (active) reply({}); }).catch(refused);
          } catch (reason) { refused(reason); }
        } else if (message.method === "ping") reply({});
        else if (message.method === "ui/request-display-mode") {
          if (params?.mode === "inline" || params?.mode === "fullscreen") switchMode(params.mode, reply);
          else reply({ mode: displayMode });
        }
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
      frame.title = fileName() ? `${fileName()} file view` : `${data.server} MCP App`;
      frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
      frame.setAttribute("allow", "");
      frame.setAttribute("referrerpolicy", "no-referrer");
      frame.style.cssText = `display:block;width:100%;height:${displayMode === "fullscreen" ? "100%" : "300px"};border:0`;
      frame.src = data.sandboxUrl;
      frameContainer.append(frame);
      if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(() => {
          if (!active || !initialized || resizeFrame !== undefined) return;
          resizeFrame = requestAnimationFrame(() => {
            resizeFrame = undefined;
            if (active && initialized) post({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { containerDimensions: dimensions() } });
          });
        });
        resizeObserver.observe(frame);
      }
      setView(data);
    }).catch(() => { if (active) fail(); });
    return stop;
  }

  createEffect(on(() => [props.agentId, props.sessionId, props.viewKey] as const, ([agentId, sessionId, viewKey], previous) => {
    if (previous && previous[0] === agentId && previous[1] === sessionId && previous[2] === viewKey) return;
    const sameConversation = !!previous && previous[0] === agentId && previous[1] === sessionId;
    stopCurrent?.(sameConversation);
    if (!sameConversation) {
      stopCurrent = undefined;
      for (const remove of retiring) remove();
    }
    setView(undefined);
    setReady(false);
    setFailed(false);
    setShownCallId(props.callId());
    stopCurrent = start(agentId, sessionId, props.callId());
  }));
  createEffect(() => { updateCurrent?.(props.callId()); });
  function pageHide() {
    stopCurrent?.(false);
    stopCurrent = undefined;
    for (const remove of retiring) remove();
    setView(undefined);
    setFailed(true);
    props.onShown?.(undefined);
  }
  window.addEventListener("pagehide", pageHide);
  onCleanup(() => {
    stopCurrent?.(false);
    stopCurrent = undefined;
    for (const remove of retiring) remove();
    window.removeEventListener("pagehide", pageHide);
  });
  return <section class="mcp-app-view" style={{ display: "flex", "flex-direction": "column", height: props.mode === "panel" ? "100%" : undefined, "min-height": "0", "min-width": "0", overflow: "hidden", border: view()?.prefersBorder ? "1px solid var(--border-subtle)" : "none", "border-radius": "8px" }}>
    <Show when={!!view() || props.mode === "panel"}><header class="mcp-app-view-header" classList={{ "mcp-app-file-header": !!file() }} style={{ display: "flex", "align-items": "center", gap: "8px", "font-size": "0.75rem", color: "var(--text-secondary)" }}>
      <Show when={!!file()} fallback={<><strong>{view()?.server ?? props.viewKey.split("\n")[0]}</strong><span style={{ flex: "1" }}>MCP App</span></>}>
        <span class="file-icon" aria-hidden="true">{getFileIcon(file()!.mimeType)}</span>
        <div style={{ flex: "1", "min-width": "0" }}>
          <strong title={fileName()} style={{ display: "block", overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap", color: "var(--text-primary)" }}>{fileName()}</strong>
          <span>{fileDescription()}</span>
        </div>
        <a class="file-download" href={`/api/media/download/${file()!.fileId}`} download="">Download</a>
      </Show>
      <Show when={!!props.onDisplayMode && (props.mode === "panel" || (ready() && allowedModes().includes("fullscreen")))}><Button variant="ghost" onClick={() => switchCurrent?.(props.mode === "panel" ? "inline" : "fullscreen")}>{props.mode === "panel" ? "Collapse" : "Expand"}</Button></Show>
    </header></Show>
    <Show when={failed()}><p role="status">View unavailable</p><pre style={{ "white-space": "pre-wrap", "overflow-wrap": "anywhere" }}>{props.text}</pre></Show>
    <Show when={!ready() && !failed()}><p role="status">Loading view…</p></Show>
    <div ref={frameContainer} style={{ flex: props.mode === "panel" ? "1" : undefined, "min-height": "0" }} />
  </section>;
}
