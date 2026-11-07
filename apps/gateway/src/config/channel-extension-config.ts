import {
  MattermostAgentConfigSchema,
  SlackAgentConfigSchema,
  TelegramAgentConfigSchema,
  type AgentConfig,
} from "@yoplai/shared";

const channelSchemas = {
  mattermost: MattermostAgentConfigSchema,
  slack: SlackAgentConfigSchema,
  telegram: TelegramAgentConfigSchema,
};

export function projectChannelExtensionBlocks(agent: AgentConfig): AgentConfig {
  let projected = agent;
  for (const channel of Object.keys(
    channelSchemas
  ) as (keyof typeof channelSchemas)[]) {
    if (agent[channel] !== undefined) continue;
    const block = agent.extensions?.[channel];
    if (!block) continue;
    const { enabled, ...config } = block;
    if (enabled === false) continue;
    const parsed = channelSchemas[channel].safeParse(config);
    if (!parsed.success) {
      const paths = parsed.error.issues.map((issue) => issue.path.join("."));
      console.warn(
        `[config] agent "${agent.id}" cannot project extension "${channel}": ${paths.join(", ")}`
      );
      continue;
    }
    projected = { ...projected, [channel]: parsed.data };
  }
  return projected;
}
