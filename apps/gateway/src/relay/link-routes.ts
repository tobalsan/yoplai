import { createHash } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { allowedCorsOrigins } from "../server/origins.js";
import { LINK_NAMESPACE, ownsLinkPath } from "./link-paths.js";
import { RelayLinkService, defaultDeviceLabel, type LinkResult } from "./link.js";
import { getDeviceLinkStates } from "./device-links.js";
import { getGatewayListener, getLinkCallbackPort, getRemoteGatewayStore, isRelayEnabled } from "./state.js";

/**
 * The local routes of the browser link. Each route enforces its own policy, in this order: the relay is on, the
 * socket peer is loopback, no forwarded address leaves loopback, and the Host is a loopback name of this gateway.
 * Then a write needs no Origin (the CLI) or exactly a configured UI origin. Only `POST .../complete` accepts the
 * callback origin `http://127.0.0.1:<gateway port>`, and it accepts nothing else. A caller header never replaces the
 * socket peer. CORS is answered here and the global CORS middleware skips this namespace.
 */

const BODY_LIMIT_BYTES = 4096;
const CONTROL_HEADER = "x-link-control";
const LOOPBACK_V4_RE = /^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]{43}$/;

export type LinkRoutesDeps = {
  service: () => RelayLinkService;
  isEnabled: () => boolean;
  /** The bound listener of the gateway. Undefined until the server listens. */
  listener: () => { address: string; port: number } | undefined;
  /** Configured browser origins of the UI, before the callback origin is removed. */
  configuredOrigins: () => string[];
  peerAddress: (c: Context) => string | undefined;
};

let sharedService: RelayLinkService | undefined;

/** The one service of this process. The routes and the CLI use it through the running gateway. */
export function getRelayLinkService(): RelayLinkService {
  sharedService ??= new RelayLinkService({
    store: getRemoteGatewayStore,
    fetch: (input, init) => globalThis.fetch(input, init),
    now: Date.now,
    callbackPort: getLinkCallbackPort,
    deviceLabel: defaultDeviceLabel,
    connections: getDeviceLinkStates,
  });
  return sharedService;
}

const defaultDeps: LinkRoutesDeps = {
  service: getRelayLinkService,
  isEnabled: isRelayEnabled,
  listener: getGatewayListener,
  configuredOrigins: allowedCorsOrigins,
  peerAddress: (c) => (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress,
};

function isLoopbackAddress(address: string): boolean {
  const value = address.replace(/^::ffff:/i, "");
  return value === "::1" || LOOPBACK_V4_RE.test(value);
}

/** A forwarded value without quotes, brackets, or a port. */
function forwardedHost(raw: string): string {
  const value = raw.trim().replace(/^"|"$/g, "");
  if (value.startsWith("[")) return value.slice(1, value.indexOf("]") === -1 ? undefined : value.indexOf("]"));
  return /^[^:]+:\d+$/.test(value) ? value.slice(0, value.lastIndexOf(":")) : value;
}

/** True when no forwarding header names an address outside loopback. A value that cannot be read counts as outside. */
function forwardedAddressesAreLoopback(headers: Headers): boolean {
  const forwardedFor = headers.get("x-forwarded-for");
  if (forwardedFor !== null && !forwardedFor.split(",").every((entry) => isLoopbackAddress(forwardedHost(entry)))) return false;
  const realIp = headers.get("x-real-ip");
  if (realIp !== null && !isLoopbackAddress(forwardedHost(realIp))) return false;
  const forwarded = headers.get("forwarded");
  if (forwarded !== null) {
    for (const part of forwarded.split(/[,;]/)) {
      const match = /^\s*for\s*=\s*(.+)$/i.exec(part);
      if (match && !isLoopbackAddress(forwardedHost(match[1]))) return false;
    }
  }
  return true;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers },
  });
}

const refuse = (status: number, error: string, message: string, headers?: Record<string, string>) => json(status, { error, message }, headers);

function unwrap<T>(result: LinkResult<T>, success = 200, headers?: Record<string, string>): Response {
  return result.ok ? json(success, result.value, headers) : json(result.status, { error: result.error, message: result.message }, headers);
}

/** True when the JSON text names one key twice at its top level, so two readers could read two values. */
export function hasDuplicateTopLevelKey(text: string): boolean {
  const seen = new Set<string>();
  let depth = 0;
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      let end = index + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      let after = end + 1;
      while (after < text.length && /\s/.test(text[after]!)) after++;
      if (depth === 1 && text[after] === ":") {
        let key: string;
        try {
          key = JSON.parse(text.slice(index, end + 1)) as string;
        } catch {
          return true;
        }
        if (seen.has(key)) return true;
        seen.add(key);
      }
      index = end + 1;
      continue;
    }
    if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") depth--;
    index++;
  }
  return false;
}

