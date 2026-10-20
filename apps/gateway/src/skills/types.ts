export type SkillFileInput = { path: string; content: string; encoding?: "utf8" | "base64" };
export type SkillInput = { name?: string; files: SkillFileInput[] } | { zip: Buffer };
export type SkillShare = { kind: "user"; id: string; mode: "read" | "write" } | { kind: "all"; mode: "read" };
export type SkillRow = {
  id: string; name: string; description: string; ownerId: string;
  createdAt: number; updatedAt: number; shares: SkillShare[]; disabledByAdmin: boolean;
};
export type SkillDirectory = { id: string; name: string; description: string; directory: string; agents?: string[] };
export type SkillState = { enabled: string[] };
export type SkillActor = { userId: string; role?: string };
export type SkillPermissions = { canRead: boolean; canWrite: boolean; canManage: boolean };
export class SkillError extends Error {
  constructor(public readonly code: string, public readonly status = 400, public readonly details: Record<string, unknown> = {}) {
    super(code);
    this.name = "SkillError";
  }
}
