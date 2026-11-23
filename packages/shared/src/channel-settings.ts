import type { z } from "zod";
import type { AgentConfig, ValidationResult } from "./types.js";

export const agentChannelIds = ["mattermost", "slack", "telegram", "irc", "discord", "threadit"] as const;
export type AgentChannelId = (typeof agentChannelIds)[number];

export function isAgentChannel(id: string): id is AgentChannelId {
  return agentChannelIds.some((channel) => channel === id);
}

export function channelSetting(value: unknown, env: Record<string, string> = {}): string | undefined {
  if (typeof value !== "string") return undefined;
  const resolved = value.startsWith("$env:") ? env[value.slice(5)] : value;
  return typeof resolved === "string" && resolved.trim() ? resolved : undefined;
}

export function isChannelUrl(value: unknown): boolean {
  if (typeof value !== "string" || !/^https?:\/\//i.test(value)) return false;
  const url = URL.parse(value);
  return url?.protocol === "http:" || url?.protocol === "https:";
}

export function commaSeparatedIds(value: unknown): string[] | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const ids = value.split(",").map((id) => id.trim());
  return ids.every((id) => id.length > 0 && !/\s/.test(id)) ? ids : undefined;
}

export function channelRoutes(block: Record<string, unknown>): Record<string, unknown> {
  const { dmEnabled, channelIds, ...config } = block;
  if (typeof dmEnabled === "boolean") {
    config.dm = { ...(typeof config.dm === "object" ? config.dm : {}), enabled: dmEnabled };
  } else if (dmEnabled !== undefined) {
    config.dm = dmEnabled;
  }
  if (Object.hasOwn(block, "channelIds")) {
    const ids = commaSeparatedIds(channelIds);
    const blank = typeof channelIds === "string" && channelIds.trim() === "";
    config.channels = ids ? Object.fromEntries(ids.map((id) => [id, {}]))
      : blank ? undefined : channelIds;
  }
  return config;
}

export function missingInboundRoute(block: Record<string, unknown>, defaultDmEnabled = true): string[] {
  const { dm, channels } = channelRoutes(block);
  if (dm && typeof dm === "object" && (("enabled" in dm ? dm.enabled : undefined) ?? defaultDmEnabled) === true) return [];
  if (channels && typeof channels === "object" && Object.keys(channels).length) return [];
  return ["dmEnabled", "channelIds"];
}

/** Check the spelling/type of submitted settings independently of completeness. */
export function validateChannelFields(
  agent: AgentConfig,
  id: AgentChannelId,
  checks: Record<string, (value: unknown) => unknown>,
  env: Record<string, string> | undefined,
  schema: z.ZodTypeAny,
  normalize?: (block: Record<string, unknown>) => Record<string, unknown>
): ValidationResult {
  const block = Object.fromEntries(Object.entries(agent.extensions?.[id] ?? {}).flatMap(([key, raw]) => {
    const value = typeof raw === "string" && raw.startsWith("$env:") ? channelSetting(raw, env) : raw;
    return value === undefined || value === "" ? [] : [[key, value]];
  }));
  const errors = Object.entries(checks).flatMap(([key, check]) =>
    block[key] === undefined || check(block[key]) ? [] : [key]);
  if (errors.length > 0) return { valid: false, errors };
  const result = schema.safeParse(normalize ? normalize(block) : block);
  if (!result.success) {
    return { valid: false, errors: [...new Set(result.error.issues.map((issue) => issue.path.join(".") || "config"))] };
  }
  return { valid: errors.length === 0, errors };
}
