import type { Hono } from "hono";
import { getSlackContext } from "./context.js";
import { getSlackPairingService, SlackPairingError } from "./pairing.js";
import { bindCredentialConnect, confirmCredentialConnect, inspectCredentialConnect } from "./credential-connect.js";
import { escapeHtml, page } from "./pairing-routes.js";

export function registerCredentialConnectRoutes(app: Hono): void {
  let multiUser: Promise<typeof import("@yoplai/extension-multi-user")> | undefined;
  app.on(["GET", "POST"], "/slack/connect/:token", async (c) => {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "same-origin");
    // form-action is omitted so the combined POST can redirect to the OAuth provider.
    c.header("Content-Security-Policy", "default-src 'none'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    let locked: ReturnType<typeof inspectCredentialConnect> | undefined;
    try {
      const token = c.req.param("token");
      const request = inspectCredentialConnect(token);
      const ctx = getSlackContext();
      const pairing = getSlackPairingService();
      if (!ctx.credentialConnect || !pairing) throw new Error("Connection unavailable");
      const { getMultiUserRuntime, hasAgentAccess, hasActiveImpersonation, getRequestAuthContext, getForwardedAuthContext } = await (multiUser ??= import("@yoplai/extension-multi-user"));
      if (hasActiveImpersonation(getRequestAuthContext(c) ?? getForwardedAuthContext(c.req.raw.headers))) {
        return c.html(page("<p>Exit read-only impersonation before connecting credentials.</p>"), 403);
      }
      const runtime = getMultiUserRuntime();
      if (!runtime) throw new Error("Sign-in unavailable");
      const session = await runtime.auth.api.getSession({ headers: c.req.raw.headers });
      if (!session) {
        const login = new URL("/login", pairing.baseUrl);
        login.searchParams.set("returnTo", `/api/slack/connect/${encodeURIComponent(token)}`);
        return c.redirect(login.href, 302);
      }
      const user = runtime.db.prepare("SELECT id, email, approved, role, banned FROM user WHERE id = ?").get(session.user.id) as { id: string; email: string; approved: number; role: string; banned: number } | undefined;
      if (!user || user.banned || (!user.approved && !["admin", "superadmin"].includes(user.role)) || !(await hasAgentAccess({ user: { id: user.id, email: user.email, role: user.role }, session: { id: session.session.id, userId: user.id } }, request.sender.agentId))) {
        return c.html(page("<p>Your account does not have access.</p>"), 403);
      }
      if (request.owner && request.owner !== user.id) throw new SlackPairingError("This link was created for another Slack account");
      // Refuse a forwarded unpaired link before asking for any secret.
      if (c.req.method === "GET" && !request.owner && request.pairingToken) await pairing.verify(request.pairingToken, user);
      if (request.busy) return c.html(page("<p>This connection is already in progress. Complete it in the provider window, or request a new link in Slack.</p>"), 409);
      if (c.req.method === "GET" && request.owner && request.target.kind !== "token") {
        request.busy = true;
        locked = request;
        await bindCredentialConnect(request, user);
        const url = await ctx.credentialConnect.start(request.target, { agentId: request.sender.agentId, userId: user.id, actorEmail: user.email, onComplete: () => confirmCredentialConnect(request) });
        locked = undefined;
        return c.redirect(url, 302);
      }
      let fields: Array<{ name: string; label: string; required: boolean; secret?: boolean }> = [];
      if (request.target.kind === "token") fields = await ctx.credentialConnect.fields(request.sender.agentId, request.target.extensionId);
      const form = fields.map((field) => `<p><label>${escapeHtml(field.label)}<input style="width:100%;padding:8px" type="${field.secret === false ? "text" : "password"}" autocomplete="off" name="${escapeHtml(field.name)}" ${field.required ? "required" : ""}></label></p>`).join("");
      if (c.req.method === "GET") {
        const identity = request.pairingToken ? pairing.inspect(request.pairingToken).identity : `${request.sender.user} · workspace ${request.workspace}`;
        const target = request.target.kind === "oauth" ? request.target.provider : request.target.extensionId;
        return c.html(page(`<p>Slack account: <strong>${escapeHtml(identity)}</strong></p><p>Connect <strong>${escapeHtml(target)}</strong> for <strong>${escapeHtml(user.email)}</strong> — Just me.</p><form method="post">${form}<button class="btn" type="submit">Connect${request.target.kind === "oauth" ? ` ${escapeHtml(request.target.provider)}` : ""}</button></form>`));
      }
      const origin = c.req.header("origin");
      if (!origin || ![new URL(c.req.url).origin, new URL(pairing.baseUrl).origin].includes(origin)) return c.html(page("<p>Invalid request origin.</p>"), 403);
      if (request.busy) return c.html(page("<p>This connection is already in progress.</p>"), 409);
      request.busy = true;
      locked = request;
      const body = request.target.kind === "token" ? await c.req.parseBody() : {};
      const secrets: Record<string, string> = {};
      for (const field of fields) {
        const value = body[field.name];
        if (typeof value === "string" && value) secrets[field.name] = value;
        else if (field.required) throw new SlackPairingError(`Enter ${field.label}.`);
      }
      await bindCredentialConnect(request, user);
      if (request.target.kind === "token") {
        await ctx.credentialConnect.save(request.sender.agentId, request.target.extensionId, user.id, secrets);
        await confirmCredentialConnect(request);
        return c.html(page("<p>You're connected, try again in Slack.</p>"));
      }
      const url = await ctx.credentialConnect.start(request.target, {
        agentId: request.sender.agentId, userId: user.id, actorEmail: user.email,
        onComplete: () => confirmCredentialConnect(request),
      });
      locked = undefined;
      return c.redirect(url, 302);
    } catch (error) {
      const message = error instanceof SlackPairingError ? error.message : "Connection failed. Please try again.";
      return c.html(page(`<p class="error">${escapeHtml(message)}</p>`), error instanceof SlackPairingError ? 400 : 503);
    } finally {
      if (locked) locked.busy = false;
    }
  });
}
