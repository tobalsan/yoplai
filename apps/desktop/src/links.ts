export type WindowOpenDecision = "child-window" | "system-browser" | "deny";
export type NavigationDecision = "allow" | "system-browser" | "restart" | "deny";

export const RESTART_URL = "yoplai-desktop://restart";
const OAUTH_FRAME_PREFIX = "yoplai-oauth";
const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/** True for URLs the system browser may open. */
export function isExternalUrl(url: string): boolean {
  try {
    return EXTERNAL_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

/**
 * Decide what `window.open` and `target=_blank` do.
 * OAuth popups and MCP app blank windows stay in-app so the opener and
 * postMessage keep working. Everything else goes to the system browser.
 */
export function decideWindowOpen(input: { url: string; frameName: string }): WindowOpenDecision {
  if (input.frameName.startsWith(OAUTH_FRAME_PREFIX)) return "child-window";
  if (input.url === "about:blank" || input.url === "") return "child-window";
  return isExternalUrl(input.url) ? "system-browser" : "deny";
}

/** Decide what a navigation in the main window does. */
export function decideNavigation(input: { url: string; uiOrigin: string }): NavigationDecision {
  if (input.url === RESTART_URL) return "restart";
  try {
    if (new URL(input.url).origin === input.uiOrigin) return "allow";
  } catch {
    return "deny";
  }
  return isExternalUrl(input.url) ? "system-browser" : "deny";
}

const ALLOWED_PERMISSIONS = new Set(["clipboard-sanitized-write", "fullscreen"]);

/** Deny every browser permission except a short list, and only for the UI origin. */
export function isPermissionAllowed(permission: string, requestingUrl: string, uiOrigin: string): boolean {
  if (!ALLOWED_PERMISSIONS.has(permission)) return false;
  try {
    return new URL(requestingUrl).origin === uiOrigin;
  } catch {
    return false;
  }
}
