import type { ExtensionContext } from "@yoplai/shared";

let discordCtx: ExtensionContext | null = null;

export function setDiscordContext(ctx: ExtensionContext): void {
  discordCtx = ctx;
}

export function clearDiscordContext(): void {
  discordCtx = null;
}

export function getDiscordContext(): ExtensionContext {
  if (!discordCtx) {
    throw new Error("Discord context not initialized");
  }
  return discordCtx;
}
