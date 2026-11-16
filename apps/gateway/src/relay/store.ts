import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveHomeDir } from "@yoplai/shared";

/** Facts about a link that the browser sign-in made. A link with no `managed` field is a manual link or an open link. */
export type ManagedLink = {
  /** The stable link ID of the remote. A re-link keeps it. */
  linkId: string;
  account: { email: string | null; name: string | null };
  deviceLabel: string;
  /** When the key expires, as an ISO time, or null when the remote named no expiry. */
  expiresAt: string | null;
  linkedAt: string;
};

export type RemoteGateway = {
  name: string;
  url: string;
  token?: string;
  managed?: ManagedLink;
  /**
   * Random value that the store sets on each new link. A link that another
   * process removes and creates again with equal values gets a new generation.
   * An older file can lack it.
   */
  generation?: string;
};

/** Holds the linked remote gateways. Callers read the credential through this interface only. */
export interface RemoteGatewayStore {
  list(): RemoteGateway[];
  save(gateway: RemoteGateway): void;
  remove(name: string): boolean;
  /**
   * Counts the changes that any process made to one name, and keeps counting after the name is removed. The count is in
   * the store file. A caller that saw a free name reads this count first. A later removal, also by the CLI, still shows
   * that the name changed.
   */
  mutationVersion(name: string): number;
  /**
   * Saves a link only when the stored link still has the generation that the caller saw. `null` means that no link of
   * this name may exist. `expectedVersion` is the `mutationVersion` that the caller saw. Returns false and writes
   * nothing on a mismatch. A saved link always gets a new generation.
   */
  saveIfGeneration(gateway: RemoteGateway, expected: string | null, expectedVersion?: number): boolean;
  /** Removes a link only when it still has this generation. */
  removeIfGeneration(name: string, expected: string | undefined): boolean;
}

export const REMOTE_GATEWAYS_FILE = "remote-gateways.json";

type StoreFile = { gateways: RemoteGateway[]; mutations: Map<string, number> };

const LOCK_WAIT_MS = 5_000;

/** The content of the lock file. */
type LockOwner = { pid: number; token: string };

export type FileRemoteGatewayStoreOptions = {
  /** How long a writer waits for a lock that a live process holds. The default is 5 seconds. */
  lockWaitMs?: number;
};

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Returns null when the file is missing or does not hold a lock owner. */
function readLockOwner(lockFile: string): LockOwner | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockFile, "utf8")) as Partial<LockOwner> | null;
    if (parsed && typeof parsed.token === "string" && typeof parsed.pid === "number" && Number.isSafeInteger(parsed.pid) && parsed.pid > 0) {
      return { pid: parsed.pid, token: parsed.token };
    }
  } catch {
    // A missing file or broken content has no owner.
  }
  return null;
}

/**
 * JSON array with mode 0600. The file is read on each call, so a running gateway sees a new entry.
 *
 * The array holds one row for each link, and a row of a changed name has a `mutations` count. A removed link leaves the
 * row `{ "removedName": <name>, "mutations": <count> }`, so the count survives the removal. `list()` returns no such
 * field or row. A file from an older version has neither, and it reads with counts of zero. Every writer, in any
 * process, reads the file, checks it, and writes it while it holds the lock file `<file>.lock`, so no process loses the
 * change of another process.
 *
 * The lock file holds the process ID of its owner and a random token. A lock is stale only when its owner process does
 * not exist. Age never makes a lock stale, so a live writer that pauses keeps its lock, and other writers wait and then
 * fail. A stale lock is moved to a unique name before it is deleted, so two writers cannot both recover it. A writer
 * deletes only a lock that holds its own token.
 */
