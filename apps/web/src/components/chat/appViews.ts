import { createComputed, createMemo, createSignal, on, type Accessor } from "solid-js";
import type { McpAppView, McpAppViewReference } from "@yoplai/shared/types";
import type { HistoryViewMode, FullToolResultMessage } from "../../api/types";
import type { ChatTranscriptSession } from "./ChatTranscript";
import type { ChatToolCall } from "./chat-history";
import { extractBlockText } from "../../lib/history";
import { save, type SavedAppViews } from "./appViewStorage";

export type AppViewCall = {
  id: string;
  timestamp: number;
  view?: McpAppView;
  result?: { view?: McpAppViewReference };
  text?: string;
  history?: boolean;
};

type AppView = { key: string; calls: AppViewCall[]; host: AppViewCall; latest: AppViewCall };

export function chatAppViewCalls(session: ChatTranscriptSession, mode: HistoryViewMode): AppViewCall[] {
  const text = (result?: FullToolResultMessage) => (result?.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => extractBlockText((block as { text: unknown }).text)).join("\n");
  let history: AppViewCall[];
  if (mode === "simple") {
    history = session.simpleMessages().flatMap((message) => message.role === "tool" && (message.viewCall ?? !!message.result?.view)
      ? [{ id: message.id, timestamp: message.timestamp, view: message.view, result: message.result, text: text(message.result) }]
      : []);
  } else {
    const results = new Map(session.fullMessages().filter((message) => message.role === "toolResult").map((message) => [message.toolCallId, message]));
    history = session.fullMessages().flatMap((message) => message.role === "assistant"
      ? message.content.flatMap((block) => block.type === "toolCall" && ((block as ChatToolCall).viewCall ?? !!results.get(block.id)?.view)
        ? [{ id: block.id, timestamp: message.timestamp, view: (block as ChatToolCall).view, result: results.get(block.id), text: text(results.get(block.id)) }]
        : [])
      : []);
  }
  return [...history.map((call) => ({ ...call, history: true })), ...session.streamingBlocks().flatMap((block) => block.type === "toolCall" && block.view
    ? [{ id: block.id, timestamp: block.timestamp, view: block.view, result: block.result, text: text(block.result) }]
    : [])];
}

export type DashboardFrame = { kind: "dashboard"; id: string; title: string };
export type AppViewTab = AppView | { key: string; frame: DashboardFrame };

export type AppViews = ReturnType<typeof createAppViews>;

export function viewKey(view: Pick<McpAppViewReference, "server" | "resourceUri" | "file" | "key">): string {
  const key = view.key ?? view.file?.filename;
  return view.server + "\n" + view.resourceUri + (key !== undefined ? "\n" + key : "");
}

