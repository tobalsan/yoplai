import { createComputed, createMemo, createSignal, on, type Accessor } from "solid-js";
import type { McpAppView, McpAppViewReference } from "@yoplai/shared/types";
import type { HistoryViewMode, FullToolResultMessage } from "../../api/types";
import type { ChatTranscriptSession } from "./ChatTranscript";
import type { ChatToolCall } from "./chat-history";
import { extractBlockText } from "../../lib/history";

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

export type AppViews = ReturnType<typeof createAppViews>;

export function viewKey(view: Pick<McpAppViewReference, "server" | "resourceUri" | "file" | "key">): string {
  const key = view.key ?? view.file?.filename;
  return view.server + "\n" + view.resourceUri + (key !== undefined ? "\n" + key : "");
}

export function createAppViews(sessionId: Accessor<string | null | undefined>, calls: Accessor<AppViewCall[]>, chatScope?: Accessor<string>) {
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
  const [selected, setSelected] = createSignal<{
    session: string | null | undefined;
    view: AppView;
    order: AppViewCall[];
  }>();
  const [standalone, setStandalone] = createSignal<DashboardFrame>();
  let selectedScope: string | undefined;
  function close() {
    setSelected(undefined);
    setStandalone(undefined);
  }
  if (chatScope) createComputed(on(chatScope, (current, previous) => {
    if (current !== previous) {
      if (current !== selectedScope) close();
      setShown(new Map());
    }
  }));
  createComputed(on(sessionId, (current, previous) => {
    if (current !== previous) {
      if (!previous && current && (standalone() || selected())) {
        setSelected((selection) => selection ? { ...selection, session: current } : undefined);
      } else close();
      setShown(new Map());
    }
  }));
  createComputed(() => {
    const frame = standalone();
    if (!frame) return;
    const view = projection().get(viewKey({ server: "yoplai", resourceUri: "ui://yoplai/dashboard", key: frame.id }));
    if (view) {
      setSelected({ session: sessionId(), view, order: [...view.calls] });
      setStandalone(undefined);
    }
  });
  const panel = createMemo(() => {
    const selection = selected();
    if (!selection || selection.session !== sessionId()) return undefined;
    const current = projection().get(selection.view.key);
    if (current) {
      // Remember observed call order: an older reconnect snapshot must not roll back the panel.
      const order = selection.order;
      const includesLatest = current.calls.some((call) => call.id === selection.view.latest.id);
      current.calls.forEach((call, index) => {
        if (order.some((known) => known.id === call.id)) return;
        const next = current.calls.slice(index + 1).find((item) => order.some((known) => known.id === item.id));
        let before = next ? order.findIndex((known) => known.id === next.id) : order.findIndex((known) => known.timestamp > call.timestamp);
        if (before < 0 && !includesLatest && call.timestamp <= selection.view.latest.timestamp) before = order.findIndex((known) => known.id === selection.view.latest.id);
        order.splice(before < 0 ? order.length : before, 0, call);
      });
      const position = (id: string) => order.findIndex((call) => call.id === id);
      if (position(current.latest.id) >= position(selection.view.latest.id)) selection.view = current;
    }
    return selection.view;
  });
  return {
    isLiveDuplicate(id: string) { return historyIds().has(id); },
    fileOf(id: string) {
      return source().find((call) => call.id === id && call.result?.view?.file)?.result?.view?.file
        ?? [...shown().values()].find((call) => call.id === id)?.result?.view?.file
        ?? panel()?.calls.find((call) => call.id === id)?.result?.view?.file;
    },
    shownFileOf(key: string) { return shown().get(key)?.result?.view?.file; },
    shownCallOf(key: string) { return shown().get(key)?.id; },
    reportShown(key: string, id: string | undefined) {
      const call = projection().get(key)?.calls.find((call) => call.id === id)
        ?? (panel()?.key === key ? panel()?.calls.find((call) => call.id === id) : undefined);
      setShown((current) => {
        const next = new Map(current);
        if (call) next.set(key, call);
        else if (current.get(key)?.id !== id) next.delete(key);
        return next;
      });
    },
    hidesFileCard(fileId: string) { return [...shown().values()].some((call) => call.result?.view?.file?.fileId === fileId); },
    panel,
    frame: standalone,
    openFrame(frame: DashboardFrame) {
      selectedScope = chatScope?.();
      setSelected(undefined);
      setStandalone(frame);
    },
    open(key: string) {
      const view = projection().get(key);
      if (view) {
        selectedScope = chatScope?.();
        setStandalone(undefined);
        setSelected({ session: sessionId(), view, order: [...view.calls] });
      }
    },
    close,
    viewOf,
    roleOf(id: string): "host" | "link" | "panel-card" | "none" {
      const view = viewOf(id);
      return !view ? "none" : view.host.id === id ? panel()?.key === view.key ? "panel-card" : "host" : "link";
    },
  };
}