export function createFileRemoteGatewayStore(
  filePath: string = path.join(resolveHomeDir(), REMOTE_GATEWAYS_FILE),
  options: FileRemoteGatewayStoreOptions = {}
): RemoteGatewayStore {
  const lockPath = `${filePath}.lock`;
  const lockWaitMs = options.lockWaitMs ?? LOCK_WAIT_MS;
  const validCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
  const read = (): StoreFile => {
    const file: StoreFile = { gateways: [], mutations: new Map() };
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      return file; // A missing or broken file reads as an empty store.
    }
    if (!Array.isArray(parsed)) return file;
    for (const row of parsed as Array<RemoteGateway & { removedName?: unknown; mutations?: unknown }>) {
      if (typeof row !== "object" || row === null) continue;
      const { mutations, removedName, ...gateway } = row;
      if (typeof removedName === "string") {
        if (validCount(mutations)) file.mutations.set(removedName, mutations);
        continue;
      }
      if (validCount(mutations)) file.mutations.set(gateway.name, mutations);
      file.gateways.push(gateway);
    }
    return file;
  };
  const write = (file: StoreFile) => {
    const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    const live = new Set(file.gateways.map((gateway) => gateway.name));
    const rows: unknown[] = file.gateways.map((gateway) => {
      const count = file.mutations.get(gateway.name);
      return count ? { ...gateway, mutations: count } : gateway;
    });
    for (const [name, count] of file.mutations) if (!live.has(name)) rows.push({ removedName: name, mutations: count });
    fs.writeFileSync(tmpPath, `${JSON.stringify(rows, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    fs.renameSync(tmpPath, filePath);
  };
  /** Moves a stale lock to a unique name. The rename lets only one writer take the lock, and the content check undoes a wrong take. */
  const recoverStaleLock = (stale: LockOwner) => {
    const moved = `${lockPath}.${process.pid}.${randomUUID()}.stale`;
    try {
      fs.renameSync(lockPath, moved);
    } catch {
      return; // Another writer moved or released the lock first.
    }
    const taken = readLockOwner(moved);
    if (!taken || (taken.token !== stale.token && processIsAlive(taken.pid))) {
      // Another writer made a new lock between our read and our rename, so put that lock back.
      try {
        fs.linkSync(moved, lockPath);
      } catch {
        // A third writer already holds the lock path. The owner keeps its token, and it deletes only that lock.
      }
    }
    fs.rmSync(moved, { force: true });
  };
  const locked = <T>(change: () => T): T => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const owner: LockOwner = { pid: process.pid, token: randomUUID() };
    // The lock file appears with its full content: write a private file, then link it to the lock path.
    const pending = `${lockPath}.${process.pid}.${owner.token}.tmp`;
    fs.writeFileSync(pending, JSON.stringify(owner), { mode: 0o600, flag: "wx" });
    const deadline = Date.now() + lockWaitMs;
    try {
      for (;;) {
        try {
          fs.linkSync(pending, lockPath);
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        const holder = readLockOwner(lockPath);
        if (holder && !processIsAlive(holder.pid)) {
          recoverStaleLock(holder);
          if (Date.now() <= deadline) continue;
        }
        if (Date.now() > deadline) {
          const who = holder ? `Process ${holder.pid} holds the lock` : "Another process holds the lock";
          throw new Error(`Cannot lock ${path.basename(filePath)}. ${who}. Wait and try again, or delete ${path.basename(lockPath)} if no Yoplai process runs.`);
        }
        sleepSync(5);
      }
    } finally {
      fs.rmSync(pending, { force: true });
    }
    try {
      return change();
    } finally {
      // Delete the lock only when it still holds our token. Another writer may have replaced it.
      if (readLockOwner(lockPath)?.token === owner.token) fs.rmSync(lockPath, { force: true });
    }
  };
  const bump = (file: StoreFile, name: string) => file.mutations.set(name, (file.mutations.get(name) ?? 0) + 1);
  return {
    list: () => read().gateways,
    save(gateway) {
      locked(() => {
        const file = read();
        const existing = file.gateways.find((item) => item.name === gateway.name);
        // An equal save changes nothing, so existing grants stay valid. Any other save starts a new link.
        const unchanged = existing?.generation !== undefined && existing.url === gateway.url && existing.token === gateway.token;
        const generation = unchanged ? existing.generation : randomUUID();
        if (!unchanged) bump(file, gateway.name);
        write({ ...file, gateways: [...file.gateways.filter((item) => item.name !== gateway.name), { ...gateway, generation }] });
      });
    },
    remove(name) {
      return locked(() => {
        const file = read();
        const remaining = file.gateways.filter((item) => item.name !== name);
        if (remaining.length === file.gateways.length) return false;
        bump(file, name);
        write({ ...file, gateways: remaining });
        return true;
      });
    },
    mutationVersion: (name) => read().mutations.get(name) ?? 0,
    saveIfGeneration(gateway, expected, expectedVersion) {
      return locked(() => {
        const file = read();
        const existing = file.gateways.find((item) => item.name === gateway.name);
        if (expectedVersion !== undefined && (file.mutations.get(gateway.name) ?? 0) !== expectedVersion) return false;
        if (expected === null ? existing !== undefined : existing?.generation !== expected) return false;
        bump(file, gateway.name);
        write({ ...file, gateways: [...file.gateways.filter((item) => item.name !== gateway.name), { ...gateway, generation: randomUUID() }] });
        return true;
      });
    },
    removeIfGeneration(name, expected) {
      return locked(() => {
        const file = read();
        const existing = file.gateways.find((item) => item.name === name);
        if (!existing || existing.generation !== expected) return false;
        bump(file, name);
        write({ ...file, gateways: file.gateways.filter((item) => item.name !== name) });
        return true;
      });
    },
  };
}
