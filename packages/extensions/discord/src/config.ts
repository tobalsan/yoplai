import { DiscordConfigSchema, channelSetting, validateChannelFields, type AgentConfig, type Extension } from "@yoplai/shared";

export function readAgentChannelConfig(agent: AgentConfig) {
  const block = agent.extensions?.discord;
  if (!block || block.enabled === false) return;
  const parsed = DiscordConfigSchema.safeParse(block);
  return parsed.success ? parsed.data : undefined;
}

export const discordSettings = {
  teamOnly: true,
  configJsonSchema: {
    type: "object",
    properties: {
      token: { type: "string", title: "Bot token", writeOnly: true },
    },
  },
  validateAgentConfig(agent, _config, env) {
    return validateChannelFields(agent, "discord", {}, env, DiscordConfigSchema);
  },
  missingAgentSettings(agent, _config, env) {
    return channelSetting(agent.extensions?.discord?.token, env) ? [] : ["token"];
  },
} satisfies Partial<Extension>;
