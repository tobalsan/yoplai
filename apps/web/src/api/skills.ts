import { API_BASE, apiFetch } from "./core";
import type { DashboardRecipient, DashboardShare } from "./dashboards";
import { gatewayApiPath, type GatewayName } from "./gateway";

export type SkillShare = { kind: "user"; id: string; mode: "read" | "write" } | { kind: "all"; mode: "read" };
export type SkillRow = {
  id: string; name: string; description: string; kind: "builtin" | "default" | "user" | "agent";
  ownerName: string | null; enabled: boolean; locked: boolean; shadowed: boolean;
  shares: SkillShare[]; mode: "read" | "write"; updatedAt: string | null;
  canRead: boolean; canWrite: boolean; canManage: boolean; disabledByAdmin?: boolean;
  agentId?: string; agentName?: string; system?: boolean;
};
export type SkillGroups = { mine: SkillRow[]; sharedWithMe: SkillRow[]; agent: SkillRow[] };
export type SkillDetail = SkillRow & { skillMd: string; files: Array<{ path: string; size: number }> };

const ERROR_MESSAGES: Record<string, string> = {
  skill_exists: "A skill with this name already exists.",
  missing_skill_md: "Add a SKILL.md file at the top level of the skill.",
  invalid_frontmatter: "SKILL.md must start with a front matter block that has a name and a description.",
  invalid_name: "The skill name can use only lowercase letters, numbers and hyphens, with a maximum of 64 characters.",
  missing_description: "Add a description to the SKILL.md front matter.",
  name_mismatch: "The name in SKILL.md must be the same as the skill name.",
  invalid_zip: "The file is not a valid zip archive.",
  body_too_large: "The upload is too large. The maximum is 25 MB.",
  content_too_large: "The skill is too large. The maximum is 25 MB.",
  too_many_entries: "The skill has too many files. The maximum is 200.",
  invalid_path: "A file path in the skill is not valid.",
  duplicate_path: "The skill contains the same file path two times.",
  special_entry: "The skill contains a link or a special file. Use only normal files and folders.",
  // Answers of the local relay for a remote gateway.
  gateway_offline: "The remote gateway is offline.",
  invalid_remote_path: "This skill ID cannot pass through the relay. Open the skill on the remote gateway.",
  skill_upload_too_large: "The upload is too large. The maximum is 25 MB.",
  invalid_multipart: "The upload is not valid. Try again.",
  untrusted_origin: "The relay refused this page.",
  relay_unavailable: "Linked gateways are not available on this gateway.",
  unknown_gateway: "The gateway is not linked.",
  relay_route_not_allowed: "The relay does not allow this action.",
};

export class SkillRequestError extends Error {
  constructor(public status: number, public code: string, public skillId?: string, kind?: string) {
    super(code === "name_taken" ? `That skill name belongs to ${kind === "user" ? "another user" : `a ${kind ?? "reserved"} skill`}. Choose another name.` : ERROR_MESSAGES[code] ?? code.replaceAll("_", " "));
  }
}

async function request<T>(path: string, init?: RequestInit, gateway?: GatewayName): Promise<T> {
  const signal = AbortSignal.timeout(15_000);
  let response: Response;
  try { response = await apiFetch(gatewayApiPath(gateway, `${API_BASE}${path}`), { ...init, signal }); }
  catch (cause) { if (signal.aborted) throw new Error("Skill request timed out. Try again."); throw cause; }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new SkillRequestError(response.status, body.error ?? `Skill request failed (${response.status}).`, body.id, body.kind);
  }
  return response.json();
}
export const fetchSkills = (gateway?: GatewayName) => request<SkillGroups>("/skills", undefined, gateway);
export const fetchSkill = (id: string, gateway?: GatewayName) => request<SkillDetail>(`/skills/${encodeURIComponent(id)}`, undefined, gateway);
export const setSkillEnabled = (id: string, enabled: boolean, gateway?: GatewayName) => request(`/skills/${encodeURIComponent(id)}/enabled`, {
  method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }),
}, gateway);

