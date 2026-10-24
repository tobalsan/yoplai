import type { ExtensionContext } from "@yoplai/shared";

let mattermostCtx: ExtensionContext | null = null;

export function setMattermostContext(ctx: ExtensionContext): void {
  mattermostCtx = ctx;
}

export function clearMattermostContext(): void {
  mattermostCtx = null;
}

export function getMattermostContext(): ExtensionContext {
  if (!mattermostCtx) {
    throw new Error("Mattermost context not initialized");
  }
  return mattermostCtx;
}

export function getMattermostContextIfInitialized(): ExtensionContext | null {
  return mattermostCtx;
}
