import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_MAIN_KEY,
  type SessionEntry,
  type ThinkLevel,
} from "@yoplai/shared";
import { CONFIG_DIR, loadConfig } from "../config/index.js";
import { getUserSessionsPath } from "@yoplai/extension-multi-user/isolation";

export { formatSessionTimestamp } from "./files.js";

/**
 * Generate a UUIDv7 (RFC 9562): 48-bit unix_ts_ms + 4-bit version + 12-bit rand_a
 * + 2-bit variant + 62-bit rand_b. Sortable by creation time.
 */
function uuidv7(): string {
  const bytes = crypto.randomBytes(16);
  const ts = Date.now();
  bytes[0] = (ts / 2 ** 40) & 0xff;
  bytes[1] = (ts / 2 ** 32) & 0xff;
  bytes[2] = (ts >>> 24) & 0xff;
  bytes[3] = (ts >>> 16) & 0xff;
  bytes[4] = (ts >>> 8) & 0xff;
  bytes[5] = ts & 0xff;
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export { DEFAULT_MAIN_KEY } from "@yoplai/shared";
export type { SessionEntry } from "@yoplai/shared";

type SessionStoreEntry = SessionEntry & {
  thinkLevel?: ThinkLevel;
};

export const DEFAULT_IDLE_MINUTES = 360;
export const DEFAULT_RESET_TRIGGERS = ["/new", "/reset"];
export const DEFAULT_ABORT_TRIGGERS = ["/abort", "/stop"];

/**
 * Check if message is an abort trigger.
 * Matches exact trigger or trigger + " " prefix.
 */
export function isAbortTrigger(
  message: string,
  triggers = DEFAULT_ABORT_TRIGGERS
): boolean {
  const trimmed = message.trim();
  for (const trigger of triggers) {
    if (!trigger) continue;
    if (trimmed === trigger || trimmed.startsWith(trigger + " ")) {
      return true;
    }
  }
  return false;
}

type StoreState = {
  store: Record<string, SessionStoreEntry>;
  loaded: boolean;
  loadPromise?: Promise<void>;
  savePromise: Promise<void>;
};

const storeStates = new Map<string, StoreState>();

function getStorePath(userId?: string): string {
  return getUserSessionsPath(userId, CONFIG_DIR);
}

function getStoreState(userId?: string): StoreState {
  const storePath = getStorePath(userId);
  let state = storeStates.get(storePath);
  if (!state) {
    state = { store: {}, loaded: false, savePromise: Promise.resolve() };
    storeStates.set(storePath, state);
  }
  return state;
}

async function ensureLoaded(userId?: string): Promise<void> {
  const state = getStoreState(userId);
  if (state.loaded) return;
  if (state.loadPromise) {
    await state.loadPromise;
    return;
  }

  const storePath = getStorePath(userId);
  state.loadPromise = (async () => {
    try {
      const raw = await fs.readFile(storePath, "utf-8");
      const parsed = JSON.parse(raw);
      state.store =
        parsed && typeof parsed === "object"
          ? (parsed as Record<string, SessionStoreEntry>)
          : {};
    } catch {
      state.store = {};
    } finally {
      state.loaded = true;
      state.loadPromise = undefined;
    }
  })();

  await state.loadPromise;
}

async function save(userId?: string) {
  const storePath = getStorePath(userId);
  const state = getStoreState(userId);
  const operation = state.savePromise.then(async () => {
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    const json = JSON.stringify(state.store, null, 2);
    const tmp = `${storePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(tmp, json, "utf-8");
    await fs.rename(tmp, storePath);
  });
  state.savePromise = operation.catch(() => {});
  await operation;
}

export type ResolveSessionParams = {
  agentId: string;
  userId?: string;
  sessionKey?: string;
  message: string;
  idleMinutes?: number;
  resetTriggers?: string[];
};

export type ResolveSessionResult = {
  sessionId: string;
  message: string; // potentially stripped of reset trigger
  isNew: boolean;
  createdAt: number;
};

/**
 * Resolve a sessionId from a sessionKey with idle timeout and reset triggers.
 * Returns the sessionId to use and the message (stripped if it was a reset trigger).
 */
export async function resolveSessionId(
  params: ResolveSessionParams
): Promise<ResolveSessionResult> {
  const {
    agentId,
    userId,
    sessionKey = DEFAULT_MAIN_KEY,
    message,
    idleMinutes,
    resetTriggers = DEFAULT_RESET_TRIGGERS,
  } = params;

  await ensureLoaded(userId);
  const state = getStoreState(userId);

  const config = loadConfig();
  const configuredIdleMinutes = config.sessions?.idleMinutes;
  const resolvedIdleMinutes =
    idleMinutes ?? configuredIdleMinutes ?? DEFAULT_IDLE_MINUTES;

  const storeKey = `${agentId}:${sessionKey}`;
  const entry = state.store[storeKey];
  const now = Date.now();
  const idleMs = resolvedIdleMinutes * 60_000;
  const trimmedMsg = message.trim();

  // Check for reset triggers
  let isReset = false;
  let strippedMessage = message;
  for (const trigger of resetTriggers) {
    if (!trigger) continue;
    if (trimmedMsg === trigger) {
      isReset = true;
      strippedMessage = "";
      break;
    }
    if (trimmedMsg.startsWith(trigger + " ")) {
      isReset = true;
      strippedMessage = trimmedMsg.slice(trigger.length + 1);
      break;
    }
  }

  // Determine if we should create a new session
  const isExpired =
    !entry ||
    (!sessionKey.startsWith("project:") && now - entry.updatedAt > idleMs);
  const shouldCreateNew = isReset || isExpired;

  let sessionId: string;
  let createdAt: number;
  if (shouldCreateNew) {
    sessionId = uuidv7();
    createdAt = now;
  } else {
    sessionId = entry.sessionId;
    createdAt = entry.createdAt ?? now; // fallback for legacy entries
  }

  // Update store
  state.store[storeKey] = { sessionId, updatedAt: now, createdAt };
  await save(userId);

  return {
    sessionId,
    message: strippedMessage,
    isNew: shouldCreateNew,
    createdAt,
  };
}

/**
 * Get session entry without modifying it (for status checks)
 */
export async function getSessionEntry(
  agentId: string,
  sessionKey: string,
  userId?: string
): Promise<SessionEntry | undefined> {
  await ensureLoaded(userId);
  return getStoreState(userId).store[`${agentId}:${sessionKey}`];
}

export async function clearSessionEntry(
  agentId: string,
  sessionKey: string,
  userId?: string
): Promise<SessionEntry | undefined> {
  await ensureLoaded(userId);
  const state = getStoreState(userId);
  const key = `${agentId}:${sessionKey}`;
  const entry = state.store[key];
  if (!entry) return undefined;
  delete state.store[key];
  await save(userId);
  return entry;
}

/**
 * Look up createdAt timestamp for a sessionId (searches all entries)
 * Returns undefined if not found
 */
export async function getSessionCreatedAt(
  sessionId: string,
  userId?: string
): Promise<number | undefined> {
  await ensureLoaded(userId);
  for (const entry of Object.values(getStoreState(userId).store)) {
    if (entry.sessionId === sessionId) {
      return entry.createdAt;
    }
  }
  return undefined;
}

/**
 * Get the thinkLevel for a session
 */
export async function getSessionThinkLevel(
  agentId: string,
  sessionKey: string,
  userId?: string
): Promise<ThinkLevel | undefined> {
  await ensureLoaded(userId);
  const storeKey = `${agentId}:${sessionKey}`;
  return getStoreState(userId).store[storeKey]?.thinkLevel;
}

/**
 * Restore session updatedAt to a previous value.
 * Used by heartbeat to avoid keeping sessions alive.
 * No-op if entry doesn't exist (safe for first-run).
 */
export async function restoreSessionUpdatedAt(
  agentId: string,
  sessionKey: string,
  originalUpdatedAt: number | undefined,
  userId?: string
): Promise<void> {
  if (originalUpdatedAt === undefined) return;
  await ensureLoaded(userId);
  const state = getStoreState(userId);
  const storeKey = `${agentId}:${sessionKey}`;
  const entry = state.store[storeKey];
  if (entry) {
    entry.updatedAt = originalUpdatedAt;
    await save(userId);
  }
}

/**
 * Set the thinkLevel for a session.
 * Creates entry if it doesn't exist.
 */
export async function setSessionThinkLevel(
  agentId: string,
  sessionKey: string,
  level: ThinkLevel,
  sessionId?: string,
  userId?: string
): Promise<void> {
  await ensureLoaded(userId);
  const state = getStoreState(userId);
  const storeKey = `${agentId}:${sessionKey}`;
  const entry = state.store[storeKey];
  if (entry) {
    entry.thinkLevel = level;
  } else {
    // Create entry if missing (use provided sessionId or generate new)
    const now = Date.now();
    state.store[storeKey] = {
      sessionId: sessionId ?? uuidv7(),
      updatedAt: now,
      createdAt: now,
      thinkLevel: level,
    };
  }
  await save(userId);
}
