import { createHash, randomBytes } from "node:crypto";
import type { DashboardEmbedMeta } from "../canvas/embed-contract.js";
import { getLinkedGateways } from "./state.js";
import type { RemoteGateway } from "./store.js";

/**
 * Limits of the snapshot store. The numbers are fixed defaults, not settings.
 * Tests change them through this object.
 */
export const dashboardViewSnapshotLimits = {
  /** Life of the metadata and of the edit and add routes. */
  ttlMs: 30 * 60 * 1000,
  /** Time to deliver the stored bytes. A snapshot that nobody delivers ends after it. */
  deliveryMs: 2 * 60 * 1000,
  /** Stored snapshots, with or without bytes. */
  count: 128,
  /** Bytes of all snapshots that wait for delivery. */
  bytes: 32 * 1024 * 1024,
};

/**
 * One checked remote answer for one dashboard. The bytes and the metadata come
 * from the same remote read and never change. The bytes leave the store at the
 * first delivery. The metadata stays until the snapshot ends. A snapshot never
 * describes another dashboard, and no frame can change it.
 */
type Snapshot = {
  gateway: string;
  /** Hash of the link that issued the snapshot. Unlink, relink, and a new link generation change it. */
  link: string;
  origin: string;
  instance: string;
  dashboardId: string;
  query: string;
  theme: "light" | "dark" | null;
  meta: DashboardEmbedMeta;
  createdAt: number;
  expiresAt: number;
  bytes?: Buffer;
  shellDelivered: boolean;
};

const snapshots = new Map<string, Snapshot>();

/** The longest delay of a Node timer. A longer deadline wakes the sweep early, and the sweep sets the timer again. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** The one cleanup timer. It waits for the next deadline of any snapshot, so an idle viewer still frees its bytes and metadata. */
let cleanupTimer: NodeJS.Timeout | undefined;

/** Time when this snapshot next changes: its delivery deadline while it holds bytes, else its end. */
function deadlineOf(snapshot: Snapshot): number {
  return snapshot.bytes === undefined ? snapshot.expiresAt : Math.min(snapshot.expiresAt, snapshot.createdAt + dashboardViewSnapshotLimits.deliveryMs);
}

/** Replaces the cleanup timer with one for the earliest deadline. No snapshot means no timer. The timer never keeps the process alive. */
function scheduleCleanup(): void {
  if (cleanupTimer) clearTimeout(cleanupTimer);
  cleanupTimer = undefined;
  if (snapshots.size === 0) return;
  let next = Infinity;
  for (const snapshot of snapshots.values()) next = Math.min(next, deadlineOf(snapshot));
  cleanupTimer = setTimeout(() => {
    cleanupTimer = undefined;
    sweep(Date.now());
  }, Math.min(Math.max(next - Date.now(), 1), MAX_TIMER_MS));
  cleanupTimer.unref();
}

function linkFingerprint(gateway: RemoteGateway): string {
  return createHash("sha256").update(JSON.stringify([gateway.name, gateway.url, gateway.token ?? null, gateway.generation ?? null])).digest("hex");
}

/**
 * Ends snapshots that expired, that nobody delivered in time, or whose link no
 * longer exists or changed. It then sets the cleanup timer for what remains.
 */
function sweep(now: number): void {
  const links = new Map(getLinkedGateways().map((gateway) => [gateway.name, linkFingerprint(gateway)]));
  for (const [handle, snapshot] of snapshots) {
    const lateDelivery = snapshot.bytes !== undefined && snapshot.createdAt + dashboardViewSnapshotLimits.deliveryMs <= now;
    if (snapshot.expiresAt <= now || lateDelivery || links.get(snapshot.gateway) !== snapshot.link) snapshots.delete(handle);
  }
  scheduleCleanup();
}

function storedBytes(): number {
  let total = 0;
  for (const snapshot of snapshots.values()) total += snapshot.bytes?.byteLength ?? 0;
  return total;
}

