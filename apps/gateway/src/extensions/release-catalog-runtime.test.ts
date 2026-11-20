import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { it } from "vitest";

const run = promisify(execFile);
const fixture = fileURLToPath(new URL("./release-catalog-runtime.fixture.mts", import.meta.url));

// Node preserves ESM import query keys. The Vitest module loader does not.
it.each(["success", "start", "stop", "config", "reload", "restore", "write-race", "watch-race", "fork-race", "nested-write", "ownership", "rename", "double-rename", "bundles", "selection", "owners"])("reconciles catalog changes through the HTTP app: %s", async (mode) => {
  const home = await fs.mkdtemp(path.join(process.cwd(), "node_modules/catalog-runtime-"));
  try {
    await run(process.execPath, ["--conditions=development", "--import", "tsx", fixture, mode], {
      env: { ...process.env, YOPLAI_HOME: home }, timeout: 15_000,
    });
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}, 20_000);
