import { createChannelBotRegistry, type ChannelIngress, type ChannelOwnerResolver } from "@yoplai/shared";
import type { SlackBot } from "./bot.js";

export const {
  clearActiveBots,
  getActiveBot,
  getActiveBots,
  getComponentBot,
  registerActiveBot,
  registerComponentBot,
} = createChannelBotRegistry<SlackBot>();

export function getSlackIngressBot(agentId: string, ingress: ChannelIngress) {
  if (ingress.surface !== "slack") return;
  const bot = ingress.botKey === "component" ? getComponentBot()
    : ingress.botKey === "agent:" + agentId ? getActiveBot(agentId) : undefined;
  if (bot?.matchesIngress(ingress)) return bot;
}

export const resolveSlackDmOwner: ChannelOwnerResolver = (input) =>
  getSlackIngressBot(input.agentId, input.ingress)?.resolveDmOwner(input);
