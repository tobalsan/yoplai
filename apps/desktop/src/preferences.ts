import fs from "node:fs";
import path from "node:path";

const FILE_NAME = "desktop-preferences.json";

export type ThemeChoice = "light" | "dark" | "system";

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return value === "light" || value === "dark" || value === "system";
}

function readPreferences(userData: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(path.join(userData, FILE_NAME), "utf8"));
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return { ...value };
  } catch {
    // Use defaults if the file is missing or unreadable.
  }
  return {};
}

function writePreferences(userData: string, patch: { splash?: boolean; theme?: ThemeChoice }): void {
  const data = { ...readPreferences(userData), ...patch };
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, FILE_NAME), `${JSON.stringify(data)}\n`);
}

export function readSplashPreference(userData: string): boolean {
  return readPreferences(userData).splash !== false;
}

export function writeSplashPreference(userData: string, splash: boolean): void {
  writePreferences(userData, { splash });
}

export function readThemePreference(userData: string): ThemeChoice | undefined {
  const { theme } = readPreferences(userData);
  return isThemeChoice(theme) ? theme : undefined;
}

export function writeThemePreference(userData: string, theme: ThemeChoice): void {
  writePreferences(userData, { theme });
}
