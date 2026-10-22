import { Hono, type Context } from "hono";
import { getOAuthProvider, type CredentialScope } from "@yoplai/shared";
import { getOAuthService, OAuthCallbackError, type OAuthService } from "./service.js";
import { getAuditActor, recordSettingsChange } from "../audit/store.js";

/**
 * Host OAuth routes (provider-agnostic):
 *   GET /api/oauth/:provider/authorize?agent=<id>[&scopes=a,b]
 *   GET /api/oauth/:provider/callback?code=&state=
 *   GET /api/oauth/:provider/status?agent=<id>   -> { state, connected, ... }
 *   POST /api/oauth/:provider/disconnect?agent=<id>
 *
 * Note: these are registered on the core `api` router, which is mounted under
 * `/api`, so paths here omit the `/api` prefix.
 */
export function createOAuthRoutes(
  service: OAuthService = getOAuthService(),
  canAccessAgent: (
    c: Context,
    agentId: string
  ) => Promise<boolean> = async () => true,
  getRequesterUserId: (c: Context) => Promise<string | undefined> = async () => undefined,
  canConfigureTeam: (c: Context, agentId: string) => Promise<boolean> = async () => true
): Hono {
  const router = new Hono();

  async function requireAgentAccess(
    c: Context,
    agentId: string
  ): Promise<Response | null> {
    return (await canAccessAgent(c, agentId))
      ? null
      : c.json({ error: "forbidden" }, 403);
  }

  /** Validate a `scope` query value and build the credential scope it names. */
  async function resolveRequestedScope(
    c: Context,
    requested: string,
    agentId: string,
    options: { teamRequiresAdmin: boolean }
  ): Promise<{ scope: CredentialScope; userId: string | undefined } | Response> {
    if (requested !== "team" && requested !== "personal") {
      return c.json({ error: "invalid_scope" }, 400);
    }
    if (
      requested === "team" &&
      options.teamRequiresAdmin &&
      !(await canConfigureTeam(c, agentId))
    ) {
      return c.json({ error: "team_requires_admin" }, 403);
    }
    const userId = await getRequesterUserId(c);
    if (requested === "personal") {
      if (!userId) return c.json({ error: "personal_requires_login" }, 401);
      return { scope: { type: "personal", userId }, userId };
    }
    return { scope: { type: "team" }, userId };
  }

  router.get("/oauth/:provider/authorize", async (c) => {
    const provider = c.req.param("provider");
    const agentId = c.req.query("agent");
    if (!agentId) {
      return c.json(
        { error: "missing_agent", message: "agent query param required" },
        400
      );
    }
    if (!getOAuthProvider(provider)) {
      return c.json({ error: "unknown_provider", provider }, 404);
    }
    const denied = await requireAgentAccess(c, agentId);
    if (denied) return denied;
    const scope = c.req.query("scope");
    if (scope === undefined) {
      return c.html(renderScopePage(provider, agentId, c.req.query("scopes"), !!(await getRequesterUserId(c)), await canConfigureTeam(c, agentId), c.req.query("returnTo")));
    }
    const resolved = await resolveRequestedScope(c, scope, agentId, {
      teamRequiresAdmin: true,
    });
    if (resolved instanceof Response) return resolved;
    const userId = resolved.userId;
    const scopeType = resolved.scope.type;
    const scopesParam = c.req.query("scopes");
    const scopes = scopesParam
      ? scopesParam
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    try {
      const actor = await getAuditActor(c);
      const { authorizeUrl } = await service.startAuthorization({
        agentId,
        provider,
        scopes,
        returnTo: c.req.query("returnTo"),
        scope: scopeType,
        userId: scopeType === "personal" ? userId : undefined,
        onComplete: async () => {
          recordSettingsChange({ ...actor, action: "oauth.connect", agentId, targetType: "oauth", targetId: provider, scope: scopeType,
            changes: [{ field: "credentials", secret: "set" }] });
        },
      });
      return c.redirect(authorizeUrl, 302);
    } catch (error) {
      return c.json(
        {
          error: "authorize_failed",
          message: error instanceof Error ? error.message : String(error),
        },
        400
      );
    }
  });

  router.get("/oauth/:provider/callback", async (c) => {
    const provider = c.req.param("provider");
    const code = c.req.query("code");
    const state = c.req.query("state");
    const providerError = c.req.query("error");
    if (providerError && !state) {
      return c.html(
        renderResultPage(false, `Google returned an error: ${providerError}`),
        400
      );
    }
    if ((!code && !providerError) || !state) {
      return c.html(renderResultPage(false, "Missing code or state."), 400);
    }
    try {
      const connection = await service.handleCallback({
        provider,
        code,
        error: providerError,
        state,
      });
      if (connection.returnTo) {
        return c.redirect(oauthReturnUrl(connection.returnTo, connection.scope ?? "team"), 302);
      }
      return c.html(
        renderResultPage(
          true,
          `Connected${connection.account ? ` as ${connection.account}` : ""}.`
        )
      );
    } catch (error) {
      if (error instanceof OAuthCallbackError && error.returnTo) {
        return c.redirect(oauthReturnUrl(error.returnTo, error.scope, error.message), 302);
      }
      return c.html(
        renderResultPage(
          false,
          error instanceof Error ? error.message : String(error)
        ),
        400
      );
    }
  });

  router.get("/oauth/:provider/status", async (c) => {
    const provider = c.req.param("provider");
    const agentId = c.req.query("agent");
    if (!agentId) {
      return c.json({ error: "missing_agent" }, 400);
    }
    const denied = await requireAgentAccess(c, agentId);
    if (denied) return denied;
    const requestedScope = c.req.query("scope");
    let userId: string | undefined;
    let scopedRequest: CredentialScope | undefined;
    if (requestedScope) {
      const resolved = await resolveRequestedScope(c, requestedScope, agentId, {
        teamRequiresAdmin: false,
      });
      if (resolved instanceof Response) return resolved;
      userId = resolved.userId;
      scopedRequest = resolved.scope;
    } else {
      userId = await getRequesterUserId(c);
    }
    const connection = scopedRequest
      ? service.getScopedConnection(agentId, provider, scopedRequest)
      : service.getConnection(agentId, provider, userId);
    const state = !connection ? "disconnected" : connection.status === "needs_reconnect" ? "needs_reconnect" : "connected";
    const teamAllowed = await canConfigureTeam(c, agentId);
    if (!connection) {
      return c.json({ state, connected: false, provider, canConfigureTeam: teamAllowed });
    }
    // `connected` stays true only for a usable grant; `needs_reconnect` is a
    // first-class state that the UI renders distinctly from "not connected".
    return c.json({
      state,
      connected: state === "connected",
      provider,
      account: connection.account,
      scopes: connection.scopes,
      connectedAt: connection.connectedAt,
      expiresAt: connection.expiresAt,
      scope: connection.scope ?? "team",
      canConfigureTeam: teamAllowed,
    });
  });

  router.post("/oauth/:provider/disconnect", async (c) => {
    const provider = c.req.param("provider");
    const agentId = c.req.query("agent");
    if (!agentId) {
      return c.json({ error: "missing_agent" }, 400);
    }
    const denied = await requireAgentAccess(c, agentId);
    if (denied) return denied;
    const requestedScope = c.req.query("scope") ?? "team";
    const resolved = await resolveRequestedScope(c, requestedScope, agentId, {
      teamRequiresAdmin: true,
    });
    if (resolved instanceof Response) return resolved;
    const scope = resolved.scope;
    const existing = service.getScopedConnection(agentId, provider, scope);
    await service.disconnect(agentId, provider, scope);
    if (existing) recordSettingsChange({ ...await getAuditActor(c), action: "oauth.disconnect", agentId, targetType: "oauth", targetId: provider, scope: scope.type,
      changes: [{ field: "credentials", secret: "removed" }] });
    return c.json({ state: "disconnected", connected: false, provider });
  });

  return router;
}

