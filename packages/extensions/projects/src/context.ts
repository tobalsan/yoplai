import type { ExtensionContext } from "@yoplai/shared";

let projectsCtx: ExtensionContext | null = null;

export function setProjectsContext(ctx: ExtensionContext) {
  projectsCtx = ctx;
}

export function getProjectsContext(): ExtensionContext {
  if (!projectsCtx) throw new Error("Projects context not initialized");
  return projectsCtx;
}

export function clearProjectsContext() {
  projectsCtx = null;
}
