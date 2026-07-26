import { watch, type FSWatcher } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { GatewayConfig } from "@aihub/shared";
import { getProject, listProjects } from "./store.js";
import { parseSpaceFile, type SpaceFile } from "./space.js";

const NEGATIVE_CACHE_TTL_MS = 5_000;

type CacheEntry = {
  value: SpaceFile | null;
  expiresAt?: number;
};

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<SpaceFile | null>>();
const watchers = new Map<string, FSWatcher>();
const generations = new Map<string, number>();
const changeListeners = new Set<(projectId: string) => void>();

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function warn(projectId: string, message: string, error?: unknown): void {
  const detail = error instanceof Error ? ` ${error.message}` : "";
  console.warn(`[space-cache] ${projectId}: ${message}${detail}`);
}

async function getSpaceFilePath(
  config: GatewayConfig,
  projectId: string
): Promise<string | null> {
  const project = await getProject(config, projectId);
  if (!project.ok) return null;
  return path.join(project.data.absolutePath, "space.json");
}

function getGeneration(projectId: string): number {
  return generations.get(projectId) ?? 0;
}

function bumpGeneration(projectId: string): void {
  generations.set(projectId, getGeneration(projectId) + 1);
}

function invalidateGeneration(projectId: string): void {
  if (inflight.has(projectId)) {
    bumpGeneration(projectId);
  } else {
    generations.delete(projectId);
  }
}

function notifySpaceChanged(projectId: string): void {
  for (const listener of changeListeners) {
    listener(projectId);
  }
}

function setCached(
  projectId: string,
  generation: number,
  value: SpaceFile | null
): SpaceFile | null {
  if (getGeneration(projectId) !== generation) return value;
  cache.set(projectId, {
    value,
    expiresAt: value === null ? Date.now() + NEGATIVE_CACHE_TTL_MS : undefined,
  });
  return value;
}

function watchSpaceFile(projectId: string, filePath: string): void {
  if (watchers.has(projectId)) return;
  try {
    const watcher = watch(filePath, (eventType) => {
      if (eventType === "change" || eventType === "rename") {
        invalidateSpaceCache(projectId);
      }
    });
    watcher.on("error", (error) => {
      warn(projectId, "watcher failed:", error);
      invalidateSpaceCache(projectId);
    });
    watchers.set(projectId, watcher);
  } catch (error) {
    warn(projectId, "failed to watch space.json:", error);
  }
}

async function readSpaceFromDisk(
  config: GatewayConfig,
  projectId: string,
  generation: number
): Promise<SpaceFile | null> {
  const filePath = await getSpaceFilePath(config, projectId);
  if (!filePath) return setCached(projectId, generation, null);

  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (!isMissingFile(error)) {
      warn(projectId, "failed to read space.json:", error);
    }
    return setCached(projectId, generation, null);
  }

  watchSpaceFile(projectId, filePath);
  try {
    return setCached(projectId, generation, parseSpaceFile(raw));
  } catch (error) {
    warn(projectId, "failed to parse space.json:", error);
    return setCached(projectId, generation, null);
  }
}

export async function getCachedSpace(
  config: GatewayConfig,
  projectId: string
): Promise<SpaceFile | null> {
  const entry = cache.get(projectId);
  if (
    entry &&
    (entry.expiresAt === undefined || entry.expiresAt > Date.now())
  ) {
    return entry.value;
  }

  const pending = inflight.get(projectId);
  if (pending) return pending;

  const generation = getGeneration(projectId);
  const promise: Promise<SpaceFile | null> = readSpaceFromDisk(
    config,
    projectId,
    generation
  ).finally(() => {
    if (inflight.get(projectId) === promise) {
      inflight.delete(projectId);
    }
  });
  inflight.set(projectId, promise);
  return promise;
}

export function invalidateSpaceCache(projectId?: string): void {
  if (projectId === undefined) {
    for (const watcher of watchers.values()) {
      watcher.close();
    }
    for (const key of new Set([
      ...cache.keys(),
      ...inflight.keys(),
      ...watchers.keys(),
    ])) {
      invalidateGeneration(key);
    }
    cache.clear();
    inflight.clear();
    watchers.clear();
    return;
  }

  invalidateGeneration(projectId);
  cache.delete(projectId);
  inflight.delete(projectId);
  const watcher = watchers.get(projectId);
  if (watcher) {
    watcher.close();
    watchers.delete(projectId);
  }
  notifySpaceChanged(projectId);
}

export function startSpaceCacheWatcher(
  config: GatewayConfig,
  onChange?: (projectId: string) => void
): () => void {
  let stopped = false;
  if (onChange) changeListeners.add(onChange);

  void listProjects(config)
    .then((result) => {
      if (stopped || !result.ok) return;
      for (const project of result.data) {
        void getCachedSpace(config, project.id);
      }
    })
    .catch((error: unknown) => {
      if (stopped) return;
      warn("*", "failed to warm space cache from listProjects:", error);
    });

  return () => {
    stopped = true;
    if (onChange) changeListeners.delete(onChange);
    invalidateSpaceCache();
  };
}