/** True when a new snapshot can fit by count. The bytes are checked when the snapshot is stored. */
export function hasDashboardViewRoom(now = Date.now()): boolean {
  sweep(now);
  return snapshots.size < dashboardViewSnapshotLimits.count;
}

export type NewSnapshot = {
  dashboardId: string;
  query: string;
  theme: "light" | "dark" | null;
  meta: DashboardEmbedMeta;
  bytes: Buffer;
};

export type StoredSnapshot = { handle: string; instance: string; expiresAt: number };

/** Stores the snapshot, or names the limit that refuses it. */
export function storeDashboardViewSnapshot(
  gateway: RemoteGateway,
  origin: string,
  snapshot: NewSnapshot,
  now = Date.now()
): StoredSnapshot | "count" | "bytes" {
  sweep(now);
  if (snapshots.size >= dashboardViewSnapshotLimits.count) return "count";
  if (storedBytes() + snapshot.bytes.byteLength > dashboardViewSnapshotLimits.bytes) return "bytes";
  const handle = randomBytes(32).toString("base64url");
  const instance = randomBytes(16).toString("base64url");
  const expiresAt = now + dashboardViewSnapshotLimits.ttlMs;
  snapshots.set(handle, {
    ...snapshot,
    gateway: gateway.name,
    link: linkFingerprint(gateway),
    origin,
    instance,
    createdAt: now,
    expiresAt,
    shellDelivered: false,
  });
  scheduleCleanup();
  return { handle, instance, expiresAt };
}

export type ResolvedSnapshot = {
  gateway: RemoteGateway;
  origin: string;
  instance: string;
  dashboardId: string;
  meta: DashboardEmbedMeta;
  expiresAt: number;
  /** `ready` while the bytes wait for delivery. `delivered` after the first delivery claimed them. */
  state: "ready" | "delivered";
};

/** Returns the snapshot, or undefined when it is unknown, expired, undelivered in time, or its link changed. */
export function resolveDashboardViewSnapshot(handle: string, now = Date.now()): ResolvedSnapshot | undefined {
  sweep(now);
  const snapshot = snapshots.get(handle);
  if (!snapshot) return undefined;
  const gateway = getLinkedGateways().find((item) => item.name === snapshot.gateway);
  if (!gateway) return undefined;
  return {
    gateway,
    origin: snapshot.origin,
    instance: snapshot.instance,
    dashboardId: snapshot.dashboardId,
    meta: snapshot.meta,
    expiresAt: snapshot.expiresAt,
    state: snapshot.bytes ? "ready" : "delivered",
  };
}

/** The shell of a snapshot loads once. A second request gets a refusal. */
export function claimDashboardViewShell(handle: string): boolean {
  const snapshot = snapshots.get(handle);
  if (!snapshot || snapshot.shellDelivered) return false;
  snapshot.shellDelivered = true;
  return true;
}

/**
 * Hands the bytes to the first caller and removes them from the store, so the
 * snapshot is delivered at most once. A later caller gets undefined, never
 * another document.
 */
export function claimDashboardViewBytes(handle: string): Buffer | undefined {
  const snapshot = snapshots.get(handle);
  const bytes = snapshot?.bytes;
  if (!snapshot || !bytes) return undefined;
  snapshot.bytes = undefined;
  scheduleCleanup();
  return bytes;
}

/**
 * Ends a snapshot that its host no longer shows, so it stops counting toward the cap before its TTL. Only the
 * issuer origin can end it. An unknown handle is already ended.
 */
export function releaseDashboardViewSnapshot(handle: string, origin: string): "released" | "forbidden" {
  const snapshot = snapshots.get(handle);
  if (!snapshot) return "released";
  if (snapshot.origin !== origin) return "forbidden";
  snapshots.delete(handle);
  scheduleCleanup();
  return "released";
}

export function resetDashboardViewSnapshotsForTests(): void {
  snapshots.clear();
  scheduleCleanup();
}

export function dashboardViewStoreSizeForTests(): { count: number; bytes: number } {
  return { count: snapshots.size, bytes: storedBytes() };
}
