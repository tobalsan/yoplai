import {
  SlackAgentConfigSchema,
  channelRoutes,
  channelSetting,
  commaSeparatedIds,
  validateChannelFields,
  type AgentConfig,
  type Extension,
} from "@yoplai/shared";

export function readAgentChannelConfig(agent: AgentConfig) {
  const block = agent.extensions?.slack;
  if (!block || block.enabled === false) return;
  const parsed = SlackAgentConfigSchema.safeParse(channelRoutes(block));
  if (parsed.success && parsed.data.token.trim() && parsed.data.appToken.trim()) return parsed.data;
}

export const slackSettings = {
  teamOnly: true,
  configJsonSchema: {
    type: "object",
    properties: {
      token: { type: "string", title: "Bot token", writeOnly: true },
      appToken: { type: "string", title: "App token", writeOnly: true },
      dmEnabled: { type: "boolean", title: "Answer DMs" },
      channelIds: { type: "string", title: "Channel IDs", description: "Separate IDs with commas. Leave empty to allow every channel the bot is in." },
    },
  },
  validateAgentConfig(agent, _config, env) {
    return validateChannelFields(agent, "slack", {
      dmEnabled: (value) => typeof value === "boolean",
      channelIds: (value) => !!commaSeparatedIds(value),
    }, env, SlackAgentConfigSchema.partial(), channelRoutes);
  },
  missingAgentSettings(agent, _config, env) {
    const block = agent.extensions?.slack;
    return ["token", "appToken"].filter((field) => !channelSetting(block?.[field], env));
  },
} satisfies Partial<Extension>;
