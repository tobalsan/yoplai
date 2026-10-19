import type { SkillActor, SkillPermissions, SkillRow } from "./types.js";

export type EligibleSkillAccount = { id: string; role?: string };
export type SkillAccessOptions = {
  multiUser: boolean;
  getEligibleAccount?: (id: string) => EligibleSkillAccount | null | undefined | Promise<EligibleSkillAccount | null | undefined>;
};

export class SkillAccessPolicy {
  constructor(readonly options: SkillAccessOptions) {}
  async permissions(row: SkillRow, actor: SkillActor): Promise<SkillPermissions> {
    const denied = { canRead: false, canWrite: false, canManage: false };
    let role = actor.role;
    if (this.options.multiUser) {
      const viewer = await this.options.getEligibleAccount?.(actor.userId);
      if (!viewer || !await this.options.getEligibleAccount?.(row.ownerId)) return denied;
      role = viewer.role;
    }
    if (row.ownerId === actor.userId) return { canRead: true, canWrite: true, canManage: true };
    const named = row.shares.filter((share) => share.kind === "user" && share.id === actor.userId);
    const canWrite = named.some((share) => share.mode === "write");
    return { canRead: role === "superadmin" || named.length > 0 || row.shares.some((share) => share.kind === "all"), canWrite, canManage: false };
  }
  async canRead(row: SkillRow, actor: SkillActor): Promise<boolean> { return (await this.permissions(row, actor)).canRead; }
  async canWrite(row: SkillRow, actor: SkillActor): Promise<boolean> { return (await this.permissions(row, actor)).canWrite; }
  async canManage(row: SkillRow, actor: SkillActor): Promise<boolean> { return (await this.permissions(row, actor)).canManage; }
  async filterVisible(rows: SkillRow[], actor: SkillActor): Promise<SkillRow[]> {
    const visible: SkillRow[] = [];
    for (const row of rows) if (await this.canRead(row, actor)) visible.push(row);
    return visible;
  }
}
