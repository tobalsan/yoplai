import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readInstallRecord, type InstallRecord } from "./install-record.js";
import type { Extension } from "../types.js";
import { ExtensionDefinitionSchema } from "../types.js";

export type DiscoveredExtension = {
  id: string;
  extension: Extension;
  path: string;
  key: string;
  managed: "catalog" | "manual";
  install?: InstallRecord;
};

export async function discoverExternalExtensions(
  directoryPath: string
): Promise<DiscoveredExtension[]> {
  const discovered: DiscoveredExtension[] = [];
  let entries;

  try {
    entries = await readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return discovered;
    throw error;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const entryPath = path.join(directoryPath, entry.name);
    const isDirectory =
      entry.isDirectory() ||
      (entry.isSymbolicLink() &&
        (await stat(entryPath).then(
          (s) => s.isDirectory(),
          () => false
        )));

    if (!isDirectory) continue;

    const indexPath = path.join(entryPath, "index.js");
    let indexStat;
    try {
      indexStat = await stat(indexPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      console.warn(
        `Failed to load extension at ${entryPath}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      continue;
    }

    try {
      const install = entry.isDirectory() ? await readInstallRecord(entryPath) : undefined;
      const key = install?.sha256 ?? `${indexStat.mtimeMs}-${indexStat.size}`;
      const extension = await importExternalExtension(indexPath, key);
      discovered.push({ id: extension.id, extension, path: entryPath, key, managed: install ? "catalog" : "manual", ...(install && { install }) });
    } catch (error) {
      console.warn(
        `Failed to load extension at ${entryPath}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  return discovered;
}

export async function importExternalExtension(indexPath: string, key: string): Promise<Extension> {
  const url = pathToFileURL(indexPath);
  url.searchParams.set("v", key);
  const module = await import(url.href);
  const raw = module.default ?? module;
  const result = ExtensionDefinitionSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid extension: ${result.error.issues.map((issue) => issue.message).join(", ")}`);
  }
  return raw as Extension;
}
