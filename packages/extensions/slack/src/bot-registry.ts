import { createChannelBotRegistry } from "@yoplai/shared";
import type { SlackBot } from "./bot.js";

export const {
  clearActiveBots,
  getActiveBot,
  getActiveBots,
  getComponentBot,
  registerActiveBot,
  registerComponentBot,
} = createChannelBotRegistry<SlackBot>();
