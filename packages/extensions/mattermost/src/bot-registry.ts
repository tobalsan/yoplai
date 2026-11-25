import { createChannelBotRegistry, type ChannelIngress, type ChannelOwnerResolver } from "@yoplai/shared";
import type { MattermostBot } from "./bot.js";

export const {
  clearActiveBots,
  getActiveBot,
  getActiveBots,
  getComponentBot,
  registerActiveBot,
  registerComponentBot,
} = createChannelBotRegistry<MattermostBot>();

export function getMattermostIngressBot(agentId: string, ingress: ChannelIngress) {
  if (ingress.surface !== "mattermost") return;
  const bot = ingress.botKey === "component" ? getComponentBot()
    : ingress.botKey === "agent:" + agentId ? getActiveBot(agentId) : undefined;
  if (bot?.rest.baseUrl === ingress.server) return bot;
}

export const resolveMattermostDmOwner: ChannelOwnerResolver = (input) =>
  getMattermostIngressBot(input.agentId, input.ingress)?.resolveDmOwner(input);
