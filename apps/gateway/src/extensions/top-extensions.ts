import fs from "node:fs";
import path from "node:path";
import { normalizeMcpServerUrl } from "@yoplai/shared";
import { CONFIG_DIR } from "../config/index.js";

export type TopExtensions = { extensions: string[]; mcp: string[] };

const topExtensionsPath = () => path.join(CONFIG_DIR, "top-extensions.json");

function uniqueStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter((v): v is string => typeof v === "string" && v.length > 0))];
}

/** Normalize MCP urls (dropping non-http), dedupe both lists. */
export function sanitizeTopExtensions(
  input: { extensions?: unknown; mcp?: unknown },
  knownExtensionIds?: Set<string>
): TopExtensions {
  const extensions = uniqueStrings(input.extensions).filter(
    (id) => !knownExtensionIds || knownExtensionIds.has(id)
  );
  const mcp = [
    ...new Set(
      uniqueStrings(input.mcp)
        .map((url) => normalizeMcpServerUrl(url))
        .filter((url): url is string => url !== null)
    ),
  ];
  return { extensions, mcp };
}

export function readTopExtensions(): TopExtensions {
  try {
    const raw = JSON.parse(fs.readFileSync(topExtensionsPath(), "utf8")) as Record<string, unknown>;
    return sanitizeTopExtensions(raw && typeof raw === "object" ? raw : {});
  } catch {
    return { extensions: [], mcp: [] };
  }
}

export function writeTopExtensions(value: TopExtensions): void {
  const filePath = topExtensionsPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

export type McpCandidate = { url: string; displayName: string; agentCount: number; iconUrl?: string };

type McpSource = { agentId: string; name: string; config: Record<string, unknown> };

function readMcpServers(file: string): { root: Record<string, unknown>; servers: Record<string, unknown> } | undefined {
  try {
    const root = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!root || typeof root !== "object" || Array.isArray(root)) return undefined;
    const servers = (root as { mcpServers?: unknown }).mcpServers;
    return { root: root as Record<string, unknown>, servers: servers && typeof servers === "object" && !Array.isArray(servers) ? servers as Record<string, unknown> : {} };
  } catch {
    return undefined;
  }
}

/**
 * Servers in the admin-shared catalog (`<data dir>/mcp.json`), one source per agent that enabled
 * it via `sharedServers` in its own mcp.json. Servers no agent enabled get one source with an
 * empty agentId so they stay star-able with a count of 0.
 */
export function readSharedMcpServerSources(agents: Array<{ id: string; workspaceDir?: string; workspace?: string }> = []): McpSource[] {
  const catalog = readMcpServers(path.join(CONFIG_DIR, "mcp.json"));
  if (!catalog) return [];
  const enabledBy = new Map<string, string[]>();
  for (const agent of agents) {
    const workspace = agent.workspaceDir ?? agent.workspace;
    const local = workspace ? readMcpServers(path.join(workspace, "mcp.json")) : undefined;
    const enabled = Array.isArray(local?.root.sharedServers) ? local.root.sharedServers : [];
    for (const name of enabled) if (typeof name === "string") enabledBy.set(name, [...enabledBy.get(name) ?? [], agent.id]);
  }
  return Object.entries(catalog.servers)
    .filter((entry): entry is [string, Record<string, unknown>] => !!entry[1] && typeof entry[1] === "object" && !Array.isArray(entry[1]))
    .flatMap(([name, config]) => (enabledBy.get(name) ?? [""]).map((agentId) => ({ agentId, name, config })));
}

/** Hostname -> website icon URL, cached by the MCP extension for its server cards. */
export function readMcpIconCache(): Record<string, string> {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, "mcp", "icons.json"), "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return {};
  }
}

function mcpIconFor(url: string, icons: Record<string, string>): string | undefined {
  const host = new URL(url).hostname;
  return icons[host] ?? icons[host.split(".").slice(-2).join(".")];
}

/** Group HTTP MCP servers across agents by normalized URL; stdio servers are ignored. */
export function aggregateMcpCandidates(
  sources: Array<{ agentId: string; name: string; config: { url?: unknown; command?: unknown; displayName?: unknown; serverTitle?: unknown } }>,
  icons: Record<string, string> = {}
): McpCandidate[] {
  const byUrl = new Map<string, { labels: Set<string>; keys: Set<string>; agents: Set<string> }>();
  const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : undefined;
  for (const source of sources) {
    const url = typeof source.config.url === "string" ? normalizeMcpServerUrl(source.config.url) : null;
    if (!url) continue;
    const group = byUrl.get(url) ?? { labels: new Set<string>(), keys: new Set<string>(), agents: new Set<string>() };
    // Prefer a real label (admin override, then the name the server reported) over a config key.
    const label = text(source.config.displayName) ?? text(source.config.serverTitle);
    if (label) group.labels.add(label);
    group.keys.add(source.name);
    if (source.agentId) group.agents.add(source.agentId);
    byUrl.set(url, group);
  }
  return [...byUrl]
    .map(([url, group]) => {
      const iconUrl = mcpIconFor(url, icons);
      const displayName = [...(group.labels.size ? group.labels : group.keys)].sort()[0];
      return { url, displayName, agentCount: group.agents.size, ...(iconUrl ? { iconUrl } : {}) };
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.url.localeCompare(b.url));
}
