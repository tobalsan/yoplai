import type { MiddlewareHandler } from "hono";
import { addGatewaySuffix, removeGatewaySuffix } from "./agent-id.js";
import { getLinkedGateways } from "./state.js";
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
const AGGREGATE_SEGMENTS = new Set(["status", "sessions"]);
const DROPPED_REQUEST_HEADERS = ["connection", "content-length", "accept-encoding"];
const DROPPED_RESPONSE_HEADERS = ["content-encoding", "content-length", "transfer-encoding", "connection"];

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
    for (const { gateway, body } of remotes) {
      if (Array.isArray(body)) {
        agents.push(...(body as RemoteAgent[]).map((agent) => suffixAgent(agent, gateway.name)));
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
        statuses[addGatewaySuffix(id, gateway.name)] = status;
      }
    }
    replaceJson(c, { statuses });
    return;
  }
  const items = [...(local as { items: Array<Record<string, unknown>> }).items];
  for (const { gateway, body } of remotes) {
    const remoteItems = (body as { items?: unknown[] }).items ?? [];
    items.push(...(remoteItems.map((item) => suffixAgentIds(item, gateway.name)) as Array<Record<string, unknown>>));
  }
  if (segments[3] !== "search") {
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
  if (!(response.headers.get("content-type") ?? "").includes("application/json")) {
    return new Response(response.body, { status: response.status, headers: responseHeaders });
  }
  let body = suffixAgentIds(await response.json(), gateway.name);
  if (request.method === "GET" && segments.length === 4 && body && typeof body === "object" && !Array.isArray(body)) {
    body = suffixAgent(body as RemoteAgent, gateway.name);
  }
  return new Response(JSON.stringify(body), { status: response.status, headers: responseHeaders });
}

async function forwardUpload(request: Request, gateways: RemoteGateway[]): Promise<Response | null> {
  const form = await request.clone().formData().catch(() => null);
  const agentId = form?.get("agentId");
  if (!form || typeof agentId !== "string") return null;
  const target = removeGatewaySuffix(agentId, gateways.map((gateway) => gateway.name));
  const gateway = gateways.find((item) => item.name === target.gateway);
  if (!gateway) return null;
  form.set("agentId", target.agentId);
  try {
    const response = await fetchRemote(gateway, "/api/media/upload", { method: "POST", body: form });
    return new Response(response.body, {
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
    });
  } catch {
    return Response.json({ error: "gateway_offline", gateway: gateway.name }, { status: 502 });
  }
}

async function downloadFromRemote(fileId: string, gateways: RemoteGateway[]): Promise<Response | null> {
  for (const gateway of gateways) {
    try {
      const response = await fetchRemote(gateway, `/api/media/download/${fileId}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) {
        const headers = new Headers(response.headers);
        for (const name of DROPPED_RESPONSE_HEADERS) headers.delete(name);
        return new Response(response.body, { status: 200, headers });
      }
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
    if (gateways.length === 0) return next();
    const url = new URL(c.req.url);
    const segments = url.pathname.split("/");
    const method = c.req.method;

    if (segments[1] === "api" && segments[2] === "agents" && segments[3] !== undefined) {
      const first = decodeURIComponent(segments[3]);
      const target = AGGREGATE_SEGMENTS.has(first)
        ? { agentId: first }
        : removeGatewaySuffix(first, gateways.map((gateway) => gateway.name));
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
        const remote = await downloadFromRemote(fileId, gateways);
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
