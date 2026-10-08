import { Hono, type Context } from "hono";
import { listOAuthProviders, type AgentConfig, type GatewayConfig } from "@yoplai/shared";
import { loadConfig, resolveAgentEnv } from "../config/index.js";
import { buildExtensionCatalog } from "../extensions/catalog.js";
import { getOAuthService } from "../oauth/service.js";
import { CredentialStore } from "./store.js";
import { deletePersonalExtensionTokens, extensionSecretFields, getPersonalExtensionTokens } from "./extension-tokens.js";
import { getAuditActor, recordSettingsChange } from "../audit/store.js";
import type { SettingsAuditChange } from "@yoplai/shared";

export function createConnectionRoutes(options: {
  canAccessAgent: (c: Context, agentId: string) => Promise<boolean>;
  getUserId: (c: Context) => Promise<string | undefined>;
  config?: () => GatewayConfig;
  catalog?: typeof buildExtensionCatalog;
  oauth?: ReturnType<typeof getOAuthService>;
  store?: CredentialStore;
}) {
  const router = new Hono();
  const config = options.config ?? loadConfig;
  const catalog = options.catalog ?? buildExtensionCatalog;
  const oauth = options.oauth ?? getOAuthService();
  const store = options.store ?? new CredentialStore();
  const findAgent = (value: GatewayConfig, id: string): AgentConfig | undefined =>
    value.agents.find((agent) => agent.id === id) ?? value.pool?.find((agent) => agent.id === id);

  router.use("/agents/:id/connections/*", async (c, next) => {
    if (!(await options.getUserId(c))) return c.json({ error: "login_required" }, 401);
    if (!(await options.canAccessAgent(c, c.req.param("id")!))) return c.json({ error: "forbidden" }, 403);
    await next();
  });

  router.get("/agents/:id/connections", async (c) => {
    const userId = (await options.getUserId(c))!;
    const value = config();
    const agent = findAgent(value, c.req.param("id"));
    if (!agent) return c.json({ error: "agent_not_found" }, 404);
    const connections = listOAuthProviders().map((provider) => ({
      kind: "oauth", id: provider.id, name: provider.id,
      personal: !!oauth.getScopedConnection(agent.id, provider.id, { type: "personal", userId }),
      team: !!oauth.getScopedConnection(agent.id, provider.id, { type: "team" }),
    }));
    for (const entry of await catalog(value, agent)) {
      const fields = extensionSecretFields(entry);
      if (!fields.length) continue;
      const tokens = getPersonalExtensionTokens(store, agent.id, userId, entry.id);
      const root = value.extensions?.[entry.id];
      const scoped = agent.extensions?.[entry.id];
      const shared: Record<string, unknown> = {
        ...(typeof root === "object" && root !== null ? root : {}),
        ...(typeof scoped === "object" && scoped !== null ? scoped : {}),
      };
      connections.push({ kind: "extension", id: entry.id, name: entry.displayName,
        personal: fields.some((field) => !!tokens?.[field]),
        team: fields.some((field) => {
          const token = shared[field];
          return typeof token === "string" && !!(token.startsWith("$env:") ? resolveAgentEnv(agent, value)[token.slice(5)] : token);
        }),
      });
    }
    c.header("Cache-Control", "no-store");
    return c.json({ connections: connections.filter((entry) => entry.personal || entry.team) });
  });

  router.delete("/agents/:id/connections/:kind/:integration", async (c) => {
    const agent = findAgent(config(), c.req.param("id"));
    if (!agent) return c.json({ error: "agent_not_found" }, 404);
    const userId = (await options.getUserId(c))!;
    const integration = c.req.param("integration");
    let changes: SettingsAuditChange[] = [];
    if (c.req.param("kind") === "oauth" && listOAuthProviders().some((provider) => provider.id === integration)) {
      if (oauth.getScopedConnection(agent.id, integration, { type: "personal", userId })) changes = [{ field: "credentials", secret: "removed" }];
      await oauth.disconnect(agent.id, integration, { type: "personal", userId });
    } else if (c.req.param("kind") === "extension") {
      const entry = (await catalog(config(), agent)).find((item) => item.id === integration);
      if (!entry || !extensionSecretFields(entry).length) return c.json({ error: "unknown_connection" }, 404);
      const existing = getPersonalExtensionTokens(store, agent.id, userId, integration);
      const secrets = new Set(extensionSecretFields(entry));
      changes = Object.entries(existing ?? {}).map(([field, before]) => secrets.has(field) ? { field, secret: "removed" as const } : { field, before });
      deletePersonalExtensionTokens(store, agent.id, userId, integration);
    } else return c.json({ error: "unknown_connection" }, 404);
    if (changes.length) recordSettingsChange({ ...await getAuditActor(c), actorUserId: userId, action: "connection.personal_remove", agentId: agent.id,
      targetType: c.req.param("kind") === "oauth" ? "oauth" : "extension", targetId: integration, scope: "personal", changes });
    return c.json({ ok: true });
  });
  return router;
}
