import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { releaseCatalogEntrySchema, extensionIdSchema, type ReleaseCatalogEntry } from "@yoplai/shared";
import { isLoopbackAddress } from "../relay/state.js";

export const defaultCatalogUrl = "https://github.com/tobalsan/yoplai-extensions/releases/latest/download/catalog.json";
const maxCatalogBytes = 5_000_000;
const maxAgeMs = 5 * 60_000;
const catalogSchema = z.object({
  schemaVersion: z.literal(1), generatedAt: z.string().datetime(),
  commit: z.string().min(1), release: z.string().min(1), extensions: z.array(z.unknown()),
});

type Catalog = Omit<z.infer<typeof catalogSchema>, "extensions"> & { extensions: ReleaseCatalogEntry[] };
type CacheRecord = { source: string; fetchedAt: string; etag?: string; catalog: Catalog };
export type CatalogResult = { source: string; fetchedAt: string | null; stale: boolean; error?: string; catalog?: Catalog };

export function catalogUrl(value: string, allowLoopback = true): URL {
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (url.username || url.password || !(url.protocol === "https:" ||
      (allowLoopback && url.protocol === "http:" && (host === "localhost" || isLoopbackAddress(host))))) {
    throw new Error("Use HTTPS for the catalog and its assets.");
  }
  return url;
}

function validateCatalog(raw: unknown): Catalog {
  const data = catalogSchema.parse(raw);
  const counts = new Map<string, number>();
  for (const rawEntry of data.extensions) {
    const id = extensionIdSchema.safeParse((rawEntry as { id?: unknown } | null)?.id);
    if (!id.success) continue;
    const key = id.data.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const extensions: ReleaseCatalogEntry[] = [];
  for (const rawEntry of data.extensions) {
    try {
      const entry = releaseCatalogEntrySchema.parse(rawEntry);
      if (counts.get(entry.id.toLowerCase()) !== 1) throw new Error("Duplicate extension ID.");
      catalogUrl(entry.url);
      if (entry.iconUrl) catalogUrl(entry.iconUrl);
      if (entry.docsUrl) catalogUrl(entry.docsUrl);
      extensions.push(entry);
    } catch {
      console.warn("The extension catalog contains an invalid or duplicate entry.");
    }
  }
  return { ...data, extensions };
}

export async function fetchCatalogAsset(source: string, headers?: HeadersInit): Promise<Response> {
  let url = catalogUrl(source);
  const signal = AbortSignal.timeout(10_000);
  for (let hop = 0; hop < 6; hop++) {
    const response = await fetch(url, { headers, signal, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    await response.body?.cancel();
    const location = response.headers.get("location");
    if (!location) break;
    url = catalogUrl(new URL(location, url).href, false);
  }
  throw new Error("The download has too many redirects or no redirect address.");
}

export async function readCatalogBytes(response: Response, maxBytes: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > maxBytes) throw new Error("The download exceeds the size limit.");
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }
  return Buffer.concat(chunks, size);
}

let memory: { root: string; record: CacheRecord } | undefined;
const pending = new Map<string, Promise<CatalogResult>>();

export function fetchReleaseCatalog(root: string, source: string, refresh = false): Promise<CatalogResult> {
  const key = JSON.stringify([root, source]);
  const current = pending.get(key);
  if (current) return current;
  const request = readReleaseCatalog(root, source, refresh).finally(() => pending.delete(key));
  pending.set(key, request);
  return request;
}

async function readReleaseCatalog(root: string, source: string, refresh: boolean): Promise<CatalogResult> {
  const cacheDir = path.join(root, ".cache");
  const cachePath = path.join(cacheDir, "catalog.json");
  let cache = memory?.root === root && memory.record.source === source ? memory.record : undefined;
  if (!cache) {
    try {
      const raw = JSON.parse(await fs.readFile(cachePath, "utf8"));
      if (raw.source === source && typeof raw.fetchedAt === "string" && Number.isFinite(Date.parse(raw.fetchedAt))) {
        cache = { source, fetchedAt: raw.fetchedAt, etag: typeof raw.etag === "string" ? raw.etag : undefined, catalog: validateCatalog(raw.catalog) };
      }
    } catch { /* The cache is optional. */ }
  }
  if (!refresh && cache && Date.now() - Date.parse(cache.fetchedAt) < maxAgeMs) return { ...cache, stale: false };
  try {
    const response = await fetchCatalogAsset(source, cache?.etag ? { "If-None-Match": cache.etag } : undefined);
    const fetchedAt = new Date().toISOString();
    if (response.status === 304 && cache) {
      cache = { ...cache, fetchedAt };
    } else {
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`The catalog returned HTTP ${response.status}.`);
      }
      const catalog = validateCatalog(JSON.parse((await readCatalogBytes(response, maxCatalogBytes)).toString("utf8")));
      cache = { source, fetchedAt, etag: response.headers.get("etag") ?? undefined, catalog };
    }
    memory = { root, record: cache };
    const temp = path.join(cacheDir, `${randomUUID()}.json`);
    try {
      await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 });
      await fs.writeFile(temp, JSON.stringify(cache), { flag: "wx", mode: 0o600 });
      await fs.rename(temp, cachePath);
    } catch {
      await fs.rm(temp, { force: true }).catch(() => undefined);
      console.warn("Could not save the extension catalog cache.");
    }
    return { ...cache, stale: false };
  } catch {
    return { source, fetchedAt: cache?.fetchedAt ?? null, catalog: cache?.catalog, stale: true, error: "Catalog not reachable." };
  }
}
