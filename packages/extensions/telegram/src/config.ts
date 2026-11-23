import {
  TelegramAgentConfigSchema,
  channelSetting,
  commaSeparatedIds,
  validateChannelFields,
  type AgentConfig,
  type Extension,
} from "@yoplai/shared";

function allowlist(value: unknown): unknown {
  return typeof value === "string" ? commaSeparatedIds(value) : value;
}

function validAllowlist(value: unknown): boolean {
  return typeof value === "string"
    ? !!commaSeparatedIds(value)
    : Array.isArray(value) && value.every((id) => typeof id === "string" || typeof id === "number");
}

function normalizeAllowLists(block: Record<string, unknown>) {
  return {
    ...block,
    allowedUsers: allowlist(block.allowedUsers),
    allowedChats: allowlist(block.allowedChats),
  };
}

export function readAgentChannelConfig(agent: AgentConfig) {
  const block = agent.extensions?.telegram;
  if (!block || block.enabled === false) return;
  const parsed = TelegramAgentConfigSchema.safeParse(normalizeAllowLists(block));
  if (parsed.success && parsed.data.token.trim()) return parsed.data;
}

export const telegramSettings = {
  teamOnly: true,
  configJsonSchema: {
    type: "object",
    properties: {
      token: { type: "string", title: "Bot token", writeOnly: true },
      allowedUsers: { type: "string", title: "Allowed users", description: "Separate IDs or usernames with commas. An empty list allows nobody." },
      allowedChats: { type: "string", title: "Allowed chats", description: "Separate IDs or usernames with commas. An empty list allows nobody." },
    },
  },
  validateAgentConfig(agent, _config, env) {
    return validateChannelFields(agent, "telegram", {
      allowedUsers: validAllowlist, allowedChats: validAllowlist,
    }, env, TelegramAgentConfigSchema.partial(), normalizeAllowLists);
  },
  missingAgentSettings(agent, _config, env) {
    const block = agent.extensions?.telegram;
    const lists = ["allowedUsers", "allowedChats"];
    return [
      ...(!channelSetting(block?.token, env) ? ["token"] : []),
      ...lists.filter((field) => {
        const entries = allowlist(block?.[field]);
        return !Array.isArray(entries) || !entries.some((id) => typeof id === "number" || !!channelSetting(id, env));
      }),
    ];
  },
} satisfies Partial<Extension>;
