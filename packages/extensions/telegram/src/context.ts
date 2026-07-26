import type { ExtensionContext } from "@yoplai/shared";

let telegramCtx: ExtensionContext | null = null;

export function setTelegramContext(ctx: ExtensionContext): void {
  telegramCtx = ctx;
}

export function clearTelegramContext(): void {
  telegramCtx = null;
}

export function getTelegramContext(): ExtensionContext {
  if (!telegramCtx) {
    throw new Error("Telegram context not initialized");
  }
  return telegramCtx;
}
