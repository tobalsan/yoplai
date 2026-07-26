import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveHomeDir } from "@yoplai/shared";
import { logError } from "../logging.js";

export type MediaDirection = "inbound" | "outbound";

export type MediaFileMetadata = {
  fileId: string;
  direction: MediaDirection;
  filename: string;
  storedFilename: string;
  path: string;
  mimeType: string;
  size: number;
  createdAt: string;
  agentId?: string;
  sessionId?: string;
};

export type MediaMetadataStore = Record<string, MediaFileMetadata>;

export function getMediaDir(): string {
  return path.join(resolveHomeDir(), "media");
}

export function getMediaInboundDir(): string {
  return path.join(getMediaDir(), "inbound");
}

export function getMediaOutboundDir(): string {
  return path.join(getMediaDir(), "outbound");
}

export function getMetadataPath(): string {
  return path.join(getMediaDir(), "metadata.json");
}

export const MEDIA_DIR = getMediaDir();
export const MEDIA_INBOUND_DIR = getMediaInboundDir();
export const MEDIA_OUTBOUND_DIR = getMediaOutboundDir();
export const MEDIA_METADATA_PATH = getMetadataPath();

export async function ensureMediaDirectories(): Promise<void> {
  await Promise.all([
    fs.mkdir(getMediaInboundDir(), { recursive: true }),
    fs.mkdir(getMediaOutboundDir(), { recursive: true }),
  ]);
}

// Serializes read-modify-write of the shared metadata store. Concurrent
// registrations (e.g. a multi-file send_file) would otherwise race: collide on
// the temp file (ENOENT on rename) and clobber each other's entries.
let metadataLock: Promise<unknown> = Promise.resolve();

function withMetadataLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = metadataLock.then(fn, fn);
  metadataLock = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

export async function readMediaMetadata(): Promise<MediaMetadataStore> {
  let raw: string;
  try {
    raw = await fs.readFile(getMetadataPath(), "utf8");
  } catch (error) {
    if (isNotFoundError(error)) return {};
    throw error;
  }
  try {
    return JSON.parse(raw) as MediaMetadataStore;
  } catch (error) {
    // A corrupt store would otherwise throw on every media registration and
    // never self-heal (registerMediaFile reads before it writes). Quarantine
    // the bad file and start fresh so the next write rebuilds a valid store.
    const quarantinePath = `${getMetadataPath()}.corrupt`;
    await fs.rename(getMetadataPath(), quarantinePath).catch(() => {});
    logError("[media] metadata store was corrupt", error, { quarantinePath });
    return {};
  }
}

export async function getMediaFileMetadata(
  fileId: string
): Promise<MediaFileMetadata | null> {
  const metadata = await readMediaMetadata();
  return metadata[fileId] ?? null;
}

function isPathWithinDir(filePath: string, dir: string): boolean {
  const relative = path.relative(dir, filePath);
  return (
    relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

export async function resolveMediaFilePath(
  metadata: MediaFileMetadata
): Promise<string> {
  if (path.basename(metadata.storedFilename) !== metadata.storedFilename) {
    throw new Error("Media file not found");
  }

  const baseDir =
    metadata.direction === "outbound"
      ? getMediaOutboundDir()
      : getMediaInboundDir();
  const candidatePath = path.join(baseDir, metadata.storedFilename);
  let realBaseDir: string;
  let realFilePath: string;
  let realMetadataPath: string;
  try {
    [realBaseDir, realFilePath, realMetadataPath] = await Promise.all([
      fs.realpath(baseDir),
      fs.realpath(candidatePath),
      fs.realpath(metadata.path),
    ]);
  } catch {
    throw new Error("Media file not found");
  }

  if (
    !isPathWithinDir(realFilePath, realBaseDir) ||
    !isPathWithinDir(realMetadataPath, realBaseDir) ||
    realMetadataPath !== realFilePath
  ) {
    throw new Error("Media file not found");
  }

  const stat = await fs.stat(realFilePath).catch(() => null);
  if (!stat) {
    throw new Error("Media file not found");
  }
  if (!stat.isFile()) {
    throw new Error("Media file not found");
  }

  return realFilePath;
}

export async function registerMediaFile(input: {
  direction: MediaDirection;
  filename: string;
  storedFilename: string;
  path: string;
  mimeType: string;
  size: number;
  fileId?: string;
  agentId?: string;
  sessionId?: string;
}): Promise<MediaFileMetadata> {
  await ensureMediaDirectories();

  const fileId = input.fileId ?? randomUUID();
  const entry: MediaFileMetadata = {
    fileId,
    direction: input.direction,
    filename: input.filename,
    storedFilename: input.storedFilename,
    path: input.path,
    mimeType: input.mimeType,
    size: input.size,
    createdAt: new Date().toISOString(),
    agentId: input.agentId,
    sessionId: input.sessionId,
  };

  return withMetadataLock(async () => {
    const metadata = await readMediaMetadata();
    metadata[fileId] = entry;
    await writeMediaMetadata(metadata);
    return entry;
  });
}

async function writeMediaMetadata(metadata: MediaMetadataStore): Promise<void> {
  const metadataPath = getMetadataPath();
  await fs.mkdir(getMediaDir(), { recursive: true });
  const tempPath = `${metadataPath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(metadata, null, 2)}\n`);
  await fs.rename(tempPath, metadataPath);
}

function isNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
