import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
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
import { dashboardChatHref, dashboardHtml, listAgentDashboards, type DashboardListContext } from "./list.js";
import { dashboardAccessPolicy, type DashboardActor } from "./policy.js";
import { DashboardRegistry } from "./store.js";
import { DashboardPinStore } from "./pins.js";
import { executeDashboardQueries } from "./sql.js";
import {
  addDashboardRow,
  DashboardEditError,
  editDashboardRow,
  issueDashboardEditToken,
  verifyDashboardEditToken,
} from "./edit.js";

// Versions are cached for a week; bump when the kit changes. Older versions keep
// resolving to the current (backward-compatible) files.
const ASSET_VERSION = "v3";
const ASSET_VERSIONS = new Set(["v1", "v2", ASSET_VERSION]);
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
type PageEditing = { canWrite: boolean; editToken: string | null; editBase: string };
/** Page identity for annotation mode; present only when the viewer may request edits from the page's agent. */
type Annotation = { id: string; slug: string; agentId: string };

let annotationSource: string | undefined;
const annotationScript = () =>
  (annotationSource ??= readFileSync(new URL("./assets/annotate.js", import.meta.url), "utf8"));

export type DashboardRouteDependencies = {
  getConfig(): GatewayConfig;
  getAgent(id: string): AgentConfig | undefined;
  registry: DashboardRegistry;
  authenticate(request: Request): Promise<unknown | null>;
  hasAgentAccess(auth: unknown, agentId: string): Promise<boolean>;
  resolveActor?(auth: unknown, agentId?: string): Promise<DashboardActor>;
  listRecipients?(): Promise<Array<{ id: string; name: string; email: string; image?: string | null }>>;
  getOwnerName?(id: string): Promise<string>;
  sessionExists: DashboardListContext["sessionExists"];
};

