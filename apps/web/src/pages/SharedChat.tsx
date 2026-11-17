import { useParams } from "@solidjs/router";
import { Show, createMemo, createResource, createSignal } from "solid-js";
import { fetchSharedChat } from "../api/chat-shares";
import { ChatTranscript, type ChatTranscriptSession } from "../components/chat/ChatTranscript";
import { createAppViews } from "../components/chat/appViews";
import { fullMessagesToSimpleView } from "../components/chat/chat-history";
import chatViewStyles from "../components/chat/ChatView.css?inline";
import { showToast } from "../lib/toast";

export function SharedChat() {
  const params = useParams<{ token: string }>();
  const [error, setError] = createSignal("");
  const [chat] = createResource(() => params.token, (token) => {
    setError("");
    return fetchSharedChat(token).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "Could not load this chat. Reload to try again.");
      return null;
    });
  });
  const messages = () => chat()?.messages ?? [];
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
  return <div class="chat-view hero-sent shared-chat">
    <style>{chatViewStyles}</style>
    <main class="chat-main">
      <Show when={!chat.loading} fallback={<p role="status" class="shared-chat-status">Loading shared chat…</p>}>
        <Show when={chat()} fallback={<p role={error() ? "alert" : "status"} class="shared-chat-status">{error() || "This link is not available."}</p>}>
          {(current) => <>
            <header class="shared-chat-banner">
              <strong>Shared, read-only</strong>
              <h1>{current().title}</h1>
              <span>{current().agentName}</span>
            </header>
            <div class="chat-body">
              <div class="messages" onClick={(event) => void copyCode(event)}>
                <ChatTranscript agentId={current().agentId} session={session} viewMode={() => "simple"} appViews={appViews} readOnly />
              </div>
            </div>
          </>}
        </Show>
      </Show>
    </main>
    <style>{`
      .shared-chat-banner { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 16px; padding: 16px max(18px, calc((100% - var(--transcript-width)) / 2 + 18px)); border-bottom: 1px solid var(--surface-2); }
      .shared-chat-banner strong, .shared-chat-banner span { color: var(--text-secondary); font-size: 13px; font-weight: 400; }
      .shared-chat-banner h1 { flex: 1 1 200px; margin: 0; color: var(--text-primary); font-size: 16px; font-weight: 600; overflow-wrap: anywhere; }
      .shared-chat-status { padding: 24px; color: var(--text-secondary); }
      @media (max-width: 768px) {
        .shared-chat-banner { padding-left: 64px; min-height: 68px; }
        .shared-chat-status { padding-left: 64px; }
      }
    `}</style>
  </div>;
}
