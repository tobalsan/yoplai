import { createChannelBotRegistry } from "@yoplai/shared";
import type { MattermostBot } from "./bot.js";

export const {
  clearActiveBots,
  getActiveBot,
  getActiveBots,
  getComponentBot,
  registerActiveBot,
  registerComponentBot,
} = createChannelBotRegistry<MattermostBot>();
