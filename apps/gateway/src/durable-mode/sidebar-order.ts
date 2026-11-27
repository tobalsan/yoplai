import fs from "node:fs/promises";
import path from "node:path";
import { getUserSessionsPath } from "@yoplai/extension-multi-user/isolation";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { writeJsonAtomic } from "../util/atomic-write.js";

const orderSchema = z.object({ agentIds: z.array(z.string().min(1)) });

class SidebarOrderStore {
  private readonly file: string;

  constructor(dataDir: string, userId?: string) {
    if (userId !== undefined && !/^[a-zA-Z0-9_-]{1,100}$/.test(userId)) throw new Error("Invalid user id");
    this.file = path.join(path.dirname(getUserSessionsPath(userId, dataDir)), "sidebar-order.json");
  }

  async get() {
    try {
      return orderSchema.parse(JSON.parse(await fs.readFile(this.file, "utf8"))).agentIds;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  set(agentIds: string[]) {
    return writeJsonAtomic(this.file, { agentIds });
  }
}

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
    const visible = new Set(await deps.getVisibleAgentIds(c));
    if (c.req.method === "GET") {
      return c.json({ agentIds: (await store.get()).filter((id) => visible.has(id)) });
    }
    const body = orderSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "agentIds must be an array of non-empty strings" }, 400);
    const agentIds = [...new Set(body.data.agentIds)].filter((id) => visible.has(id));
    await store.set(agentIds);
    return c.json({ agentIds });
  });
  return routes;
}
