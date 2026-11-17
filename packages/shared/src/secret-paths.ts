/**
 * Request paths that hold a secret: the browser link routes, the remote link routes, and the remote dashboard
 * viewer. The gateway routes, the global CORS skip, and the access log use these tests, and so does the dev proxy
 * error handler in `apps/web/vite.config.ts`. A spelling that the gateway refuses is then also a spelling that the
 * gateway log and the proxy log hide. The file has no Node import, so a Vite config can load it too.
 */

/** The namespace of the browser link routes. */
export const LINK_NAMESPACE = "/api/relay/link";

/** The remote side of the link. Its paths hold request IDs, and a stray request can carry a verifier or a code. */
export const REMOTE_LINK_NAMESPACE = "/api/auth/gateway-link";

/** The viewer namespace of a remote dashboard. A viewer path holds a secret snapshot handle. */
export const DASHBOARD_VIEW_NAMESPACE = "/api/relay/dashboard-views";

/** Decodes each valid percent sequence and keeps a broken one. It never throws. */
function decodeLenient(value: string): string {
  return value.replace(/%([0-9a-f]{2})/gi, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/** Resolves dot segments and repeated slashes the way a server routes the path, so a log test sees the real target. */
function resolveSegments(value: string): string {
  const kept: string[] = [];
  for (const segment of value.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") kept.pop();
    else kept.push(segment);
  }
  return `/${kept.join("/")}`;
}

/**
 * Strict routing test: true for every spelling of the namespace that the routes accept: encoded, double encoded,
 * mixed case, or with a broken sequence after it.
 */
export function ownsLinkPath(pathname: string): boolean {
  let value = pathname;
  for (let i = 0; i < 4; i++) {
    const lower = value.toLowerCase();
    if (lower === LINK_NAMESPACE || lower.startsWith(`${LINK_NAMESPACE}/`)) return true;
    const decoded = decodeLenient(value);
    if (decoded === value) break;
    value = decoded;
  }
  return false;
}

/**
 * Broad redaction test: true for every spelling of the namespace, also a request that the routes reject: encoded,
 * double encoded, mixed case, with dot segments or repeated slashes, or with a broken sequence after it. Only a log
 * or a proxy error handler uses it. It hides the whole target, so no part of it needs a separate rule.
 */
export function ownsRedactedPath(pathname: string, namespace: string): boolean {
  let value = pathname;
  for (let i = 0; i < 4; i++) {
    for (const candidate of [value, resolveSegments(value)]) {
      const lower = candidate.toLowerCase();
      if (lower.startsWith(namespace) && /^[/?#]?$/.test(lower.charAt(namespace.length))) return true;
    }
    const decoded = decodeLenient(value);
    if (decoded === value) break;
    value = decoded;
  }
  return false;
}

/** Broad redaction test of the remote link namespace. */
export function ownsRemoteLinkPath(pathname: string): boolean {
  return ownsRedactedPath(pathname, REMOTE_LINK_NAMESPACE);
}

/** True for every spelling of the viewer namespace: encoded, double encoded, mixed case, or with a broken sequence after it. */
export function ownsDashboardViewPath(pathname: string): boolean {
  let value = pathname;
  for (let i = 0; i < 4; i++) {
    if (value.toLowerCase().startsWith(DASHBOARD_VIEW_NAMESPACE)) return true;
    const decoded = decodeLenient(value);
    if (decoded === value) break;
    value = decoded;
  }
  return false;
}
