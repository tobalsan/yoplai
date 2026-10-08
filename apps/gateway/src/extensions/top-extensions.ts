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
  sources: Array<{ agentId: string; name: string; config: { url?: unknown; command?: unknown; displayName?: unknown } }>,
  icons: Record<string, string> = {}
): McpCandidate[] {
  const byUrl = new Map<string, { names: Set<string>; agents: Set<string> }>();
  for (const source of sources) {
    const url = typeof source.config.url === "string" ? normalizeMcpServerUrl(source.config.url) : null;
    if (!url) continue;
    const group = byUrl.get(url) ?? { names: new Set<string>(), agents: new Set<string>() };
    const label = typeof source.config.displayName === "string" && source.config.displayName.trim() ? source.config.displayName.trim() : source.name;
    group.names.add(label);
    group.agents.add(source.agentId);
    byUrl.set(url, group);
  }
  return [...byUrl]
    .map(([url, group]) => {
      const iconUrl = mcpIconFor(url, icons);
      return { url, displayName: [...group.names].sort()[0], agentCount: group.agents.size, ...(iconUrl ? { iconUrl } : {}) };
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.url.localeCompare(b.url));
}
