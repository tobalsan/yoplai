// electron-builder skips node_modules folders in extraResources. This hook copies the gateway
// node_modules into the app after packing. The symlinks of the pnpm layout are relative, so the copy keeps them.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));

/** @param {import("electron-builder").AfterPackContext} context */
export default async function afterPack(context) {
  const source = path.join(scriptsDir, "..", "build", "gateway", "node_modules");
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const target = path.join(context.appOutDir, appName, "Contents", "Resources", "gateway", "node_modules");
  fs.cpSync(source, target, { recursive: true, verbatimSymlinks: true });
}
