import { API_BASE, apiFetch } from "./core";
import type { DashboardRecipient, DashboardShare } from "./dashboards";
import { encodeSkillId } from "@yoplai/shared/skill-id-wire";
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
  invalid_skill_id: "The skill ID is not valid.",
  remote_skill_route_unsupported: "This gateway or the remote gateway is too old for this skill action. Upgrade both gateways together, then try again.",
};

export class SkillRequestError extends Error {
  constructor(public status: number, public code: string, public skillId?: string, kind?: string) {
    super(code === "name_taken" ? `That skill name belongs to ${kind === "user" ? "another user" : `a ${kind ?? "reserved"} skill`}. Choose another name.` : ERROR_MESSAGES[code] ?? code.replaceAll("_", " "));
  }
}

/**
 * The path of one skill object. The local gateway keeps its own routes. A linked gateway gets the alias route with the
 * canonical wire ID, so an ID with a slash, a percent sign, or a colon passes the relay as one safe segment. The ID of
 * the page, the links, and the returned rows stay unchanged.
 */
const objectPath = (id: string, gateway: GatewayName | undefined, suffix = "") =>
  gateway === undefined ? `/skills/${encodeURIComponent(id)}${suffix}` : `/skill-ids/${encodeSkillId(id)}${suffix}`;

async function request<T>(path: string, init?: RequestInit, gateway?: GatewayName): Promise<T> {
  const signal = AbortSignal.timeout(15_000);
  let response: Response;
  try { response = await apiFetch(gatewayApiPath(gateway, `${API_BASE}${path}`), { ...init, signal }); }
  catch (cause) { if (signal.aborted) throw new Error("Skill request timed out. Try again."); throw cause; }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    // A peer without the alias answers an unknown route with no JSON error, and an old local relay refuses the route.
    // Both are an explicit upgrade error. The request is never repeated on a legacy route and never goes to Local.
    if (gateway !== undefined && path.startsWith("/skill-ids/") && ((response.status === 404 || response.status === 405) && !body.error || body.error === "relay_route_not_allowed")) {
      throw new SkillRequestError(response.status, "remote_skill_route_unsupported");
    }
    throw new SkillRequestError(response.status, body.error ?? `Skill request failed (${response.status}).`, body.id, body.kind);
  }
  return response.json();
}
export const fetchSkills = (gateway?: GatewayName) => request<SkillGroups>("/skills", undefined, gateway);
export const fetchSkill = (id: string, gateway?: GatewayName) => request<SkillDetail>(objectPath(id, gateway), undefined, gateway);
export const setSkillEnabled = (id: string, enabled: boolean, gateway?: GatewayName) => request(objectPath(id, gateway, "/enabled"), {
  method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }),
}, gateway);

export function uploadSkill(files: File[], folder: boolean, skillId?: string, gateway?: GatewayName) {
  const body = new FormData();
  for (const file of files) {
    const path = folder ? file.webkitRelativePath.split("/").slice(1).join("/") : file.name;
    body.append(folder ? "files" : "file", file, path);
  }
  return request<{ id: string; name: string }>(skillId ? objectPath(skillId, gateway, "/content") : "/skills", { method: skillId ? "PUT" : "POST", body }, gateway);
}

export const fetchSkillRecipients = (gateway?: GatewayName) => request<{ users: DashboardRecipient[] }>("/skills/recipients", undefined, gateway);
export const saveSkillShares = (id: string, shares: DashboardShare[], gateway?: GatewayName) => request(objectPath(id, gateway, "/shares"), {
  method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ shares }),
}, gateway);

export type ImportToken = { id: string; createdAt: string; expiresAt: string };
export type CreatedImportToken = { id: string; token: string; expiresAt: string; prompt: string };
export const fetchImportTokens = (gateway?: GatewayName) => request<{ tokens: ImportToken[] }>("/skills/import-token", undefined, gateway);
export const createImportToken = (gateway?: GatewayName) => request<CreatedImportToken>("/skills/import-token", { method: "POST" }, gateway);
export const revokeImportToken = (id: string, gateway?: GatewayName) => request(`/skills/import-token/${encodeURIComponent(id)}`, { method: "DELETE" }, gateway);
export const deleteSkill = (id: string, gateway?: GatewayName) => request(objectPath(id, gateway), { method: "DELETE" }, gateway);
export const fetchSkillVersions = (id: string, gateway?: GatewayName) => request<{ versions: Array<{ id: string; createdAt: string }> }>(objectPath(id, gateway, "/versions"), undefined, gateway);
export const restoreSkillVersion = (id: string, versionId: string, gateway?: GatewayName) => request(objectPath(id, gateway, `/versions/${encodeURIComponent(versionId)}/restore`), { method: "POST" }, gateway);
export const fetchAdminSkills = (gateway?: GatewayName) => request<{ skills: Array<SkillRow & { enabledCount: number; collisions: string[]; ownerActive: boolean; ownerId: string }>; agent: SkillRow[]; system: Array<SkillRow & { agents?: string[] }> }>("/admin/skills", undefined, gateway);
export const transferSkillOwner = (id: string, ownerId: string, gateway?: GatewayName) => request(objectPath(id, gateway, "/owner"), {
  method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ownerId }),
}, gateway);
export const checkSkillDefault = (id: string, gateway?: GatewayName) => request<{ outsidePaths: string[] }>(objectPath(id, gateway, "/default"), undefined, gateway);
export const makeSkillDefault = (id: string, gateway?: GatewayName) => request<{ id: string; name: string }>(objectPath(id, gateway, "/default"), { method: "POST" }, gateway);
export const setSkillSystem = (id: string, system: boolean, gateway?: GatewayName) => request(objectPath(id, gateway, "/system"), {
  method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ system }),
}, gateway);
export const setSkillAdminDisabled = (id: string, disabledByAdmin: boolean, gateway?: GatewayName) => request(objectPath(id, gateway, "/admin"), {
  method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ disabledByAdmin }),
}, gateway);

/** Link of one skill page. The gateway stays in the address, so a link, a reload, and Back keep it. */
export const skillPath = (id: string, gateway?: GatewayName) => `/skills/${encodeURIComponent(id)}${gateway === undefined ? "" : `?gateway=${encodeURIComponent(gateway)}`}`;
export const skillsPath = (gateway?: GatewayName) => `/skills${gateway === undefined ? "" : `?gateway=${encodeURIComponent(gateway)}`}`;
