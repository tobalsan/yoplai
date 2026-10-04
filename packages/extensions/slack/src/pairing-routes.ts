import type { Hono } from "hono";
import { getSlackContextIfInitialized } from "./context.js";
import { getSlackPairingService, SlackPairingError } from "./pairing.js";

export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
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

const brandName = () => getSlackContextIfInitialized()?.getConfig().branding?.name?.trim() || "Yoplai";

export function page(content: string): string {
  const branding = getSlackContextIfInitialized()?.getConfig().branding;
  const name = escapeHtml(brandName());
  const logo = branding?.logo ? `<img src="/api/branding/logo" alt="">` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Slack to ${name}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>${PAGE_STYLE}</style><link rel="stylesheet" href="/api/theme.css"></head>
<body><main><div class="brand">${logo}<span>${name}</span></div><h1>Connect Slack to ${name}</h1>${content}</main></body></html>`;
}

export function registerSlackPairingRoutes(app: Hono): void {
  app.on(["GET", "POST"], "/slack/pair/:token", async (c) => {
    c.header("Cache-Control", "no-store");
    // no-referrer would make browsers send `Origin: null` on the form POST.
    c.header("Referrer-Policy", "same-origin");
    c.header("Content-Security-Policy", "default-src 'none'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    const service = getSlackPairingService();
    if (!service) return c.html(page("<p>Slack pairing is unavailable.</p>"), 503);
    try {
      const token = c.req.param("token");
      const identity = service.inspect(token);
      const { getMultiUserRuntime } = await import("@yoplai/extension-multi-user");
      const runtime = getMultiUserRuntime();
      if (!runtime) return c.html(page("<p>Slack pairing requires multi-user sign-in.</p>"), 503);
      const session = await runtime.auth.api.getSession({ headers: c.req.raw.headers });
      const description = `<p>Slack account: <strong>${escapeHtml(identity.identity)}</strong></p><p class="meta">${escapeHtml(identity.slackUserId)} · workspace ${escapeHtml(identity.workspaceId)}</p>`;
      if (!session) {
        const returnTo = `/api/slack/pair/${encodeURIComponent(token)}`;
        const login = new URL("/login", service.baseUrl);
        login.searchParams.set("returnTo", returnTo);
        return c.html(page(`${description}<p>Sign in to your existing ${escapeHtml(brandName())} account to connect Slack.</p><a class="btn" href="${escapeHtml(login.href)}">Sign in</a>`), c.req.method === "POST" ? 401 : 200);
      }
      const user = runtime.db.prepare("SELECT id, email, approved, role, banned FROM user WHERE id = ?")
        .get(session.user.id) as { id: string; email: string; approved: number; role: string; banned: number } | undefined;
      if (!user || user.banned || (!user.approved && !["admin", "superadmin"].includes(user.role))) {
        return c.html(page("<p>Your account does not have access.</p>"), 403);
      }
      if (c.req.method === "GET") {
        return c.html(page(`${description}<p>Connect to <strong>${escapeHtml(user.email)}</strong>.</p><form method="post"><button class="btn" type="submit">Connect Slack</button></form>`));
      }
      const origin = c.req.header("origin");
      if (!origin || ![new URL(c.req.url).origin, new URL(service.baseUrl).origin].includes(origin)) return c.html(page("<p>Invalid request origin.</p>"), 403);
      await service.redeem(token, user);
      return c.html(page("<p>Slack connected. Return to Slack and retry your message.</p>"));
    } catch (error) {
      const message = error instanceof SlackPairingError ? error.message : "Slack pairing is unavailable. Please try again.";
      return c.html(page(`<p class="error">${escapeHtml(message)}</p>`), error instanceof SlackPairingError ? 400 : 503);
    }
  });
}
