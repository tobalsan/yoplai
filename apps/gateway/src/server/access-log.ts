import type { MiddlewareHandler } from "hono";
import { logger } from "hono/logger";

const SLOW_REQUEST_MS = 500;
const SECRET_QUERY_NAMES = new Set([
  "code",
  "state",
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

export function accessLogger(): MiddlewareHandler {
  const normalLogger = logger((message) => {
    if (message.startsWith("<-- ")) return;
    const safeMessage = stripAnsi(message).replace(
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
