/**
 * The viewer namespace and its ownership test. The route code, the global CORS
 * skip, and the access log all use this one test, so a path that the viewer
 * refuses is also a path that the log redacts.
 */
export const DASHBOARD_VIEW_NAMESPACE = "/api/relay/dashboard-views";

/** Decodes each valid percent sequence and keeps a broken one. It never throws. */
function decodeLenient(value: string): string {
  return value.replace(/%([0-9a-f]{2})/gi, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/** True for every spelling of the namespace: encoded, double encoded, mixed case, or with a broken sequence after it. */
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
