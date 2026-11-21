import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { Worker } from "node:worker_threads";
import type { ReleaseCatalogEntry } from "@yoplai/shared";
import { fetchCatalogAsset, readCatalogBytes } from "./release-catalog-fetch.js";

const unzip = promisify(gunzip);
const block = 512;
const extensionCheckTimeoutMs = 30_000;
const allowedFiles = new Set(["index.js", "manifest.json", "icon.svg", "icon.png", "pdf.worker.mjs", "LICENSE"]);

function numberField(field: Buffer): number {
  const value = field.toString("ascii").replace(/[\0 ]+$/, "").trim();
  if (!/^[0-7]+$/.test(value)) throw new Error("The archive contains an invalid number.");
  return Number.parseInt(value, 8);
}

export async function extractReleaseBundle(bytes: Buffer, directory: string): Promise<void> {
  const maxBytes = 100_000_000;
  const archive = await unzip(bytes, { maxOutputLength: maxBytes + (allowedFiles.size * 2 + 20) * block });
  const seen = new Set<string>();
  let total = 0;
  for (let offset = 0; offset + block <= archive.length;) {
    const header = archive.subarray(offset, offset + block);
    if (header.every((byte) => byte === 0)) {
      const remainder = archive.subarray(offset);
      if (remainder.length >= 2 * block && remainder.every((byte) => byte === 0) && seen.has("index.js") && seen.has("manifest.json")) return;
      break;
    }
    const name = header.subarray(0, 100).toString("utf8").replace(/\0+$/, "");
    if (!allowedFiles.has(name) || seen.has(name) || (header[156] !== 48 && header[156] !== 0) ||
        header.subarray(345, 500).some((byte) => byte !== 0)) {
      throw new Error("The archive contains a file that is not allowed.");
    }
    const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (checksum !== numberField(header.subarray(148, 156))) throw new Error("The archive header is invalid.");
    const size = numberField(header.subarray(124, 136));
    const start = offset + block;
    total += size;
    if (total > maxBytes || start + size > archive.length) throw new Error("The archive exceeds the size limit or is incomplete.");
    await fs.writeFile(path.join(directory, name), archive.subarray(start, start + size), { flag: "wx", mode: 0o644 });
    seen.add(name);
    offset = start + Math.ceil(size / block) * block;
  }
  throw new Error("The archive does not contain a complete extension.");
}

async function readStagedExtensionId(indexPath: string, key: string): Promise<string> {
  const entry = import.meta.url.endsWith(".ts") ? "./release-bundle.worker.ts" : "./release-bundle.worker.js";
  const worker = new Worker(new URL(entry, import.meta.url), { workerData: { indexPath, key } });
  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<string>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("The extension check timed out.")), extensionCheckTimeoutMs);
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.once("exit", () => reject(new Error("The extension check stopped without a result.")));
    });
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
}

export async function stageReleaseBundle(entry: ReleaseCatalogEntry, directory: string): Promise<void> {
  const response = await fetchCatalogAsset(entry.url);
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`The download returned HTTP ${response.status}.`);
  }
  const bytes = await readCatalogBytes(response, entry.size);
  if (bytes.length !== entry.size) throw new Error("The download size does not match the catalog.");
  if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) {
    throw new Error("The download digest does not match the catalog.");
  }
  await extractReleaseBundle(bytes, directory);
  const manifest = JSON.parse(await fs.readFile(path.join(directory, "manifest.json"), "utf8"));
  if (manifest?.id !== entry.id || manifest.version !== entry.version) {
    throw new Error("The manifest ID or version does not match the catalog.");
  }
  await fs.writeFile(path.join(directory, "package.json"), '{"type":"module"}');
  const id = await readStagedExtensionId(path.join(directory, "index.js"), entry.sha256);
  if (id !== entry.id) throw new Error("The extension ID does not match the catalog.");
}
