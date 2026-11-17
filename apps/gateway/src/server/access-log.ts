import type { MiddlewareHandler } from "hono";
import { logger } from "hono/logger";
import {
  DASHBOARD_VIEW_NAMESPACE,
  LINK_NAMESPACE,
  REMOTE_LINK_NAMESPACE,
  ownsDashboardViewPath,
  ownsLinkPath,
  ownsRemoteLinkPath,
} from "@yoplai/shared/secret-paths";

const SLOW_REQUEST_MS = 500;
const SECRET_QUERY_NAMES = new Set([
  "code",
  "state",
  "verifier",
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "client_secret",
  "password",
  "api_key",
  "apikey",
  "signature",
  "sig",
]);
const ANSI_ESCAPE = new RegExp(
  `${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`,
  "g"
);

export function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE, "");
}

function redactQuery(target: string): string {
  const queryStart = target.indexOf("?");
  if (queryStart === -1 || queryStart === target.length - 1) return target;

  const path = target.slice(0, queryStart);
  try {
    const query = target
      .slice(queryStart + 1)
      .split("&")
      .map((pair) => {
        const equals = pair.indexOf("=");
        const name = equals === -1 ? pair : pair.slice(0, equals);
        const decodedName = decodeURIComponent(
          name.replace(/\+/g, " ")
        ).toLowerCase();
        return equals !== -1 && SECRET_QUERY_NAMES.has(decodedName)
          ? `${name}=[redacted]`
          : pair;
      })
      .join("&");
    return `${path}?${query}`;
  } catch {
    return path;
  }
}

function isPollingOrHealthPath(path: string): boolean {
  return (
    path === "/health" ||
    path === "/api/agents/sessions" ||
    path === "/api/auth/get-session" ||
    /^\/api\/agents\/[^/]+\/history$/.test(path) ||
    /^\/api\/chat-projects(?:\/[^/]+)?$/.test(path) ||
    (path !== "/api/skills/import-token" &&
      path !== "/api/skills/recipients" &&
      /^\/api\/skills(?:\/[^/]+)?$/.test(path)) ||
    /^\/d-assets\//.test(path) ||
    /^\/api\/(?:theme\.css|branding\/(?:logo|icon)|manifest\.webmanifest)$/.test(
      path
    )
  );
}

/** Hides the whole target of an owned viewer request, because every part of it can carry a snapshot handle. */
function redactViewerTarget(message: string): string {
  const parts = /^(--> \S+ )([\s\S]+?)( \d{3} \S+)$/.exec(message);
  if (!parts || !ownsDashboardViewPath(parts[2].split("?")[0])) return message;
  return `${parts[1]}${DASHBOARD_VIEW_NAMESPACE}/[redacted]${parts[3]}`;
}

/**
 * Hides the whole target of a link request on either side, because a path can hold an attempt ID or a request ID and
 * a query can hold a verifier or a code. A rejected request is hidden in the same way.
 */
function redactLinkTarget(message: string): string {
  const parts = /^(--> \S+ )([\s\S]+?)( \d{3} \S+)$/.exec(message);
  if (!parts) return message;
  const path = parts[2].split("?")[0];
  if (ownsLinkPath(path)) return `${parts[1]}${LINK_NAMESPACE}/[redacted]${parts[3]}`;
  if (ownsRemoteLinkPath(path)) return `${parts[1]}${REMOTE_LINK_NAMESPACE}/[redacted]${parts[3]}`;
  return message;
}

export function accessLogger(): MiddlewareHandler {
  const normalLogger = logger((message) => {
    if (message.startsWith("<-- ")) return;
    const safeMessage = redactLinkTarget(redactViewerTarget(stripAnsi(message))).replace(/\/(sandbox|content|open)\/[^/?\s]+(?:\?[^\s]*)?/g, "/$1/[redacted]").replace(
      /(\/api\/surface-links\/pair\/|%2fapi%2fsurface-links%2fpair%2f)[A-Za-z0-9_-]+/gi,
      "$1[redacted]"
    ).replace(
      /^(--> \S+ )(\S+)/,
      (_, prefix: string, target: string) => prefix + redactQuery(target)
    );
    console.log(safeMessage);
  });

  return async (c, next) => {
    if (c.req.method !== "GET" || !isPollingOrHealthPath(c.req.path)) {
      return normalLogger(c, next);
    }

    const startedAt = Date.now();
    await next();

    const elapsedMs = Date.now() - startedAt;
    if (c.res.status < 300 && elapsedMs <= SLOW_REQUEST_MS) return;

    console.log(
      `--> ${c.req.method} ${c.req.path} ${c.res.status} ${elapsedMs}ms`
    );
  };
}
