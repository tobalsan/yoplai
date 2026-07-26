import type { ExtensionContext } from "@yoplai/shared";

let slackCtx: ExtensionContext | null = null;

export function setSlackContext(ctx: ExtensionContext): void {
  slackCtx = ctx;
}

export function clearSlackContext(): void {
  slackCtx = null;
}

export function getSlackContext(): ExtensionContext {
  if (!slackCtx) {
    throw new Error("Slack context not initialized");
  }
  return slackCtx;
}

export function getSlackContextIfInitialized(): ExtensionContext | undefined {
  return slackCtx ?? undefined;
}
