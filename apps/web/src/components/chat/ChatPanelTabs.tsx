import { createMemo, createSignal, createUniqueId, For, Show, type JSX } from "solid-js";
import { getFileIcon } from "../../lib/attachments";
import type { AppViews } from "./appViews";
import { McpAppView } from "./McpAppView";
import { CapturedFrameView, FrameView } from "./FrameView";
import { isExtensionFrameView } from "./chat-history";

const MEMORY_TAB = "memory";

export function ChatPanelTabs(props: {
  appViews: AppViews;
  agentId: string;
  gateway?: string;
  gatewayPending?: boolean;
  sessionId: string | null | undefined;
  memory?: { active: boolean; activate(): void; close(): void; content: JSX.Element };
  onSelectView?: () => void;
  onUserMessage: (key: string, text: string) => Promise<void>;
}) {
  const id = createUniqueId();
  const tabId = (key: string) => `${id}-tab-${encodeURIComponent(key)}`;
  const panelId = (key: string) => `${id}-panel-${encodeURIComponent(key)}`;
  const tab = (key: string) => props.appViews.tabs().find((item) => item.key === key);
  const view = (key: string) => {
    const current = tab(key);
    return current && !("frame" in current) ? current : undefined;
  };
  const frame = (key: string) => {
    const current = tab(key);
    return current && "frame" in current ? current.frame : undefined;
  };
  const file = (key: string) => props.appViews.shownFileOf(key) ?? view(key)?.latest.result?.view?.file;
  const dashboard = (key: string) => !!frame(key) || view(key)?.latest.result?.view?.resourceUri === "ui://yoplai/dashboard";
  const extensionFrame = (key: string) => isExtensionFrameView(view(key)?.latest.result?.view);
  const title = (key: string) => {
    if (key === MEMORY_TAB) return "Memory";
    const latest = view(key)?.latest.result?.view;
    return frame(key)?.title ?? latest?.title ?? latest?.file?.title ?? latest?.file?.filename ?? file(key)?.title ?? file(key)?.filename ?? (dashboard(key) ? "Dashboard" : latest?.server ?? "View");
  };
  // Tab buttons can move. Mounted iframe panels must never move with them.
  const mountedKeys = createMemo<string[]>((previous = []) => {
    const keys = props.appViews.tabs().map((item) => item.key);
    return [...previous.filter((key) => keys.includes(key)), ...keys.filter((key) => !previous.includes(key))];
  }, [], { equals: (a, b) => a.length === b.length && a.every((key, index) => key === b[index]) });
  const viewKeys = createMemo(() => props.appViews.tabs().map((item) => item.key));
  const keys = () => props.memory ? [MEMORY_TAB, ...viewKeys()] : viewKeys();
  const activeKey = () => props.memory && (props.memory.active || !viewKeys().length) ? MEMORY_TAB : props.appViews.activeKey();
  function activate(key: string) {
    if (key === MEMORY_TAB) props.memory?.activate();
    else {
      props.onSelectView?.();
      props.appViews.activate(key);
    }
  }
  const multiple = () => keys().length > 1;
  const [dragged, setDragged] = createSignal<string>();
  const [dropIndex, setDropIndex] = createSignal<number>();
  function endDrag() { setDragged(undefined); setDropIndex(undefined); }
  function drop(event: DragEvent) {
    const key = dragged();
    const index = dropIndex();
    if (!key || index === undefined || event.dataTransfer?.getData("application/x-yoplai-panel-tab") !== key) return;
    event.preventDefault();
    props.appViews.move(key, index - Number(!!props.memory) - Number(keys().indexOf(key) < index));
    endDrag();
  }
  function keyDown(event: KeyboardEvent, key: string) {
    const index = keys().indexOf(key);
    const direction = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    if (direction && event.ctrlKey && event.shiftKey) {
      event.preventDefault();
      if (key !== MEMORY_TAB) props.appViews.move(key, index + direction - Number(!!props.memory));
      queueMicrotask(() => document.getElementById(tabId(key))?.focus());
      return;
    }
    if (event.ctrlKey || event.altKey || event.metaKey || (!direction && event.key !== "Home" && event.key !== "End")) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? keys().length - 1 : (index + direction + keys().length) % keys().length;
    const target = keys()[next];
    activate(target);
    document.getElementById(tabId(target))?.focus();
  }
  function close(key: string) {
    if (key === MEMORY_TAB) props.memory?.close();
    else props.appViews.closeTab(key);
    queueMicrotask(() => {
      const active = activeKey();
      if (active) document.getElementById(multiple() ? tabId(active) : panelId(active))?.focus();
    });
  }
  return <>
    <Show when={multiple()}>
      <div class="chat-panel-tabs" role="tablist" aria-label="Side panel views" onDrop={drop} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropIndex(undefined); }}>
        <For each={keys()}>{(key) => <div class="chat-panel-tab" role="presentation" classList={{ "chat-panel-drop-before": dropIndex() === keys().indexOf(key), "chat-panel-drop-after": dropIndex() === keys().length && keys().at(-1) === key }}>
          <button type="button" role="tab" id={tabId(key)} aria-controls={panelId(key)} aria-selected={activeKey() === key} aria-label={title(key)} title={title(key)} tabIndex={activeKey() === key ? 0 : -1} onClick={() => activate(key)} onKeyDown={(event) => keyDown(event, key)} draggable={key !== MEMORY_TAB}
            onDragStart={(event) => { if (key === MEMORY_TAB) return; setDragged(key); event.dataTransfer!.effectAllowed = "move"; event.dataTransfer!.setData("application/x-yoplai-panel-tab", key); }}
            onDragEnd={endDrag}
            onDragOver={(event) => { if (!dragged()) return; event.preventDefault(); event.dataTransfer!.dropEffect = "move"; const rect = event.currentTarget.getBoundingClientRect(); setDropIndex(keys().indexOf(key) + (event.clientX >= rect.left + rect.width / 2 ? 1 : 0)); }}>
            <Show when={file(key)} fallback={<i class={key === MEMORY_TAB ? "fa-regular fa-note-sticky" : dashboard(key) ? "fa-solid fa-table-columns" : "fa-solid fa-window-maximize"} aria-hidden="true" />}>
              <span class="file-icon" aria-hidden="true">{getFileIcon(file(key)!.mimeType)}</span>
            </Show>
            <span class="chat-panel-tab-title">{title(key)}</span>
          </button>
          <button type="button" class="chat-panel-tab-close" aria-label={`Close ${title(key)}`} title={`Close ${title(key)}`} onClick={() => close(key)}><i class="fa-solid fa-xmark" aria-hidden="true" /></button>
        </div>}</For>
      </div>
    </Show>
    {/* A stable parent: the tablist appearing beside loose panels made Solid re-insert (and reload) the first panel. */}
    <div class="chat-panel-tabpanels">
      <Show when={props.memory}>{(memory) =>
        <div class="chat-panel-tabpanel" role="tabpanel" id={panelId(MEMORY_TAB)}
          aria-labelledby={multiple() ? tabId(MEMORY_TAB) : undefined} aria-label={multiple() ? undefined : "Memory"}
          hidden={activeKey() !== MEMORY_TAB} tabIndex={-1}>
          <Show when={!multiple()}>
            <button type="button" class="chat-panel-tab-close memory-standalone-close" aria-label="Close Memory" onClick={() => close(MEMORY_TAB)}>
              <i class="fa-solid fa-xmark" aria-hidden="true" />
            </button>
          </Show>
          {memory().content}
        </div>
      }</Show>
      <For each={mountedKeys()}>{(key) => <div class="chat-panel-tabpanel" role="tabpanel" id={panelId(key)} aria-labelledby={multiple() ? tabId(key) : undefined} aria-label={multiple() ? undefined : title(key)} hidden={activeKey() !== key} tabIndex={-1}>
        <Show when={frame(key)} fallback={
          <Show when={props.sessionId} fallback={<p role="status">{props.sessionId === null ? "View unavailable" : "Loading view…"}</p>}>
          <Show when={dashboard(key) || extensionFrame(key)} fallback={
            <McpAppView agentId={props.agentId} sessionId={props.sessionId!} viewKey={key} callId={() => view(key)!.latest.id} startCallId={props.appViews.shownCallOf(key)} text={view(key)?.latest.text ?? ""} mode="panel" fileOf={props.appViews.fileOf} onShown={(callId) => props.appViews.reportShown(key, callId)} onDisplayMode={(mode) => { if (mode === "inline") close(key); }} onUserMessage={(text) => props.onUserMessage(key, text)} />
          }>
            <CapturedFrameView kind={extensionFrame(key) ? "extension" : "dashboard"} agentId={props.agentId} gateway={props.gateway} query={props.appViews.queryOf(key)} gatewayPending={props.gatewayPending} sessionId={props.sessionId!} callId={() => view(key)!.latest.id} startCallId={props.appViews.shownCallOf(key)} mode="panel" onCollapse={() => close(key)} onShown={(callId) => props.appViews.reportShown(key, callId)} />
          </Show>
          </Show>
        }>{(target) => <FrameView target={target()} mode="panel" onCollapse={() => close(key)} />}</Show>
      </div>}</For>
    </div>
  </>;
}
