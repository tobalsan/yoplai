import { Hono, type Context } from "hono";
import { resolveWebBaseUrl, type Extension, type GatewayConfig } from "@yoplai/shared";
import type { ExtensionRuntime } from "./runtime.js";

/** Mount extension pages under a host-owned prefix, following runtime reloads. */
export function createExtensionPageRoutes(deps: {
  getRuntime(): ExtensionRuntime;
  getConfig(): GatewayConfig;
  authenticate(request: Request): Promise<unknown | null>;
}): Hono {
  const routes = new Hono();
  const mounted = new WeakMap<Extension, Hono>();
  routes.all("/:extensionId/*", async (c) => {
    const runtime = deps.getRuntime();
    const id = c.req.param("extensionId");
    const extension = runtime.getLoadedExtensions().find((entry) => entry.id === id);
    if (!extension?.registerPageRoutes || !runtime.isEnabled(id, deps.getConfig())) {
      return c.json({ error: "extension_disabled", extension: id }, 404);
    }
    let app = mounted.get(extension);
    if (!app) {
      const pages = new Hono();
      for (const route of extension.tokenAuthenticatedRoutes ?? []) {
        pages.on(route.method, route.path, async (page: Context, next) => {
          page.set("extensionTokenAuthenticated", true);
          await next();
        });
      }
      pages.use("*", async (page: Context, next) => {
        page.header("Cache-Control", "no-store");
        if (page.get("extensionTokenAuthenticated") || !deps.getRuntime().isEnabled("multiUser")) {
          await next();
          return;
        }
        const auth = await deps.authenticate(page.req.raw);
        if (!auth) {
          if (page.req.method !== "GET") return page.json({ error: "unauthorized" }, 401);
          const login = new URL("/login", resolveWebBaseUrl(deps.getConfig()));
          const target = new URL(page.req.url);
          login.searchParams.set("returnTo", target.pathname + target.search);
          return page.redirect(login.toString(), 302);
        }
        if (page.req.method !== "GET" && typeof auth === "object" && "impersonator" in auth && auth.impersonator) {
          return page.json({ error: "read_only_impersonation" }, 403);
        }
        page.set("multiUserAuthContext", auth);
        await next();
      });
      extension.registerPageRoutes(pages);
      app = new Hono().route(`/x/${encodeURIComponent(id)}`, pages);
      mounted.set(extension, app);
    }
    return app.fetch(c.req.raw);
  });
  return routes;
}