export function dashboardCsp(
  config: GatewayConfig,
  assetOrigin?: string
): string {
  const assets = `${assetOrigin ?? dashboardBaseUrl(config)}/d-assets/`;
  return `sandbox allow-scripts allow-downloads allow-modals allow-popups allow-popups-to-escape-sandbox; default-src 'none'; script-src 'unsafe-inline' ${assets}; style-src 'unsafe-inline' ${assets}; img-src data: blob:; font-src data: ${assets}; connect-src ${assetOrigin ?? dashboardBaseUrl(config)}/d/; frame-ancestors 'self'`;
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
      // Platform impersonation is read-only, and legacy pages must be claimed
      // first: no token means the page cannot save edits.
      const impersonated = typeof auth === "object" && auth !== null && "impersonator" in auth && !!auth.impersonator;
      const editToken = entry.ownerUserId && actor.userId && !impersonated
        ? issueDashboardEditToken(await deps.registry.editSigningKey(), {
          dashboardId: entry.id, userId: actor.userId, email: viewer.email ?? null, name: viewer.name ?? null,
        })
        : null;
      html = await renderDashboardHtml(
        agent,
        html,
        viewer,
        params,
        links,
        parseThemeCookie(c.req.header("Cookie")),
        undefined,
        await dashboardChatHref(entry, actor, deps.sessionExists),
        {
          canWrite: !!editToken && dashboardAccessPolicy.canWrite(entry, actor),
          editToken,
          editBase: `${dashboardBaseUrl(config)}/d/${encodeURIComponent(entry.id)}`,
        },
        // Annotations are a chat request to the page's agent: offer them only
        // to viewers who could make the edit and can chat with that agent.
        dashboardAccessPolicy.canWrite(entry, actor) && actor.hasAgentAccess
          ? { id: entry.id, slug, agentId: entry.agentId }
          : null
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
  // Page edits. The page is an opaque-origin sandbox without cookies, so it
  // posts text/plain JSON (no preflight) carrying its signed edit token; the
  // token, not the origin, is the credential.
  routes.post("/:id/:op{edit|add}", async (c) => {
    const reply = (status: 200 | 400 | 401 | 403 | 404 | 503, body: Record<string, unknown>) =>
      c.json(body, status, { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
    const refuse = (status: 400 | 401 | 403 | 404 | 503, error: string) => reply(status, { ok: false, error });
    if (deps.getConfig().canvas?.enabled === false) return refuse(404, "Not found");
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await c.req.text()) as Record<string, unknown>;
    } catch {
      return refuse(400, "Invalid request");
    }
    const id = c.req.param("id");
    const claims = verifyDashboardEditToken(await deps.registry.editSigningKey(), body?.token);
    if (!claims || claims.dashboardId !== id) return refuse(401, "Reload to keep editing");
    const entry = await deps.registry.get(id);
    if (!entry) return refuse(404, "Not found");
    if (!entry.ownerUserId) return refuse(403, "Claim this dashboard before editing it");
    // Re-check access now so revoked shares stop working immediately.
    const actor = await routeActor(deps, {
      user: { id: claims.userId, email: claims.email ?? undefined, name: claims.name ?? undefined },
      session: { id: "dashboard-edit", userId: claims.userId },
    }, entry.agentId);
    if (actor.userId !== claims.userId || !dashboardAccessPolicy.canRead(entry, actor))
      return refuse(403, "You no longer have access to this dashboard");
    const agent = deps.getAgent(entry.agentId);
    if (!agent) return refuse(404, "Not found");
    try {
      const { html } = await dashboardHtml(agent, deps.registry, { ...entry, slug: normalizeDashboardSlug(entry.slug) }, actor);
      const editor = { ...claims, canWrite: dashboardAccessPolicy.canWrite(entry, actor) };
      const result = c.req.param("op") === "edit"
        ? await editDashboardRow(agent, html, editor, body)
        : await addDashboardRow(agent, html, editor, body);
      return reply(200, { ok: true, ...result });
    } catch (error) {
      if (error instanceof DashboardEditError) return refuse(error.status, error.message);
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return refuse(404, "Not found");
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
      const rows = await listAgentDashboards(agent, deps.registry, deps.getConfig(), { actor: await routeActor(deps, auth, agentId), ownerName: deps.getOwnerName, sessionExists: deps.sessionExists });
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
        const rows = await listAgentDashboards(agent, deps.registry, deps.getConfig(), { actor: await routeActor(deps, auth, current.agentId), ownerName: deps.getOwnerName, sessionExists: deps.sessionExists });
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
        const rows = await listAgentDashboards(agent, deps.registry, deps.getConfig(), { actor, ownerName: deps.getOwnerName, sessionExists: deps.sessionExists });
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
  protectedLinkParams?: Record<string, string>,
  chatHref?: string | null,
  editing?: PageEditing,
  annotation?: Annotation | null
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
      chatHref,
      ...editing,
      annotation,
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
    chatHref?: string | null;
    canWrite?: boolean;
    editToken?: string | null;
    editBase?: string;
    annotation?: Annotation | null;
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
  const chatStyle = runtime.chatHref ? `<style>
.yoplai-dashboard-chat{position:fixed;bottom:16px;right:16px;z-index:1000;display:inline-flex;align-items:center;gap:8px;box-sizing:border-box;min-height:40px;padding:8px 16px 8px 14px;border:0;border-radius:999px;--yoplai-chat-accent:var(--bg-accent,#2563eb);background:var(--yoplai-chat-accent);color:var(--text-on-accent,#fff);font:600 14px/20px system-ui,sans-serif;text-decoration:none;box-shadow:0 4px 14px color-mix(in srgb,var(--yoplai-chat-accent) 35%,transparent),0 1px 3px rgba(0,0,0,.2);transition:background-color 150ms ease,box-shadow 150ms ease}
.yoplai-dashboard-chat svg{width:18px;height:18px;flex:none}
.yoplai-dashboard-chat:hover{background:color-mix(in srgb,var(--yoplai-chat-accent) 85%,#000);box-shadow:0 6px 18px color-mix(in srgb,var(--yoplai-chat-accent) 45%,transparent),0 1px 3px rgba(0,0,0,.2)}
.yoplai-dashboard-chat:focus-visible{outline:2px solid var(--yoplai-chat-accent);outline-offset:3px}
</style>` : "";
  const bootstrap = `<script>(function(r){const build=(base,p)=>{const u=new URL(base,location.origin);for(const [k,v] of Object.entries(p||{}))u.searchParams.set(k,String(v));return u.pathname+u.search};window.YOPLAI={data:r.data,viewer:r.viewer,params:r.params,link:(slug,p)=>{const base=r.links[slug];if(!base)throw new Error("Unknown dashboard: "+slug);return build(base,{...p,...r.protectedLinkParams})}};const post=(op,body)=>{if(!r.editToken)return Promise.reject(new Error("Editing is not available here"));return fetch(r.editBase+"/"+op,{method:"POST",headers:{"Content-Type":"text/plain;charset=UTF-8"},credentials:"omit",cache:"no-store",body:JSON.stringify({...body,token:r.editToken})}).catch(()=>{throw new Error("Could not reach the server; not saved")}).then((res)=>res.json().catch(()=>({})).then((j)=>{if(!res.ok||!j.ok)throw new Error(j.error||"Not saved ("+res.status+")");delete j.ok;return j}))};YOPLAI.canWrite=!!r.canWrite;YOPLAI.canEdit=!!r.editToken;YOPLAI.edit=(o)=>post("edit",{edit:o&&o.edit,key:o&&o.key,field:o&&o.field,value:o&&o.value});YOPLAI.add=(o)=>post("add",{edit:o&&o.edit,values:(o&&o.values)||{}});if(r.chatHref&&window.top===window){const showChat=()=>{const a=document.createElement("a");a.className="yoplai-dashboard-chat";a.href=r.chatHref;a.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg><span>Chat</span>';a.target="_blank";a.rel="noopener noreferrer";document.body.append(a)};if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",showChat,{once:true});else showChat()}for(const e of r.errors)console.error("Dashboard query error ("+e.name+"): "+e.error)})(${safeJson(runtime)});</script>`;
  const errors = runtime.errors.length
    ? `<section role="alert" style="font:14px sans-serif;background:#fee;color:#900;border:1px solid #d88;padding:12px;margin:12px"><strong>Dashboard query error</strong>${runtime.errors.map((error) => `<div><code>${escapeHtml(error.name)}</code>: ${escapeHtml(error.error)}</div>`).join("")}</section>`
    : "";
  const annotate = runtime.annotation
    ? `<script data-annotation="${escapeHtml(JSON.stringify({ ...runtime.annotation, params: runtime.params }))}">${annotationScript()}</script>`
    : "";
  const insertion = `${hasClosingHead ? "" : theme}${themeScript}${chatStyle}${bootstrap}${annotate}${errors}`;
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
