import fs from "node:fs";
import { getDefaultConfigPath, readEnv } from "@yoplai/shared";

type UserConfig = {
  apiUrl?: string;
  token?: string;
};

export type CliConfig = {
  apiUrl: string;
  token?: string;
};

function readUserConfig(): UserConfig {
  const filePath = getDefaultConfigPath();
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw) as UserConfig;
  } catch {
    return {};
  }
}

function trimValue(value: string | undefined): string | undefined {
  const next = value?.trim();
  return next ? next : undefined;
}

export function resolveConfig(): CliConfig {
  const fileConfig = readUserConfig();
  const apiUrl =
    readEnv("YOPLAI_API_URL") ??
    readEnv("YOPLAI_URL") ??
    trimValue(fileConfig.apiUrl);

  if (!apiUrl) {
    throw new Error(
      'Missing Yoplai API URL. Set YOPLAI_API_URL (or YOPLAI_URL) or add $YOPLAI_HOME/yoplai.json with {"apiUrl":"http://..."}.'
    );
  }

  const token = readEnv("YOPLAI_TOKEN") ?? trimValue(fileConfig.token);

  return { apiUrl, token };
}
