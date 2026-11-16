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
