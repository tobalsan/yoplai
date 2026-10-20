import fs from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import {
  resolveHomeDir,
  type AgentConfig,
  type GatewayConfig,
} from "@yoplai/shared";
import {
  dashboardBaseUrl,
  deleteDashboardFile,
  normalizeDashboardSlug,
  openDashboardFile,
} from "./dashboard-files.js";
import { dashboardHtml, listAgentDashboards } from "./list.js";
import { dashboardAccessPolicy, type DashboardActor } from "./policy.js";
import { DashboardRegistry } from "./store.js";
import { DashboardPinStore } from "./pins.js";
import { executeDashboardQueries } from "./sql.js";

// Versions are cached for a week; bump when the kit changes. Older versions keep
// resolving to the current (backward-compatible) files.
const ASSET_VERSION = "v2";
const ASSET_VERSIONS = new Set(["v1", ASSET_VERSION]);
const ASSET_CACHE = "public, max-age=604800";
const THEME_MAPPING = `:root:root:not([data-yoplai-dashboard-theme]) {
  --dk-bg: var(--bg-base);
  --dk-surface: var(--bg-surface);
  --dk-text: var(--text-primary);
  --dk-muted: var(--text-secondary);
  --dk-border: var(--border-default);
  --dk-accent: var(--bg-accent);
}\n`;
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
  resolveActor?(auth: unknown, agentId?: string): Promise<DashboardActor>;
  listRecipients?(): Promise<Array<{ id: string; name: string; email: string }>>;
  getOwnerName?(id: string): Promise<string>;
};

export function dashboardCsp(
  config: GatewayConfig,
  assetOrigin?: string
): string {
  const assets = `${assetOrigin ?? dashboardBaseUrl(config)}/d-assets/`;
  return `sandbox allow-scripts allow-downloads allow-modals; default-src 'none'; script-src 'unsafe-inline' ${assets}; style-src 'unsafe-inline' ${assets}; img-src data: blob:; font-src data: ${assets}; connect-src 'none'`;
}

