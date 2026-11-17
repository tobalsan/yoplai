// Build the packaged macOS app: Yoplai.app and a .dmg in apps/desktop/release.
// Steps: repo build, desktop build, web build with an empty home, gateway deploy stage,
// native module rebuild for the Electron version, electron-builder.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(desktopDir, "../..");
const buildDir = path.join(desktopDir, "build");
const stageDir = path.join(buildDir, "gateway");
const webOutDir = path.join(buildDir, "web");
const ARCH = "arm64";

const electronVersion = createRequire(import.meta.url)("electron/package.json").version;

function run(command, args, options = {}) {
  console.log(`\n$ ${command} ${args.join(" ")}`);
  execFileSync(command, args, { stdio: "inherit", cwd: repoRoot, ...options });
}

/** The web build reads the home config for its base path. A dev flag or a tailscale config would change it. */
function cleanWebBuildEnv(emptyHome) {
  const env = { ...process.env, YOPLAI_HOME: emptyHome };
  for (const name of Object.keys(env)) {
    if (name === "YOPLAI_DEV" || name === "WEB_DEV" || name === "YOPLAI_WEB_DEV" || name.startsWith("VITE_")) delete env[name];
  }
  return env;
}

/** Remove what the gateway does not load: its TypeScript source, evals, test builds, and source maps. */
function pruneStage(stage) {
  for (const name of ["src", "evals", "tsconfig.json", "tsconfig.tsbuildinfo"]) {
    fs.rmSync(path.join(stage, name), { recursive: true, force: true });
  }
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(full);
      } else if (/\.(test\.js|map|tsbuildinfo)$/.test(entry.name)) {
        fs.rmSync(full);
      }
    }
  };
  walk(path.join(stage, "dist"));
}

if (process.platform !== "darwin") throw new Error("The packaged app builds on macOS only.");

fs.rmSync(buildDir, { recursive: true, force: true });
fs.mkdirSync(buildDir, { recursive: true });

run("pnpm", ["build"]);
run("pnpm", ["--filter", "@yoplai/desktop", "build"]);

const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "yoplai-web-build-home-"));
try {
  run("pnpm", ["--filter", "@yoplai/web", "build"], { env: cleanWebBuildEnv(emptyHome) });
} finally {
  fs.rmSync(emptyHome, { recursive: true, force: true });
}
fs.cpSync(path.join(repoRoot, "apps/web/dist"), webOutDir, { recursive: true });

run("pnpm", ["--filter", "@yoplai/gateway", "deploy", "--prod", "--legacy", stageDir]);

pruneStage(stageDir);

run("pnpm", [
  "--filter", "@yoplai/desktop", "exec", "electron-rebuild",
  "--force", "--module-dir", stageDir, "--version", electronVersion, "--arch", ARCH,
]);

run("pnpm", ["--filter", "@yoplai/desktop", "exec", "electron-builder", "--config", "electron-builder.yml"], { cwd: desktopDir });

const releaseDir = path.join(desktopDir, "release");
console.log(`\nElectron ${electronVersion}, ${ARCH}. Output in ${releaseDir}:`);
for (const name of fs.readdirSync(releaseDir)) console.log(`  ${name}`);
