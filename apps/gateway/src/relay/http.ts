import type { MiddlewareHandler } from "hono";
import { getAgent, loadConfig } from "../config/index.js";
import { createRelayedFileOpen, createRelayedFileView, createRelayedMcpView, revokeMcpAppSession } from "../mcp-apps/views.js";
import { addGatewaySuffix, isSupportedRemoteAgentId } from "./agent-id.js";
import { MAX_UPLOAD_SIZE_BYTES } from "../media/upload.js";
import { getLinkedGateways, isLoopbackForwardedFor, isTrustedRequest, resolveRemoteAgent } from "./state.js";
import {
  fetchRemote,
  fetchRemoteJson,
  fetchRemoteWithRedirects,
  isSafeRemotePath,
  LIST_TIMEOUT_MS,
  UnsafeRemoteRedirectError,
  suffixAgentIds,
  suffixAvatarUrl,
} from "./remote.js";
import { configurationRedirect, isResponse, relayConfiguration } from "./configuration.js";
import type { RemoteGateway } from "./store.js";

type RemoteAgent = { id: string; avatar?: string } & Record<string, unknown>;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEARCH_LIMIT = 50;
// The linked RPC route has a 30-second deadline. Allow time for transport too.
const MCP_APP_RESOURCE_TIMEOUT_MS = 32_000;
const AGGREGATE_SEGMENTS = new Set(["status", "sessions"]);
const DROPPED_REQUEST_HEADERS = ["connection", "content-length", "accept-encoding"];
const DROPPED_RESPONSE_HEADERS = ["content-encoding", "content-length", "transfer-encoding", "connection", "set-cookie"];

function suffixAgent(agent: RemoteAgent, gateway: string): RemoteAgent {
  return {
    ...(suffixAgentIds(agent, gateway) as RemoteAgent),
    id: addGatewaySuffix(agent.id, gateway),
    ...(agent.avatar ? { avatar: suffixAvatarUrl(agent.avatar, gateway) } : {}),
    gateway,
  };
}

/** The relay lists only remote agents whose raw ID the HTTP transport carries. */
function isRelayedAgent(agent: RemoteAgent): boolean {
  return typeof agent.id === "string" && isSupportedRemoteAgentId(agent.id);
}

function isRelayedSessionItem(item: unknown): boolean {
  const agentId = (item as { agentId?: unknown } | null)?.agentId;
  return typeof agentId !== "string" || isSupportedRemoteAgentId(agentId);
}

async function remoteLists<T>(
  gateways: RemoteGateway[],
  pathAndQuery: string
): Promise<Array<{ gateway: RemoteGateway; body: T }>> {
  const results = await Promise.all(
    gateways.map(async (gateway) => ({
      gateway,
      body: await fetchRemoteJson<T>(gateway, pathAndQuery),
    }))
  );
  return results.flatMap(({ gateway, body }) => (body ? [{ gateway, body }] : []));
}

function replaceJson(c: Parameters<MiddlewareHandler>[0], body: unknown): void {
  const headers = new Headers(c.res.headers);
  headers.delete("content-length");
  c.res = new Response(JSON.stringify(body), { status: c.res.status, headers });
}