async function readBoundedText(request: Request): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > BODY_LIMIT_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

type Body = { ok: true; value: Record<string, unknown> } | { ok: false; response: Response };

/** A JSON object body with a size limit, one value for each key, and the JSON content type. */
async function readJsonObject(request: Request, headers: Record<string, string>): Promise<Body> {
  if (!/^application\/json\s*(;|$)/i.test(request.headers.get("content-type") ?? "")) {
    return { ok: false, response: refuse(415, "json_required", "Send a JSON body.", headers) };
  }
  const text = await readBoundedText(request);
  if (text === null) return { ok: false, response: refuse(413, "body_too_large", "The body is too large.", headers) };
  if (hasDuplicateTopLevelKey(text)) return { ok: false, response: refuse(400, "invalid_body", "The body repeats a field.", headers) };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, response: refuse(400, "invalid_body", "The body is not valid JSON.", headers) };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, response: refuse(400, "invalid_body", "The body must be a JSON object.", headers) };
  return { ok: true, value: raw as Record<string, unknown> };
}

const invalidBody = (headers: Record<string, string>) => refuse(400, "invalid_body", "The body has missing or unknown fields.", headers);

function onlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

// The callback page holds fixed local code. The fragment leaves the address bar before any request goes out.
const CALLBACK_SCRIPT = `(function () {
  var title = document.getElementById("title");
  var detail = document.getElementById("detail");
  function show(heading, text) { title.textContent = heading; detail.textContent = text; }
  var fragment = window.location.hash.slice(1);
  window.history.replaceState(null, "", window.location.pathname);
  var params = new URLSearchParams(fragment);
  var state = params.get("state");
  var code = params.get("code");
  var error = params.get("error");
  var single = ["state", "code", "error"].every(function (name) { return params.getAll(name).length <= 1; });
  var body = null;
  if (single && state && code && !error) body = { code: code, state: state };
  else if (single && state && error === "access_denied" && !code) body = { error: error, state: state };
  if (!body) { show("Link not finished", "Start the link again from Yoplai."); return; }
  fetch("/api/relay/link/complete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    .then(function (response) { return response.json().catch(function () { return {}; }).then(function (data) { return { ok: response.ok, data: data }; }); })
    .then(function (result) {
      var status = result.data && result.data.status;
      if (result.ok && status === "linked") show("Gateway linked", "You can close this tab and go back to Yoplai.");
      else if (result.ok && status === "denied") show("Link refused", "You refused the link. You can close this tab.");
      else show("Link not finished", (result.data && result.data.message) || "Start the link again from Yoplai.");
    })
    .catch(function () { show("Link not finished", "This gateway did not answer. Start the link again from Yoplai."); });
})();`;

