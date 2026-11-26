import { createEffect, createMemo, createSignal, For, Index, onCleanup, Show } from "solid-js";
import type { FeedDetail, FeedItem, FeedToolCall, TurnPlan } from "@yoplai/shared/types";
import type { FullToolResultMessage, HistoryViewMode } from "../../api/types";
import { fetchFeedDetail } from "../../api/feed";
import { formatTimestamp } from "../../lib/format";
import { groupActivityItems } from "../../lib/chat-activity";
import { writeReplyClipboard } from "../../lib/clipboard";
import { formatReplyClipboard } from "../../lib/reply-clipboard";
import { CopyButton } from "../CopyButton";
import { ActivityGroup, AssistantText, McpAppToolRow, type ActivityItem } from "./ChatBlocks";
import type { AppViewCall, AppViews } from "./appViews";
import type { createFeedWindow } from "./feed-window";

type Assistant = Extract<FeedItem, { role: "assistant" }>;

export function createFeedDetails(agentId: string, beforeChange: () => void) {
  type Cached = { text: string; count: number; activity?: string; detail?: FeedDetail; controller: AbortController };
  const cache = new Map<string, Cached>();
  const [revision, setRevision] = createSignal(0);
  onCleanup(() => cache.forEach(({ controller }) => controller.abort()));

  const matches = (entry: Cached | undefined, item: Assistant) =>
    entry?.text === item.text && entry.count === item.toolCallCount;

  return {
    get(item: FeedItem) {
      if (item.role !== "assistant" || !item.toolCallCount) return undefined;
      revision();
      const entry = cache.get(item.id);
      return matches(entry, item) ? entry?.detail : undefined;
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
      const detail = matching ? previous?.detail : undefined;
      const controller = new AbortController();
      const entry = { text: item.text, count: item.toolCallCount, activity, controller, detail };
      cache.set(item.id, entry);
      void fetchFeedDetail(agentId, item.id, controller.signal).then((detail) => {
        if (controller.signal.aborted) return;
        beforeChange();
        cache.set(item.id, { ...entry, detail });
        setRevision((value) => value + 1);
      }, () => {
        if (controller.signal.aborted) return;
        cache.delete(item.id);
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

function FeedActivity(props: TranscriptProps & {
  reasoning: string[];
  calls: FeedToolCall[];
  timestamp: number;
  live?: boolean;
}) {
  const groups = createMemo(() => {
    const items: ActivityItem[] = [
      ...props.reasoning.map((content): ActivityItem => ({ type: "thinking", content })),
      ...props.calls.map((call): ToolRow => ({
        type: "tool", id: call.id, name: call.name, arguments: call.arguments,
        parentToolCallId: call.parentToolCallId, status: call.status,
        result: toolResult(call, props.timestamp), at: props.timestamp,
      })).filter((call) => !props.live || !call.result?.view || !props.appViews.isLiveDuplicate(call.id)),
    ];
    return groupActivityItems(items, (item) => item.type === "thinking" || !item.result?.view);
  });
  return <Index each={groups()}>{(group) => {
    const activity = () => {
      const current = group();
      return current.kind === "activity" ? current.items : undefined;
    };
    const app = () => {
      const current = group();
      return current.kind === "message" ? current.item as ToolRow : undefined;
    };
    return <>
      <Show when={activity()}>
        {(items) => <ActivityGroup items={items()} simple={props.mode === "simple"} streaming={props.live} working={props.live} />}
      </Show>
      <Show when={app()}>
        {(call) => <McpAppToolRow agentId={props.agentId} sessionId={props.sessionId} appViews={props.appViews}
          onUserMessage={props.onUserMessage} toolCallId={call().id} name={call().name}
          arguments={call().arguments} result={call().result} />}
      </Show>
    </>;
  }}</Index>;
}

const reasons = { threshold: "Threshold", overflow: "Overflow", manual: "Manual" };

function seamDescription(item: Extract<FeedItem, { role: "seam" }>) {
  const count = item.carried.indexed;
  return `${reasons[item.reason]} · ${count === 0 ? "No older requests" : `${count} older request${count === 1 ? "" : "s"}`} carried`;
}

const stepLabels = { pending: "Pending", in_progress: "In progress", completed: "Completed" };

function TurnChecklist(props: { plan: TurnPlan }) {
  return <div class="feed-plan">
    <Show when={props.plan.explanation}>
      {(caption) => <div class="feed-plan-caption" title={caption()}>{caption()}</div>}
    </Show>
    <ul role="list" aria-label="Turn plan">
      <Index each={props.plan.steps}>{(step) => <li>
        <span class="feed-plan-box" role="img" aria-label={stepLabels[step().status]} data-status={step().status} />
        <span>{step().text}</span>
      </li>}</Index>
    </ul>
  </div>;
}

export function FeedTranscript(props: TranscriptProps & {
  feed: ReturnType<typeof createFeedWindow>;
  details: ReturnType<typeof createFeedDetails>;
  flashing?: string;
}) {
  const items = createMemo(() => new Map(props.feed.items().map((item) => [item.id, item])));
  const visible = new Map<Element, (visible: boolean) => void>();
  const observer = typeof IntersectionObserver === "function"
    ? new IntersectionObserver((entries) => {
      for (const entry of entries) visible.get(entry.target)?.(entry.isIntersecting);
    }, { rootMargin: "400px 0px" })
    : undefined;
  onCleanup(() => observer?.disconnect());
  const live = () => props.feed.detached() ? null : props.feed.live();
  const runningAnswer = createMemo((previous: string | undefined) => {
    if (!props.feed.live()) return undefined;
    if (props.feed.detached()) return previous;
    const item = props.feed.items().at(-1);
    return item?.role === "assistant" ? item.id : undefined;
  });
  // A result may settle without changing the answer text or tool count.
  const liveActivity = createMemo(() => {
    const current = props.feed.live();
    return current && JSON.stringify([current.runId, current.toolCalls.map(({ id, status }) => [id, status])]);
  });
  const liveCalls = createMemo(() => new Set(live()?.toolCalls.map(({ id }) => id)));

  return <>
    <Show when={props.feed.status() === "loading" && !props.feed.items().length}>
      <div class="feed-notice" role="status">Loading messages…</div>
    </Show>
    <Show when={props.feed.status() === "not-found"}><div class="feed-notice" role="status">Message not found.</div></Show>
    <Show when={props.feed.status() === "error"}><div class="feed-notice" role="alert">Could not load messages.</div></Show>
    <For each={props.feed.items().map(({ id }) => id)}>{(id) => {
      const item = createMemo((previous: FeedItem) => items().get(id) ?? previous, items().get(id)!);
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
        if (near()) props.details.load(item(), runningAnswer() === id ? liveActivity() ?? undefined : undefined);
      });
      const detail = () => props.details.get(item());
      const assistant = () => {
        const current = item();
        return current.role === "assistant" ? current : undefined;
      };
      const storedPlan = () => runningAnswer() === id && live()?.plan ? undefined : assistant()?.plan;
      const user = () => {
        const current = item();
        return current.role === "user" ? current : undefined;
      };
      const seam = () => {
        const current = item();
        return current.role === "seam" ? current : undefined;
      };
      const failure = () => {
        const current = item();
        return current.role === "failure" ? current : undefined;
      };
      return <div ref={observe} class="feed-row" data-feed-message={id} classList={{ "feed-flash": props.flashing === id }}>
        <Show when={user()}>
          {(message) => <div class="message user no-anim">
            <div class="content">{message().text}</div>
            <div class="message-time">
              {message().sender}{message().surface && message().surface !== "web" ? ` · ${message().surface}` : ""} · {formatTimestamp(message().timestamp)}
            </div>
          </div>}
        </Show>
        <Show when={assistant()}>
          {(message) => <>
            <Show when={detail()}>
              {(loaded) => <FeedActivity agentId={props.agentId} sessionId={props.sessionId} appViews={props.appViews}
                onUserMessage={props.onUserMessage} mode={props.mode} reasoning={loaded().reasoning}
                calls={loaded().toolCalls.filter((call) => call.view || call.result?.view || !liveCalls().has(call.id))}
                timestamp={message().timestamp} />}
            </Show>
            <Show when={message().text || message().deliveries?.length || storedPlan()}>
              <div class="message assistant no-anim" classList={{ "full-message": props.mode === "full" }}>
                <Show when={message().text}>
                  <AssistantText class="content markdown-content" text={message().text} options={{ copyCode: true }} />
                </Show>
                <Show when={storedPlan()}>{(plan) => <TurnChecklist plan={plan()} />}</Show>
                <div class="message-time">
                  {formatTimestamp(message().timestamp)}
                  <For each={message().deliveries}>{(delivery) => <span>{delivery.surface} · {delivery.state}</span>}</For>
                  <Show when={message().text}>
                    <CopyButton label="Copy reply" copy={() => writeReplyClipboard(formatReplyClipboard([message().text]))} />
                  </Show>
                </div>
              </div>
            </Show>
          </>}
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
    <Show when={live()}>
      {(answer) => <>
        <Show when={answer().reasoning.length || answer().toolCalls.length}>
          <FeedActivity agentId={props.agentId} sessionId={props.sessionId} appViews={props.appViews}
            onUserMessage={props.onUserMessage} mode={props.mode} reasoning={answer().reasoning}
            calls={answer().toolCalls} timestamp={Date.now()} live />
        </Show>
        <Show when={answer().text || answer().plan}>
          <div class="message assistant streaming no-anim" classList={{ "full-message": props.mode === "full" }}>
            <Show when={answer().text}>
              <AssistantText class="content markdown-content" text={answer().text} options={{ copyCode: true }} />
            </Show>
            <Show when={answer().plan}>{(plan) => <TurnChecklist plan={plan()} />}</Show>
          </div>
        </Show>
      </>}
    </Show>
  </>;
}
