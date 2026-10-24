// Flicker rules: keep immutable streamingBlocks() reads, Index lists and non-keyed
// boolean Show branches; grouping creates new objects each chunk. Read inner values
// through accessors and retain history/block references used by reply copying.
import { createMemo, For, Index, Show, Switch, Match, type JSX, type Accessor } from "solid-js";
import type { HistoryViewMode, FullHistoryMessage, FullToolResultMessage, ContentBlock, FileBlock, ActiveToolCall } from "../../api/types";
import type { StreamingBlock, CompactStatus } from "./createChatSession";
import { groupActivityItems, streamingActivityItems, type ActivitySegment } from "../../lib/chat-activity";
import { formatTimestamp } from "../../lib/format";
import { formatReplyClipboard } from "../../lib/reply-clipboard";
import { writeReplyClipboard } from "../../lib/clipboard";
import { CopyButton } from "../CopyButton";
import { CompactionSummary, CompactStatusView, ActivityGroup, ContentBlocks, FileAttachmentList, FileCard, ModelMetaDisplay, ActiveToolIndicator, AssistantText, McpAppToolRow } from "./ChatBlocks";
import { userText, compactSummary, fullHistoryDisplayRows, type SimpleViewMessage, type SimpleToolMessage, type SimpleSummaryMessage, type FullDisplayRow } from "./chat-history";

export type ChatTranscriptSession = {
  appSessionId: Accessor<string | null | undefined>;
  simpleMessages: Accessor<SimpleViewMessage[]>;
  fullMessages: Accessor<FullHistoryMessage[]>;
  streamingBlocks: Accessor<StreamingBlock[]>;
  streamingText: Accessor<string>;
  streamingThinking: Accessor<string>;
  streamingToolCalls: Accessor<Array<{ id: string; parentToolCallId?: string; name: string; arguments: unknown; status: "running" | "done" | "error"; timestamp: number }>>;
  streamingFiles: Accessor<FileBlock[]>;
  streamingTextAt: Accessor<number | null>;
  streamingStartedAt: Accessor<number | null>;
  isStreaming: Accessor<boolean>;
  streamingFinished: Accessor<boolean>;
  showInterrupted: Accessor<boolean>;
  activeTools: Accessor<ActiveToolCall[]>;
  historyCursor: Accessor<string | undefined>;
  loadingEarlier: Accessor<boolean>;
  historyError: Accessor<string>;
  compactStatusForCurrentSession: Accessor<CompactStatus | undefined>;
  copyTurnFor(message: SimpleViewMessage | ContentBlock): string[] | undefined;
  shouldAnimate(id: string): boolean;
  loadEarlierHistory(): Promise<void>;
};

function activityItems<T>(segment: ActivitySegment<T>): T[] {
  return segment.kind === "activity" ? segment.items : [];
}

function SegmentView<T>(props: {
  segment: ActivitySegment<T>;
  activity: (items: () => T[]) => JSX.Element;
  message: (item: () => T) => JSX.Element;
}) {
  return (
    <Show
      when={props.segment.kind === "activity"}
      fallback={
        <Show when={messageItem(props.segment)}>
          {(item) => props.message(item as () => T)}
        </Show>
      }
    >
      {props.activity(() => activityItems(props.segment))}
    </Show>
  );
}

function messageItem<T>(segment: ActivitySegment<T>): T | undefined {
  return segment.kind === "message" ? segment.item : undefined;
}