const CALLBACK_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Linking gateway</title></head>
<body><main><h1 id="title">Finishing the link</h1><p id="detail" role="status">Please wait.</p></main><script>${CALLBACK_SCRIPT}</script></body>
</html>
`;

const CALLBACK_CSP = [
  "default-src 'none'",
  `script-src 'sha256-${createHash("sha256").update(CALLBACK_SCRIPT).digest("base64")}'`,
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** The control token header of status and cancel. */
function controlToken(c: Context): string | undefined {
  const value = c.req.header(CONTROL_HEADER);
  return value && BASE64URL_RE.test(value) ? value : undefined;
}

export function relayLinkApi(overrides: Partial<LinkRoutesDeps> = {}): MiddlewareHandler {
  const deps = { ...defaultDeps, ...overrides };

  /** UI origins are the configured browser origins minus the callback origin, which only `complete` accepts. */
  const uiOrigins = (port: number) => {
    const callbackOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
    return deps.configuredOrigins().filter((origin) => !callbackOrigins.has(origin));
  };

  return async (c, next) => {
    const url = new URL(c.req.url);
    if (!ownsLinkPath(url.pathname)) return next();

    if (!deps.isEnabled()) return refuse(403, "relay_unavailable", "Linked gateways are off for this gateway.");
    const listener = deps.listener();
    const peer = deps.peerAddress(c);
    if (!listener || peer === undefined || !isLoopbackAddress(peer)) return refuse(403, "untrusted_peer", "This route answers only on this computer.");
    if (!forwardedAddressesAreLoopback(c.req.raw.headers)) return refuse(403, "untrusted_peer", "This route answers only on this computer.");
    const host = c.req.header("host");
    const allowedHosts = ["127.0.0.1", "localhost", "[::1]"].map((name) => `${name}:${listener.port}`);
    // The UI port is the port of the browser page. A proxy from that page rewrites Host to the gateway, so only the gateway port counts.
    if (host === undefined || !allowedHosts.includes(host.toLowerCase())) return refuse(403, "untrusted_host", "This route answers only on a loopback host name of this gateway.");

    const route = url.pathname;
    const method = c.req.method;
    const origin = c.req.header("origin");
    const trustedUi = origin !== undefined && uiOrigins(listener.port).includes(origin);
    const cors: Record<string, string> = trustedUi
      ? { "access-control-allow-origin": origin, vary: "Origin" }
      : {};

    if (method === "OPTIONS") {
      if (!trustedUi) return refuse(403, "untrusted_origin", "This origin cannot use this route.");
      return new Response(null, {
        status: 204,
        headers: {
          ...cors,
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": `content-type, ${CONTROL_HEADER}`,
          "access-control-max-age": "600",
        },
      });
    }
    // The routes take no query. A query string is a spelling that no route owns.
    if (c.req.url.includes("?")) return refuse(404, "invalid_link_route", "Unknown link route.", cors);

    if (route === `${LINK_NAMESPACE}/callback`) {
      if (method !== "GET") return refuse(405, "method_not_allowed", "Use GET.", { allow: "GET" });
      return new Response(CALLBACK_HTML, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": CALLBACK_CSP,
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
        },
      });
    }

    const service = deps.service();

    if (route === `${LINK_NAMESPACE}/complete`) {
      if (method !== "POST") return refuse(405, "method_not_allowed", "Use POST.", { allow: "POST" });
      // Only the callback page of this gateway may complete, and only on the literal callback host.
      if (origin !== `http://127.0.0.1:${listener.port}` || host.toLowerCase() !== `127.0.0.1:${listener.port}`) {
        return refuse(403, "untrusted_origin", "Only the link page of this gateway can finish a link.");
      }
      const body = await readJsonObject(c.req.raw, {});
      if (!body.ok) return body.response;
      const { state, code, error } = body.value;
      if (typeof state !== "string" || !BASE64URL_RE.test(state) || !onlyKeys(body.value, ["state", "code", "error"])) return invalidBody({});
      if (typeof code === "string" && error === undefined && code.length >= 1 && code.length <= 128) {
        return unwrap(await service.complete({ state, code }));
      }
      if (error === "access_denied" && code === undefined) return unwrap(await service.complete({ state, error }));
      return invalidBody({});
    }

    // Every other route is for the UI or the CLI: no Origin, or exactly a configured UI origin.
    if (origin !== undefined && !trustedUi) return refuse(403, "untrusted_origin", "This origin cannot use this route.");

    const statusMatch = /^\/api\/relay\/link\/status\/([A-Za-z0-9_-]{43})$/.exec(route);
    if (statusMatch) {
      if (method !== "GET") return refuse(405, "method_not_allowed", "Use GET.", { allow: "GET", ...cors });
      const token = controlToken(c);
      if (!token) return refuse(404, "unknown_attempt", "This link attempt is not known.", cors);
      return unwrap(service.status(statusMatch[1], token), 200, cors);
    }

    if (method !== "POST") return refuse(404, "invalid_link_route", "Unknown link route.", cors);
    const body = await readJsonObject(c.req.raw, cors);
    if (!body.ok) return body.response;
    const value = body.value;

    switch (route) {
      case `${LINK_NAMESPACE}/start`: {
        if (!onlyKeys(value, ["remote", "name"]) || typeof value.remote !== "string" || value.remote.length > 300) return invalidBody(cors);
        if (value.name !== undefined && (typeof value.name !== "string" || value.name.length > 64)) return invalidBody(cors);
        const result = await service.start({ remote: value.remote, name: value.name as string | undefined });
        if (!result.ok) return unwrap(result, 200, cors);
        return json(result.value.kind === "linked" ? 200 : 201, result.value.kind === "linked" ? { status: "linked", name: result.value.name } : result.value.attempt, cors);
      }
      case `${LINK_NAMESPACE}/cancel`: {
        const token = controlToken(c);
        if (!onlyKeys(value, ["attemptId"]) || typeof value.attemptId !== "string" || !BASE64URL_RE.test(value.attemptId) || !token) return invalidBody(cors);
        return unwrap(service.cancel(value.attemptId, token), 200, cors);
      }
      case `${LINK_NAMESPACE}/metadata`: {
        if (Object.keys(value).length > 0) return invalidBody(cors);
        return json(200, { gateways: service.list() }, cors);
      }
      case `${LINK_NAMESPACE}/disconnect`: {
        if (!onlyKeys(value, ["name", "localOnly"]) || typeof value.name !== "string" || value.name.length > 64) return invalidBody(cors);
        if (value.localOnly !== undefined && typeof value.localOnly !== "boolean") return invalidBody(cors);
        return unwrap(await service.disconnect(value.name, { localOnly: value.localOnly === true }), 200, cors);
      }
      default:
        return refuse(404, "invalid_link_route", "Unknown link route.", cors);
    }
  };
}