export function createDashboardAssetRoutes(
  getConfig: () => GatewayConfig
): Hono {
  const routes = new Hono();
  routes.get("/theme.css", async (c) => {
    c.header("Content-Type", "text/css; charset=utf-8");
    c.header("Cache-Control", "no-cache");
    try {
      const css = await fs.readFile(
        path.join(resolveHomeDir(), "theme.css"),
        "utf8"
      );
      return c.body(`${THEME_MAPPING}${css}`);
    } catch {
      return c.body("");
    }
  });
  routes.get("/:asset", (c) => {
    const asset = c.req.param("asset");
    if (asset !== "kit.js" && asset !== "kit.css") return c.notFound();
    c.header("Cache-Control", "public, max-age=300");
    return c.redirect(`/d-assets/${ASSET_VERSION}/${asset}`, 302);
  });
  routes.get("/:version/:asset", async (c) => {
    if (!ASSET_VERSIONS.has(c.req.param("version"))) return c.notFound();
    const asset = ASSETS[c.req.param("asset") as keyof typeof ASSETS];
    if (!asset) return c.notFound();
    const body = await fs.readFile(asset.url);
    const headers: Record<string, string> = {
      "Content-Type": asset.type,
      "Cache-Control": ASSET_CACHE,
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
      const target = new URL(c.req.url);
      login.searchParams.set("returnTo", target.pathname + target.search);
      return c.redirect(login.toString(), 302);
    }
    const actor = await routeActor(deps, auth, entry.agentId);
    if (!dashboardAccessPolicy.canRead(entry, actor)) return c.notFound();

    const agent = deps.getAgent(entry.agentId);
    if (!agent) return c.notFound();
    let slug: string;
    try {
      slug = normalizeDashboardSlug(entry.slug);
    } catch {
      return c.notFound();
    }
    try {
      let { html } = await dashboardHtml(agent, deps.registry, { ...entry, slug }, actor);
      const viewer =
        typeof auth === "object" && auth && "user" in auth
          ? ((auth as { user?: Viewer }).user ?? {})
          : {};
      const url = new URL(c.req.url);
      const params = Object.fromEntries(url.searchParams.entries());
      const dashboards = dashboardAccessPolicy.filterVisible(await deps.registry.list(agent.id), actor);
      const links = Object.fromEntries(
        dashboards.map((dashboard) => [dashboard.slug, `/d/${dashboard.id}`])
      );
      html = await renderDashboardHtml(
        agent,
        html,
        viewer,
        params,
        links,
        parseThemeCookie(c.req.header("Cookie"))
      );
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

async function routeActor(deps: DashboardRouteDependencies, auth: unknown, agentId?: string): Promise<DashboardActor> {
  if (deps.resolveActor) return deps.resolveActor(auth, agentId);
  return { eligible: true, hasAgentAccess: !!agentId && await deps.hasAgentAccess(auth, agentId) };
}

export function createDashboardResourceRoutes(deps: DashboardRouteDependencies & { pins: DashboardPinStore }): Hono {
  const routes = new Hono();
  routes.use("*", async (c, next) => {
    if (deps.getConfig().canvas?.enabled === false) return c.notFound();
    await next();
  });
  routes.get("/", async (c) => {
    if (deps.getConfig().canvas?.enabled === false) return c.notFound();
    const auth = await deps.authenticate(c.req.raw);
    if (!auth) return c.json({ error: "unauthorized" }, 401);
    const actor = await routeActor(deps, auth);
    if (!actor.eligible) return c.json({ error: "account_ineligible" }, 403);
    const pins = actor.userId ? await deps.pins.list(actor.userId) : new Set<string>();
    const owned = [];
    const shared = [];
    const entries = (await deps.registry.all()).filter((entry) => entry.ownerUserId &&
      (entry.ownerUserId === actor.userId || entry.shares?.some((share) => share.kind === "all" || share.id === actor.userId)));
    const listedIds = new Set(entries.map((entry) => entry.id));
    const agentIds = new Set(entries.map((entry) => entry.agentId));
    for (const agentId of agentIds) {
      const agent = deps.getAgent(agentId);
      if (!agent) continue;
      const rows = await listAgentDashboards(agent, deps.registry, deps.getConfig(), { actor: await routeActor(deps, auth, agentId), ownerName: deps.getOwnerName });
      for (const row of rows) {
        if (row.legacy || !listedIds.has(row.id)) continue;
        const dashboard = { ...row, pinned: pins.has(row.id) };
        if (row.isOwner) owned.push(dashboard);
        else shared.push(dashboard);
      }
    }
    return c.json({ owned, shared });
  });
  routes.get("/recipients", async (c) => {
    const auth = await deps.authenticate(c.req.raw);
    if (!auth) return c.json({ error: "unauthorized" }, 401);
    if (!(await routeActor(deps, auth)).eligible) return c.json({ error: "account_ineligible" }, 403);
    return c.json({ users: await deps.listRecipients?.() ?? [] });
  });
  routes.on(["PUT", "DELETE"], "/:id/pin", async (c) => {
    const auth = await deps.authenticate(c.req.raw);
    if (!auth) return c.json({ error: "unauthorized" }, 401);
    if (!(await routeActor(deps, auth)).eligible) return c.json({ error: "account_ineligible" }, 403);
    const entry = await deps.registry.get(c.req.param("id"));
    if (!entry?.ownerUserId) return c.notFound();
    const actor = await routeActor(deps, auth, entry.agentId);
    if (!actor.userId || !dashboardAccessPolicy.canRead(entry, actor)) return c.notFound();
    const pinned = c.req.method === "PUT";
    await deps.pins.set(actor.userId, entry.id, pinned);
    return c.json({ ok: true, pinned });
  });
  routes.patch("/:id/sharing", async (c) => {
    const auth = await deps.authenticate(c.req.raw);
    if (!auth) return c.json({ error: "unauthorized" }, 401);
    const entry = await deps.registry.get(c.req.param("id"));
    if (!entry?.ownerUserId) return c.notFound();
    const actor = await routeActor(deps, auth, entry.agentId);
    if (!dashboardAccessPolicy.canManage(entry, actor)) return c.notFound();
    const schema = z.object({ shares: z.array(z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("user"), id: z.string().min(1), mode: z.enum(["read", "write"]) }).strict(),
      z.object({ kind: z.literal("all"), mode: z.enum(["read", "write"]) }).strict(),
    ])) }).strict();
    const parsed = schema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_shares" }, 400);
    const recipients = new Set((await deps.listRecipients?.() ?? []).map((user) => user.id));
    const keys = new Set<string>();
    for (const share of parsed.data.shares) {
      const key = share.kind === "all" ? "all" : `user:${share.id}`;
      if (keys.has(key) || (share.kind === "user" && !recipients.has(share.id))) return c.json({ error: "invalid_shares" }, 400);
      keys.add(key);
    }
    try {
      return await deps.registry.withRegistration(entry.id, async (current) => {
        if (!dashboardAccessPolicy.canManage(current, await routeActor(deps, auth, current.agentId))) return c.notFound();
        await deps.registry.replaceShares(current.id, parsed.data.shares);
        const agent = deps.getAgent(current.agentId);
        if (!agent) return c.notFound();
        const rows = await listAgentDashboards(agent, deps.registry, deps.getConfig(), { actor: await routeActor(deps, auth, current.agentId), ownerName: deps.getOwnerName });
        return c.json({ dashboard: rows.find((row) => row.id === current.id) });
      });
    } catch (error) {
      if ((error as Error).message === "Dashboard not found") return c.notFound();
      throw error;
    }
  });
  routes.post("/:id/claim", async (c) => {
    const auth = await deps.authenticate(c.req.raw);
    if (!auth) return c.json({ error: "unauthorized" }, 401);
    const entry = await deps.registry.get(c.req.param("id"));
    if (!entry) return c.notFound();
    try {
      return await deps.registry.withRegistration(entry.id, async (current) => {
        const actor = await routeActor(deps, auth, current.agentId);
        if (!actor.eligible || !actor.userId || !actor.hasAgentAccess) return c.notFound();
        if (current.ownerUserId) return c.notFound();
        const agent = deps.getAgent(current.agentId);
        if (!agent) return c.notFound();
        const file = await openDashboardFile(agent, normalizeDashboardSlug(current.slug));
        let html: string;
        try { html = await file.readFile("utf8"); } finally { await file.close(); }
        await deps.registry.claim(current.id, actor.userId, html);
        const rows = await listAgentDashboards(agent, deps.registry, deps.getConfig(), { actor, ownerName: deps.getOwnerName });
        return c.json({ dashboard: rows.find((row) => row.id === current.id) });
      });
    } catch (error) {
      if ((error as Error).message === "Dashboard not found" || (error as NodeJS.ErrnoException).code === "ENOENT") return c.notFound();
      throw error;
    }
  });
  routes.delete("/:id", async (c) => {
    const auth = await deps.authenticate(c.req.raw);
    if (!auth) return c.json({ error: "unauthorized" }, 401);
    const entry = await deps.registry.get(c.req.param("id"));
    if (!entry?.ownerUserId) return c.notFound();
    try {
      return await deps.registry.withRegistration(entry.id, async (current) => {
        if (!dashboardAccessPolicy.canManage(current, await routeActor(deps, auth, current.agentId))) return c.notFound();
        const agent = deps.getAgent(current.agentId);
        if (agent) await deleteDashboardFile(agent, normalizeDashboardSlug(current.slug));
        await deps.registry.deleteId(current.id);
        return c.json({ ok: true });
      });
    } catch (error) {
      if ((error as Error).message === "Dashboard not found") return c.notFound();
      throw error;
    }
  });
  return routes;
}