async function mergeLists(
  c: Parameters<MiddlewareHandler>[0],
  gateways: RemoteGateway[],
  segments: string[]
): Promise<void> {
  if (c.res.status !== 200) return;
  const url = new URL(c.req.url);
  const pathAndQuery = `${url.pathname}${url.search}`;
  const local = (await c.res.clone().json()) as unknown;
  const remotes = await remoteLists<unknown>(gateways, pathAndQuery);
  if (segments.length === 2) {
    const agents = [...(local as RemoteAgent[])];
    const knownIds = new Set(agents.map((agent) => agent.id));
    for (const { gateway, body } of remotes) {
      if (Array.isArray(body)) {
        for (const agent of (body as RemoteAgent[]).filter(isRelayedAgent)) {
          const suffixed = suffixAgent(agent, gateway.name);
          if (knownIds.has(suffixed.id)) continue;
          knownIds.add(suffixed.id);
          agents.push(suffixed);
        }
      }
    }
    replaceJson(c, agents);
    return;
  }
  if (segments[2] === "status") {
    const statuses = { ...(local as { statuses: Record<string, string> }).statuses };
    for (const { gateway, body } of remotes) {
      for (const [id, status] of Object.entries(
        (body as { statuses?: Record<string, string> }).statuses ?? {}
      )) {
        if (!isSupportedRemoteAgentId(id)) continue;
        statuses[addGatewaySuffix(id, gateway.name)] ??= status;
      }
    }
    replaceJson(c, { statuses });
    return;
  }
  const items = [...(local as { items: Array<Record<string, unknown>> }).items];
  for (const { gateway, body } of remotes) {
    const remoteItems = ((body as { items?: unknown[] }).items ?? []).filter(isRelayedSessionItem);
    for (const item of remoteItems.map((entry) => suffixAgentIds(entry, gateway.name)) as Array<Record<string, unknown>>) {
      if (typeof item.agentId === "string" && getAgent(item.agentId)) continue;
      items.push(item);
    }
  }
  if (segments[3] === "search") {
    items.sort(
      (a, b) =>
        Number(b.match === "title") - Number(a.match === "title") ||
        Number(b.lastActivity) - Number(a.lastActivity)
    );
    items.splice(SEARCH_LIMIT);
  } else {
    items.sort((a, b) => Number(b.lastActivity) - Number(a.lastActivity));
  }
  replaceJson(c, { ...(local as object), items });
}

async function forward(
  request: Request,
  gateway: RemoteGateway,
  pathAndQuery: string,
  agentDetail = false
): Promise<Response> {
  const headers = new Headers(request.headers);
  for (const name of DROPPED_REQUEST_HEADERS) headers.delete(name);
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  let response: Response;
  try {
    response = await fetchRemote(gateway, pathAndQuery, {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      signal: request.signal,
      duplex: "half",
    });
  } catch {
    return Response.json({ error: "gateway_offline", gateway: gateway.name }, { status: 502 });
  }
  const responseHeaders = new Headers(response.headers);
  if (response.status >= 300 && response.status < 400 && responseHeaders.has("location")) {
    const location = configurationRedirect(gateway, responseHeaders.get("location")!, pathAndQuery);
    if (!location) {
      await response.body?.cancel();
      return Response.json({ error: "unsafe_remote_redirect" }, { status: 502 });
    }
    responseHeaders.set("location", location);
  }
  for (const name of DROPPED_RESPONSE_HEADERS) responseHeaders.delete(name);
  const hasNoBody =
    request.method === "HEAD" || [204, 205, 304].includes(response.status);
  if (hasNoBody || !(response.headers.get("content-type") ?? "").includes("application/json")) {
    return new Response(hasNoBody ? null : response.body, { status: response.status, headers: responseHeaders });
  }
  let rawBody: unknown;
  try { rawBody = await response.json(); }
  catch { return Response.json({ error: "invalid_remote_response", gateway: gateway.name }, { status: 502 }); }
  let body = suffixAgentIds(rawBody, gateway.name);
  if (response.ok && request.method === "GET" && pathAndQuery.split("?")[0] === "/api/agents" && Array.isArray(body)) {
    body = (rawBody as RemoteAgent[]).filter(isRelayedAgent).map((agent) => suffixAgent(agent, gateway.name));
  }
  if (
    response.ok &&
    request.method === "GET" &&
    agentDetail &&
    body &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    typeof (body as RemoteAgent).id === "string"
  ) {
    body = suffixAgent(rawBody as RemoteAgent, gateway.name);
  }
  return new Response(JSON.stringify(body), { status: response.status, headers: responseHeaders });
}

const UPLOAD_FORM_OVERHEAD_BYTES = 1024 * 1024;

