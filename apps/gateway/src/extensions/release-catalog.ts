import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import {
  discoverExternalExtensions, extensionIdSchema, readInstallRecord,
  type GatewayConfig, type InstallRecord, type ReleaseCatalogEntry, type ReleaseCatalogRow, type ReleaseCatalogView,
} from "@yoplai/shared";
import {
  getExternalExtensionsPath, getLoadedExtensions, reconcileExternal, reservedExtensionIds, withExtensionMutation,
} from "./registry.js";
import { defaultCatalogUrl, fetchReleaseCatalog } from "./release-catalog-fetch.js";
import { stageReleaseBundle } from "./release-bundle.js";

const { version: gatewayVersion } = createRequire(import.meta.url)("../../package.json") as { version: string };

function compareVersions(left: string, right: string): number {
  const split = (v: string) => v.split("+", 1)[0].split(/-(.*)/, 2);
  const [leftVersion, leftPre] = split(left);
  const [rightVersion, rightPre] = split(right);
  const leftNumbers = leftVersion.split(".");
  const rightNumbers = rightVersion.split(".");
  for (let i = 0; i < 3; i++) {
    const difference = Number(leftNumbers[i]) - Number(rightNumbers[i]);
    if (difference) return difference;
  }
  if (leftPre === rightPre) return 0;
  if (!leftPre || !rightPre) return leftPre ? -1 : 1;
  const a = leftPre.split(".");
  const b = rightPre.split(".");
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    const aNumeric = /^\d+$/.test(a[i]);
    const bNumeric = /^\d+$/.test(b[i]);
    if (aNumeric && bNumeric) return Number(a[i]) - Number(b[i]);
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a[i] < b[i] ? -1 : 1;
  }
  return a.length - b.length;
}

export class CatalogOperationError extends Error {
  constructor(readonly status: 404 | 409 | 502, message: string) { super(message); }
}

