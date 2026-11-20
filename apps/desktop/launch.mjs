// Dev launcher: runs Electron in its own process group and forwards the
// first SIGINT, SIGTERM, or SIGHUP to Electron only. Repeats are ignored.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const electronPath = createRequire(import.meta.url)("electron");
const child = spawn(electronPath, ["dist/main.js", ...process.argv.slice(2)], {
  stdio: "inherit",
  detached: true,
});

let forwarded = false;
const forward = (signal) => {
  if (forwarded) return;
  forwarded = true;
  try {
    child.kill(signal);
  } catch {
    // Electron already exited.
  }
};
process.on("SIGINT", () => forward("SIGINT"));
process.on("SIGTERM", () => forward("SIGTERM"));
// A closed terminal sends SIGHUP. Electron runs in its own session and does not get it.
process.on("SIGHUP", () => forward("SIGTERM"));

child.on("error", (err) => {
  console.error(err);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