function uploadTooLarge(): Response {
  return Response.json(
    { error: "File exceeds the 25MB upload limit", maxSize: MAX_UPLOAD_SIZE_BYTES },
    { status: 413 }
  );
}

/** Reads the body from one stream. Returns null and cancels the stream when it passes `limit` bytes. */
async function readLimited(body: ReadableStream<Uint8Array> | null, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  const reader = body?.getReader();
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** Handles an upload for a remote agent. The page names the agent in the `agentId` query parameter. */
async function forwardUpload(request: Request, gateways: RemoteGateway[]): Promise<Response | null> {
  const queryAgentId = new URL(request.url).searchParams.get("agentId");
  if (!queryAgentId) return null;
  const target = resolveRemoteAgent(queryAgentId, gateways);
  const gateway = gateways.find((item) => item.name === target.gateway);
  if (!gateway) return null;
  const limit = MAX_UPLOAD_SIZE_BYTES + UPLOAD_FORM_OVERHEAD_BYTES;
  if (Number(request.headers.get("content-length")) > limit) return uploadTooLarge();
  const bytes = await readLimited(request.body, limit);
  if (!bytes) return uploadTooLarge();
  const form = await new Response(new Uint8Array(bytes), {
    headers: { "content-type": request.headers.get("content-type") ?? "" },
  })
    .formData()
    .catch(() => null);
  if (!form) return Response.json({ error: "Invalid upload" }, { status: 400 });
  const file = form.get("file");
  if (file instanceof File && file.size > MAX_UPLOAD_SIZE_BYTES) return uploadTooLarge();
  form.set("agentId", target.agentId);
  try {
    const response = await fetchRemoteWithRedirects(gateway, "/api/media/upload", "upload", {
      method: "POST",
      body: form,
      signal: request.signal,
    });
    return new Response(response.body, {
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
    });
  } catch (error) {
    if (error instanceof UnsafeRemoteRedirectError) return Response.json({ error: "unsafe_remote_redirect" }, { status: 502 });
    return Response.json({ error: "gateway_offline", gateway: gateway.name }, { status: 502 });
  }
}

async function downloadFromRemote(
  fileId: string,
  gateways: RemoteGateway[],
  signal: AbortSignal
): Promise<Response | null> {
  for (const gateway of gateways) {
    try {
      const response = await fetchRemoteWithRedirects(gateway, `/api/media/download/${fileId}`, "download", {
        signal,
      });
      if (response.ok) {
        const headers = new Headers(response.headers);
        for (const name of DROPPED_RESPONSE_HEADERS) headers.delete(name);
        return new Response(response.body, { status: 200, headers });
      }
      await response.body?.cancel();
    } catch (error) {
      if (error instanceof UnsafeRemoteRedirectError) return Response.json({ error: "unsafe_remote_redirect" }, { status: 502 });
      continue;
    }
  }
  return null;
}

/** Resolve only allowed configuration routes before the local extension gate. */
export function relayConfigurationHttp(): MiddlewareHandler {
  return async (c, next) => {
    const result = await relayConfiguration(c.req.raw, getLinkedGateways(), forward);
    if (isResponse(result)) return result;
    if (result) c.req.raw = result;
    return next();
  };
}

async function readLinkedMcpApp(gateway: RemoteGateway, path: string, uri: string, requestSignal: AbortSignal): Promise<unknown> {
  const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(MCP_APP_RESOURCE_TIMEOUT_MS)]);
  try {
    const response = await fetchRemote(gateway, path, {
      method: "POST", headers: { "content-type": "application/json" }, signal,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri } }),
    }, MCP_APP_RESOURCE_TIMEOUT_MS);
    if (response.ok) return await response.json() as unknown;
    await response.body?.cancel();
    return null;
  } catch (error) {
    // A transport failure allows the existing forwarded-view fallback.
    return error instanceof SyntaxError ? null : undefined;
  }
}

