import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { it } from "vitest";

const run = promisify(execFile);
const fixture = fileURLToPath(new URL("./release-catalog-runtime.fixture.mts", import.meta.url));

async function runFixture(mode: string, timeout = 15_000) {
  const home = await fs.mkdtemp(path.join(process.cwd(), "node_modules/catalog-runtime-"));
  try {
    await run(process.execPath, ["--conditions=development", "--import", "tsx", fixture, mode], {
      env: { ...process.env, YOPLAI_HOME: home }, timeout,
    });
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

// Node preserves ESM import query keys. The Vitest module loader does not.
it.each(["success", "prefix", "restart", "status-race", "start", "stop", "config", "reload", "restore", "write-race", "watch-race", "fork-race", "nested-write", "ownership", "rename", "double-rename", "recovery-routes", "bundles", "selection", "owners"])("reconciles catalog changes through the HTTP app: %s", (mode) => runFixture(mode), 20_000);

it("ends a stalled bundle check and permits the next install", () => runFixture("bundle-timeout", 50_000), 55_000);
