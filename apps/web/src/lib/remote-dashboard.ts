/** Pure rules of the trusted remote-dashboard host: public routes, Chat targets, and link requests. */

export const DASHBOARD_ID_PATTERN = /^[A-Za-z0-9_-]{32}$/;
/** Query names with this prefix belong to the viewer transport. The gateway never forwards them. */
const TRANSPORT_QUERY_PREFIX = "__yoplai_";
const VIEWER_PATH = /^\/api\/relay\/dashboard-views\/([A-Za-z0-9_-]{32})\/$/;
const MAX_HREF = 2048;

/** A query string without `?` and without transport fields. */
export function cleanDashboardQuery(query: string | undefined): string {
  const bare = (query ?? "").replace(/^\?/, "");
  const params = new URLSearchParams(bare);
  if (![...params.keys()].some((name) => name.startsWith(TRANSPORT_QUERY_PREFIX))) return bare;
  const kept = new URLSearchParams();
  for (const [name, value] of params) {
    if (!name.startsWith(TRANSPORT_QUERY_PREFIX)) kept.append(name, value);
  }
  return kept.toString();
}

/** The public route of a remote dashboard. It holds no handle, instance, or token. */
export function remoteDashboardPath(gateway: string, id: string, query?: string): string {
  const clean = cleanDashboardQuery(query);
  return `/remote-dashboards/${encodeURIComponent(gateway)}/${encodeURIComponent(id)}${clean ? `?${clean}` : ""}`;
}

/** The checked view of one remote dashboard, built from gateway metadata and host state only. */
export type CheckedRemoteView = {
  gateway: string;
  dashboardId: string;
  /** The remote agent ID with the gateway suffix, as the chat page names it. */
  agentId: string;
  canWrite: boolean;
  canEdit: boolean;
  chat: { sessionId: string | null } | null;
  annotation: boolean;
};

/** Null when the viewer has no agent access. A null session starts a new chat. */
export function remoteDashboardChatPath(view: CheckedRemoteView): string | undefined {
  if (!view.chat) return undefined;
  const agent = encodeURIComponent(view.agentId);
  const dashboard = encodeURIComponent(view.dashboardId);
  return view.chat.sessionId
    ? `/chat/${agent}?session=${encodeURIComponent(view.chat.sessionId)}&dashboard=${dashboard}`
    : `/chat/${agent}?dashboard=${dashboard}&new=1`;
}

export type DashboardLinkDecision =
  | { kind: "dashboard"; id: string; query: string }
  | { kind: "external"; href: string; destination: string }
  | { kind: "blocked"; reason: "credentials" | "local" }
  | { kind: "ignored" };

function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host.startsWith("[")) {
    const address = host.slice(1, -1);
    // Loopback, unspecified, unique local, link local, and mapped IPv4 addresses.
    return address === "::1" || address === "::" || /^f[cd]/.test(address) || /^fe[89ab]/.test(address) || address.startsWith("::ffff:");
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  const octets = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)?.slice(1).map(Number);
  if (octets) {
    const [a, b] = octets;
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  // A name with no dot resolves on the local network.
  return !host.includes(".");
}

/**
 * Classifies one link request of an untrusted renderer. A relative address
 * resolves against the checked dashboard of this view. A viewer path on the
 * host origin names a dashboard of the same gateway: only its ID and query
 * count. Every other target is external and needs a user click. The renderer
 * never selects an agent or a gateway.
 */
export function classifyDashboardLink(href: unknown, context: { origin: string; dashboardId: string }): DashboardLinkDecision {
  if (typeof href !== "string" || !href || href.length > MAX_HREF) return { kind: "ignored" };
  let url: URL;
  try {
    url = new URL(href, `${context.origin}/api/relay/dashboard-views/${context.dashboardId}/`);
  } catch {
    return { kind: "ignored" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { kind: "ignored" };
  if (url.origin === context.origin) {
    const match = VIEWER_PATH.exec(url.pathname);
    if (!match || url.hash || url.username || url.password) return { kind: "ignored" };
    return { kind: "dashboard", id: match[1], query: cleanDashboardQuery(url.search) };
  }
  if (url.username || url.password) return { kind: "blocked", reason: "credentials" };
  if (isLocalHostname(url.hostname)) return { kind: "blocked", reason: "local" };
  return { kind: "external", href: url.href, destination: `${url.origin}${url.pathname}` };
}