/** Sends `/api/agents/:id` calls for remote agents to their gateway and merges remote entries into the lists. */
export function relayHttp(): MiddlewareHandler {
  return async (c, next) => {
    const gateways = getLinkedGateways();
    if (gateways.length === 0) return next();
    const url = new URL(c.req.url);
    const segments = url.pathname.split("/");
    const method = c.req.method;
    const appOperation = method === "POST" && segments.length === 9 && segments[4] === "sessions" && segments[6] === "mcp-apps"
      ? segments[8] : undefined;
    const isView = appOperation === "view";
    const isOpen = appOperation === "open";
    const forwardedFor = c.req.header("x-forwarded-for");
    const trusted = isTrustedRequest(c.req.header("origin"), forwardedFor);
    if (!trusted && (!(isView || isOpen) || !isLoopbackForwardedFor(forwardedFor))) return next();

    if (segments[1] === "api" && segments[2] === "agents" && segments[3] !== undefined) {
      const first = decodeURIComponent(segments[3]);
      const target = AGGREGATE_SEGMENTS.has(first)
        ? { agentId: first }
        : resolveRemoteAgent(first, gateways);
      const gateway = gateways.find((item) => item.name === target.gateway);
      if (gateway) {
        if (!trusted) return c.json({ error: "untrusted_origin" }, 403);
        const remoteSegments = [...segments];
        remoteSegments[3] = encodeURIComponent(target.agentId);
        if (isView || isOpen) {
          const appPath = remoteSegments.slice(0, -1).join("/");
          const dataPath = `${appPath}/data${url.search}`;
          const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(LIST_TIMEOUT_MS)]);
          const readData = (): Promise<unknown> => fetchRemote(gateway, dataPath, { method: "POST", signal })
            .then(async (response) => {
              if (response.ok) return response.json();
              await response.body?.cancel();
            })
            .catch(() => undefined);
          if (isOpen && isSafeRemotePath(dataPath)) {
            // Linked gateways are available only in single-user mode.
            const scope = { agentId: first, sessionId: decodeURIComponent(segments[5]) };
            const open = await createRelayedFileOpen(loadConfig, c, scope, { gateway, agentId: target.agentId }, readData);
            if (open) return open;
          } else if (isView) {
            const data = await readData();
            if (data) {
              const scope = { agentId: first, sessionId: decodeURIComponent(segments[5]) };
              const config = loadConfig();
              const toolCallId = decodeURIComponent(segments[7]);
              const view = await createRelayedFileView(config, c, scope, toolCallId, data)
                ?? await createRelayedMcpView(config, c, scope, toolCallId, data, (uri) =>
                  readLinkedMcpApp(gateway, `${appPath}/rpc${url.search}`, uri, c.req.raw.signal));
              if (view) return view;
            }
          }
        }
        const response = await forward(c.req.raw, gateway, `${remoteSegments.join("/")}${url.search}`, segments.length === 4);
        if (response.ok && method === "DELETE" && segments.length === 6 && segments[4] === "sessions") {
          revokeMcpAppSession({ agentId: first, sessionId: decodeURIComponent(segments[5]) });
        }
        return response;
      }
    }

    if (method === "GET") {
      const listPath = url.pathname === "/api/agents"
        ? 2
        : ["/api/agents/status", "/api/agents/sessions", "/api/agents/sessions/search"].includes(url.pathname)
          ? 3
          : 0;
      if (listPath) {
        await next();
        await mergeLists(c, gateways, url.pathname.split("/").slice(1));
        return;
      }
      const fileId = /^\/api\/media\/download\/([^/]+)$/.exec(url.pathname)?.[1];
      if (fileId && UUID_RE.test(fileId)) {
        await next();
        if (c.res.status !== 404) return;
        const remote = await downloadFromRemote(fileId, gateways, c.req.raw.signal);
        if (remote) c.res = remote;
        return;
      }
    }

    if (method === "POST" && url.pathname === "/api/media/upload") {
      const response = await forwardUpload(c.req.raw, gateways);
      if (response) return response;
    }
    return next();
  };
}
