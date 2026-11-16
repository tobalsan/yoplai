/**
 * The namespace of the browser link routes and its ownership test. The route code, the global CORS skip, and the
 * access log use this one test, so a spelling that the routes refuse is also a spelling that the log hides.
 */
export const LINK_NAMESPACE = "/api/relay/link";

/** Decodes each valid percent sequence and keeps a broken one. It never throws. */
function decodeLenient(value: string): string {
  return value.replace(/%([0-9a-f]{2})/gi, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/** True for every spelling of the namespace: encoded, double encoded, mixed case, or with a broken sequence after it. */
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

/** The remote side of the link. Its paths hold request IDs, and a stray request can carry a verifier or a code. */
export const REMOTE_LINK_NAMESPACE = "/api/auth/gateway-link";

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
 * True for every spelling of the remote link namespace, also a request that the routes reject: encoded, double
 * encoded, mixed case, with dot segments or repeated slashes, or with a broken sequence after it. Only the log and
 * the proxy error handler use this test. It hides the whole target, so no part of it needs a separate rule.
 */
export function ownsRemoteLinkPath(pathname: string): boolean {
  let value = pathname;
  for (let i = 0; i < 4; i++) {
    for (const candidate of [value, resolveSegments(value)]) {
      const lower = candidate.toLowerCase();
      if (lower.startsWith(REMOTE_LINK_NAMESPACE) && /^[/?#]?$/.test(lower.charAt(REMOTE_LINK_NAMESPACE.length))) return true;
    }
    const decoded = decodeLenient(value);
    if (decoded === value) break;
    value = decoded;
  }
  return false;
}
