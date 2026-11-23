import {
  ThreaditAgentConfigSchema,
  channelSetting,
  isChannelUrl,
  validateChannelFields,
  type Extension,
  ThreaditExtensionConfigSchema,
} from "@yoplai/shared";

export const DEFAULT_POLL_INTERVAL_MS = 5000;
export const DEFAULT_TURN_TIMEOUT_MINUTES = 60;

export type ResolvedThreaditConfig = {
  baseUrl: string;
  /** Absent until the agent has an account. The poller idles without it. */
  token: string | undefined;
  pollIntervalMs: number;
  turnTimeoutMinutes: number;
  activity: "safe" | "detailed";
};

export type ResolveResult =
  | { status: "ok"; config: ResolvedThreaditConfig }
  | { status: "skipped" }
  | { status: "invalid"; reason: "agent config" | "baseUrl" };

/**
 * Merge root defaults with one agent's `extensions.threadit`.
 * The agent value wins. An agent without config or with `enabled: false` is skipped.
 */
export function resolveThreaditConfig(
  rootRaw: unknown,
  agentRaw: unknown
): ResolveResult {
  if (agentRaw === undefined || agentRaw === null) return { status: "skipped" };
  if (
    typeof agentRaw === "object" &&
    (agentRaw as { enabled?: unknown }).enabled === false
  ) {
    return { status: "skipped" };
  }
  const candidate = agentRaw as { token?: unknown };
  const agent = ThreaditAgentConfigSchema.safeParse(candidate.token === "" ? { ...candidate, token: undefined } : agentRaw);
  if (!agent.success) return { status: "invalid", reason: "agent config" };
  const root = ThreaditExtensionConfigSchema.safeParse(rootRaw ?? {});
  const rootData = root.success ? root.data : {};
  const baseUrl = (agent.data.baseUrl ?? rootData.baseUrl ?? "")
    .trim()
    .replace(/\/+$/, "");
  if (!baseUrl) return { status: "invalid", reason: "baseUrl" };
  return {
    status: "ok",
    config: {
      baseUrl,
      token: agent.data.token?.trim() ? agent.data.token : undefined,
      pollIntervalMs:
        agent.data.pollIntervalMs ??
        rootData.pollIntervalMs ??
        DEFAULT_POLL_INTERVAL_MS,
      turnTimeoutMinutes:
        agent.data.turnTimeoutMinutes ??
        rootData.turnTimeoutMinutes ??
        DEFAULT_TURN_TIMEOUT_MINUTES,
      activity: agent.data.activity ?? rootData.activity ?? "detailed",
    },
  };
}

export const threaditSettings = {
  teamOnly: true,
  advancedConfigFields: ["pollIntervalMs", "turnTimeoutMinutes", "activity"],
  configJsonSchema: {
    type: "object",
    properties: {
      baseUrl: { type: "string", title: "Board URL" },
      token: { type: "string", title: "Board token", writeOnly: true, description: "Leave blank to register the agent from chat and approve it on the board." },
      pollIntervalMs: { type: "integer", title: "Poll interval (ms)", minimum: 1000 },
      turnTimeoutMinutes: { type: "number", title: "Turn timeout (minutes)", minimum: 1 },
      activity: { type: "string", title: "Activity detail", description: "Enter safe or detailed (default)." },
    },
  },
  validateAgentConfig(agent, _config, env) {
    return validateChannelFields(agent, "threadit", {
      baseUrl: isChannelUrl,
      pollIntervalMs: (value) => typeof value === "number" && Number.isInteger(value) && value >= 1000,
      turnTimeoutMinutes: (value) => typeof value === "number" && Number.isFinite(value) && value >= 1,
      activity: (value) => value === "safe" || value === "detailed",
    }, env, ThreaditAgentConfigSchema);
  },
  missingAgentSettings(agent, config, env) {
    const block = agent.extensions?.threadit;
    return [
      ...(!channelSetting(block?.baseUrl ?? config.extensions?.threadit?.baseUrl, env) ? ["baseUrl"] : []),
      ...(!channelSetting(block?.token, env) ? ["token"] : []),
    ];
  },
} satisfies Partial<Extension>;
