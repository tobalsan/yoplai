import {
  MattermostAgentConfigSchema,
  channelRoutes,
  channelSetting,
  commaSeparatedIds,
  isChannelUrl,
  missingInboundRoute,
  validateChannelFields,
  type AgentConfig,
  type Extension,
} from "@yoplai/shared";

export function readAgentChannelConfig(agent: AgentConfig) {
  const block = agent.extensions?.mattermost;
  if (!block || block.enabled === false) return;
  const parsed = MattermostAgentConfigSchema.safeParse(channelRoutes(block));
  if (parsed.success && parsed.data.token.trim()) return parsed.data;
}

export const mattermostSettings = {
  teamOnly: true,
  configJsonSchema: {
    type: "object",
    properties: {
      url: { type: "string", title: "Server URL" },
      token: { type: "string", title: "Bot token", writeOnly: true },
      dmEnabled: { type: "boolean", title: "Answer DMs" },
      channelIds: { type: "string", title: "Channel IDs", description: "Separate channel IDs with commas." },
    },
  },
  validateAgentConfig(agent, _config, env) {
    return validateChannelFields(agent, "mattermost", {
      url: isChannelUrl,
      dmEnabled: (value) => typeof value === "boolean",
      channelIds: (value) => !!commaSeparatedIds(value),
    }, env, MattermostAgentConfigSchema.partial(), channelRoutes);
  },
  missingAgentSettings(agent, _config, env) {
    const block = agent.extensions?.mattermost ?? {};
    return [
      ...(!channelSetting(block.url, env) ? ["url"] : []),
      ...(!channelSetting(block.token, env) ? ["token"] : []),
      ...missingInboundRoute(block),
    ];
  },
} satisfies Partial<Extension>;
