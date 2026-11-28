import { Hono, type Context } from "hono";
import { getAgent } from "../config/index.js";
import { removeGatewaySuffix } from "../relay/agent-id.js";
import { getLinkedGateways, isTrustedRequest } from "../relay/state.js";
import { SidebarOrderStore, sidebarOrderSchema, type SidebarOrder } from "./sidebar-order-store.js";
import { sidebarOrderSync } from "./sidebar-order-sync.js";
import { applyVisibleOrder } from "./sidebar-ordering.js";
import { durableModeTime } from "./store.js";

export function createSidebarOrderRoutes(deps: {
  dataDir: string;
  getUserId(c: Context): Promise<string | undefined>;
  isMultiUser(): boolean;
  getVisibleAgentIds(c: Context): Promise<string[]>;
}): Hono {
  const routes = new Hono();
  routes.on(["GET", "PUT"], "/me/sidebar-order", async (c) => {
    const userId = await deps.getUserId(c);
    if (deps.isMultiUser() && (!userId || userId === "local")) return c.json({ error: "Unauthorized" }, 401);
    const store = new SidebarOrderStore(deps.dataDir, userId);
    const localOnly = c.req.method === "GET" && c.req.query("local") === "1";
    const trusted = isTrustedRequest(c.req.header("origin"), c.req.header("x-forwarded-for"));
    if (c.req.method === "GET" && !localOnly && trusted) await sidebarOrderSync.reconcile(store);
    const visible = new Set(await deps.getVisibleAgentIds(c));
    const gatewayNames = localOnly ? [] : getLinkedGateways().map(({ name }) => name);
    const isVisible = (id: string) => visible.has(id) ||
      (!getAgent(id) && removeGatewaySuffix(id, gatewayNames).gateway !== undefined);
    const filterVisible = (order: SidebarOrder) => ({
      ...order, agentIds: order.agentIds.filter(isVisible),
    });
    if (c.req.method === "GET") return c.json(filterVisible(await store.read()));
    const body = sidebarOrderSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      const error = body.error.issues[0]?.path[0] === "updatedAt"
        ? "updatedAt must be a valid ISO timestamp"
        : "agentIds must be an array of non-empty strings";
      return c.json({ error }, 400);
    }
    const { agentIds, updatedAt } = filterVisible(body.data);
    const saved = await store.update((current) => {
      if (updatedAt !== undefined && durableModeTime(updatedAt) <= durableModeTime(current.updatedAt)) return current;
      return {
        agentIds: applyVisibleOrder(current.agentIds, [...new Set(agentIds)]),
        updatedAt: updatedAt ?? new Date().toISOString(),
      };
    });
    if (updatedAt === undefined && trusted) await sidebarOrderSync.pushToLinks(saved);
    return c.json(filterVisible(saved));
  });
  return routes;
}