function oauthReturnUrl(returnTo: string, scope: "personal" | "team", error?: string): string {
  const url = new URL(returnTo, "https://yoplai.invalid");
  url.searchParams.set("oauth", error === undefined ? "connected" : "error");
  url.searchParams.set("oauth_scope", scope);
  if (error !== undefined) url.searchParams.set("oauth_error", error);
  return `${url.pathname}${url.search}${url.hash}`;
}

function renderScopePage(provider: string, agentId: string, scopes: string | undefined, personalAvailable: boolean, teamAvailable: boolean, returnTo?: string): string {
  const query = new URLSearchParams({ agent: agentId });
  if (scopes) query.set("scopes", scopes);
  if (returnTo) query.set("returnTo", returnTo);
  const base = `/api/oauth/${encodeURIComponent(provider)}/authorize?${query.toString()}`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Connect ${escapeHtml(provider)}</title></head>
<body><h1>Who is this connection for?</h1>
${personalAvailable ? `<p><a href="${escapeHtml(base)}&amp;scope=personal">Just me</a></p>` : "<p>Sign in with a Yoplai user account to connect just for yourself.</p>"}
${teamAvailable ? `<p><a href="${escapeHtml(base)}&amp;scope=team">Whole team</a></p>` : ""}</body></html>`;
}

function renderResultPage(success: boolean, message: string): string {
  const title = success ? "Connected" : "Connection failed";
  const color = success ? "#137333" : "#c5221f";
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f8f9fa}
.card{max-width:420px;padding:32px;border-radius:12px;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.12);text-align:center}
h1{color:${color};font-size:20px;margin:0 0 12px}p{color:#3c4043;margin:0}</style></head>
<body><div class="card"><h1>${title}</h1><p>${escapeHtml(message)}</p>
<p style="margin-top:16px;color:#5f6368;font-size:13px">You can close this window and return to Yoplai.</p></div>
<script>try{window.opener&&window.opener.postMessage({type:"yoplai-oauth",success:${success}},"*")}catch(e){}</script>
</body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
