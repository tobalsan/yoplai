import { readEnv, type GatewayConfig } from "@yoplai/shared";
import { loadConfig } from "../config/index.js";

function toOrigin(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    return new URL(trimmed).origin;
  } catch {
    return undefined;
  }
}

function portFromEnv(name: string): number | undefined {
  const port = Number.parseInt(readEnv(name) ?? "", 10);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
}

/** CORS and the relay use the same configured browser origins. */
export function allowedCorsOrigins(): string[] {
  let config: GatewayConfig | undefined;
  try {
    config = loadConfig();
  } catch {
    config = undefined;
  }

  // The launcher sets the effective ports in the environment. They win over the config ports.
  const gatewayPort = portFromEnv("GATEWAY_PORT") ?? config?.gateway?.port ?? config?.server?.port ?? 4000;
  const uiPort = portFromEnv("UI_PORT") ?? config?.ui?.port ?? 3000;

  return [
    ...new Set(
      [
        toOrigin(config?.server?.baseUrl),
        toOrigin(config?.web?.baseUrl),
        `http://localhost:${uiPort}`,
        `http://127.0.0.1:${uiPort}`,
        `http://localhost:${gatewayPort}`,
        `http://127.0.0.1:${gatewayPort}`,
      ].filter((value): value is string => !!value)
    ),
  ];
}
