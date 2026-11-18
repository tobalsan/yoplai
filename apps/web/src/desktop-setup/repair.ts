export function setupRepairHref(step: "model" | "agent", path: string): string {
  return `/setup?${new URLSearchParams({ step, return: path })}`;
}

export function localReturn(path: string | null): string | undefined {
  if (!path?.startsWith("/") || /^\/[\\/]/.test(path) || /[\t\n\r]/.test(path)) return;
  const url = new URL(path, "http://localhost");
  if (url.origin !== "http://localhost" || url.pathname.startsWith("//")) return;
  return path;
}
