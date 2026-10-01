import type { GatewayConfig } from "@yoplai/shared";

/** Same public origin order as multi-user auth's trusted origins. */
export function resolveWebBaseUrl(config: GatewayConfig): string {
  const configured = [config.server?.baseUrl, config.web?.baseUrl]
    .find((value) => typeof value === "string" && value.trim().length > 0);
  return (configured?.trim() ?? `http://localhost:${config.ui?.port ?? 3000}`).replace(/\/+$/, "");
}
