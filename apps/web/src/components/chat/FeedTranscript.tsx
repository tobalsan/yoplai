import { createEffect, createMemo, createSignal, For, Index, onCleanup, Show } from "solid-js";
import type { FeedDetail, FeedItem, FeedLive, FeedToolCall, TurnPlan } from "@yoplai/shared/types";
import type { FullToolResultMessage, HistoryViewMode } from "../../api/types";
import { fetchFeedDetail } from "../../api/feed";
import { formatTimestamp } from "../../lib/format";
import { writeReplyClipboard } from "../../lib/clipboard";
import { formatReplyClipboard } from "../../lib/reply-clipboard";
import { CopyButton } from "../CopyButton";
import { ActivityGroup, AssistantText, McpAppToolRow, type ActivityItem } from "./ChatBlocks";
import type { AppViewCall, AppViews } from "./appViews";
import type { createFeedWindow } from "./feed-window";

type Assistant = Extract<FeedItem, { role: "assistant" }>;

export function createFeedDetails(agentId: string, beforeChange: () => void, threadId?: string) {
  type Cached = { text: string; count: number; activity?: string; detail?: FeedDetail; loaded?: true; controller: AbortController };
  const cache = new Map<string, Cached>();
  const [revision, setRevision] = createSignal(0);
  onCleanup(() => cache.forEach(({ controller }) => controller.abort()));

  const matches = (entry: Cached | undefined, item: Assistant) =>
    entry?.text === item.text && entry.count === item.toolCallCount;

  return {
    get(item: FeedItem, freshness?: "settled") {
      if (item.role !== "assistant" || !item.toolCallCount) return undefined;
      revision();
      const entry = cache.get(item.id);
      if (freshness === "settled" && (!entry?.loaded || entry.activity || !matches(entry, item))) return undefined;
      return entry?.detail;
    },
    load(item: FeedItem, activity?: string) {
      if (item.role !== "assistant" || !item.toolCallCount) return;
      const previous = cache.get(item.id);
      const matching = matches(previous, item);
      if (matching && previous?.activity === activity) return;
      previous?.controller.abort();
      cache.delete(item.id);
      const oldest = cache.size >= 200 ? cache.keys().next().value : undefined;
      if (oldest) {
        cache.get(oldest)?.controller.abort();
        cache.delete(oldest);
      }
      const detail = previous?.detail;
      const controller = new AbortController();
      const entry = { text: item.text, count: item.toolCallCount, activity, controller, detail };
      cache.set(item.id, entry);
      void fetchFeedDetail(agentId, item.id, controller.signal, threadId).then((detail) => {
        if (controller.signal.aborted) return;
        beforeChange();
        cache.set(item.id, { ...entry, detail, loaded: true });
        setRevision((value) => value + 1);
      }, () => {
        if (controller.signal.aborted) return;
        if (previous?.detail) cache.set(item.id, previous);
        else cache.delete(item.id);
      });
    },
  };
}

function toolResult(call: FeedToolCall, timestamp: number): FullToolResultMessage | undefined {
  const view = call.result?.view ?? call.view;
  if (!call.result && !view) return undefined;
  return {
    role: "toolResult",
    toolCallId: call.id,
    parentToolCallId: call.parentToolCallId,
    toolName: call.name,
    content: call.result?.text ? [{ type: "text", text: call.result.text }] : [],
    isError: call.isError,
    details: call.result?.diff ? { diff: call.result.diff } : undefined,
    view,
    timestamp,
  };
}

export function feedAppViewCalls(
  feed: ReturnType<typeof createFeedWindow>,
  details: ReturnType<typeof createFeedDetails>,
): AppViewCall[] {
  const forCalls = (calls: FeedToolCall[], timestamp: number, history: boolean) =>
    calls.flatMap((call) => {
      const result = toolResult(call, timestamp);
      return result?.view ? [{ id: call.id, timestamp, view: call.view, result, text: call.result?.text, history }] : [];
    });
  const live = feed.detached() ? null : feed.live();
  return [
    ...feed.items().flatMap((item) => forCalls(details.get(item)?.toolCalls ?? [], item.timestamp, true)),
    ...forCalls(live?.toolCalls ?? [], Date.now(), false),
  ];
}

