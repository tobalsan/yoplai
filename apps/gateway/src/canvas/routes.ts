import fs from "node:fs/promises";
import { Hono } from "hono";
import type { AgentConfig, GatewayConfig } from "@yoplai/shared";
import {
  dashboardBaseUrl,
  dashboardDirectory,
  normalizeDashboardSlug,
  openDashboardFile,
} from "./index.js";
import { DashboardRegistry } from "./store.js";
import { executeDashboardQueries } from "./sql.js";

const ASSET_VERSION = "v1";
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
const ASSETS = {
  "kit.js": {
    url: new URL("./assets/kit.js", import.meta.url),
    type: "text/javascript; charset=utf-8",
  },
  "kit.css": {
    url: new URL("./assets/kit.css", import.meta.url),
    type: "text/css; charset=utf-8",
  },
  "sample.html": {
    url: new URL("./assets/sample.html", import.meta.url),
    type: "text/html; charset=utf-8",
  },
  "echarts.js": {
    url: new URL(
      "../../node_modules/echarts/dist/echarts.min.js",
      import.meta.url
    ),
    type: "text/javascript; charset=utf-8",
  },
  "marked.js": {
    url: new URL(
      "../../node_modules/marked/lib/marked.umd.js",
      import.meta.url
    ),
    type: "text/javascript; charset=utf-8",
  },
  "purify.js": {
    url: new URL(
      "../../node_modules/dompurify/dist/purify.min.js",
      import.meta.url
    ),
    type: "text/javascript; charset=utf-8",
  },
} as const;

type Viewer = { email?: string; name?: string };

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

export function createDashboardAssetRoutes(getConfig: () => GatewayConfig): Hono {
  const routes = new Hono();
  routes.get("/:asset", (c) => {
    const asset = c.req.param("asset");
    if (asset !== "kit.js" && asset !== "kit.css") return c.notFound();
    c.header("Cache-Control", "public, max-age=300");
    return c.redirect(`/d-assets/${ASSET_VERSION}/${asset}`, 302);
  });
  routes.get(`/${ASSET_VERSION}/:asset`, async (c) => {
    const asset = ASSETS[c.req.param("asset") as keyof typeof ASSETS];
    if (!asset) return c.notFound();
    const body = await fs.readFile(asset.url);
    const headers: Record<string, string> = {
      "Content-Type": asset.type,
      "Cache-Control": IMMUTABLE_CACHE,
      "X-Content-Type-Options": "nosniff",
    };
    if (asset.type.startsWith("text/html")) {
      headers["Content-Security-Policy"] = dashboardCsp(getConfig());
    }
    return new Response(body, { headers });
  });
  return routes;
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
      const viewer =
        typeof auth === "object" && auth && "user" in auth
          ? ((auth as { user?: Viewer }).user ?? {})
          : {};
      const url = new URL(c.req.url);
      const params = Object.fromEntries(url.searchParams.entries());
      const bindings: Record<string, string | null> = {
        ...params,
        viewer_email: viewer.email ?? null,
        viewer_name: viewer.name ?? null,
        today: new Date().toISOString().slice(0, 10),
      };
      const result = await executeDashboardQueries(agent, html, bindings);
      const files = await fs.readdir(dashboardDirectory(agent), {
        withFileTypes: true,
      });
      const dashboards = await Promise.all(
        files
          .filter((file) => file.isFile())
          .map((file) => file.name)
          .filter((file) => {
            try {
              normalizeDashboardSlug(file);
              return true;
            } catch {
              return false;
            }
          })
          .map((file) => deps.registry.link(agent.id, file))
      );
      const links = Object.fromEntries(
        dashboards.map((dashboard) => [dashboard.slug, `/d/${dashboard.id}`])
      );
      html = injectDashboardRuntime(html, {
        data: result.data,
        viewer: { email: viewer.email ?? null, name: viewer.name ?? null },
        params,
        links,
        errors: result.errors,
      });
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

function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

export function injectDashboardRuntime(
  html: string,
  runtime: {
    data: Record<string, unknown[]>;
    viewer: { email: string | null; name: string | null };
    params: Record<string, string>;
    links: Record<string, string>;
    errors: Array<{ name: string; error: string }>;
  }
): string {
  const bootstrap = `<script>(function(r){const build=(base,p)=>{const u=new URL(base,location.origin);for(const [k,v] of Object.entries(p||{}))u.searchParams.set(k,String(v));return u.pathname+u.search};window.YOPLAI={data:r.data,viewer:r.viewer,params:r.params,link:(slug,p)=>{const base=r.links[slug];if(!base)throw new Error("Unknown dashboard: "+slug);return build(base,p)}}})(${safeJson(runtime)});</script>`;
  const errors = runtime.errors.length
    ? `<section role="alert" style="font:14px sans-serif;background:#fee;color:#900;border:1px solid #d88;padding:12px;margin:12px"><strong>Dashboard query error</strong>${runtime.errors.map((error) => `<div><code>${escapeHtml(error.name)}</code>: ${escapeHtml(error.error)}</div>`).join("")}</section>`
    : "";
  const insertion = `${bootstrap}${errors}`;
  const doctype = html.match(/^\s*<!doctype[^>]*>/i);
  return doctype
    ? `${html.slice(0, doctype[0].length)}${insertion}${html.slice(doctype[0].length)}`
    : `${insertion}${html}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
