import fs from "node:fs/promises";
import path from "node:path";
import type {
  AgentConfig,
  Extension,
  ExtensionAgentTool,
  GatewayConfig,
} from "@yoplai/shared";
import {
  discoverExternalExtensions,
  resolveAgentConfigRoute,
} from "@yoplai/shared";
import {
  getBuiltInExtensionRegistrations,
  getExternalExtensionsPath,
} from "../extensions/registry.js";

export type CapabilityKind = "extension" | "mcp-server";
export type CapabilityEnableTier = "self-enable" | "settings-page";

export type CapabilityEntry = {
  id: string;
  displayName: string;
  description: string;
  kind: CapabilityKind;
  tools: Array<{ name: string; description: string }>;
  enableTier: CapabilityEnableTier;
  settingsPath: string;
  enabledOnAgents: string[];
  enabled: boolean;
  requiredSecrets?: string[];
  connectPath?: string;
  connection?: { url?: string; command?: string };
};

export type McpServerConfig = {
  url?: unknown;
  command?: unknown;
  args?: unknown;
  env?: unknown;
  headers?: unknown;
};

export type McpServerSource = {
  agentId: string;
  name: string;
  config: McpServerConfig;
  tools?: Array<{ name: string; description: string }>;
};

export type CapabilityCatalogInput = {
  extensions: Extension[];
  agents: AgentConfig[];
  callingAgentId: string;
  mcpServers?: McpServerSource[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function enabledForAgent(agent: AgentConfig, extensionId: string): boolean {
  const extensions = agent.extensions as Record<string, unknown> | undefined;
  const value = extensions?.[extensionId];
  return isRecord(value) && value.enabled !== false;
}

function compact(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 240 ? `${oneLine.slice(0, 239)}…` : oneLine;
}

const SETTINGS_ONLY_EXTENSION_IDS = new Set([
  "discord",
  "irc",
  "slack",
  "telegram",
  "webhooks",
]);

async function discoveryTools(
  extension: Extension
): Promise<ExtensionAgentTool[]> {
  try {
    if (extension.getDiscoveryTools) return await extension.getDiscoveryTools();
    if (!extension.getAgentTools) return [];
    return await extension.getAgentTools(
      {
        id: "capability-discovery",
        extensions: { [extension.id]: { enabled: true } },
      } as AgentConfig,
      {
        config: {
          version: 3,
          agents: [],
          extensions: {},
        } as unknown as GatewayConfig,
        env: {},
      }
    );
  } catch {
    return [];
  }
}

function mcpConnection(
  config: McpServerConfig
): { url?: string; command?: string } | undefined {
  const url = typeof config.url === "string" ? config.url : undefined;
  const command =
    typeof config.command === "string" ? config.command : undefined;
  return url || command
    ? { ...(url ? { url } : {}), ...(command ? { command } : {}) }
    : undefined;
}

/**
 * Pure catalog builder over already-discovered extension definitions, agent
 * configs, and MCP declarations. It never reads credentials or starts tools.
 */
export async function buildCapabilityCatalog(
  input: CapabilityCatalogInput
): Promise<CapabilityEntry[]> {
  const caller = input.agents.find(
    (agent) => agent.id === input.callingAgentId
  );
  if (!caller) return [];

  const entries: CapabilityEntry[] = [];
  const seen = new Set<string>();
  for (const extension of input.extensions) {
    if (extension.factory || seen.has(extension.id)) continue;
    seen.add(extension.id);
    const tools = await discoveryTools(extension);
    const settingsPath =
      resolveAgentConfigRoute(extension.configRoute, caller.id) ??
      `/agents/${encodeURIComponent(caller.id)}/extensions/${encodeURIComponent(extension.id)}/config`;
    const enabledOnAgents = input.agents
      .filter((agent) => enabledForAgent(agent, extension.id))
      .map((agent) => agent.id)
      .sort();
    // Channel/component extensions are configured outside agent.extensions.
    const selfEnable =
      (extension.requiredSecrets?.length ?? 0) === 0 &&
      !SETTINGS_ONLY_EXTENSION_IDS.has(extension.id) &&
      (extension.getDiscoveryTools !== undefined ||
        extension.getAgentTools !== undefined);
    entries.push({
      id: extension.id,
      displayName: extension.displayName,
      description: compact(extension.description),
      kind: "extension",
      tools: tools.map((tool) => ({
        name: tool.name,
        description: compact(tool.description),
      })),
      enableTier: selfEnable ? "self-enable" : "settings-page",
      settingsPath,
      enabledOnAgents,
      enabled: enabledOnAgents.includes(caller.id),
      ...(selfEnable
        ? {}
        : { requiredSecrets: [...(extension.requiredSecrets ?? [])] }),
      ...(extension.oauth ? { connectPath: settingsPath } : {}),
    });
  }

  const groupedMcp = new Map<string, McpServerSource[]>();
  for (const server of input.mcpServers ?? []) {
    const sources = groupedMcp.get(server.name) ?? [];
    sources.push(server);
    groupedMcp.set(server.name, sources);
  }
  for (const [name, sources] of groupedMcp) {
    const enabledOnAgents = [
      ...new Set(sources.map((source) => source.agentId)),
    ].sort();
    entries.push({
      id: `mcp:${name}`,
      displayName: name,
      description: "MCP server",
      kind: "mcp-server",
      tools: sources[0].tools ?? [],
      enableTier: "self-enable",
      settingsPath: `/agents/${encodeURIComponent(caller.id)}/extensions/mcp`,
      enabledOnAgents,
      enabled: enabledOnAgents.includes(caller.id),
      ...(mcpConnection(sources[0].config)
        ? { connection: mcpConnection(sources[0].config) }
        : {}),
    });
  }

  return entries.sort((left, right) => left.id.localeCompare(right.id));
}

export async function readMcpServerSources(
  agents: AgentConfig[]
): Promise<McpServerSource[]> {
  const sources: McpServerSource[] = [];
  for (const agent of agents) {
    const workspace = agent.workspaceDir ?? agent.workspace;
    if (!workspace) continue;
    try {
      const raw = JSON.parse(
        await fs.readFile(path.join(workspace, "mcp.json"), "utf8")
      ) as unknown;
      if (!isRecord(raw) || !isRecord(raw.mcpServers)) continue;
      for (const [name, config] of Object.entries(raw.mcpServers)) {
        if (isRecord(config)) sources.push({ agentId: agent.id, name, config });
      }
    } catch {
      // MCP is optional; malformed or absent files do not break discovery.
    }
  }
  return sources;
}

export async function listReachableMcpTools(
  config: McpServerConfig
): Promise<Array<{ name: string; description: string }>> {
  if (typeof config.url !== "string") return [];
  let url: URL;
  try {
    url = new URL(config.url);
    if (url.username || url.password) return [];
  } catch {
    return [];
  }

  const request = async (
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    notification = false
  ) => {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        ...(notification ? {} : { id: method }),
        method,
        ...(params ? { params } : {}),
      }),
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) throw new Error("MCP server unavailable");
    return {
      sessionId: response.headers.get("Mcp-Session-Id") ?? sessionId,
      ...(notification
        ? {}
        : {
            result: (await response.json()) as {
              result?: { tools?: unknown };
            },
          }),
    };
  };

  try {
    const initialized = await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "yoplai-capability-discovery", version: "1" },
    });
    await request(
      "notifications/initialized",
      undefined,
      initialized.sessionId,
      true
    );
    const listed = await request("tools/list", undefined, initialized.sessionId);
    if (!Array.isArray(listed.result?.result?.tools)) return [];
    return listed.result.result.tools.flatMap((tool) => {
      if (!isRecord(tool) || typeof tool.name !== "string") return [];
      return [
        {
          name: tool.name,
          description: compact(
            typeof tool.description === "string" ? tool.description : ""
          ),
        },
      ];
    });
  } catch {
    return [];
  }
}

