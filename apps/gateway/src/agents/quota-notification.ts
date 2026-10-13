import { notify, type AgentConfig, type RequiredModelConfig } from "@yoplai/shared";
import { loadConfig, resolveAgentEnv } from "../config/index.js";
import { resolveSecretValue } from "../config/secrets.js";
import { logError } from "../logging.js";

const lastNotifications = new Map<string, number>();
const HOUR_MS = 60 * 60 * 1000;

export async function notifyProviderQuota(
  agent: AgentConfig,
  override?: RequiredModelConfig
): Promise<void> {
  const { provider, model } = override ?? agent.model;
  logError("[agent] provider quota exhausted", undefined, { provider, model, agentId: agent.id });
  const config = loadConfig();
  const channel = config.notifications?.adminChannel;
  if (!channel) return;
  const key = `${provider}/${model}`;
  const now = Date.now();
  const last = lastNotifications.get(key);
  if (last !== undefined && now - last < HOUR_MS) return;
  lastNotifications.set(key, now);

  const env = resolveAgentEnv(agent, config);
  const discordToken = agent.discord?.token ?? config.extensions?.discord?.token;
  const slackToken = agent.slack?.token ?? config.extensions?.slack?.token;
  const summary = await notify({
    config: config.notifications,
    channel,
    message: `Provider quota exhausted for ${provider}/${model} (agent ${agent.id})`,
    discordToken: discordToken ? await resolveSecretValue(discordToken, env) : undefined,
    slackToken: slackToken ? await resolveSecretValue(slackToken, env) : undefined,
    fetchImpl: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(10_000) }),
  });
  if (!summary.ok) {
    logError("[agent] quota notification delivery failed", undefined, { agentId: agent.id });
  }
}
