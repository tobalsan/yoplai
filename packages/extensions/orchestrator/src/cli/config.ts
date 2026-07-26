import fs from "node:fs";
import { getDefaultConfigPath, readEnv } from "@yoplai/shared";

export type CliConfig = { apiUrl: string; token?: string };

type UserConfig = { apiUrl?: string; token?: string };

function trim(value: string | undefined): string | undefined {
  const next = value?.trim();
  return next ? next : undefined;
}

function readUserConfig(): UserConfig {
  try {
    return JSON.parse(fs.readFileSync(getDefaultConfigPath(), "utf8")) as UserConfig;
  } catch {
    return {};
  }
}

export function resolveConfig(): CliConfig {
  const fileConfig = readUserConfig();
  const apiUrl = trim(readEnv("API_URL")) ?? trim(readEnv("URL")) ?? trim(fileConfig.apiUrl);
  if (!apiUrl) {
    throw new Error('Missing Yoplai API URL. Set YOPLAI_API_URL (or YOPLAI_URL) or add $YOPLAI_HOME/yoplai.json with {"apiUrl":"http://..."}.');
  }
  return { apiUrl, token: trim(readEnv("TOKEN")) ?? trim(fileConfig.token) };
}
