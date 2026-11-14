import type { MiddlewareHandler } from "hono";
import { getAgent } from "../config/index.js";
import { addGatewaySuffix } from "./agent-id.js";
import { MAX_UPLOAD_SIZE_BYTES } from "../media/upload.js";
import { getLinkedGateways, isTrustedRequest, resolveRemoteAgent } from "./state.js";
import {
  fetchRemote,
  fetchRemoteJson,
  suffixAgentIds,
  suffixAvatarUrl,
} from "./remote.js";
import type { RemoteGateway } from "./store.js";

type RemoteAgent = { id: string; avatar?: string } & Record<string, unknown>;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEARCH_LIMIT = 50;
const AGGREGATE_SEGMENTS = new Set(["status", "sessions"]);
const DROPPED_REQUEST_HEADERS = ["connection", "content-length", "accept-encoding"];
const DROPPED_RESPONSE_HEADERS = ["content-encoding", "content-length", "transfer-encoding", "connection", "set-cookie"];

function suffixAgent(agent: RemoteAgent, gateway: string): RemoteAgent {
  return {
    ...agent,
    id: addGatewaySuffix(agent.id, gateway),
    ...(agent.avatar ? { avatar: suffixAvatarUrl(agent.avatar, gateway) } : {}),
    gateway,
  };
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
        for (const agent of body as RemoteAgent[]) {
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
        statuses[addGatewaySuffix(id, gateway.name)] ??= status;
      }
    }
    replaceJson(c, { statuses });
    return;
  }
  const items = [...(local as { items: Array<Record<string, unknown>> }).items];
  for (const { gateway, body } of remotes) {
    const remoteItems = (body as { items?: unknown[] }).items ?? [];
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
  remoteAgentId: string,
  segments: string[]
): Promise<Response> {
  const url = new URL(request.url);
  const remoteSegments = [...segments];
  remoteSegments[3] = encodeURIComponent(remoteAgentId);
  const headers = new Headers(request.headers);
  for (const name of DROPPED_REQUEST_HEADERS) headers.delete(name);
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  let response: Response;
  try {
    response = await fetchRemote(gateway, `${remoteSegments.join("/")}${url.search}`, {
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
  for (const name of DROPPED_RESPONSE_HEADERS) responseHeaders.delete(name);
  const hasNoBody =
    request.method === "HEAD" || [204, 205, 304].includes(response.status);
  if (hasNoBody || !(response.headers.get("content-type") ?? "").includes("application/json")) {
    return new Response(hasNoBody ? null : response.body, { status: response.status, headers: responseHeaders });
  }
  let body = suffixAgentIds(await response.json(), gateway.name);
  if (
    response.ok &&
    request.method === "GET" &&
    segments.length === 4 &&
    body &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    typeof (body as RemoteAgent).id === "string"
  ) {
    body = suffixAgent(body as RemoteAgent, gateway.name);
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
    const response = await fetchRemote(gateway, "/api/media/upload", {
      method: "POST",
      body: form,
      signal: request.signal,
    });
    return new Response(response.body, {
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
    });
  } catch {
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
      const response = await fetchRemote(gateway, `/api/media/download/${fileId}`, {
        signal,
      });
      if (response.ok) {
        const headers = new Headers(response.headers);
        for (const name of DROPPED_RESPONSE_HEADERS) headers.delete(name);
        return new Response(response.body, { status: 200, headers });
      }
      await response.body?.cancel();
    } catch {
      continue;
    }
  }
  return null;
}

/** Sends `/api/agents/:id` calls for remote agents to their gateway and merges remote entries into the lists. */
export function relayHttp(): MiddlewareHandler {
  return async (c, next) => {
    const gateways = getLinkedGateways();
    if (gateways.length === 0 || !isTrustedRequest(c.req.header("origin"), c.req.header("x-forwarded-for"))) return next();
    const url = new URL(c.req.url);
    const segments = url.pathname.split("/");
    const method = c.req.method;

    if (segments[1] === "api" && segments[2] === "agents" && segments[3] !== undefined) {
      const first = decodeURIComponent(segments[3]);
      const target = AGGREGATE_SEGMENTS.has(first)
        ? { agentId: first }
        : resolveRemoteAgent(first, gateways);
      const gateway = gateways.find((item) => item.name === target.gateway);
      if (gateway) {
        return forward(c.req.raw, gateway, target.agentId, segments);
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