async function lstat(directory: string) {
  try { return await fs.lstat(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
}

async function checkTarget(directory: string): Promise<InstallRecord | undefined> {
  const stat = await lstat(directory);
  if (!stat) return undefined;
  const record = stat.isDirectory() ? await readInstallRecord(directory) : undefined;
  if (!record) throw new CatalogOperationError(409, "Managed by hand");
  return record;
}

function checkId(id: string) {
  if (!extensionIdSchema.safeParse(id).success) throw new CatalogOperationError(404, "Extension not found.");
  if (reservedExtensionIds().some((reserved) => reserved.toLowerCase() === id.toLowerCase())) {
    throw new CatalogOperationError(409, "The gateway reserves this extension ID.");
  }
}

async function checkCollision(root: string, id: string) {
  const key = id.toLowerCase();
  const target = path.join(root, id);
  const names = await fs.readdir(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  if (names.some((name) => name !== id && name.toLowerCase() === key) ||
      (await discoverExternalExtensions(root)).some((item) => item.path !== target && item.id.toLowerCase() === key)) {
    throw new CatalogOperationError(409, "Another folder uses this extension ID.");
  }
}

function row(config: GatewayConfig, id: string, entry?: ReleaseCatalogEntry, installed?: InstallRecord, manual = false): ReleaseCatalogRow {
  const usedByAgents = config.agents.filter((agent) => agent.extensions && Object.hasOwn(agent.extensions, id)).length;
  const state = manual ? "manual" : installed && (!entry || installed.sha256 === entry.sha256) ? "installed"
    : entry && compareVersions(entry.minYoplai, gatewayVersion) > 0 ? "incompatible"
    : installed ? "update" : "available";
  return { ...entry, id, state, installedVersion: installed?.version, usedByAgents };
}

export async function listReleaseCatalog(config: GatewayConfig, refresh = false): Promise<ReleaseCatalogView> {
  const root = getExternalExtensionsPath(config);
  const { source, fetchedAt, stale, error, catalog } = await fetchReleaseCatalog(root, config.extensionCatalog?.url ?? defaultCatalogUrl, refresh);
  const entries: ReleaseCatalogRow[] = [];
  const found = await discoverExternalExtensions(root);
  const listed = new Set<string>();
  for (const entry of catalog?.extensions ?? []) {
    const key = entry.id.toLowerCase();
    const hit = found.find((item) => item.id.toLowerCase() === key && item.managed === "manual") ??
      found.find((item) => item.id.toLowerCase() === key);
    const target = path.join(root, entry.id);
    const stat = await lstat(target);
    const install = stat?.isDirectory() ? await readInstallRecord(target) : undefined;
    entries.push(row(config, entry.id, entry, install, hit?.managed === "manual" || !!stat && !install ||
      reservedExtensionIds().some((id) => id.toLowerCase() === key)));
    listed.add(key);
  }
  const names = await fs.readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const folder of names) {
    if (folder.name.startsWith(".") || !(folder.isDirectory() || folder.isSymbolicLink())) continue;
    const location = path.join(root, folder.name);
    const hit = found.find((item) => item.path === location);
    const id = hit?.id ?? folder.name;
    if (listed.has(id.toLowerCase())) continue;
    const install = folder.isDirectory() ? await readInstallRecord(location) : undefined;
    entries.push({ ...row(config, id, undefined, install, !install), name: hit?.extension.displayName, description: hit?.extension.description });
    listed.add(id.toLowerCase());
  }
  return { source, fetchedAt, stale, error, entries };
}

async function makeWorkFolder(root: string, name: ".staging" | ".trash"): Promise<string> {
  const folder = path.join(root, name);
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  if (!(await fs.lstat(folder)).isDirectory()) throw new Error("The extension work folder is not a directory.");
  return folder;
}

async function cleanFolder(folder: string) {
  try { await fs.rm(folder, { recursive: true, force: true }); }
  catch { console.warn("Could not remove the extension work folder."); }
}

export function installFromCatalog(config: GatewayConfig, id: string, actor: string) {
  return withExtensionMutation(async () => {
    checkId(id);
    const root = getExternalExtensionsPath(config);
    const result = await fetchReleaseCatalog(root, config.extensionCatalog?.url ?? defaultCatalogUrl);
    const entry = result.catalog?.extensions.find((item) => item.id === id);
    if (!result.catalog) throw new CatalogOperationError(502, "Catalog not reachable.");
    if (!entry) throw new CatalogOperationError(404, "Extension not found in the catalog.");
    if (compareVersions(entry.minYoplai, gatewayVersion) > 0) {
      throw new CatalogOperationError(409, `This extension needs Yoplai ${entry.minYoplai}.`);
    }
    const target = path.join(root, id);
    await checkTarget(target);
    await checkCollision(root, id);
    const staging = await fs.mkdtemp(path.join(await makeWorkFolder(root, ".staging"), `${id}-`));
    const install: InstallRecord = { id, version: entry.version, sha256: entry.sha256, url: entry.url,
      release: result.catalog.release, installedAt: new Date().toISOString(), installedBy: actor };
    try {
      await stageReleaseBundle(entry, staging);
      await fs.writeFile(path.join(staging, ".install.json"), JSON.stringify(install), { flag: "wx", mode: 0o600 });
      await checkCollision(root, id);
      const trash = path.join(await makeWorkFolder(root, ".trash"), `${id}-${randomUUID()}`);
      const previous = await checkTarget(target);
      if (previous) await fs.rename(target, trash);
      try {
        if (await checkTarget(target)) throw new CatalogOperationError(409, "The extension folder changed during the operation.");
        await fs.rename(staging, target);
      } catch (error) {
        if (previous && !(await lstat(target))) await fs.rename(trash, target);
        throw error;
      }
      await reconcileExternal(config, { requiredExternalId: id, fileChange: { id, restore: async () => {
        if (!(await checkTarget(target))) throw new Error("The installed extension folder is missing.");
        await fs.rm(target, { recursive: true });
        if (previous) await fs.rename(trash, target);
      } } });
      if (previous) await cleanFolder(trash);
      return { entry: row(config, id, entry, install), action: previous ? "extension.update" : "extension.install", previousSha256: previous?.sha256 ?? null };
    } finally {
      await cleanFolder(staging);
    }
  });
}

export function removeFromCatalog(config: GatewayConfig, id: string) {
  return withExtensionMutation(async () => {
    checkId(id);
    const dependent = getLoadedExtensions().find((extension) => extension.dependencies.includes(id));
    if (dependent) throw new CatalogOperationError(409, `Extension ${dependent.id} needs this extension.`);
    const root = getExternalExtensionsPath(config);
    const target = path.join(root, id);
    if (!(await checkTarget(target))) throw new CatalogOperationError(404, "Extension not found.");
    const trash = path.join(await makeWorkFolder(root, ".trash"), `${id}-${randomUUID()}`);
    await checkCollision(root, id);
    const previous = await checkTarget(target);
    if (!previous) throw new CatalogOperationError(404, "Extension not found.");
    await fs.rename(target, trash);
    await reconcileExternal(config, { fileChange: { id, restore: async () => {
      if (await lstat(target)) throw new Error("The extension folder changed during the operation.");
      await fs.rename(trash, target);
    } } });
    await cleanFolder(trash);
    return previous.sha256;
  });
}