export function createAppViews(sessionId: Accessor<string | null | undefined>, calls: Accessor<AppViewCall[]>, chatScope?: Accessor<string>, persistence?: { agentId: Accessor<string>; ready: Accessor<boolean> }) {
  const source = createMemo(calls);
  const [shown, setShown] = createSignal(new Map<string, AppViewCall>());
  const historyIds = createMemo(() => new Set(source().filter((call) => call.history).map((call) => call.id)));
  const projection = createMemo(() => {
    const groups = new Map<string, AppViewCall[]>();
    const unique = new Map<string, AppViewCall>();
    for (const call of source()) {
      const previous = unique.get(call.id);
      if (!previous || call.result?.view) unique.set(call.id, call);
    }
    for (const call of unique.values()) {
      const ref = call.result?.view ?? call.view;
      if (!ref) continue;
      const key = viewKey(ref);
      const group = groups.get(key) ?? [];
      group.push(call);
      groups.set(key, group);
    }
    const views = new Map<string, AppView>();
    for (const [key, group] of groups) {
      const successful = group.filter((call) => call.result?.view);
      // The newest successful call hosts the inline view, so it follows the conversation.
      if (successful.length) views.set(key, { key, calls: group, host: successful[successful.length - 1], latest: successful[successful.length - 1] });
    }
    return views;
  });
  function viewOf(id: string) {
    return [...projection().values()].find((view) => view.calls.some((call) => call.id === id));
  }
  const [selections, setSelections] = createSignal<{
    session: string | null | undefined;
    tab: AppViewTab;
    order: AppViewCall[];
  }[]>([]);
  const [activeKey, setActiveKey] = createSignal<string>();
  let selectedScope: string | undefined;
  let pendingSave = false;
  function close() {
    pendingSave = false;
    setSelections([]);
    setActiveKey(undefined);
  }
  if (chatScope) createComputed(on(chatScope, (current, previous) => {
    if (current !== previous) {
      if (current !== selectedScope) close();
      setShown(new Map());
    }
  }));
  createComputed(on(sessionId, (current, previous) => {
    if (current !== previous) {
      if (!previous && current && selections().length) {
        setSelections((currentTabs) => currentTabs.map((selection) => ({ ...selection, session: current })));
        persist();
      } else close();
      setShown(new Map());
    }
  }));
  const tabs = createMemo(() => selections().filter((selection) => selection.session === sessionId()).map((selection) => {
    const current = projection().get(selection.tab.key);
    if (current && "frame" in selection.tab) {
      selection.tab = current;
      selection.order = [...current.calls];
    } else if (current && !("frame" in selection.tab)) {
      const previous = selection.tab;
      // Remember observed call order: an older reconnect snapshot must not roll back the panel.
      const order = selection.order;
      const includesLatest = current.calls.some((call) => call.id === previous.latest.id);
      current.calls.forEach((call, index) => {
        if (order.some((known) => known.id === call.id)) return;
        const next = current.calls.slice(index + 1).find((item) => order.some((known) => known.id === item.id));
        let before = next ? order.findIndex((known) => known.id === next.id) : order.findIndex((known) => known.timestamp > call.timestamp);
        if (before < 0 && !includesLatest && call.timestamp <= previous.latest.timestamp) before = order.findIndex((known) => known.id === previous.latest.id);
        order.splice(before < 0 ? order.length : before, 0, call);
      });
      const position = (id: string) => order.findIndex((call) => call.id === id);
      if (position(current.latest.id) >= position(previous.latest.id)) selection.tab = current;
    }
    return selection.tab;
  }));
  function persist() {
    if (!persistence) return;
    pendingSave = true;
    const session = sessionId();
    if (!session || !persistence.ready()) return;
    pendingSave = false;
    save(persistence.agentId(), session, {
      tabs: tabs().map((tab) => ({ key: tab.key, ...("frame" in tab ? { frame: { id: tab.frame.id, title: tab.frame.title } } : {}) })),
      active: activeKey(),
    });
  }
  if (persistence) createComputed(on(persistence.ready, () => {
    if (pendingSave) persist();
  }));
  const panel = createMemo(() => {
    const tab = tabs().find((tab) => tab.key === activeKey());
    return tab && !("frame" in tab) ? tab : undefined;
  });
  const frame = createMemo(() => {
    const tab = tabs().find((tab) => tab.key === activeKey());
    return tab && "frame" in tab ? tab.frame : undefined;
  });
  function isTab(key: string) { return tabs().some((tab) => tab.key === key); }
  function activate(key: string) {
    if (isTab(key)) {
      setActiveKey(key);
      persist();
    }
  }
  return {
    isLiveDuplicate(id: string) { return historyIds().has(id); },
    fileOf(id: string) {
      return source().find((call) => call.id === id && call.result?.view?.file)?.result?.view?.file
        ?? [...shown().values()].find((call) => call.id === id)?.result?.view?.file
        ?? tabs().flatMap((tab) => "frame" in tab ? [] : tab.calls).find((call) => call.id === id)?.result?.view?.file;
    },
    shownFileOf(key: string) { return shown().get(key)?.result?.view?.file; },
    shownCallOf(key: string) { return shown().get(key)?.id; },
    reportShown(key: string, id: string | undefined) {
      const tab = tabs().find((tab) => tab.key === key);
      const call = projection().get(key)?.calls.find((call) => call.id === id)
        ?? (tab && !("frame" in tab) ? tab.calls.find((call) => call.id === id) : undefined);
      setShown((current) => {
        const next = new Map(current);
        if (call) next.set(key, call);
        else if (current.get(key)?.id !== id) next.delete(key);
        return next;
      });
    },
    hidesFileCard(fileId: string) { return [...shown().values()].some((call) => call.result?.view?.file?.fileId === fileId); },
    panel,
    frame,
    tabs,
    activeKey,
    activate,
    isTab,
    restore(saved: SavedAppViews | undefined) {
      if (!saved) return;
      selectedScope = chatScope?.();
      const existing = selections();
      const previousActive = activeKey();
      const restored: ReturnType<typeof selections> = [];
      for (const entry of saved.tabs) {
        if (restored.some((selection) => selection.tab.key === entry.key)) continue;
        const open = existing.find((selection) => selection.tab.key === entry.key);
        const view = projection().get(entry.key);
        if (open) restored.push(open);
        else if (view) restored.push({ session: sessionId(), tab: view, order: [...view.calls] });
        else if (entry.frame) restored.push({ session: sessionId(), tab: { key: entry.key, frame: { kind: "dashboard", ...entry.frame } }, order: [] });
      }
      restored.push(...existing.filter((selection) => !restored.some((item) => item.tab.key === selection.tab.key)));
      setSelections(restored);
      setActiveKey(existing.length ? previousActive : restored.find((selection) => selection.tab.key === saved.active)?.tab.key ?? restored[0]?.tab.key);
      persist();
    },
    move(key: string, index: number) {
      setSelections((current) => {
        const from = current.findIndex((selection) => selection.tab.key === key);
        if (from < 0) return current;
        const next = [...current];
        const [selection] = next.splice(from, 1);
        next.splice(Math.max(0, Math.min(index, next.length)), 0, selection);
        return next;
      });
      persist();
    },
    closeTab(key: string) {
      const index = tabs().findIndex((tab) => tab.key === key);
      if (index < 0) return;
      const remaining = selections().filter((selection) => selection.tab.key !== key);
      setSelections(remaining);
      if (activeKey() === key) setActiveKey(remaining[index]?.tab.key ?? remaining[index - 1]?.tab.key);
      persist();
    },
    openFrame(frame: DashboardFrame) {
      selectedScope = chatScope?.();
      const key = viewKey({ server: "yoplai", resourceUri: "ui://yoplai/dashboard", key: frame.id });
      if (!isTab(key)) setSelections((current) => [...current, { session: sessionId(), tab: { key, frame }, order: [] }]);
      setActiveKey(key);
      persist();
    },
    open(key: string) {
      if (isTab(key)) {
        selectedScope = chatScope?.();
        activate(key);
        return;
      }
      const view = projection().get(key);
      if (view) {
        selectedScope = chatScope?.();
        setSelections((current) => [...current, { session: sessionId(), tab: view, order: [...view.calls] }]);
        setActiveKey(key);
        persist();
      }
    },
    close,
    viewOf,
    roleOf(id: string): "host" | "link" | "panel-card" | "none" {
      const view = viewOf(id);
      return !view ? "none" : view.host.id === id ? isTab(view.key) ? "panel-card" : "host" : "link";
    },
  };
}
