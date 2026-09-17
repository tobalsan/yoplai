import { z } from "zod";
import type {
  Extension,
  ExtensionAgentToolContext,
  GatewayConfig,
} from "@yoplai/shared";
import { resolveWorkspaceDir } from "../config/index.js";
import { resolveStartupConfig } from "../config/validate.js";
import { updateAgentExtensionConfig } from "../extensions/agent-config-writer.js";
import { logInfo } from "../logging.js";
import {
  loadCapabilityCatalog,
  readMcpServerSources,
  type CapabilityEntry,
} from "./catalog.js";
import { mergeMcpServerConfig } from "./mcp-config.js";

const empty = z.object({});
const listArgs = z.object({ need: z.string().trim().max(2_000).optional() });
const enableArgs = z.object({
  id: z.string().min(1),
  kind: z.enum(["extension", "mcp-server"]),
});

type EnableResult = {
  outcome: "enabled" | "refused" | "redirect";
  reason: string;
  settingsPath?: string;
  connectPath?: string;
  requiredSecrets?: string[];
};

const pendingConfirmations = new Map<
  string,
  { capabilityIds: Set<string>; listedAt: number }
>();

function confirmationKey(
  context: ExtensionAgentToolContext
): string | undefined {
  if (!context.sessionId) return undefined;
  return `${context.agent.id}:${context.userId ?? ""}:${context.sessionId}`;
}

async function hasChatConfirmation(
  capabilityId: string,
  context: ExtensionAgentToolContext
): Promise<boolean> {
  const key = confirmationKey(context);
  const pending = key ? pendingConfirmations.get(key) : undefined;
  if (
    !pending ||
    !pending.capabilityIds.has(capabilityId) ||
    !context.sessionId
  ) {
    return false;
  }
  const { getSessionHistory } = await import("../agents/index.js");
  const history = await getSessionHistory(
    context.agent.id,
    context.sessionId,
    context.userId
  );
  const latestUserMessage = (history ?? [])
    .filter((message) => message.role === "user")
    .at(-1);
  return Boolean(
    latestUserMessage &&
    latestUserMessage.timestamp > pending.listedAt &&
    /\b(yes|confirm|go ahead|enable (it|this|that)|please do|do it)\b/i.test(
      latestUserMessage.content
    )
  );
}

function topMatches(
  entries: CapabilityEntry[],
  need: string | undefined
): CapabilityEntry[] {
  const terms = (need ?? "").toLowerCase().match(/[a-z0-9][a-z0-9-]*/g) ?? [];
  if (terms.length === 0) return entries.slice(0, 3);
  return entries
    .map((entry) => {
      const haystack = [
        entry.id,
        entry.displayName,
        entry.description,
        ...entry.tools.map((tool) => `${tool.name} ${tool.description}`),
      ]
        .join(" ")
        .toLowerCase();
      return {
        entry,
        score: terms.reduce(
          (score, term) => score + Number(haystack.includes(term)),
          0
        ),
      };
    })
    .filter(({ score }) => score > 0)
    .sort(
      (left, right) =>
        right.score - left.score || left.entry.id.localeCompare(right.entry.id)
    )
    .slice(0, 3)
    .map(({ entry }) => entry);
}

function suggestedOutcome(matches: CapabilityEntry[]): string {
  const first = matches[0];
  if (!first) return "none";
  if (first.enabledOnAgents.length > Number(first.enabled)) return "redirect";
  return first.enableTier === "self-enable" ? "self-enable" : "settings-page";
}

async function canConfigureAgent(
  agentId: string,
  userId: string | undefined
): Promise<boolean> {
  const registry = await import("../extensions/registry.js");
  if (!registry.isExtensionLoaded("multiUser")) return true;
  if (!userId) return false;
  const { getMultiUserRuntime } = await import("@yoplai/extension-multi-user");
  const runtime = getMultiUserRuntime();
  if (!runtime) return false;
  const user = runtime.db
    .prepare("SELECT role FROM user WHERE id = ?")
    .get(userId) as { role?: unknown } | undefined;
  const roles = Array.isArray(user?.role) ? user.role : [user?.role];
  if (roles.some((role) => role === "admin" || role === "superadmin"))
    return true;
  return runtime.access.canUserChatAgent(userId, agentId);
}

async function reloadAfterWrite(): Promise<GatewayConfig> {
  const configModule = await import("../config/index.js");
  const raw = configModule.reloadConfig();
  const config = await resolveStartupConfig(raw);
  configModule.setLoadedConfig(config);
  const { reloadExtensions } = await import("../extensions/registry.js");
  await reloadExtensions(config);
  return config;
}

