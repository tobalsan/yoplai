import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import path from "node:path";
import { getMimeType } from "hono/utils/mime";
import {
  DASHBOARD_VIEW_NAMESPACE,
  LINK_NAMESPACE,
  REMOTE_LINK_NAMESPACE,
  ownsDashboardViewPath,
  ownsRedactedPath,
} from "@yoplai/shared/secret-paths";
import { logWarn } from "../logging.js";

export interface UiListenerOptions {
  /** Directory of the built web UI. */
  webDist: string;
  host: string;
  port: number;
  gatewayHost: string;
  gatewayPort: number;
  /** Called when the UI listener cannot bind or fails. */
  onError: (error: Error) => void;
}

/** The same service paths as the `proxy` block of `apps/web/vite.config.ts`. */
const FORWARDED_PREFIXES = ["/api", "/ws", "/hooks"];
const FORWARDED_DIRECTORIES = ["/d/", "/d-assets/"];
/** The standard hop-by-hop headers (RFC 9110 section 7.6.1, plus the old proxy-connection). A proxy must not forward them. */
const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

/** Remove the standard hop-by-hop headers and every header that `Connection` names. Returns a copy. */
function withoutHopByHop<T extends http.IncomingHttpHeaders | http.OutgoingHttpHeaders>(source: T): T {
  const headers = { ...source };
  const named = String(headers.connection ?? "")
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  for (const name of [...HOP_BY_HOP_HEADERS, ...named]) delete headers[name];
  return headers;
}

function pathnameOf(target: string | undefined): string {
  const raw = target ?? "/";
  const end = raw.search(/[?#]/);
  return end === -1 ? raw : raw.slice(0, end);
}

/** True for a path that the gateway owns. The test also looks at the decoded form, so no spelling skips the forward. */
export function isForwardedPath(pathname: string): boolean {
  const candidates = [pathname];
  try {
    candidates.push(decodeURIComponent(pathname));
  } catch {
    return true;
  }
  return candidates.some((candidate) => {
    const lower = candidate.toLowerCase();
    return (
      FORWARDED_PREFIXES.some((prefix) => lower === prefix || lower.startsWith(`${prefix}/`)) ||
      FORWARDED_DIRECTORIES.some((directory) => lower.startsWith(directory))
    );
  });
}

/** Secret paths show as a namespace only. */
export function redactedTarget(target: string | undefined): string {
  const pathname = pathnameOf(target);
  if (ownsDashboardViewPath(pathname)) return `${DASHBOARD_VIEW_NAMESPACE}/[redacted]`;
  if (ownsRedactedPath(pathname, LINK_NAMESPACE)) return `${LINK_NAMESPACE}/[redacted]`;
  if (ownsRedactedPath(pathname, REMOTE_LINK_NAMESPACE)) return `${REMOTE_LINK_NAMESPACE}/[redacted]`;
  return pathname;
}

function forwardedHeaders(request: IncomingMessage, gatewayHost: string, gatewayPort: number): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = withoutHopByHop(request.headers);
  const peer = request.socket.remoteAddress ?? "";
  const previous = request.headers["x-forwarded-for"];
  headers["x-forwarded-for"] = [typeof previous === "string" ? previous : undefined, peer].filter(Boolean).join(", ");
  headers["x-forwarded-proto"] = "http";
  if (request.headers.host) headers["x-forwarded-host"] = request.headers.host;
  headers.host = `${gatewayHost}:${gatewayPort}`;
  return headers;
}

function forwardRequest(request: IncomingMessage, response: ServerResponse, options: UiListenerOptions): void {
  const upstream = http.request(
    {
      host: options.gatewayHost,
      port: options.gatewayPort,
      method: request.method,
      path: request.url,
      headers: forwardedHeaders(request, options.gatewayHost, options.gatewayPort),
      agent: false,
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.statusMessage, withoutHopByHop(upstreamResponse.headers));
      // pipe does not pass an upstream failure on. Destroy the response so the browser sees a truncated body.
      upstreamResponse.on("error", () => response.destroy());
      upstreamResponse.on("close", () => {
        if (!upstreamResponse.complete) response.destroy();
      });
      upstreamResponse.pipe(response);
    }
  );
  upstream.on("error", (error) => {
    logWarn("UI listener forward failed", { target: redactedTarget(request.url), message: error.message });
    if (!response.headersSent) response.writeHead(502, { "Content-Type": "text/plain" });
    response.end("Bad Gateway");
  });
  response.on("close", () => upstream.destroy());
  request.pipe(upstream);
}

