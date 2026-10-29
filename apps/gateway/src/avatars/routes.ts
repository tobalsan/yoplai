import path from "node:path";
import { Hono, type Context } from "hono";
import type { AgentConfig, GatewayConfig } from "@yoplai/shared";
import { AvatarProviderUnavailableError } from "./generate.js";
import { generateAgentAvatar, type AvatarServiceDeps } from "./service.js";
import { defaultAvatarStyle, listAvatarStyles, UnknownAvatarStyleError } from "./styles.js";

type AvatarRouteDeps = {
  getConfig(): GatewayConfig;
  getAgent(id: string): AgentConfig | undefined;
  canManageAgent(c: Context, agentId: string): Promise<boolean>;
  /** Called once agent.yaml points at the new file, so the next agent list shows it. */
  afterWrite(): Promise<unknown>;
  audit?(c: Context, agentId: string, before: string | undefined, after: string): Promise<void>;
  service?: AvatarServiceDeps;
};

export function createAvatarRoutes(deps: AvatarRouteDeps): Hono {
  const routes = new Hono();

  routes.get("/avatars/styles", (c) => {
    const config = deps.getConfig();
    return c.json({
      default: defaultAvatarStyle(config),
      styles: listAvatarStyles(config).map(({ id, label }) => ({ id, label })),
    });
  });

  // POST /api/agents/:id/avatar {style?} - generate, save and select a new avatar
  routes.post("/agents/:id/avatar", async (c) => {
    const agentId = c.req.param("id");
    const agent = deps.getAgent(agentId);
    if (!agent) return c.json({ error: "Not found" }, 404);
    if (!(await deps.canManageAgent(c, agentId))) return c.json({ error: "Forbidden" }, 403);
    const body = (await c.req.json().catch(() => ({}))) as { style?: unknown };
    if (body.style !== undefined && typeof body.style !== "string") {
      return c.json({ error: "style must be a string" }, 400);
    }
    try {
      const result = await generateAgentAvatar(agent, deps.getConfig(), body.style, deps.service, c.req.raw.signal);
      await deps.afterWrite();
      await deps.audit?.(c, agentId, agent.avatar, `${path.basename(result.file)} (${result.style})`);
      return c.json({ style: result.style, avatar: `/api/agents/${encodeURIComponent(agentId)}/avatar?v=${Date.now()}` });
    } catch (error) {
      if (error instanceof UnknownAvatarStyleError) return c.json({ error: error.message }, 400);
      if (error instanceof AvatarProviderUnavailableError) return c.json({ error: error.message }, 409);
      console.warn(`[avatars] generation for ${agentId} failed: ${(error as Error).message}`);
      return c.json({ error: (error as Error).message }, 502);
    }
  });

  return routes;
}
