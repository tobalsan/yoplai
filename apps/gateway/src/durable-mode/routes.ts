import { Hono, type Context } from "hono";
import { isTrustedRequest } from "../relay/state.js";
import { DurableModeStore, durableModeTime } from "./store.js";
import { durableModeSync } from "./sync.js";

type DurableModeRouteDeps = {
  dataDir: string;
  getUserId(c: Context): Promise<string | undefined>;
  isMultiUser(): boolean;
};

export function createDurableModeRoutes(deps: DurableModeRouteDeps): Hono {
  const routes = new Hono();
  const canSync = (c: Context) => isTrustedRequest(c.req.header("origin"), c.req.header("x-forwarded-for"));
  const storeFor = async (c: Context) => {
    const userId = await deps.getUserId(c);
    if (deps.isMultiUser() && (!userId || userId === "local")) return null;
    return new DurableModeStore(deps.dataDir, userId);
  };
  routes.get("/me/durable-mode", async (c) => {
    const store = await storeFor(c);
    if (!store) return c.json({ error: "Unauthorized" }, 401);
    if (c.req.query("local") === "1" || !canSync(c)) return c.json(await store.read());
    const unsynced = await durableModeSync.reconcile(store);
    return c.json({ ...await store.read(), ...(unsynced.length ? { unsynced } : {}) });
  });
  routes.put("/me/durable-mode", async (c) => {
    const store = await storeFor(c);
    if (!store) return c.json({ error: "Unauthorized" }, 401);
    const body = await c.req.json().catch(() => null) as { enabled?: unknown; updatedAt?: unknown } | null;
    if (typeof body?.enabled !== "boolean") return c.json({ error: "Enabled must be a boolean" }, 400);
    const { enabled, updatedAt } = body;
    if (updatedAt !== undefined && (typeof updatedAt !== "string" || durableModeTime(updatedAt) === -Infinity)) {
      return c.json({ error: "UpdatedAt must be a valid date string" }, 400);
    }
    const saved = await store.set(enabled, updatedAt);
    if (updatedAt !== undefined || !canSync(c)) return c.json(saved);
    const unsynced = await durableModeSync.pushToLinks(saved);
    return c.json({ ...saved, ...(unsynced.length ? { unsynced } : {}) });
  });
  return routes;
}
