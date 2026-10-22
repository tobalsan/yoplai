const POPUP_NAME = "yoplai-oauth";
const POPUP_FEATURES = "width=520,height=640";
const OAUTH_MESSAGE_TYPES = ["yoplai-oauth", "aihub-oauth"];

/** Opens the OAuth popup at `url`. Call synchronously from a click handler or browsers block it. */
export function openOAuthPopup(url: string): Window | null {
  return window.open(url, POPUP_NAME, POPUP_FEATURES);
}

/**
 * Calls `onReturn` when the window regains focus or the OAuth popup posts its
 * result message (optionally only for one `extension`). Returns a disposer.
 */
export function onOAuthReturn(onReturn: () => void, filter?: { extension?: string }): () => void {
  const onMessage = (event: MessageEvent) => {
    const data = event.data;
    if (!data || typeof data !== "object" || !OAUTH_MESSAGE_TYPES.includes(data.type)) return;
    if (filter?.extension !== undefined && data.extension !== filter.extension) return;
    onReturn();
  };
  window.addEventListener("message", onMessage);
  window.addEventListener("focus", onReturn);
  return () => {
    window.removeEventListener("message", onMessage);
    window.removeEventListener("focus", onReturn);
  };
}
