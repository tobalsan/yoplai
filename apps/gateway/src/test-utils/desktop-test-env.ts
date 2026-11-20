import { vi } from "vitest";

export function stubDesktopTestEnv(home: string, configHome: string) {
  for (const name of Object.keys(process.env)) {
    if (!/^(?:PATH|TMPDIR|TMP|TEMP|LANG|LC_[A-Z_]+|TZ|CI|NODE_ENV|VITEST(?:_.*)?)$/.test(name)) {
      vi.stubEnv(name, undefined);
    }
  }
  vi.stubEnv("HOME", home);
  vi.stubEnv("YOPLAI_HOME", configHome);
  vi.stubEnv("YOPLAI_DESKTOP", "1");
  vi.stubEnv("YOPLAI_DEV", "1");
}
