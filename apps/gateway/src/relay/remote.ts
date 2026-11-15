import type { RemoteGateway } from "./store.js";
import { addGatewaySuffix } from "./agent-id.js";

export const LIST_TIMEOUT_MS = 3000;

function withBearer(gateway: RemoteGateway, headers?: HeadersInit): Headers {
  const result = new Headers(headers);
  result.delete("authorization");
  result.delete("proxy-authorization");
  result.delete("cookie");
  result.delete("host");
  result.delete("origin");
  result.delete("referer");
  for (const name of [...result.keys()]) {
    if (name.startsWith("x-yoplai-") || name.startsWith("x-forwarded-") || name === "forwarded") result.delete(name);
  }
  if (gateway.token) result.set("authorization", `Bearer ${gateway.token}`);
  return result;
}

export function isSafeRemotePath(pathAndQuery: string): boolean {
  const path = pathAndQuery.split("?")[0];
  if (!path.startsWith("/") || path.startsWith("//") || /[\\#\s\p{Cc}]/u.test(path)) return false;
  try {
    return path.split("/").slice(1).every((part) => {
      const decoded = decodeURIComponent(part);
      return decoded !== "." && decoded !== ".." && !/[/\\%?#\p{Cc}]/u.test(decoded);
    });
  } catch {
    return false;
  }
}

export function remoteHttpUrl(gateway: RemoteGateway, pathAndQuery: string): string {
  const base = new URL(gateway.url);
  if (!isSafeRemotePath(pathAndQuery)) throw new Error("Invalid remote path");
  const target = new URL(`${gateway.url.replace(/\/+$/, "")}${pathAndQuery}`);
  if (target.origin !== base.origin || target.username || target.password) throw new Error("Invalid remote origin");
  return target.href;
}

export function remoteWsUrl(gateway: RemoteGateway): string {
  return remoteHttpUrl(gateway, "/ws").replace(/^http/i, "ws");
}

export function remoteDeviceUrl(gateway: RemoteGateway): string {
  return remoteHttpUrl(gateway, "/ws/device").replace(/^http/i, "ws");
}

export function remoteWsHeaders(gateway: RemoteGateway): Record<string, string> {
  return Object.fromEntries(withBearer(gateway).entries());
}

export const FIRST_RESPONSE_TIMEOUT_MS = 30_000;

/** The deadline covers the wait for the response headers only. A streamed body can run longer. */
export async function fetchRemote(
  gateway: RemoteGateway,
  pathAndQuery: string,
  init: RequestInit & { duplex?: "half" } = {}
): Promise<Response> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), FIRST_RESPONSE_TIMEOUT_MS);
  try {
    return await fetch(remoteHttpUrl(gateway, pathAndQuery), {
      ...init,
      redirect: "manual",
      headers: withBearer(gateway, init.headers),
      signal: init.signal
        ? AbortSignal.any([init.signal, deadline.signal])
        : deadline.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export class UnsafeRemoteRedirectError extends Error {
  constructor() { super("Unsafe remote redirect"); }
}

type RedirectFamily = "upload" | "download" | "agent-list";

/** Only replay buffered uploads. Other callers use GET without a body. */
export async function fetchRemoteWithRedirects(
  gateway: RemoteGateway,
  pathAndQuery: string,
  family: RedirectFamily,
  init: RequestInit = {}
): Promise<Response> {
  const initialPath = pathAndQuery.split("?")[0].replace(/\/$/, "");
  const base = new URL(gateway.url);
  const basePath = base.pathname.replace(/\/+$/, "");
  const seen = new Set<string>();
  let currentPath = pathAndQuery;
  for (let hop = 0; ; hop++) {
    const current = remoteHttpUrl(gateway, currentPath);
    if (seen.has(current)) throw new UnsafeRemoteRedirectError();
    seen.add(current);
    const response = await fetchRemote(gateway, currentPath, init);
    if (response.status < 300 || response.status >= 400) return response;
    void response.body?.cancel().catch(() => undefined);
    const location = response.headers.get("location");
    const allowedStatus = family === "upload" ? [307, 308] : [301, 302, 303, 307, 308];
    if (!allowedStatus.includes(response.status) || !location || hop >= 5 || /[\s\p{Cc}\\]/u.test(location)) throw new UnsafeRemoteRedirectError();
    // Check the raw path before URL parsing can remove traversal segments.
    const rawPath = location.replace(/^[a-z][a-z\d+.-]*:\/\/[^/?#]*/i, "");
    if (!isSafeRemotePath(rawPath.startsWith("/") ? rawPath : `/${rawPath}`)) throw new UnsafeRemoteRedirectError();
    let target: URL;
    try { target = new URL(location, current); }
    catch { throw new UnsafeRemoteRedirectError(); }
    if (target.origin !== base.origin || target.username || target.password || target.hash) throw new UnsafeRemoteRedirectError();
    if (!target.pathname.startsWith(`${basePath}/`)) throw new UnsafeRemoteRedirectError();
    const routePath = target.pathname.slice(basePath.length);
    const path = routePath.replace(/\/$/, "");
    const allowedPath = family === "download"
      ? /^\/api\/media\/download\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(path)
      : family === "upload" ? path === "/api/media/upload" : path === initialPath;
    if (!allowedPath || !isSafeRemotePath(target.pathname)) throw new UnsafeRemoteRedirectError();
    currentPath = `${routePath}${target.search}`;
  }
}

/** Fetch JSON from a remote gateway. Returns null when it does not answer in time or answers with an error. */
export async function fetchRemoteJson<T>(
  gateway: RemoteGateway,
  pathAndQuery: string
): Promise<T | null> {
  try {
    const response = await fetchRemoteWithRedirects(gateway, pathAndQuery, "agent-list", {
      signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

/** Add the gateway suffix to the agent ID fields of a JSON body. */
export function suffixAgentIds(value: unknown, gatewayName: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => suffixAgentIds(item, gatewayName));
  }
  if (!value || typeof value !== "object") return value;
  const record = { ...(value as Record<string, unknown>) };
  if (typeof record.agentId === "string") {
    record.agentId = addGatewaySuffix(record.agentId, gatewayName);
  }
  for (const key of ["items", "owned", "shared", "dashboard"]) {
    if (record[key] && typeof record[key] === "object") record[key] = suffixAgentIds(record[key], gatewayName);
  }
  if (typeof record.avatar === "string") {
    record.avatar = suffixAvatarUrl(record.avatar, gatewayName);
  }
  return record;
}

/** Avatar files live on the remote gateway, so the URL names the suffixed agent. */
export function suffixAvatarUrl(avatar: string, gatewayName: string): string {
  return avatar.replace(
    /^\/api\/agents\/([^/]+)\/avatar$/,
    (_match, id: string) =>
      `/api/agents/${encodeURIComponent(addGatewaySuffix(decodeURIComponent(id), gatewayName))}/avatar`
  );
}
