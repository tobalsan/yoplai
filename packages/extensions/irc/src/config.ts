import {
  IrcAgentConfigSchema,
  channelRoutes,
  channelSetting,
  commaSeparatedIds,
  missingInboundRoute,
  validateChannelFields,
  type AgentConfig,
  type Extension,
} from "@yoplai/shared";

export function readAgentChannelConfig(agent: AgentConfig) {
  const block = agent.extensions?.irc;
  if (!block || block.enabled === false) return;
  const parsed = IrcAgentConfigSchema.safeParse(channelRoutes(block));
  return parsed.success ? parsed.data : undefined;
}

export const ircSettings = {
  teamOnly: true,
  configJsonSchema: {
    type: "object",
    properties: {
      host: { type: "string", title: "Server host" },
      port: { type: "integer", title: "Port", minimum: 1, maximum: 65535 },
      tls: { type: "boolean", title: "Use TLS", default: true },
      nick: { type: "string", title: "Nickname" },
      password: { type: "string", title: "Server password", writeOnly: true },
      nickservPassword: { type: "string", title: "NickServ password", writeOnly: true },
      channelIds: { type: "string", title: "Channels", description: "Separate channel names with commas, including their # or & prefix." },
      dmEnabled: { type: "boolean", title: "Answer DMs" },
    },
  },
  validateAgentConfig(agent, _config, env) {
    return validateChannelFields(agent, "irc", {
      host: (value) => typeof value === "string" && !/[\s/]/.test(value),
      port: (value) => typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535,
      tls: (value) => typeof value === "boolean",
      nick: (value) => typeof value === "string" && !/\s/.test(value),
      channelIds: (value) => commaSeparatedIds(value)?.every((name) => /^[#&]./.test(name)),
      dmEnabled: (value) => typeof value === "boolean",
    }, env, IrcAgentConfigSchema.partial(), channelRoutes);
  },
  missingAgentSettings(agent, _config, env) {
    const block = agent.extensions?.irc ?? {};
    return [
      ...["host", "nick"].filter((field) => !channelSetting(block[field], env)),
      ...missingInboundRoute(block, false),
    ];
  },
} satisfies Partial<Extension>;
