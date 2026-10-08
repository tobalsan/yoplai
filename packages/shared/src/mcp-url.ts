/**
 * Canonical identity for an HTTP MCP server: lowercase scheme+host, path kept,
 * query/hash/credentials dropped, trailing slashes removed. Returns null for
 * unparseable or non-http(s) URLs (e.g. stdio servers).
 */
export function normalizeMcpServerUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const path = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.protocol}//${parsed.host}${path}`;
}