type TranscriptProps = {
  agentId: string;
  sessionId?: string;
  mode: HistoryViewMode;
  appViews: AppViews;
  onUserMessage: (viewKey: string, text: string) => Promise<void>;
};
type ToolRow = Extract<ActivityItem, { type: "tool" }> & { id: string };
type TraceEntry = Extract<ActivityItem, { type: "thinking" }> | { type: "tool"; call: FeedToolCall };

function WorkingIndicator() {
  return <div class="message assistant thinking no-anim" role="status" aria-label="Working">
    <div class="thinking-dots" aria-hidden="true"><span /><span /><span /></div>
  </div>;
}

function FeedActivity(props: TranscriptProps & {
  detail?: FeedDetail;
  settled?: FeedDetail;
  live?: FeedLive;
  timestamp: number;
  waiting: boolean;
}) {
  const running = createMemo(() => !!props.live);
  // The live projection contains only one round. Keep earlier entries in place until
  // detail catches up, and update the overlapping call without losing its result.
  const entries = createMemo<TraceEntry[]>((previous) => {
    const settled = props.settled;
    if (settled) return [
      ...settled.reasoning.map((content): TraceEntry => ({ type: "thinking", content })),
      ...settled.toolCalls.map((call): TraceEntry => ({ type: "tool", call })),
    ];
    const next = previous.slice();
    const toolIndices = new Map(next.flatMap((entry, index) => entry.type === "tool" ? [[entry.call.id, index] as const] : []));
    for (const source of [props.detail, props.live]) {
      if (!source) continue;
      for (const content of source.reasoning) {
        const index = next.findIndex((entry) => entry.type === "thinking" &&
          (entry.content.startsWith(content) || content.startsWith(entry.content)));
        const earlier = next[index];
        if (!earlier) next.push({ type: "thinking", content });
        else if (earlier.type === "thinking" && content.length > earlier.content.length) {
          next[index] = { type: "thinking", content };
        }
      }
      for (const call of source.toolCalls) {
        const index = toolIndices.get(call.id);
        if (index === undefined) {
          toolIndices.set(call.id, next.length);
          next.push({ type: "tool", call });
          continue;
        }
        const existing = next[index] as Extract<TraceEntry, { type: "tool" }>;
        const state = call.status === "running" && existing.call.status !== "running" ? existing.call : call;
        next[index] = { type: "tool", call: {
          ...existing.call, ...call, status: state.status, isError: state.isError,
          result: call.result ?? existing.call.result, view: call.view ?? existing.call.view,
        } };
      }
    }
    return next;
  }, []);
  const rows = createMemo(() => {
    const activity: ActivityItem[] = [];
    const apps: ToolRow[] = [];
    for (const entry of entries()) {
      if (entry.type === "thinking") {
        activity.push(entry);
        continue;
      }
      const { call } = entry;
      const row: ToolRow = {
        type: "tool", id: call.id, name: call.name, arguments: call.arguments,
        parentToolCallId: call.parentToolCallId, status: call.status,
        result: toolResult(call, props.timestamp), at: props.timestamp,
      };
      if (row.result?.view) apps.push(row);
      else activity.push(row);
    }
    return { activity, apps };
  });
  return <>
    <Show when={props.waiting && entries().length === 0}><WorkingIndicator /></Show>
    <Show when={rows().activity.length}>
      <ActivityGroup items={rows().activity} simple={props.mode === "simple"} streaming={running()} working={running()} />
    </Show>
    <Index each={rows().apps}>
      {(call) => <McpAppToolRow agentId={props.agentId} sessionId={props.sessionId} appViews={props.appViews}
          onUserMessage={props.onUserMessage} toolCallId={call().id} name={call().name}
          arguments={call().arguments} result={call().result} />}
    </Index>
  </>;
}

const reasons = { threshold: "Threshold", overflow: "Overflow", manual: "Manual" };

function seamDescription(item: Extract<FeedItem, { role: "seam" }>) {
  const count = item.carried.indexed;
  return `${reasons[item.reason]} · ${count === 0 ? "No older requests" : `${count} older request${count === 1 ? "" : "s"}`} carried`;
}

const stepLabels = { pending: "Pending", in_progress: "In progress", completed: "Completed", attention: "Needs attention" };

