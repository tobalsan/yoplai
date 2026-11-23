import { createChannelBotRegistry } from "@yoplai/shared";
import type { TelegramBot } from "./bot.js";

export const {
  clearActiveBots,
  getActiveBot,
  getActiveBots,
  getComponentBot,
  registerActiveBot,
  registerComponentBot,
} = createChannelBotRegistry<TelegramBot>();