async function availableExtensions(
  config: GatewayConfig
): Promise<Extension[]> {
  const extensions: Extension[] = [];
  const seen = new Set<string>();
  for (const registration of getBuiltInExtensionRegistrations()) {
    try {
      const extension = await registration.load();
      if (!seen.has(extension.id)) {
        seen.add(extension.id);
        extensions.push(extension);
      }
    } catch {
      // Uninstalled built-ins are not platform capabilities.
    }
  }
  for (const external of await discoverExternalExtensions(
    getExternalExtensionsPath(config)
  )) {
    if (!seen.has(external.extension.id)) {
      seen.add(external.extension.id);
      extensions.push(external.extension);
    }
  }
  return extensions;
}

/** Read the deployment catalog afresh, matching the settings-page behavior. */
export async function loadCapabilityCatalog(
  config: GatewayConfig,
  callingAgentId: string
): Promise<CapabilityEntry[]> {
  const agents = [...config.agents, ...(config.pool ?? [])];
  const mcpServers = await readMcpServerSources(agents);
  const mcpWithTools = await Promise.all(
    mcpServers.map(async (server) => ({
      ...server,
      tools: await listReachableMcpTools(server.config),
    }))
  );
  return buildCapabilityCatalog({
    extensions: await availableExtensions(config),
    agents,
    callingAgentId,
    mcpServers: mcpWithTools,
  });
}
