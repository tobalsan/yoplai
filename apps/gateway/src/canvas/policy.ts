import type { DashboardRegistration } from "./store.js";

/** Identity and current eligibility supplied by trusted gateway code. */
export type DashboardActor = {
  userId?: string;
  eligible: boolean;
  superadmin?: boolean;
  hasAgentAccess?: boolean;
  durableChat?: boolean;
};

export class DashboardAccessPolicy {
  canRead(entry: DashboardRegistration, actor: DashboardActor): boolean {
    if (!actor.eligible) return false;
    if (!entry.ownerUserId) return actor.hasAgentAccess === true;
    return Boolean(
      actor.superadmin ||
      actor.userId === entry.ownerUserId ||
      entry.shares?.some(
        (share) => share.kind === "all" || share.id === actor.userId
      )
    );
  }

  canWrite(entry: DashboardRegistration, actor: DashboardActor): boolean {
    if (!actor.eligible) return false;
    if (!entry.ownerUserId) return actor.hasAgentAccess === true;
    return (
      actor.userId === entry.ownerUserId ||
      Boolean(
        entry.shares?.some(
          (share) =>
            share.mode === "write" &&
            (share.kind === "all" || share.id === actor.userId)
        )
      )
    );
  }

  canManage(entry: DashboardRegistration, actor: DashboardActor): boolean {
    return (
      actor.eligible &&
      (entry.ownerUserId
        ? actor.userId === entry.ownerUserId
        : actor.hasAgentAccess === true)
    );
  }

  filterVisible(
    entries: DashboardRegistration[],
    actor: DashboardActor
  ): DashboardRegistration[] {
    return entries.filter((entry) => this.canRead(entry, actor));
  }
}

export const dashboardAccessPolicy = new DashboardAccessPolicy();
