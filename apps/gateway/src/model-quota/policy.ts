import type { QuotaSnapshot } from "@yoplai/shared";
import { QUOTA_MAX_AGE_SECONDS, QUOTA_PACE_FLOOR } from "./constants.js";

function unknown(snapshot: QuotaSnapshot, now: number): boolean {
  return (
    snapshot.status !== "known" ||
    snapshot.stale ||
    snapshot.updatedAt === undefined ||
    now - snapshot.updatedAt > QUOTA_MAX_AGE_SECONDS ||
    snapshot.windows.some(
      (window) => window.kind !== "other" && now >= window.resetAt
    )
  );
}

export function pace(
  snapshot: QuotaSnapshot,
  kind: "weekly",
  now: number
): number | "unknown" {
  if (unknown(snapshot, now)) return "unknown";
  const window = snapshot.windows.find((window) => window.kind === kind);
  if (!window) return "unknown";
  const elapsed = Math.max(
    QUOTA_PACE_FLOOR,
    Math.min(1, 1 - (window.resetAt - now) / window.windowSeconds)
  );
  return window.usedPercent / (elapsed * 100);
}

export function fiveHourState(
  snapshot: QuotaSnapshot,
  now: number
): "exhausted" | "ok" | "absent" | "unknown" {
  if (unknown(snapshot, now)) return "unknown";
  const window = snapshot.windows.find((window) => window.kind === "five-hour");
  if (!window) return "absent";
  return window.usedPercent >= 100 ||
    window.status === "rejected" ||
    window.status === "limited"
    ? "exhausted"
    : "ok";
}