function outcomeForUnavailable(entry: CapabilityEntry): EnableResult {
  return {
    outcome: "refused",
    reason: "This capability requires settings configured by an admin.",
    settingsPath: entry.settingsPath,
    ...(entry.requiredSecrets
      ? { requiredSecrets: entry.requiredSecrets }
      : {}),
  };
}

async function enableCapability(
  raw: unknown,
  context: ExtensionAgentToolContext
): Promise<EnableResult> {
  const args = enableArgs.parse(raw);
  const config = context.config;
  const caller = config.agents.find((agent) => agent.id === context.agent.id);
  if (!caller)
    return { outcome: "refused", reason: "This agent cannot be configured." };
  const catalog = await loadCapabilityCatalog(config, caller.id);
  const entry = catalog.find(
    (candidate) => candidate.id === args.id && candidate.kind === args.kind
  );
  if (!entry)
    return {
      outcome: "refused",
      reason: "Capability is not available on this platform.",
    };
  if (entry.enabled)
    return { outcome: "enabled", reason: "Capability is already enabled." };
  if (entry.enableTier === "settings-page") return outcomeForUnavailable(entry);
  if (!(await hasChatConfirmation(entry.id, context))) {
    return {
      outcome: "refused",
      reason:
        "Ask the user to confirm in chat before enabling this capability.",
    };
  }
  if (!(await canConfigureAgent(caller.id, context.userId))) {
    return {
      outcome: "refused",
      reason: "You are not allowed to configure this agent.",
    };
  }
  const workspace = resolveWorkspaceDir(
    caller.workspaceDir ?? caller.workspace
  );
  if (args.kind === "extension") {
    await updateAgentExtensionConfig(workspace, args.id, { enabled: true });
  } else {
    const name = args.id.slice("mcp:".length);
    const sources = await readMcpServerSources([
      ...config.agents,
      ...(config.pool ?? []),
    ]);
    const source = sources.find((candidate) => candidate.name === name);
    if (!source)
      return {
        outcome: "refused",
        reason: "MCP server is no longer available.",
      };
    await mergeMcpServerConfig(workspace, name, source.config);
    await updateAgentExtensionConfig(workspace, "mcp", { enabled: true });
  }
  await reloadAfterWrite();
  return {
    outcome: "enabled",
    reason: "Capability enabled for this agent.",
    ...(entry.connectPath ? { connectPath: entry.connectPath } : {}),
  };
}

export const capabilityDiscoveryExtension: Extension = {
  id: "capabilityDiscovery",
  displayName: "Capability discovery",
  description: "Platform capability discovery and self-enable tools.",
  dependencies: [],
  factory: true,
  routePrefixes: [],
  configSchema: empty,
  validateConfig: () => ({ valid: true, errors: [] }),
  registerRoutes: () => {},
  start: async () => {},
  stop: async () => {},
  capabilities: () => [],
  getSystemPromptContributions: () =>
    "Only call capabilities.list after a genuine dead end: no enabled tool can do the user's task. Do not narrate this lookup or pitch capabilities for work you can already do. If another agent already has a matching capability, redirect the user there first. Otherwise, for a self-enable capability, explain the matching tools and ask for explicit confirmation before calling capabilities.enable. For a settings-page capability, give its exact settings page and required fields, and say an admin must configure it. Never call capabilities.enable without the user's explicit confirmation.",
  getAgentTools(agent) {
    return [
      {
        name: "capabilities.list",
        description:
          "List platform capabilities only after no enabled tool can do the user's task.",
        parameters: {
          type: "object",
          properties: {
            need: { type: "string", description: "The unmet user need." },
          },
        },
        execute: async (raw, context) => {
          const { need } = listArgs.parse(raw);
          const catalog = await loadCapabilityCatalog(context.config, agent.id);
          const matches = topMatches(catalog, need);
          const key = confirmationKey(context);
          if (key) {
            pendingConfirmations.set(key, {
              capabilityIds: new Set(matches.map((entry) => entry.id)),
              listedAt: Date.now(),
            });
          }
          logInfo("missing_capability_lookup", {
            agentId: agent.id,
            userId: context.userId,
            sessionId: context.sessionId,
            need,
            matchedCapabilityIds: matches.map((entry) => entry.id),
            outcome: suggestedOutcome(matches),
          });
          return catalog;
        },
      },
      {
        name: "capabilities.enable",
        description:
          "Enable a confirmed self-enable platform capability for this agent.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string" },
            kind: { type: "string", enum: ["extension", "mcp-server"] },
          },
          required: ["id", "kind"],
        },
        execute: (raw, context) => enableCapability(raw, context),
      },
    ];
  },
};