export function ChatTranscript(props: { agentId: string; session: ChatTranscriptSession; viewMode: Accessor<HistoryViewMode> }) {
  const { simpleMessages, fullMessages, streamingBlocks, streamingText, streamingThinking, streamingToolCalls, streamingFiles, streamingTextAt, streamingStartedAt, isStreaming, streamingFinished, showInterrupted, activeTools, historyCursor, loadingEarlier, historyError, compactStatusForCurrentSession, copyTurnFor, shouldAnimate, loadEarlierHistory } = props.session;
  const viewMode = props.viewMode;
  const visibleFullMessages = fullMessages;
  // Build a map of toolCallId -> toolResult for grouping tool calls with their results
  const toolResultsMap = createMemo(() => {
    const map = new Map<string, FullToolResultMessage>();
    for (const msg of fullMessages()) {
      if (msg.role === "toolResult") {
        map.set(msg.toolCallId, msg);
      }
    }
    return map;
  });

  const fullDisplaySegments = createMemo(() =>
    groupActivityItems(
      fullHistoryDisplayRows(visibleFullMessages(), toolResultsMap()),
      (row) => row.kind === "activity"
    )
  );

  // Index of the last visible message at or before compaction settled; the
  // status renders right after it so later messages flow below. -1 = before
  // all messages; null = bottom (still running).
  const compactStatusAnchorIndex = createMemo((): number | null => {
    const at = compactStatusForCurrentSession()?.at;
    if (at === undefined) return null;
    const list: { role: string; timestamp: number }[] =
      viewMode() === "simple"
        ? simpleMessages()
        : fullHistoryDisplayRows(visibleFullMessages(), toolResultsMap()).map(
            (row) => visibleFullMessages()[row.historyIndex]
          );
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].role !== "toolResult" && list[i].timestamp <= at) return i;
    }
    return -1;
  });


  return <>
          <Show when={historyCursor()}>
            <button class="load-earlier" disabled={loadingEarlier()} onClick={() => void loadEarlierHistory()}>
              {loadingEarlier() ? "Loading earlier messages…" : "Load earlier messages"}
            </button>
          </Show>
          <Show when={historyError()}><div role="alert">{historyError()}</div></Show>
          <Show when={compactStatusAnchorIndex() === -1}>
            <CompactStatusView status={compactStatusForCurrentSession()} />
          </Show>

          <Show when={viewMode() === "simple"}>
            <Index
              each={groupActivityItems(
                simpleMessages(),
                (msg) => (msg.role === "tool" && !msg.viewCall) || msg.role === "thinking"
              )}
            >
              {(segment) => (
                <SegmentView
                  segment={segment()}
                  activity={(items) => (
                    <>
                      <ActivityGroup
                        simple
                        items={items().map((msg) =>
                          msg.role === "thinking"
                            ? {
                                type: "thinking" as const,
                                content: msg.content,
                                startedAt: msg.timestamp,
                                endedAt: msg.endedAt,
                              }
                            : {
                                type: "tool" as const,
                                id: msg.id,
                                parentToolCallId: (msg as SimpleToolMessage).parentToolCallId,
                                result: (msg as SimpleToolMessage).result,
                                name: (msg as SimpleToolMessage).toolName,
                                arguments: (msg as SimpleToolMessage).arguments,
                                at: msg.timestamp,
                              }
                        )}
                      />
                      <Show
                        when={segment().endIndex === compactStatusAnchorIndex()}
                      >
                        <CompactStatusView
                          status={compactStatusForCurrentSession()}
                        />
                      </Show>
                    </>
                  )}
                  message={(row) => {
                    const skipAnim = !shouldAnimate(row().id);
                    const visible = () => {
                      const message = row();
                      return message.role === "tool" ||
                        message.role === "thinking" || message.role === "compaction"
                        ? undefined
                        : message;
                    };
                    return (
                      <>
                        <Show when={row().role === "tool"}>
                          <McpAppToolRow agentId={props.agentId} sessionId={props.session.appSessionId()} toolCallId={row().id} name={(row() as SimpleToolMessage).toolName} arguments={(row() as SimpleToolMessage).arguments} result={(row() as SimpleToolMessage).result} />
                        </Show>
                        <Show when={row().role === "compaction"}>
                          <CompactionSummary text={(row() as SimpleSummaryMessage).content} timestamp={row().timestamp} />
                        </Show>
                        <Show when={visible()}>
                          {(item) => (
                            <div
                              class={`message ${item().role}${skipAnim ? " no-anim" : ""}`}
                              classList={{ "system-message": !!item().meta?.failure }}
                            >
                              {item().role === "assistant" ? (
                                <>
                                  <Show when={item().content}>
                                    <AssistantText class="content markdown-content" text={item().content} options={{ copyCode: true }} />
                                  </Show>
                                  <For each={item().files ?? []}>
                                    {(file) => <FileCard file={file} />}
                                  </For>
                                </>
                              ) : (
                                <>
                                  <div class="content">{item().content}</div>
                                  <FileAttachmentList files={item().files} />
                                </>
                              )}
                              <div class="message-time">
                                {formatTimestamp(item().timestamp)}
                                <Show when={copyTurnFor(row())}>
                                  {(texts) => <CopyButton label="Copy reply" copy={() => writeReplyClipboard(formatReplyClipboard(texts()))} />}
                                </Show>
                              </div>
                            </div>
                          )}
                        </Show>
                        <Show
                          when={
                            segment().endIndex === compactStatusAnchorIndex()
                          }
                        >
                          <CompactStatusView
                            status={compactStatusForCurrentSession()}
                          />
                        </Show>
                      </>
                    );
                  }}
                />
              )}
            </Index>
          </Show>

          <Show when={viewMode() === "full"}>
            <Index each={fullDisplaySegments()}>
              {(segment) => (
                <>
                <SegmentView
                  segment={segment()}
                  activity={(items) => (
                    <ActivityGroup
                      items={items().map(
                        (row) =>
                          (row as Extract<FullDisplayRow, { kind: "activity" }>)
                            .item
                      )}
                    />
                  )}
                  message={(row) => (
                    <Switch>
                      <Match when={row().kind === "mcp-app"}>
                        {(() => {
                          const app = () => row() as Extract<FullDisplayRow, { kind: "mcp-app" }>;
                          return <McpAppToolRow agentId={props.agentId} sessionId={props.session.appSessionId()} toolCallId={app().call.id} name={app().call.name} arguments={app().call.arguments} result={app().result} />;
                        })()}
                      </Match>
                      <Match when={row().kind === "assistant-content"}>
                        {(() => {
                          const assistantRow = () =>
                            row() as Extract<
                              FullDisplayRow,
                              { kind: "assistant-content" }
                            >;
                          return (
                            <div class="message assistant full-message" classList={{ "system-message": !!assistantRow().meta?.failure }}>
                              <Show
                                when={assistantRow().block.type === "text"}
                                fallback={
                                  <FileCard
                                    file={assistantRow().block as FileBlock}
                                  />
                                }
                              >
                                <AssistantText class="block-text markdown-content" text={(
                                      assistantRow().block as {
                                        type: "text";
                                        text: string;
                                      }
                                    ).text} options={{ copyCode: true }} />
                              </Show>
                              <Show when={assistantRow().footer}>
                                {assistantRow().meta && (
                                  <ModelMetaDisplay
                                    meta={assistantRow().meta!}
                                  />
                                )}
                                <div class="message-time">
                                  {formatTimestamp(assistantRow().timestamp)}
                                  <Show when={copyTurnFor(assistantRow().block)}>
                                    {(texts) => <CopyButton label="Copy reply" copy={() => writeReplyClipboard(formatReplyClipboard(texts()))} />}
                                  </Show>
                                </div>
                              </Show>
                            </div>
                          );
                        })()}
                      </Match>
                      <Match when={row().kind === "message"}>
                        {(() => {
                          const msg = () =>
                            (
                              row() as Extract<
                                FullDisplayRow,
                                { kind: "message" }
                              >
                            ).message;
                          return (
                            <>
                              <Show when={msg().role === "user"}>
                                <div class="message user">
                                  <Show when={userText(msg())}>
                                    <div class="content">{userText(msg())}</div>
                                  </Show>
                                  <FileAttachmentList
                                    files={msg().content.filter(
                                      (b): b is FileBlock => b.type === "file"
                                    )}
                                  />
                                  <div class="message-time">
                                    {formatTimestamp(msg().timestamp)}
                                  </div>
                                </div>
                              </Show>
                              <Show when={compactSummary(msg()) !== undefined}>
                                <CompactionSummary text={compactSummary(msg())!} timestamp={msg().timestamp} />
                              </Show>
                              <Show when={msg().role === "system" && compactSummary(msg()) === undefined}>
                                <div class="message assistant full-message system-message">
                                  <ContentBlocks
                                    blocks={msg().content}
                                    timestamp={msg().timestamp}
                                    toolResultsMap={toolResultsMap()}
                                  />
                                  <div class="message-time">
                                    {formatTimestamp(msg().timestamp)}
                                  </div>
                                </div>
                              </Show>
                            </>
                          );
                        })()}
                      </Match>
                    </Switch>
                  )}
                />
                <Show when={segment().endIndex === compactStatusAnchorIndex()}>
                  <CompactStatusView status={compactStatusForCurrentSession()} />
                </Show>
                </>
              )}
            </Index>
          </Show>

          {/* Streaming content in full mode - show blocks incrementally */}
          <Show
            when={
              viewMode() === "full" &&
              (isStreaming() || streamingFinished()) &&
              (streamingBlocks().length > 0 ||
                streamingText() ||
                streamingFiles().length > 0)
            }
          >
            <div
              class="message assistant full-message"
              classList={{ streaming: isStreaming() }}
            >
              <div class="content-blocks">
                <Index
                  each={groupActivityItems(
                    streamingBlocks(),
                    (block) =>
                      block.type === "thinking" || (block.type === "toolCall" && !block.view)
                  )}
                >
                  {(segmentAccessor) => {
                    const segment = () => segmentAccessor();
                    return (
                      <SegmentView
                        segment={segment()}
                        activity={() => (
                          <ActivityGroup
                            streaming={isStreaming()}
                            working={
                              isStreaming() &&
                              segment().endIndex ===
                                streamingBlocks().length - 1
                            }
                            items={streamingActivityItems<
                              StreamingBlock,
                              FullToolResultMessage
                            >(
                              streamingBlocks(),
                              segment() as ActivitySegment<StreamingBlock> & {
                                kind: "activity";
                              },
                              isStreaming(),
                              true
                            )}
                          />
                        )}
                        message={() => {
                          const block = () => messageItem(segment());
                          return (
                            <Switch>
                              <Match when={block()?.type === "text"}>
                                <AssistantText class="block-text markdown-content" text={(block() as { text: string }).text} options={{ copyCode: true }} />
                              </Match>
                              <Match when={block()?.type === "toolCall"}>
                                <McpAppToolRow agentId={props.agentId} sessionId={props.session.appSessionId()} toolCallId={(block() as Extract<StreamingBlock, { type: "toolCall" }>).id} result={(block() as Extract<StreamingBlock, { type: "toolCall" }>).result} name={(block() as Extract<StreamingBlock, { type: "toolCall" }>).name} arguments={(block() as Extract<StreamingBlock, { type: "toolCall" }>).arguments} />
                              </Match>
                              <Match when={block()?.type === "file"}>
                                <FileCard file={block() as FileBlock} />
                              </Match>
                            </Switch>
                          );
                        }}
                      />
                    );
                  }}
                </Index>
              </div>
              <Show
                when={
                  streamingStartedAt() &&
                  streamingBlocks().some(
                    (block) => block.type === "text" || block.type === "file"
                  )
                }
              >
                <div class="message-time">
                  {formatTimestamp(streamingStartedAt()!)}
                </div>
              </Show>
            </div>
          </Show>

          {/* Streaming content in simple mode */}
          <Show
            when={
              viewMode() === "simple" &&
              isStreaming() &&
              (streamingBlocks().length > 0 ||
                streamingText() ||
                streamingFiles().length > 0)
            }
          >
            <div class="simple-stream-blocks">
              <Show when={streamingBlocks().length === 0 && streamingText()}>
                <div class="message assistant streaming">
                  <AssistantText class="content markdown-content" text={streamingText()} options={{ copyCode: true }} />
                  {(streamingTextAt() || streamingStartedAt()) && (
                    <div class="message-time">
                      {formatTimestamp(
                        (streamingTextAt() ?? streamingStartedAt()) as number
                      )}
                    </div>
                  )}
                </div>
              </Show>
              <Index
                each={groupActivityItems(
                  streamingBlocks(),
                  (block) =>
                    block.type === "thinking" || (block.type === "toolCall" && !block.view)
                )}
              >
                {(segmentAccessor) => {
                  const segment = () => segmentAccessor();
                  return (
                    <SegmentView
                      segment={segment()}
                      activity={() => (
                        <ActivityGroup
                          simple
                          streaming={isStreaming()}
                          working={
                            isStreaming() &&
                            segment().endIndex === streamingBlocks().length - 1
                          }
                          items={streamingActivityItems<
                            StreamingBlock,
                            FullToolResultMessage
                          >(
                            streamingBlocks(),
                            segment() as ActivitySegment<StreamingBlock> & {
                              kind: "activity";
                            },
                            isStreaming(),
                            false
                          )}
                        />
                      )}
                      message={() => {
                        const block = () => messageItem(segment());
                        return (
                          <Switch>
                            <Match when={block()?.type === "text"}>
                              <div class="message assistant streaming">
                                <AssistantText class="content markdown-content" text={(block() as { text: string }).text} options={{ copyCode: true }} />
                                <div class="message-time">
                                  {formatTimestamp(block()!.timestamp)}
                                </div>
                              </div>
                            </Match>
                            <Match when={block()?.type === "toolCall"}>
                                <McpAppToolRow agentId={props.agentId} sessionId={props.session.appSessionId()} toolCallId={(block() as Extract<StreamingBlock, { type: "toolCall" }>).id} result={(block() as Extract<StreamingBlock, { type: "toolCall" }>).result} name={(block() as Extract<StreamingBlock, { type: "toolCall" }>).name} arguments={(block() as Extract<StreamingBlock, { type: "toolCall" }>).arguments} />
                              </Match>
                              <Match when={block()?.type === "file"}>
                              <div class="message assistant">
                                <FileCard file={block() as FileBlock} />
                                <div class="message-time">
                                  {formatTimestamp(block()!.timestamp)}
                                </div>
                              </div>
                            </Match>
                          </Switch>
                        );
                      }}
                    />
                  );
                }}
              </Index>
              <Show when={streamingBlocks().length === 0}>
                <For each={streamingFiles()}>
                  {(file) => <FileCard file={file} />}
                </For>
              </Show>
            </div>
          </Show>

        {/* Thinking dots when waiting (nothing received yet) */}
        {isStreaming() &&
          !streamingThinking() &&
          streamingToolCalls().length === 0 &&
          !streamingText() &&
          streamingFiles().length === 0 && (
            <div class="message assistant thinking">
              <div class="thinking-dots">
                <span />
                <span />
                <span />
              </div>
              {streamingStartedAt() && (
                <div class="message-time">
                  {formatTimestamp(streamingStartedAt()!)}
                </div>
              )}
            </div>
          )}

        <Show
          when={
            viewMode() === "simple" &&
            activeTools().length > 0 &&
            streamingBlocks().length === 0
          }
        >
          <ActiveToolIndicator tools={activeTools()} />
        </Show>

        <Show when={showInterrupted()}>
          <div class="message interrupted">
            <div class="content">Interrupted</div>
          </div>
        </Show>

        <Show when={compactStatusAnchorIndex() === null}>
          <CompactStatusView status={compactStatusForCurrentSession()} />
        </Show>

        <div data-scroll-anchor />
  </>;
}
