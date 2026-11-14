import type { RemoteGateway } from "./store.js";
import { addGatewaySuffix } from "./agent-id.js";

export const LIST_TIMEOUT_MS = 3000;

function withBearer(gateway: RemoteGateway, headers?: HeadersInit): Headers {
  const result = new Headers(headers);
  result.delete("authorization");
  result.delete("cookie");
  result.delete("host");
  if (gateway.token) result.set("authorization", `Bearer ${gateway.token}`);
  return result;
}

export function remoteHttpUrl(gateway: RemoteGateway, pathAndQuery: string): string {
  return `${gateway.url.replace(/\/+$/, "")}${pathAndQuery}`;
}

export function remoteWsUrl(gateway: RemoteGateway): string {
  return remoteHttpUrl(gateway, "/ws").replace(/^http/i, "ws");
}

export function remoteWsHeaders(gateway: RemoteGateway): Record<string, string> {
  return Object.fromEntries(withBearer(gateway).entries());
}

export function fetchRemote(
  gateway: RemoteGateway,
  pathAndQuery: string,
  init: RequestInit & { duplex?: "half" } = {}
): Promise<Response> {
  return fetch(remoteHttpUrl(gateway, pathAndQuery), {
    ...init,
    headers: withBearer(gateway, init.headers),
  });
}

/** Fetch JSON from a remote gateway. Returns null when it does not answer in time or answers with an error. */
export async function fetchRemoteJson<T>(
  gateway: RemoteGateway,
  pathAndQuery: string
): Promise<T | null> {
  try {
    const response = await fetchRemote(gateway, pathAndQuery, {
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
  if (Array.isArray(record.items)) {
    record.items = suffixAgentIds(record.items, gatewayName);
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
