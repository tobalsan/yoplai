import fs from "node:fs/promises";
import type { AgentConfig, GatewayConfig } from "@yoplai/shared";
import { dashboardBaseUrl, dashboardDirectory, normalizeDashboardSlug, openDashboardFile } from "./index.js";
import { DashboardRegistry } from "./store.js";

export async function listAgentDashboards(
  agent: AgentConfig,
  registry: DashboardRegistry,
  config: GatewayConfig
) {
  let names: string[];
  try {
    names = (await fs.readdir(dashboardDirectory(agent), { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => {
        try {
          normalizeDashboardSlug(name);
          return true;
        } catch {
          return false;
        }
      })
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const dashboards = [];
  for (const slug of names) {
    try {
      const file = await openDashboardFile(agent, slug);
      try {
        const [stat, html] = await Promise.all([file.stat(), file.readFile("utf8")]);
        const title = html.match(/<title(?:\s[^>]*)?>([\s\S]*?)<\/title\s*>/i)?.[1]
          ?.replace(/<[^>]*>/g, "")
          .trim() || slug;
        let params: string[] = [];
        for (const meta of html.matchAll(/<meta\b([^>]*)>/gi)) {
          const attributes = new Map(
            [...meta[1].matchAll(/([\w-]+)\s*=\s*(["'])(.*?)\2/gs)].map((match) => [
              match[1].toLowerCase(),
              match[3],
            ])
          );
          if (attributes.get("name") !== "yoplai:params") continue;
          params = (attributes.get("content") || "")
            .split(",")
            .map((param) => param.trim())
            .filter(Boolean);
          break;
        }
        const linksTo = new Set<string>();
        for (const match of html.matchAll(/YOPLAI\.link\(\s*["']([^"']+)["']/g)) {
          try {
            const target = normalizeDashboardSlug(match[1]);
            if (target !== slug) linksTo.add(target);
          } catch {
            // Invalid links cannot identify a child dashboard.
          }
        }
        const entry = await registry.link(agent.id, slug);
        dashboards.push({ title, slug, params, linksTo: [...linksTo], updatedAt: stat.mtime.toISOString(), link: `${dashboardBaseUrl(config)}/d/${entry.id}` });
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return dashboards;
}
