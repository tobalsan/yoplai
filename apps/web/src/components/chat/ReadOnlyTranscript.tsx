import { createEffect, createMemo, onCleanup } from "solid-js";
import type { FullHistoryMessage } from "../../api/types";
import { showToast } from "../../lib/toast";
import { createAppViews } from "./appViews";
import { fullMessagesToSimpleView } from "./chat-history";
import { ChatTranscript, type ChatTranscriptSession } from "./ChatTranscript";

export function ReadOnlyTranscript(props: { agentId: string; messages: FullHistoryMessage[]; highlightHistoryIndex?: number }) {
  const messages = () => props.messages;
  const simple = createMemo(() => fullMessagesToSimpleView(messages()));
  const session: ChatTranscriptSession = {
    appSessionId: () => null,
    simpleMessages: simple,
    fullMessages: messages,
    streamingBlocks: () => [],
    streamingText: () => "",
    streamingThinking: () => "",
    streamingToolCalls: () => [],
    streamingFiles: () => [],
    streamingTextAt: () => null,
    streamingStartedAt: () => null,
    isStreaming: () => false,
    streamingFinished: () => false,
    showInterrupted: () => false,
    activeTools: () => [],
    historyCursor: () => undefined,
    loadingEarlier: () => false,
    historyError: () => "",
    compactStatusForCurrentSession: () => undefined,
    copyTurnFor: () => undefined,
    shouldAnimate: () => false,
    loadEarlierHistory: async () => {},
  };
  let scroller: HTMLDivElement | undefined;
  createEffect(() => {
    const index = props.highlightHistoryIndex;
    if (index === undefined) {
      if (scroller) scroller.scrollTop = 0;
      return;
    }
    simple();
    const frame = requestAnimationFrame(() => {
      const target = scroller?.querySelector(".legacy-message-highlight");
      if (target) target.scrollIntoView?.({ block: "center" });
      else if (scroller) scroller.scrollTop = 0;
    });
    onCleanup(() => cancelAnimationFrame(frame));
  });
  const appViews = createAppViews(() => null, () => []);
  const copyCode = async (event: MouseEvent) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLButtonElement>("button[data-copy-code]");
    if (!button) return;
    try {
      await navigator.clipboard.writeText(JSON.parse(button.dataset.copyCode!) as string);
      showToast("Code copied", "success");
    } catch {
      showToast("Could not copy code. Try again.", "error");
    }
  };
  return <div class="chat-body">
    <div class="messages" ref={scroller} onClick={(event) => void copyCode(event)}>
      <ChatTranscript agentId={props.agentId} session={session} viewMode={() => "simple"} appViews={appViews}
        readOnly highlightHistoryIndex={props.highlightHistoryIndex} />
    </div>
  </div>;
}
