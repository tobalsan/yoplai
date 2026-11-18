import fs from "node:fs";
import path from "node:path";

const FILE_NAME = "desktop-preferences.json";

export function readSplashPreference(userData: string): boolean {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(path.join(userData, FILE_NAME), "utf8"));
    return !(typeof value === "object" && value !== null && "splash" in value && value.splash === false);
  } catch {
    return true;
  }
}

export function writeSplashPreference(userData: string, splash: boolean): void {
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, FILE_NAME), `${JSON.stringify({ splash })}\n`);
}
