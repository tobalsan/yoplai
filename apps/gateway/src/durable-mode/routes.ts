import { Hono, type Context } from "hono";
import { DurableModeStore } from "./store.js";

type DurableModeRouteDeps = {
  dataDir: string;
  getUserId(c: Context): Promise<string | undefined>;
  isMultiUser(): boolean;
};

export function createDurableModeRoutes(deps: DurableModeRouteDeps): Hono {
  const routes = new Hono();
  const storeFor = async (c: Context) => {
    const userId = await deps.getUserId(c);
    if (deps.isMultiUser() && (!userId || userId === "local")) return null;
    return new DurableModeStore(deps.dataDir, userId);
  };
  routes.get("/me/durable-mode", async (c) => {
    const store = await storeFor(c);
    if (!store) return c.json({ error: "Unauthorized" }, 401);
    return c.json({ enabled: await store.get() });
  });
  routes.put("/me/durable-mode", async (c) => {
    const store = await storeFor(c);
    if (!store) return c.json({ error: "Unauthorized" }, 401);
    const body = await c.req.json().catch(() => null) as { enabled?: unknown } | null;
    if (typeof body?.enabled !== "boolean") return c.json({ error: "Enabled must be a boolean" }, 400);
    await store.set(body.enabled);
    return c.json({ enabled: body.enabled });
  });
  return routes;
}
