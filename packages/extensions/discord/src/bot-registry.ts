import { createChannelBotRegistry } from "@yoplai/shared";
import type { DiscordBot } from "./bot.js";

export const {
  clearActiveBots,
  getActiveBot,
  getActiveBots,
  getComponentBot,
  registerActiveBot,
  registerComponentBot,
} = createChannelBotRegistry<DiscordBot>();
