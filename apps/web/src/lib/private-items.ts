import type { AgentDashboard } from "../api/agents";
import type { ScheduleJob } from "../api/schedules";
import { createSignal } from "solid-js";

const STORAGE_KEY = "yoplai:show-private-items";
const [showPrivateItems, setShowPrivateItems] = createSignal(false);
let storageWriteFailed = false;

export function usePrivateItemsVisibility() {
  try {
    if (!storageWriteFailed) setShowPrivateItems(localStorage.getItem(STORAGE_KEY) === "true");
  } catch {
    // Keep the in-memory preference when browser storage is unavailable.
  }
  const togglePrivateItems = () => {
    const next = !showPrivateItems();
    setShowPrivateItems(next);
    try {
      localStorage.setItem(STORAGE_KEY, String(next));
      storageWriteFailed = false;
    } catch {
      // A newly mounted tab must not restore a stale persisted preference.
      storageWriteFailed = true;
    }
  };
  return { showPrivateItems, togglePrivateItems };
}

type JobOwnership = Pick<ScheduleJob, "credentialMode" | "ownerUserId">;

export function isForeignMine(job: JobOwnership, viewerId: string | undefined): boolean {
  return job.credentialMode === "owner" && !!job.ownerUserId && !!viewerId && job.ownerUserId !== viewerId;
}

export function visibleJobs<T extends JobOwnership>(rows: T[], viewerId: string | undefined, showAll: boolean): T[] {
  return showAll ? rows : rows.filter((row) => !isForeignMine(row, viewerId));
}

export function visibleDashboards<T extends Pick<AgentDashboard, "isOwner" | "legacy" | "shared">>(
  rows: T[], viewerId: string | undefined, showAll: boolean,
): T[] {
  return !viewerId || showAll ? rows : rows.filter((row) => row.isOwner || row.legacy || row.shared);
}
