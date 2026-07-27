import { Hono, type Context } from "hono";
import { getOAuthProvider } from "@yoplai/shared";
import { getOAuthService, type OAuthService } from "./service.js";

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
  ) => Promise<boolean> = async () => true
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
    const scopesParam = c.req.query("scopes");
    const scopes = scopesParam
      ? scopesParam
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    try {
      const { authorizeUrl } = await service.startAuthorization({
        agentId,
        provider,
        scopes,
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
    if (providerError) {
      return c.html(
        renderResultPage(false, `Google returned an error: ${providerError}`),
        400
      );
    }
    if (!code || !state) {
      return c.html(renderResultPage(false, "Missing code or state."), 400);
    }
    try {
      const connection = await service.handleCallback({
        provider,
        code,
        state,
      });
      return c.html(
        renderResultPage(
          true,
          `Connected${connection.account ? ` as ${connection.account}` : ""}.`
        )
      );
    } catch (error) {
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
    const state = service.getConnectionState(agentId, provider);
    const connection = service.getConnection(agentId, provider);
    if (!connection) {
      return c.json({ state, connected: false, provider });
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
    await service.disconnect(agentId, provider);
    return c.json({ state: "disconnected", connected: false, provider });
  });

  return router;
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
