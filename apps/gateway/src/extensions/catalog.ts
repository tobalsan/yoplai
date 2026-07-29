import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentConfig, Extension, GatewayConfig } from "@yoplai/shared";
import {
  discoverExternalExtensions,
  resolveAgentConfigRoute,
} from "@yoplai/shared";
import {
  getBuiltInExtensionRegistrations,
  getExternalExtensionsPath,
  hasAgentRootConfig,
} from "./registry.js";
import { resolveAgentEnv } from "../config/index.js";

/** Icon files above this size are skipped rather than inlined as a data URI. */
const MAX_ICON_BYTES = 256 * 1024;

/** How many parent directories to walk while looking for `package.json`. */
const MAX_PACKAGE_ROOT_WALK = 8;

/**
 * Best-effort resolution of a built-in extension's package directory, used
 * only for icon lookup. The `@yoplai/extension-*` packages are ESM-only (their
 * `exports` map has no `require`/`default` condition), so we resolve via
 * `import.meta.resolve` rather than CJS `require.resolve`. The resolved entry
 * point can land under `dist/` (default conditions) or `src/` (dev
 * conditions), so instead of assuming a fixed path shape, we walk up from the
 * entry point until we find the directory containing `package.json` — that's
 * the package root, which holds the committed `icon.svg`/`icon.png`. Anything
 * that doesn't resolve is left unresolved; icon lookup is best-effort and
 * must never throw or block the catalog.
 */
