import type { Context, Hono } from "hono";
import { getSurfaceLinkService, type GatewayConfig } from "@yoplai/shared";
import { getMultiUserRuntime } from "./runtime-state.js";
import { getEligibleAccount } from "./users.js";
import { SurfaceLinkError } from "./surface-links.js";

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const PAGE_STYLE = `
:root{--bg-base:#0a0a0a;--bg-surface:#1a1a1a;--border-default:#2a2a2a;--text-primary:#fff;--text-secondary:#b6b6b6;--text-tertiary:#888;--bg-accent:#2563eb;--text-on-accent:#fff;--tone-error:#f5b0b0}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;background:var(--bg-base);color:var(--text-primary);display:flex;align-items:center;justify-content:center;padding:24px;line-height:1.5}
main{width:100%;max-width:420px;background:var(--bg-surface);border:1px solid var(--border-default);border-radius:12px;padding:32px}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:24px;color:var(--text-secondary);font-weight:600;font-size:14px}
.brand img{height:28px;width:auto}
h1{font-size:20px;font-weight:600;margin-bottom:16px}
p{color:var(--text-secondary);font-size:14px;margin-bottom:12px}
strong{color:var(--text-primary);font-weight:600}
.meta{color:var(--text-tertiary);font-size:12px}
.error{color:var(--tone-error)}
.btn{display:inline-block;margin-top:12px;width:100%;text-align:center;border:0;border-radius:8px;padding:10px 16px;font:inherit;font-size:14px;font-weight:600;cursor:pointer;text-decoration:none;background:var(--bg-accent);color:var(--text-on-accent)}
.btn:hover{filter:brightness(1.1)}`;

function isTrustedOrigin(c: Context, baseUrl: string): boolean {
  const origin = c.req.header("origin");
  return !!origin && [new URL(c.req.url).origin, new URL(baseUrl).origin].includes(origin);
}

export function registerSurfaceLinkRoutes(app: Hono, getBranding: () => GatewayConfig["branding"] = () => undefined): void {
  const page = (content: string, surface = "surface account") => {
    const branding = getBranding();
    const name = escapeHtml(branding?.name?.trim() || "Yoplai");
    const logo = branding?.logo ? '<img src="/api/branding/logo" alt="">' : "";
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect ${surface} to ${name}</title><style>${PAGE_STYLE}</style><link rel="stylesheet" href="/api/theme.css"></head><body><main><div class="brand">${logo}<span>${name}</span></div><h1>Connect ${surface} to ${name}</h1>${content}</main></body></html>`;
  };
  const manage = async (c: Context) => {
    c.header("Cache-Control", "no-store");
    const service = getSurfaceLinkService();
    const runtime = getMultiUserRuntime();
    if (!service || !runtime) return c.json({ error: "linking_unavailable" }, 503);
    const session = await runtime.auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: "login_required" }, 401);
    const user = getEligibleAccount(runtime.db, session.user.id);
    if (!user) return c.json({ error: "forbidden" }, 403);
    if (c.req.method === "GET") return c.json({ links: service.list(user.id) });
    if (!isTrustedOrigin(c, service.baseUrl)) return c.json({ error: "invalid_origin" }, 403);
    service.unlink(user.id, c.req.param("id")!);
    return c.json({ ok: true });
  };
  app.get("/surface-links", manage);
  app.delete("/surface-links/:id", manage);
  app.on(["GET", "POST"], "/surface-links/pair/:token", async (c) => {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "same-origin");
    c.header("Content-Security-Policy", "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    const service = getSurfaceLinkService();
    if (!service) return c.html(page("<p>Account linking requires multi-user sign-in.</p>"), 503);
    try {
      const token = c.req.param("token");
      const identity = service.inspect(token);
      const surface = identity.surface === "threadit" ? "Threadit" : "Mattermost";
      const runtime = getMultiUserRuntime();
      const session = await runtime?.auth.api.getSession({ headers: c.req.raw.headers });
      const description = `<p>${surface} account: <strong>@${escapeHtml(identity.username)}</strong></p><p class="meta">${escapeHtml(identity.scope)}</p>`;
      if (!session || !runtime) {
        const login = new URL("/login", service.baseUrl);
        login.searchParams.set("returnTo", `/api/surface-links/pair/${encodeURIComponent(token)}`);
        return c.html(page(`${description}<p>Sign in to connect your account.</p><a class="btn" href="${escapeHtml(login.href)}">Sign in</a>`, surface), c.req.method === "POST" ? 401 : 200);
      }
      const user = getEligibleAccount(runtime.db, session.user.id);
      if (!user) return c.html(page("<p>Your account does not have access.</p>", surface), 403);
      if (c.req.method === "GET") {
        return c.html(page(`${description}<p>Connect to <strong>${escapeHtml(user.email)}</strong>.</p><form method="post"><button class="btn" type="submit">Connect</button></form>`, surface));
      }
      if (!isTrustedOrigin(c, service.baseUrl)) return c.html(page("<p>Invalid request origin.</p>", surface), 403);
      await service.redeem(token, user);
      return c.html(page(`<p>Connected. Return to ${surface} and retry your message.</p>`, surface));
    } catch (error) {
      const message = error instanceof SurfaceLinkError ? error.message : "Account linking is unavailable. Please try again.";
      return c.html(page(`<p class="error">${escapeHtml(message)}</p>`), error instanceof SurfaceLinkError ? 400 : 503);
    }
  });
}
