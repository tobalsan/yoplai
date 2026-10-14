import type { MiddlewareHandler } from "hono";
import { logger } from "hono/logger";

const SLOW_REQUEST_MS = 500;
const ANSI_ESCAPE = new RegExp(
  `${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`,
  "g"
);

export function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE, "");
}

function isPollingOrHealthPath(path: string): boolean {
  return (
    path === "/health" ||
    path === "/api/agents/sessions" ||
    path === "/api/auth/get-session" ||
    /^\/api\/agents\/[^/]+\/history$/.test(path)
  );
}

export function accessLogger(): MiddlewareHandler {
  const normalLogger = logger((message) => {
    const safeMessage = stripAnsi(message).replace(
      /\/internal\/dashboards\/[^/?\s]+\/html\?[^\s]*/g,
      (target) => {
        const url = new URL(target, "http://gateway");
        if (!url.searchParams.has("token")) return target;
        url.searchParams.set("token", "[redacted]");
        return url.pathname + url.search;
      }
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