function TurnChecklist(props: { plan: TurnPlan }) {
  return <div class="feed-plan">
    <div class="feed-plan-header">
      <strong>Plan for this task</strong>
      <span>{props.plan.steps.filter((step) => step.status === "completed").length} of {props.plan.steps.length} done</span>
    </div>
    <Show when={props.plan.explanation}>
      {(caption) => <div class="feed-plan-caption" title={caption()}>{caption()}</div>}
    </Show>
    <ul role="list" aria-label="Turn plan">
      <Index each={props.plan.steps}>{(step) => <li>
        <span class="feed-plan-box" role="img" aria-label={stepLabels[step().status]} data-status={step().status}>
          <Show when={step().status === "attention"}><i class="fa-solid fa-exclamation" aria-hidden="true" /></Show>
        </span>
        <div>
          <span>{step().text}</span>
          <Show when={step().note}>{(note) => <div class="feed-plan-note">{note()}</div>}</Show>
        </div>
      </li>}</Index>
    </ul>
  </div>;
}

export function FeedTranscript(props: TranscriptProps & {
  feed: ReturnType<typeof createFeedWindow>;
  details: ReturnType<typeof createFeedDetails>;
  sending: boolean;
  flashing?: string;
  showUserActions?: boolean;
  onStartThread?: (messageId: string) => void;
  threadActionBusy?: boolean;
}) {
  const live = createMemo(() => props.feed.detached() ? null : props.feed.live());
  const running = createMemo(() => !!live());
  const transcript = createMemo(() => {
    const rows = new Map<string, FeedItem | undefined>();
    let turn = "answer:";
    for (const item of props.feed.items()) {
      if (item.role === "assistant") {
        rows.set(turn, item);
      } else {
        rows.set(item.id, item);
        if (item.role !== "seam") turn = "answer:" + item.id;
      }
    }
    // The answer occupies the same slot before and after it gets a server ID.
    if (running() && !rows.has(turn)) rows.set(turn, undefined);
    return { rows, running: running() ? turn : undefined };
  });
  const visible = new Map<Element, (visible: boolean) => void>();
  const observer = typeof IntersectionObserver === "function"
    ? new IntersectionObserver((entries) => {
      for (const entry of entries) visible.get(entry.target)?.(entry.isIntersecting);
    }, { rootMargin: "400px 0px" })
    : undefined;
  onCleanup(() => observer?.disconnect());
  // A result may settle without changing the answer text or tool count.
  const liveActivity = createMemo(() => {
    const current = props.feed.live();
    return current && JSON.stringify([current.runId, current.toolCalls.map(({ id, status }) => [id, status])]);
  });
  const showWorking = () => {
    if (live()) return false;
    const last = props.feed.items().at(-1);
    return !!props.feed.pendingSends().length || (props.sending && (!last || last.role === "user"));
  };

  const StartThreadButton = (button: { id: string }) => (
    <Show when={props.onStartThread}>
      <button type="button" class="copy-button feed-branch-button" disabled={props.threadActionBusy}
        title="Start a thread from here" aria-label="Start a thread from here" onClick={() => props.onStartThread?.(button.id)}>
        <i class="fa-solid fa-code-branch" aria-hidden="true" />
      </button>
    </Show>
  );

  return <>
    <Show when={props.feed.status() === "loading" && !props.feed.items().length}>
      <div class="feed-notice" role="status">Loading messages…</div>
    </Show>
    <Show when={props.feed.status() === "not-found"}><div class="feed-notice" role="status">Message not found.</div></Show>
    <Show when={props.feed.status() === "error"}><div class="feed-notice" role="alert">Could not load messages.</div></Show>
    <For each={[...transcript().rows.keys()]}>{(key) => {
      const item = createMemo(() => transcript().rows.get(key));
      const isRunning = createMemo(() => transcript().running === key);
      const activity = () => isRunning() ? live() ?? undefined : undefined;
      const [near, setNear] = createSignal(false);
      const observe = (row: HTMLElement) => {
        visible.set(row, setNear);
        observer?.observe(row);
        onCleanup(() => {
          observer?.unobserve(row);
          visible.delete(row);
        });
      };
      createEffect(() => {
        const message = item();
        if (near() && message) props.details.load(message, isRunning() ? liveActivity() ?? undefined : undefined);
      });
      const assistant = () => {
        const current = item();
        return current?.role === "assistant" ? current : undefined;
      };
      const detail = createMemo(() => {
        const message = assistant();
        return message && props.details.get(message);
      });
      const settledDetail = createMemo(() => {
        const message = assistant();
        return !isRunning() && message ? props.details.get(message, "settled") : undefined;
      });
      const timedAssistant = () => {
        const message = assistant();
        return message && (!isRunning() || message.text || message.deliveries?.length) ? message : undefined;
      };
      const plan = () => activity()?.plan ?? assistant()?.plan;
      const user = () => {
        const current = item();
        return current?.role === "user" ? current : undefined;
      };
      const seam = () => {
        const current = item();
        return current?.role === "seam" ? current : undefined;
      };
      const failure = () => {
        const current = item();
        return current?.role === "failure" ? current : undefined;
      };
      const text = () => {
        const stored = assistant()?.text;
        const partial = activity()?.text;
        return stored && partial && stored !== partial ? stored + "\n" + partial : partial || stored;
      };
      const timestamp = Date.now();
      return <div ref={observe} class="feed-row" data-feed-message={item()?.id} classList={{ "feed-flash": !!item() && props.flashing === item()?.id }}>
        <Show when={user()}>
          {(message) => <>
            <div class="message user no-anim">
              <div class="content">{message().text}</div>
              <div class="message-time">
                {message().sender}{message().surface && message().surface !== "web" ? ` · ${message().surface}` : ""} · {formatTimestamp(message().timestamp)}
              </div>
            </div>
            <Show when={props.showUserActions}>
              <div class="feed-user-actions">
                <CopyButton label="Copy message" copy={() => writeReplyClipboard(formatReplyClipboard([message().text]))} />
                <StartThreadButton id={message().id} />
              </div>
            </Show>
          </>}
        </Show>
        <Show when={key.startsWith("answer:")}>
          <FeedActivity agentId={props.agentId} sessionId={props.sessionId} appViews={props.appViews}
            onUserMessage={props.onUserMessage} mode={props.mode} live={activity()}
            detail={detail()} settled={settledDetail()} timestamp={assistant()?.timestamp ?? timestamp}
            waiting={!!activity() && !text() && !assistant()?.toolCallCount} />
          <Show when={text() || assistant()?.deliveries?.length || plan()}>
            <div class="message assistant no-anim" classList={{ "full-message": props.mode === "full", streaming: isRunning() }}>
              <Show when={text()}>{(content) =>
                <AssistantText class="content markdown-content" text={content()} options={{ copyCode: true }} />
              }</Show>
              <Show when={plan()}>{(current) => <TurnChecklist plan={current()} />}</Show>
              <Show when={timedAssistant()}>
                {(message) => <div class="message-time">
                    {formatTimestamp(message().timestamp)}
                    <For each={message().deliveries}>{(delivery) => <span>{delivery.surface} · {delivery.state}</span>}</For>
                    <Show when={message().text}>
                      <CopyButton label="Copy reply" copy={() => writeReplyClipboard(formatReplyClipboard([message().text]))} />
                      <StartThreadButton id={message().id} />
                    </Show>
                </div>}
              </Show>
            </div>
          </Show>
        </Show>
        <Show when={seam()}>
          {(marker) => <div class="feed-seam" tabIndex={0} title={seamDescription(marker())}
            aria-description={seamDescription(marker())}>{marker().text}</div>}
        </Show>
        <Show when={failure()}>
          {(notice) => <div class="message assistant system-message no-anim" role="status"
            classList={{ "tool-interrupted": notice().kind === "tool_interrupted" }}>{notice().text}</div>}
        </Show>
      </div>;
    }}</For>
    <Show when={!props.feed.detached()}>
      <For each={props.feed.pendingSends()}>{(send) =>
        <div class="message user no-anim">
          <div class="content">{send.text}</div>
          <div class="message-time">{formatTimestamp(send.timestamp)}</div>
        </div>
      }</For>
      <Show when={showWorking()}><WorkingIndicator /></Show>
    </Show>
  </>;
}