export async function renderDashboardHtml(
  agent: AgentConfig,
  html: string,
  viewer: Viewer,
  params: Record<string, string>,
  links: Record<string, string>,
  theme?: "light" | "dark" | null,
  protectedLinkParams?: Record<string, string>
): Promise<string> {
  const bindings: Record<string, string | null> = {
    ...params,
    viewer_email: viewer.email ?? null,
    viewer_name: viewer.name ?? null,
    today: new Date().toISOString().slice(0, 10),
  };
  const result = await executeDashboardQueries(agent, html, bindings);
  return injectDashboardRuntime(
    html,
    {
      data: result.data,
      viewer: { email: viewer.email ?? null, name: viewer.name ?? null },
      params,
      links,
      errors: result.errors,
      protectedLinkParams,
    },
    theme
  );
}

function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

export function parseThemeCookie(
  header: string | undefined | null
): "light" | "dark" | null {
  if (!header) return null;
  const match = header.match(/(?:^|;\s*)yoplai-theme=([^;]*)/);
  if (!match) return null;
  const value = decodeURIComponent(match[1]);
  return value === "light" || value === "dark" ? value : null;
}

export function injectDashboardRuntime(
  html: string,
  runtime: {
    data: Record<string, unknown[]>;
    viewer: { email: string | null; name: string | null };
    params: Record<string, string>;
    links: Record<string, string>;
    errors: Array<{ name: string; error: string }>;
    protectedLinkParams?: Record<string, string>;
  },
  themeCookie?: "light" | "dark" | null
): string {
  const hasDataTheme = /<html[^>]*\bdata-theme\s*=/i.test(html);
  let themeScript = "";
  if (!hasDataTheme) {
    if (themeCookie === "light" || themeCookie === "dark") {
      html = html.replace(
        /<html([^>]*)>/i,
        (_match, attrs) => `<html${attrs} data-theme="${themeCookie}">`
      );
    } else {
      themeScript =
        "<script>(function(){try{var d=matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';var h=document.documentElement;if(!h.hasAttribute('data-theme'))h.setAttribute('data-theme',d);}catch(e){}})();</script>";
    }
  }
  const theme = '<link rel="stylesheet" href="/d-assets/theme.css">';
  const hasClosingHead = /<\/head\s*>/i.test(html);
  if (hasClosingHead) html = html.replace(/<\/head\s*>/i, `${theme}</head>`);
  const bootstrap = `<script>(function(r){const build=(base,p)=>{const u=new URL(base,location.origin);for(const [k,v] of Object.entries(p||{}))u.searchParams.set(k,String(v));return u.pathname+u.search};window.YOPLAI={data:r.data,viewer:r.viewer,params:r.params,link:(slug,p)=>{const base=r.links[slug];if(!base)throw new Error("Unknown dashboard: "+slug);return build(base,{...p,...r.protectedLinkParams})}};for(const e of r.errors)console.error("Dashboard query error ("+e.name+"): "+e.error)})(${safeJson(runtime)});</script>`;
  const errors = runtime.errors.length
    ? `<section role="alert" style="font:14px sans-serif;background:#fee;color:#900;border:1px solid #d88;padding:12px;margin:12px"><strong>Dashboard query error</strong>${runtime.errors.map((error) => `<div><code>${escapeHtml(error.name)}</code>: ${escapeHtml(error.error)}</div>`).join("")}</section>`
    : "";
  const insertion = `${hasClosingHead ? "" : theme}${themeScript}${bootstrap}${errors}`;
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
