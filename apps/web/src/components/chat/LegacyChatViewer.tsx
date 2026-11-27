import { useLocation, useNavigate } from "@solidjs/router";
import { createResource, createSignal, onCleanup, Show } from "solid-js";
import { continueLegacyChat, fetchLegacyChat } from "../../api/legacy-sessions";
import { Button } from "../ui/Button";
import { ReadOnlyTranscript } from "./ReadOnlyTranscript";
import chatViewStyles from "./ChatView.css?inline";

export function LegacyChatViewer(props: { agentId: string; sessionId: string }) {
  const location = useLocation();
  const navigate = useNavigate();
  const lifetime = new AbortController();
  onCleanup(() => lifetime.abort());
  const requestSignal = () => AbortSignal.any([lifetime.signal, AbortSignal.timeout(15_000)]);
  const [loadFailed, setLoadFailed] = createSignal(false);
  const [chat] = createResource(() => fetchLegacyChat(props.agentId, props.sessionId, requestSignal()).catch(() => {
    if (!lifetime.signal.aborted) setLoadFailed(true);
    return null;
  }));
  const [continuing, setContinuing] = createSignal(false);
  const [continueFailed, setContinueFailed] = createSignal(false);

  const anchor = () => {
    const match = /^#legacy-message=(\d+)$/.exec(location.hash);
    if (!match) return;
    const index = Number(match[1]);
    if (Number.isSafeInteger(index)) return index;
  };

  const continueChat = async () => {
    if (continuing()) return;
    setContinueFailed(false);
    setContinuing(true);
    try {
      const thread = await continueLegacyChat(props.agentId, props.sessionId, requestSignal());
      if (!lifetime.signal.aborted) {
        navigate(`/chat/${encodeURIComponent(props.agentId)}?thread=${encodeURIComponent(thread.id)}`);
      }
    } catch {
      if (!lifetime.signal.aborted) setContinueFailed(true);
    } finally {
      if (!lifetime.signal.aborted) setContinuing(false);
    }
  };

  return <div class="chat-view hero-sent legacy-chat">
    <style>{chatViewStyles}</style>
    <main class="chat-main">
      <Show when={!chat.loading} fallback={<p class="legacy-chat-status" role="status">Loading older chat…</p>}>
        <Show when={chat()} fallback={
          <p class="legacy-chat-status" role={loadFailed() ? "alert" : "status"}>
            {loadFailed() ? "Could not load older chat. Reload to try again." : "This older chat is not available."}
          </p>
        }>
          {(current) => <>
            <header class="legacy-chat-banner">
              <div class="legacy-chat-heading">
                <span>Older chat, read-only</span>
                <Show when={current().title}><h1>{current().title}</h1></Show>
              </div>
              <Button variant="primary" loading={continuing()} loadingLabel="Continuing…" disabled={continuing()} onClick={() => void continueChat()}>
                Continue
              </Button>
            </header>
            <Show when={continueFailed()}>
              <p class="legacy-chat-status" role="alert">Could not continue older chat. Try again.</p>
            </Show>
            <ReadOnlyTranscript agentId={current().agentId} messages={current().messages} highlightHistoryIndex={anchor()} />
          </>}
        </Show>
      </Show>
    </main>
    <style>{`
      .legacy-chat-banner { display: flex; align-items: center; justify-content: space-between; gap: 12px 16px; padding: 16px max(18px, calc((100% - var(--transcript-width)) / 2 + 18px)); border-bottom: 1px solid var(--surface-2); }
      .legacy-chat-heading { min-width: 0; }
      .legacy-chat-heading span, .legacy-chat-status { color: var(--text-secondary); font-size: 13px; }
      .legacy-chat-heading h1 { margin: 4px 0 0; color: var(--text-primary); font-size: 16px; font-weight: 600; overflow-wrap: anywhere; }
      .legacy-chat-status { margin: 0; padding: 16px max(18px, calc((100% - var(--transcript-width)) / 2 + 18px)); }
      .legacy-chat-status[role="alert"] { color: var(--tone-error); }
      .legacy-chat .messages { padding-bottom: 36px; transition: none; }
      .legacy-chat .legacy-message-highlight { border-radius: var(--radius-md); outline: 2px solid var(--accent); outline-offset: 4px; }
      @media (max-width: 768px) {
        .legacy-chat-banner, .legacy-chat-status { padding-left: 64px; }
      }
    `}</style>
  </div>;
}
