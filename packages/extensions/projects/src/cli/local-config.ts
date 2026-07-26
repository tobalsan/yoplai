import fs from "node:fs";
import path from "node:path";
import {
  GatewayConfigSchema,
  migrateConfigV1toV2,
  resolveConfigPath,
} from "@yoplai/shared";

export type ConfigVersionInfo = {
  label: "1 (legacy)" | "2";
  number: 1 | 2;
};

export type LocalConfigFile = {
  path: string;
  raw: string;
  json: unknown;
};

export type ConfigValidationResult = {
  config: ReturnType<typeof GatewayConfigSchema.parse>;
  migrated: boolean;
  warnings: string[];
  version: ConfigVersionInfo;
};

export function resolveLocalConfigPath(configPath?: string): string {
  return resolveConfigPath(configPath);
}

export function readLocalConfigFile(configPath?: string): LocalConfigFile {
  const resolvedPath = resolveLocalConfigPath(configPath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Config not found: ${resolvedPath}`);
  }

  const raw = fs.readFileSync(resolvedPath, "utf8");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown JSON parse error";
    throw new Error(`Invalid JSON in ${resolvedPath}: ${message}`);
  }

  return { path: resolvedPath, raw, json };
}

export function validateLocalConfig(
  configPath?: string
): ConfigValidationResult {
  const file = readLocalConfigFile(configPath);
  const parsed = GatewayConfigSchema.parse(file.json);
  if (parsed.version === 2) {
    return {
      config: parsed,
      migrated: false,
      warnings: [],
      version: { number: 2, label: "2" },
    };
  }

  const migration = migrateConfigV1toV2(parsed);
  return {
    config: GatewayConfigSchema.parse(migration.config),
    migrated: true,
    warnings: migration.warnings,
    version: { number: 1, label: "1 (legacy)" },
  };
}

export type ConfigMigrationActionResult = {
  path: string;
  backupPath: string;
  migratedConfig: ReturnType<typeof GatewayConfigSchema.parse>;
  warnings: string[];
  version: ConfigVersionInfo;
  changed: boolean;
};

function getBackupPath(configPath: string): string {
  const parsed = path.parse(configPath);
  if (parsed.ext.toLowerCase() === ".json") {
    return path.join(parsed.dir, `${parsed.name}.v1${parsed.ext}`);
  }
  return `${configPath}.v1.json`;
}

export function migrateLocalConfig(
  configPath?: string
): ConfigMigrationActionResult {
  const file = readLocalConfigFile(configPath);
  const parsed = GatewayConfigSchema.parse(file.json);
  const version: ConfigVersionInfo =
    parsed.version === 2
      ? { number: 2, label: "2" }
      : { number: 1, label: "1 (legacy)" };
  const migration =
    parsed.version === 2
      ? { config: parsed, warnings: [] }
      : migrateConfigV1toV2(parsed);
  const migratedConfig = GatewayConfigSchema.parse(migration.config);
  const backupPath = getBackupPath(file.path);
  const changed =
    JSON.stringify(parsed, null, 2) !== JSON.stringify(migratedConfig, null, 2);

  if (changed) {
    fs.writeFileSync(backupPath, file.raw);
    fs.writeFileSync(
      `${file.path}.tmp`,
      `${JSON.stringify(migratedConfig, null, 2)}\n`
    );
    fs.renameSync(`${file.path}.tmp`, file.path);
  }

  return {
    path: file.path,
    backupPath,
    migratedConfig,
    warnings: migration.warnings,
    version,
    changed,
  };
}

export function previewMigration(configPath?: string): {
  path: string;
  originalConfig: ReturnType<typeof GatewayConfigSchema.parse>;
  migratedConfig: ReturnType<typeof GatewayConfigSchema.parse>;
  warnings: string[];
  version: ConfigVersionInfo;
  changed: boolean;
} {
  const file = readLocalConfigFile(configPath);
  const parsed = GatewayConfigSchema.parse(file.json);
  const version: ConfigVersionInfo =
    parsed.version === 2
      ? { number: 2, label: "2" }
      : { number: 1, label: "1 (legacy)" };
  const migration =
    parsed.version === 2
      ? { config: parsed, warnings: [] }
      : migrateConfigV1toV2(parsed);
  const migratedConfig = GatewayConfigSchema.parse(migration.config);

  return {
    path: file.path,
    originalConfig: parsed,
    migratedConfig,
    warnings: migration.warnings,
    version,
    changed:
      JSON.stringify(parsed, null, 2) !==
      JSON.stringify(migratedConfig, null, 2),
  };
}

export function describeMigration(
  originalConfig: ReturnType<typeof GatewayConfigSchema.parse>,
  migratedConfig: ReturnType<typeof GatewayConfigSchema.parse>
): string[] {
  const actions: string[] = [];

  for (const agent of originalConfig.agents) {
    if (agent.discord?.token) {
      actions.push(
        `Move agent "${agent.id}" discord config -> extensions.discord`
      );
    }
  }

  const legacyOriginal = originalConfig as typeof originalConfig & {
    scheduler?: unknown;
  };

  if (legacyOriginal.scheduler) {
    actions.push("Move scheduler config -> extensions.scheduler");
  } else if (
    originalConfig.agents.some((agent) => agent.heartbeat) &&
    migratedConfig.extensions?.scheduler
  ) {
    actions.push("Add extensions.scheduler");
  }

  if (originalConfig.projects && migratedConfig.extensions?.projects) {
    actions.push("Move projects config -> extensions.projects");
  }

  if (
    originalConfig.agents.some((agent) => agent.heartbeat) &&
    migratedConfig.extensions?.heartbeat
  ) {
    actions.push("Add extensions.heartbeat");
  }

  if (originalConfig.version !== 2 && migratedConfig.version === 2) {
    actions.unshift("Set version -> 2");
  }

  return Array.from(new Set(actions));
}
