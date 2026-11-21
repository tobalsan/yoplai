// Build the packaged macOS app: Yoplai.app and a .dmg in apps/desktop/release.
// Steps: repo build, desktop build, web build with an empty home, gateway deploy stage
// (the workspace state file is restored after it),
// native module rebuild for the Electron version, electron-builder.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { checkBuilderEnv, releaseOptions, stapleRelease } from "./mac-release.mjs";
import { checkGateway, checkGatewayStoreLayout, pruneGateway, reportGatewaySize } from "./prune-gateway.mjs";

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(desktopDir, "../..");
const buildDir = path.join(desktopDir, "build");
const stageDir = path.join(buildDir, "gateway");
const webOutDir = path.join(buildDir, "web");
const ARCH = "arm64";
const workspaceStateFile = path.join(repoRoot, "node_modules/.pnpm-workspace-state-v1.json");

const electronVersion = createRequire(import.meta.url)("electron/package.json").version;

function run(command, args, options = {}) {
  console.log(`\n$ ${command} ${args.join(" ")}`);
  execFileSync(command, args, { stdio: "inherit", cwd: repoRoot, env: buildEnv, ...options });
}

/** The web build reads the home config for its base path. A dev flag or a tailscale config would change it. */
function cleanWebBuildEnv(emptyHome) {
  const env = { ...buildEnv, YOPLAI_HOME: emptyHome };
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

const isRelease = process.argv.includes("--release");
if (isRelease) checkBuilderEnv(desktopDir);
const release = isRelease ? releaseOptions(process.env) : undefined;
const buildEnv = release?.env ?? process.env;

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

// `pnpm deploy` overwrites the workspace state of the repo with a state that has only the gateway project.
// The next pnpm command sees a changed workspace, runs an install, and the desktop postinstall fails.
// Restore the saved state after the deploy, so the next command needs no install.
const workspaceState = fs.existsSync(workspaceStateFile) ? fs.readFileSync(workspaceStateFile) : undefined;
try {
  // The copy option prevents the second store copy on macOS with pnpm 12.3.4.
  run("pnpm", ["--filter", "@yoplai/gateway", "deploy", "--prod", "--legacy", "--config.package-import-method=copy", stageDir]);
} finally {
  if (workspaceState) fs.writeFileSync(workspaceStateFile, workspaceState);
}

checkGatewayStoreLayout(stageDir);
pruneStage(stageDir);
pruneGateway(stageDir, "before-rebuild");

run("pnpm", [
  "--filter", "@yoplai/desktop", "exec", "electron-rebuild",
  "--force", "--module-dir", stageDir, "--version", electronVersion, "--arch", ARCH,
]);

pruneGateway(stageDir, "after-rebuild");
checkGateway(stageDir);
reportGatewaySize(stageDir);

const builderArgs = ["--filter", "@yoplai/desktop", "exec", "electron-builder", "--config", "electron-builder.yml"];
if (release) checkBuilderEnv(desktopDir);
run("pnpm", [...builderArgs, ...(release?.args ?? [])], { cwd: desktopDir });

const releaseDir = path.join(desktopDir, release ? "release/signed" : "release");
const appPath = path.join(releaseDir, "mac-arm64", "Yoplai.app");
checkGateway(path.join(appPath, "Contents", "Resources", "gateway"));
if (release) {
  run("node", [path.join(desktopDir, "scripts/packaged-check.mjs"), appPath], { cwd: desktopDir });
  const { version } = JSON.parse(fs.readFileSync(path.join(desktopDir, "package.json"), "utf8"));
  stapleRelease(releaseDir, version, release.env);
}
console.log(`\nElectron ${electronVersion}, ${ARCH}. Output in ${releaseDir}:`);
for (const name of fs.readdirSync(releaseDir)) console.log(`  ${name}`);
