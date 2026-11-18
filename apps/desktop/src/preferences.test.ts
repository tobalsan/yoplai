import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { readSplashPreference } from "./preferences.js";

it.each([[null, true], ["{", true], ['{"splash":0}', true], ['{"splash":true}', true], ['{"splash":false}', false]])(
  "reads splash preference %s as %s", async (content, enabled) => {
    const userData = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-preferences-"));
    try {
      if (content !== null) await fs.writeFile(path.join(userData, "desktop-preferences.json"), content);
      expect(readSplashPreference(userData)).toBe(enabled);
    } finally {
      await fs.rm(userData, { recursive: true, force: true });
    }
  },
);