export function resolveBuiltInExtensionDir(
  packageName: string | undefined
): string | undefined {
  if (!packageName) return undefined;
  try {
    const entryPath = fileURLToPath(import.meta.resolve(packageName));
    let dir = path.dirname(entryPath);
    for (let i = 0; i < MAX_PACKAGE_ROOT_WALK; i++) {
      if (existsSync(path.join(dir, "package.json"))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Look for `icon.svg` (preferred) or `icon.png` at the root of an extension's
 * directory and inline it as a data URI. Missing/unreadable/oversized files
 * all fall back to `undefined` — the web UI shows a placeholder.
 */
export function resolveIconDataUri(
  dir: string | undefined
): string | undefined {
  if (!dir) return undefined;
  const candidates: Array<[file: string, mime: string]> = [
    ["icon.svg", "image/svg+xml"],
    ["icon.png", "image/png"],
  ];
  for (const [file, mime] of candidates) {
    try {
      const filePath = path.join(dir, file);
      const stats = statSync(filePath);
      if (!stats.isFile() || stats.size > MAX_ICON_BYTES) continue;
      const data = readFileSync(filePath);
      return `data:${mime};base64,${data.toString("base64")}`;
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * Where an extension's config surface lives, so the hub UI knows how to render
 * it:
 *  - `auto-form`: the extension exposes a config JSON-schema we can render as a
 *    form.
 *  - `bespoke-route`: the extension self-registers its own agent-keyed config
 *    route (`configRoute`); the hub redirects there instead of rendering a
 *    form.
 *  - `toggle-only`: no config beyond enabled/disabled.
 *
 * Bespoke routes win over auto-form: an extension that declares its own config
 * route owns its config surface even if it also happens to expose a schema.
 */
export type ExtensionConfigTier = "auto-form" | "bespoke-route" | "toggle-only";

export type ExtensionCatalogEntry = {
  id: string;
  displayName: string;
  description: string;
  /** true = built-in static registry, false = runtime-scanned external dir. */
  builtIn: boolean;
  /** Enabled for this specific agent (agent-scoped config). */
  enabled: boolean;
  /** Whether this enabled extension has usable per-agent configuration. */
  configured: boolean;
  /** Invalid or missing config field names; never values. */
  missingConfig: string[];
  /** True when writes can persist to a real agent fork. */
  configurable: boolean;
  /** True when root-level agent config enables this extension, locking UI writes. */
  managedAtRoot: boolean;
  /** Config JSON-schema when the extension exposes one, else null. */
  configJsonSchema: Record<string, unknown> | null;
  /** Field names a UI must mask. */
  requiredSecrets: string[];
  /** Field names a UI should collapse under advanced settings. */
  advancedConfigFields: string[];
  /** Existing per-agent config values, with secret fields redacted. */
  configValues: Record<string, unknown>;
  /**
   * Agent-resolved bespoke config route (`:agentId` substituted) when the
   * extension self-registers one, else null. The hub redirects here on enable
   * for `bespoke-route` extensions.
   */
  configRoutePath: string | null;
  tier: ExtensionConfigTier;
  /**
   * Auto-detected `icon.svg`/`icon.png` from the extension's root directory,
   * inlined as a data URI. Undefined when no icon file was found or it
   * couldn't be resolved/read; the UI shows a placeholder in that case.
   */
  iconDataUri?: string;
};

/**
 * A JSON-schema is "meaningful" (worth an auto-form) when it describes config
 * fields beyond the base `enabled` toggle. A schema whose only property is
 * `enabled` is treated as toggle-only.
 */
function hasMeaningfulSchema(
  schema: Record<string, unknown> | null | undefined
): boolean {
  if (!schema) return false;
  const properties = schema.properties;
  if (properties === undefined) {
    // No `properties` key at all — e.g. a passthrough/record schema. Treat any
    // non-empty schema object as meaningful config.
    return Object.keys(schema).length > 0;
  }
  if (typeof properties !== "object" || properties === null) return false;
  const keys = Object.keys(properties as Record<string, unknown>).filter(
    (key) => key !== "enabled"
  );
  return keys.length > 0;
}

function resolveTier(
  configRoutePath: string | null,
  configJsonSchema: Record<string, unknown> | null
): ExtensionConfigTier {
  if (configRoutePath) return "bespoke-route";
  if (hasMeaningfulSchema(configJsonSchema)) return "auto-form";
  return "toggle-only";
}

function isEnabledForAgent(agent: AgentConfig, extensionId: string): boolean {
  const extensions = agent.extensions as Record<string, unknown> | undefined;
  if (!extensions || !(extensionId in extensions)) {
    return hasAgentRootConfig(agent, extensionId);
  }
  const value = extensions[extensionId];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return (value as { enabled?: unknown }).enabled !== false;
}

function configValuesForAgent(
  agent: AgentConfig,
  extension: Extension
): Record<string, unknown> {
  const extensions = agent.extensions as Record<string, unknown> | undefined;
  const value = extensions?.[extension.id];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const config = { ...(value as Record<string, unknown>) };
  delete config.enabled;
  for (const field of extension.requiredSecrets ?? []) {
    if (field in config) config[field] = "********";
  }
  return config;
}

function toCatalogEntry(
  extension: Extension,
  builtIn: boolean,
  config: GatewayConfig,
  agent: AgentConfig,
  dir: string | undefined,
  configurable: boolean
): ExtensionCatalogEntry {
  const configJsonSchema = extension.configJsonSchema ?? null;
  const configRoutePath =
    resolveAgentConfigRoute(extension.configRoute, agent.id) ?? null;
  const validation = extension.validateAgentConfig?.(
    agent,
    config,
    resolveAgentEnv(agent, config)
  );
  const extensions = agent.extensions as Record<string, unknown> | undefined;
  const hasExplicitConfig = extensions && extension.id in extensions;
  return {
    id: extension.id,
    displayName: extension.displayName,
    description: extension.description,
    builtIn,
    enabled: isEnabledForAgent(agent, extension.id),
    configured: validation?.valid ?? true,
    missingConfig: validation?.valid === false ? validation.errors : [],
    configurable,
    managedAtRoot: !hasExplicitConfig && hasAgentRootConfig(agent, extension.id),
    configJsonSchema,
    requiredSecrets: extension.requiredSecrets ?? [],
    advancedConfigFields: extension.advancedConfigFields ?? [],
    configValues: configValuesForAgent(agent, extension),
    configRoutePath,
    tier: resolveTier(configRoutePath, configJsonSchema),
    iconDataUri: resolveIconDataUri(dir),
  };
}

/**
 * Build the full extension catalog for one agent: every available extension
 * (built-in static registry + runtime scan of the external extensions dir),
 * each with its per-agent enabled state and config metadata.
 *
 * Accuracy is the contract: an extension appears iff it is actually available
 * (a built-in package that loads, or an external dir that parses as a valid
 * extension). Built-ins whose package cannot be loaded are skipped so we never
 * surface a ghost. External ids that collide with a built-in id are dropped
 * (the built-in already covers that id).
 */
export async function buildExtensionCatalog(
  config: GatewayConfig,
  agent: AgentConfig,
  options: { configurable?: boolean } = {}
): Promise<ExtensionCatalogEntry[]> {
  const entries: ExtensionCatalogEntry[] = [];
  const seen = new Set<string>();
  const configurable = options.configurable ?? true;

  for (const registration of getBuiltInExtensionRegistrations()) {
    let extension: Extension;
    try {
      extension = await registration.load();
    } catch {
      // Package not installed in this deployment — not actually available, so
      // it must not appear in the catalog (no ghosts).
      continue;
    }
    if (seen.has(extension.id)) continue;
    seen.add(extension.id);
    // Factory extensions are internal/non-user-facing: hidden from the
    // agent-edit UI, still enable-able manually in agent.yaml.
    if (extension.factory === true) continue;
    const dir = resolveBuiltInExtensionDir(registration.packageName);
    entries.push(toCatalogEntry(extension, true, config, agent, dir, configurable));
  }

  const external = await discoverExternalExtensions(
    getExternalExtensionsPath(config)
  );
  for (const { extension, path: extensionDir } of external) {
    if (seen.has(extension.id)) continue;
    seen.add(extension.id);
    if (extension.factory === true) continue;
    entries.push(
      toCatalogEntry(extension, false, config, agent, extensionDir, configurable)
    );
  }

  entries.sort((a, b) => a.id.localeCompare(b.id));
  return entries;
}

/**
 * Resolve a single extension's definition by id (built-in or external),
 * regardless of its `factory` flag. Factory extensions are intentionally
 * omitted from `buildExtensionCatalog`'s output, so the PATCH endpoint needs
 * this separate lookup to check the flag before allowing a config write.
 */
export async function resolveExtensionDefinition(
  config: GatewayConfig,
  extensionId: string
): Promise<Extension | undefined> {
  for (const registration of getBuiltInExtensionRegistrations()) {
    if (registration.id !== extensionId) continue;
    try {
      return await registration.load();
    } catch {
      return undefined;
    }
  }

  const external = await discoverExternalExtensions(
    getExternalExtensionsPath(config)
  );
  return external.find(({ id }) => id === extensionId)?.extension;
}
