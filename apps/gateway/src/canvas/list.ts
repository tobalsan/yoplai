import type { AgentConfig, GatewayConfig } from "@yoplai/shared";
import { dashboardBaseUrl, normalizeDashboardSlug, openDashboardFile } from "./dashboard-files.js";
import { attributes } from "./sql.js";
import { DashboardRegistry, type DashboardRegistration } from "./store.js";
import { dashboardAccessPolicy, type DashboardActor } from "./policy.js";
import { dashboardTitle } from "./title.js";

export type DashboardListContext = {
  actor: DashboardActor;
  ownerName?(id: string): Promise<string>;
  sessionExists(userId: string, agentId: string, sessionId: string): Promise<boolean>;
};

export async function dashboardChatHref(
  entry: DashboardRegistration,
  actor: DashboardActor,
  sessionExists: DashboardListContext["sessionExists"]
): Promise<string | null> {
  if (!actor.hasAgentAccess) return null;
  const agent = encodeURIComponent(entry.agentId);
  const dashboard = encodeURIComponent(entry.id);
  if (entry.createdIn && entry.createdIn.userId === actor.userId &&
    await sessionExists(entry.createdIn.userId, entry.agentId, entry.createdIn.sessionId)) {
    return `/chat/${agent}?session=${encodeURIComponent(entry.createdIn.sessionId)}&dashboard=${dashboard}`;
  }
  return `/chat/${agent}?dashboard=${dashboard}&new=1`;
}

export async function dashboardHtml(
  agent: AgentConfig,
  registry: DashboardRegistry,
  entry: DashboardRegistration,
  actor: DashboardActor
): Promise<{ html: string; updatedAt: string | null }> {
  if (entry.ownerUserId && !dashboardAccessPolicy.canWrite(entry, actor)) {
    return { html: await registry.readPublished(entry.id), updatedAt: entry.publishedAt ?? null };
  }
  const file = await openDashboardFile(agent, normalizeDashboardSlug(entry.slug));
  try {
    return { html: await file.readFile("utf8"), updatedAt: (await file.stat()).mtime.toISOString() };
  } finally { await file.close(); }
}

export async function listAgentDashboards(
  agent: AgentConfig,
  registry: DashboardRegistry,
  config: GatewayConfig,
  context: DashboardListContext = { actor: { eligible: true, hasAgentAccess: true }, sessionExists: async () => false }
) {
  const entries = await registry.list(agent.id);
  const visible = dashboardAccessPolicy.filterVisible(entries, context.actor);
  const visibleSlugs = new Set(visible.map((entry) => entry.slug));
  const dashboards = [];
  for (const entry of visible) {
    let html = "";
    let updatedAt: string | null = entry.publishedAt ?? null;
    try {
      ({ html, updatedAt } = await dashboardHtml(agent, registry, entry, context.actor));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" ||
        (entry.ownerUserId && !dashboardAccessPolicy.canWrite(entry, context.actor))) throw error;
      // A missing draft does not remove its durable registration.
    }
    const title = dashboardTitle(html, entry.slug);
    let params: string[] = [];
    for (const meta of html.matchAll(/<meta\b([^>]*)>/gi)) {
      const values = attributes(meta[1]);
      if (values.get("name") !== "yoplai:params") continue;
      params = (values.get("content") || "").split(",").map((value) => value.trim()).filter(Boolean);
      break;
    }
    const linksTo = new Set<string>();
    for (const match of html.matchAll(/YOPLAI\.link\(\s*["']([^"']+)["']/g)) {
      try {
        const target = normalizeDashboardSlug(match[1]);
        if (target !== entry.slug && visibleSlugs.has(target)) linksTo.add(target);
      } catch { /* Invalid targets do not identify registered dashboards. */ }
    }
    const isOwner = !!entry.ownerUserId && entry.ownerUserId === context.actor.userId;
    dashboards.push({
      id: entry.id, agentId: agent.id, agentName: agent.name,
      title, slug: entry.slug, params, linksTo: [...linksTo], updatedAt,
      link: `${dashboardBaseUrl(config)}/d/${entry.id}`,
      chatHref: await dashboardChatHref(entry, context.actor, context.sessionExists),
      publishedAt: entry.publishedAt ?? null, legacy: !entry.ownerUserId, isOwner,
      shared: !!entry.ownerUserId && !isOwner && !!context.actor.userId &&
        !!entry.shares?.some((share) => share.kind === "all" || share.id === context.actor.userId),
      ownerName: entry.ownerUserId ? await context.ownerName?.(entry.ownerUserId) ?? entry.ownerUserId : null,
      mode: dashboardAccessPolicy.canWrite(entry, context.actor) ? "write" as const : "read" as const,
      ...(isOwner ? { shares: entry.shares ?? [] } : {}),
    });
  }
  return dashboards.sort((a, b) => a.slug.localeCompare(b.slug));
}
