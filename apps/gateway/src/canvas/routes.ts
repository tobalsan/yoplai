import { Hono } from "hono";
import type { AgentConfig, GatewayConfig } from "@yoplai/shared";
import {
  dashboardBaseUrl,
  normalizeDashboardSlug,
  openDashboardFile,
} from "./index.js";
import { DashboardRegistry } from "./store.js";

export type DashboardRouteDependencies = {
  getConfig(): GatewayConfig;
  getAgent(id: string): AgentConfig | undefined;
  registry: DashboardRegistry;
  authenticate(request: Request): Promise<unknown | null>;
  hasAgentAccess(auth: unknown, agentId: string): Promise<boolean>;
};

export function dashboardCsp(config: GatewayConfig): string {
  const assets = `${dashboardBaseUrl(config)}/d-assets/`;
  return `sandbox allow-scripts allow-downloads allow-modals; default-src 'none'; script-src 'unsafe-inline' ${assets}; style-src 'unsafe-inline' ${assets}; img-src data: blob:; font-src data: ${assets}; connect-src 'none'`;
}

export function createDashboardRoutes(deps: DashboardRouteDependencies): Hono {
  const routes = new Hono();
  routes.get("/:id", async (c) => {
    const config = deps.getConfig();
    if (config.canvas?.enabled === false) return c.notFound();
    const entry = await deps.registry.get(c.req.param("id"));
    if (!entry) return c.notFound();

    const auth = await deps.authenticate(c.req.raw);
    if (!auth) {
      const login = new URL("/login", dashboardBaseUrl(config));
      login.searchParams.set("returnTo", new URL(c.req.url).pathname);
      return c.redirect(login.toString(), 302);
    }
    if (!(await deps.hasAgentAccess(auth, entry.agentId))) return c.notFound();

    const agent = deps.getAgent(entry.agentId);
    if (!agent) return c.notFound();
    let slug: string;
    try {
      slug = normalizeDashboardSlug(entry.slug);
    } catch {
      return c.notFound();
    }
    try {
      const file = await openDashboardFile(agent, slug);
      let html: string;
      try {
        html = await file.readFile("utf8");
      } finally {
        await file.close();
      }
      c.header("Content-Security-Policy", dashboardCsp(config));
      c.header("Cache-Control", "no-store");
      return c.html(html);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return c.notFound();
      throw error;
    }
  });
  return routes;
}