export function uploadSkill(files: File[], folder: boolean, skillId?: string, gateway?: GatewayName) {
  const body = new FormData();
  for (const file of files) {
    const path = folder ? file.webkitRelativePath.split("/").slice(1).join("/") : file.name;
    body.append(folder ? "files" : "file", file, path);
  }
  return request<{ id: string; name: string }>(skillId ? `/skills/${encodeURIComponent(skillId)}/content` : "/skills", { method: skillId ? "PUT" : "POST", body }, gateway);
}

export const fetchSkillRecipients = (gateway?: GatewayName) => request<{ users: DashboardRecipient[] }>("/skills/recipients", undefined, gateway);
export const saveSkillShares = (id: string, shares: DashboardShare[], gateway?: GatewayName) => request(`/skills/${encodeURIComponent(id)}/shares`, {
  method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ shares }),
}, gateway);

export type ImportToken = { id: string; createdAt: string; expiresAt: string };
export type CreatedImportToken = { id: string; token: string; expiresAt: string; prompt: string };
export const fetchImportTokens = (gateway?: GatewayName) => request<{ tokens: ImportToken[] }>("/skills/import-token", undefined, gateway);
export const createImportToken = (gateway?: GatewayName) => request<CreatedImportToken>("/skills/import-token", { method: "POST" }, gateway);
export const revokeImportToken = (id: string, gateway?: GatewayName) => request(`/skills/import-token/${encodeURIComponent(id)}`, { method: "DELETE" }, gateway);
export const deleteSkill = (id: string, gateway?: GatewayName) => request(`/skills/${encodeURIComponent(id)}`, { method: "DELETE" }, gateway);
export const fetchSkillVersions = (id: string, gateway?: GatewayName) => request<{ versions: Array<{ id: string; createdAt: string }> }>(`/skills/${encodeURIComponent(id)}/versions`, undefined, gateway);
export const restoreSkillVersion = (id: string, versionId: string, gateway?: GatewayName) => request(`/skills/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}/restore`, { method: "POST" }, gateway);
export const fetchAdminSkills = (gateway?: GatewayName) => request<{ skills: Array<SkillRow & { enabledCount: number; collisions: string[]; ownerActive: boolean; ownerId: string }>; agent: SkillRow[]; system: Array<SkillRow & { agents?: string[] }> }>("/admin/skills", undefined, gateway);
export const transferSkillOwner = (id: string, ownerId: string, gateway?: GatewayName) => request(`/skills/${encodeURIComponent(id)}/owner`, {
  method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ownerId }),
}, gateway);
export const checkSkillDefault = (id: string, gateway?: GatewayName) => request<{ outsidePaths: string[] }>(`/skills/${encodeURIComponent(id)}/default`, undefined, gateway);
export const makeSkillDefault = (id: string, gateway?: GatewayName) => request<{ id: string; name: string }>(`/skills/${encodeURIComponent(id)}/default`, { method: "POST" }, gateway);
export const setSkillSystem = (id: string, system: boolean, gateway?: GatewayName) => request(`/skills/${encodeURIComponent(id)}/system`, {
  method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ system }),
}, gateway);
export const setSkillAdminDisabled = (id: string, disabledByAdmin: boolean, gateway?: GatewayName) => request(`/skills/${encodeURIComponent(id)}/admin`, {
  method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ disabledByAdmin }),
}, gateway);

/** Link of one skill page. The gateway stays in the address, so a link, a reload, and Back keep it. */
export const skillPath = (id: string, gateway?: GatewayName) => `/skills/${encodeURIComponent(id)}${gateway === undefined ? "" : `?gateway=${encodeURIComponent(gateway)}`}`;
export const skillsPath = (gateway?: GatewayName) => `/skills${gateway === undefined ? "" : `?gateway=${encodeURIComponent(gateway)}`}`;