/** Send a WebSocket upgrade to the gateway. The head is written again with the Host rewritten. */
function forwardUpgrade(request: IncomingMessage, socket: net.Socket, head: Buffer, options: UiListenerOptions): void {
  const upstream = net.connect(options.gatewayPort, options.gatewayHost);
  const headers = forwardedHeaders(request, options.gatewayHost, options.gatewayPort);
  headers.connection = "Upgrade";
  headers.upgrade = request.headers.upgrade;
  const lines = [`${request.method} ${request.url} HTTP/1.1`];
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [String(value)]) lines.push(`${name}: ${item}`);
  }
  upstream.once("connect", () => {
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  const closeBoth = () => {
    socket.destroy();
    upstream.destroy();
  };
  upstream.on("error", (error) => {
    logWarn("UI listener upgrade failed", { target: redactedTarget(request.url), message: error.message });
    closeBoth();
  });
  socket.on("error", closeBoth);
  socket.on("close", closeBoth);
  upstream.on("close", closeBoth);
}

function notFound(response: ServerResponse): void {
  response.writeHead(404, { "Content-Type": "text/plain" });
  response.end("Not Found");
}

/** The file for a request path, or undefined when it is missing or outside the web directory. */
async function resolveFile(root: string, pathname: string): Promise<string | undefined> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0")) return undefined;
  const candidate = path.resolve(root, `.${decoded.startsWith("/") ? decoded : `/${decoded}`}`);
  try {
    const real = await fs.promises.realpath(candidate);
    if (real !== root && !real.startsWith(`${root}${path.sep}`)) return undefined;
    const stat = await fs.promises.stat(real);
    return stat.isFile() ? real : undefined;
  } catch {
    return undefined;
  }
}

/**
 * True for a path that gets the app shell when no file matches. The test uses the decoded path.
 * Nothing under /assets is a page, and a last segment with a file extension is a missing file.
 */
function ownsPageFallback(pathname: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  const normalized = path.posix.normalize(decoded);
  if (normalized === "/assets" || normalized.startsWith("/assets/")) return false;
  return !path.posix.basename(normalized).includes(".");
}

async function serveStatic(request: IncomingMessage, response: ServerResponse, root: string): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") return notFound(response);
  const pathname = pathnameOf(request.url);
  let file = await resolveFile(root, pathname);
  if (!file && ownsPageFallback(pathname)) file = await resolveFile(root, "/index.html");
  if (!file) return notFound(response);

  const hashed = file.startsWith(`${root}${path.sep}assets${path.sep}`);
  const stat = await fs.promises.stat(file);
  response.writeHead(200, {
    "Content-Type": getMimeType(file) ?? "application/octet-stream",
    "Content-Length": stat.size,
    "Cache-Control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
  if (request.method === "HEAD") return void response.end();
  const stream = fs.createReadStream(file);
  stream.on("error", () => response.destroy());
  stream.pipe(response);
}

/**
 * The UI listener of the packaged app. It serves the built web UI and forwards the service paths to the gateway
 * with a real HTTP request, because the link routes check the socket peer and the Host. The UI origin stays
 * different from the gateway origin, as the browser link needs.
 */
export function startUiListener(options: UiListenerOptions): http.Server {
  const root = fs.realpathSync(path.resolve(options.webDist));
  const server = http.createServer((request, response) => {
    if (isForwardedPath(pathnameOf(request.url))) return forwardRequest(request, response, options);
    serveStatic(request, response, root).catch(() => {
      if (!response.headersSent) response.writeHead(500, { "Content-Type": "text/plain" });
      response.end("Internal Server Error");
    });
  });
  server.on("upgrade", (request, socket, head) => {
    if (!isForwardedPath(pathnameOf(request.url))) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    forwardUpgrade(request, socket as net.Socket, head, options);
  });
  server.on("error", options.onError);
  server.listen(options.port, options.host);
  return server;
}
