import type { MattermostBot } from "./bot.js";

const activeBots = new Map<string, MattermostBot>();

export function registerActiveBot(agentId: string, bot: MattermostBot): void {
  activeBots.set(agentId, bot);
}

export function getActiveBot(agentId: string): MattermostBot | undefined {
  return activeBots.get(agentId);
}

export function getActiveBots(): Map<string, MattermostBot> {
  return activeBots;
}

export function clearActiveBots(): void {
  activeBots.clear();
}
