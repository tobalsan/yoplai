import type { Hono } from "hono";
import { getSlackPairingService, SlackPairingError } from "./pairing.js";

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const page = (content: string) => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Connect Slack to Yoplai</title><body><main><h1>Connect Slack to Yoplai</h1>${content}</main></body></html>`;

export function registerSlackPairingRoutes(app: Hono): void {
  app.on(["GET", "POST"], "/slack/pair/:token", async (c) => {
    c.header("Cache-Control", "no-store");
    // no-referrer would make browsers send `Origin: null` on the form POST.
    c.header("Referrer-Policy", "same-origin");
    c.header("Content-Security-Policy", "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    const service = getSlackPairingService();
    if (!service) return c.html(page("<p>Slack pairing is unavailable.</p>"), 503);
    try {
      const token = c.req.param("token");
      const identity = service.inspect(token);
      const { getMultiUserRuntime } = await import("@yoplai/extension-multi-user");
      const runtime = getMultiUserRuntime();
      if (!runtime) return c.html(page("<p>Slack pairing requires multi-user sign-in.</p>"), 503);
      const session = await runtime.auth.api.getSession({ headers: c.req.raw.headers });
      const description = `<p>Slack account: <strong>${escapeHtml(identity.identity)}</strong> (${escapeHtml(identity.slackUserId)}) in workspace ${escapeHtml(identity.workspaceId)}.</p>`;
      if (!session) {
        const returnTo = `/api/slack/pair/${encodeURIComponent(token)}`;
        const login = new URL("/login", service.baseUrl);
        login.searchParams.set("returnTo", returnTo);
        return c.html(page(`${description}<p>Sign in to your existing Yoplai account to connect Slack.</p><a href="${escapeHtml(login.href)}">Sign in</a>`), c.req.method === "POST" ? 401 : 200);
      }
      const user = runtime.db.prepare("SELECT id, email, approved, role, banned FROM user WHERE id = ?")
        .get(session.user.id) as { id: string; email: string; approved: number; role: string; banned: number } | undefined;
      if (!user || user.banned || (!user.approved && !["admin", "superadmin"].includes(user.role))) {
        return c.html(page("<p>Your account does not have access.</p>"), 403);
      }
      if (c.req.method === "GET") {
        return c.html(page(`${description}<p>Connect to ${escapeHtml(user.email)}.</p><form method="post"><button type="submit">Connect Slack</button></form>`));
      }
      const origin = c.req.header("origin");
      if (!origin || ![new URL(c.req.url).origin, new URL(service.baseUrl).origin].includes(origin)) return c.html(page("<p>Invalid request origin.</p>"), 403);
      await service.redeem(token, user);
      return c.html(page("<p>Slack connected. Return to Slack and retry your message.</p>"));
    } catch (error) {
      const message = error instanceof SlackPairingError ? error.message : "Slack pairing is unavailable. Please try again.";
      return c.html(page(`<p>${escapeHtml(message)}</p>`), error instanceof SlackPairingError ? 400 : 503);
    }
  });
}
