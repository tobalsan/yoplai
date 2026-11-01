import type { ModelRoutingRow } from "@yoplai/shared";

export type Pool = "claude" | "chatgpt";
export type QuotaSnapshot =
  | { status: "known"; exhausted: boolean; pace?: number }
  | { status: "unknown"; reason?: string };
export type PoolSnapshots = Record<Pool, QuotaSnapshot>;
type PoolRow = Pick<ModelRoutingRow, "pool"> & Partial<Pick<ModelRoutingRow, "claude" | "chatgpt">>;
export type PoolSelection = { pool?: Pool; reason: string };

export function selectPool(row: PoolRow, snapshots: PoolSnapshots, paceThreshold = 1.15): PoolSelection {
  if (!row.claude) return { pool: "chatgpt", reason: "single-pick" };
  if (!row.chatgpt) return { pool: "claude", reason: "single-pick" };
  const { claude, chatgpt } = snapshots;
  if (claude.status === "known" && chatgpt.status === "known") {
    if (claude.exhausted && chatgpt.exhausted) return { reason: "both-5h-exhausted" };
    if (claude.exhausted) return { pool: "chatgpt", reason: "5h-exhausted" };
    if (chatgpt.exhausted) return { pool: "claude", reason: "5h-exhausted" };
    if (row.pool !== "either") {
      const preferred = row.pool === "prefer_claude" ? "claude" : "chatgpt";
      const other = preferred === "claude" ? "chatgpt" : "claude";
      const quota = snapshots[preferred];
      return quota.status === "known" && quota.pace !== undefined && quota.pace > paceThreshold
        ? { pool: other, reason: "pace" }
        : { pool: preferred, reason: "preference" };
    }
    if (claude.pace === undefined || chatgpt.pace === undefined) return { reason: "quota-unknown" };
    return { pool: claude.pace <= chatgpt.pace ? "claude" : "chatgpt", reason: "pace" };
  }
  const reason = [claude, chatgpt].some((quota) => quota.status === "unknown" && quota.reason === "stale")
    ? "quota-stale" : "quota-unknown";
  return row.pool === "either" ? { reason } : {
    pool: row.pool === "prefer_claude" ? "claude" : "chatgpt", reason,
  };
}
