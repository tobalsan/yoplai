import type { ThinkLevel } from "@yoplai/shared/types";
import type { Model } from "../desktop-setup/api";
import { apiFetch } from "./core";
import { fetchGatewayList, gatewayApiPath, type GatewayName } from "./gateway";

export type ModelChoice = Pick<Model, "provider" | "model">;
type Skill = { id: string; name: string; description: string };
export type ToggleableSkill = Skill & { enabled: boolean };
export type AgentSettings = {
  canEditAgent: boolean;
  canSetPublic?: boolean;
  public?: boolean;
  name: string;
  role?: string;
  description?: string;
  hasCustomAvatar: boolean;
  defaultFace?: number;
  model?: { provider?: string; model: string };
  reasoning?: ThinkLevel | null;
  instructions?: string;
  skills: { global: Skill[]; agent: ToggleableSkill[]; user: ToggleableSkill[] };
};
export type AgentSettingsPatch = {
  name?: string;
  role?: string;
  description?: string;
  model?: ModelChoice;
  reasoning?: ThinkLevel | null;
  instructions?: string;
  avatar?: number;
  public?: boolean;
};
export type ManagementMode = "off" | "superadmin" | "admin" | "anyone";
export type ManagementModeSetting = { mode: ManagementMode; source: "default" | "ui" | "config"; locked: boolean };

async function request<T>(path: string, gateway?: GatewayName, init?: RequestInit): Promise<T> {
  const write = init?.method && init.method !== "GET";
  let response: Response;
  try {
    response = await apiFetch(gatewayApiPath(gateway, path), { signal: AbortSignal.timeout(write ? 40_000 : 8_000), ...init });
  } catch {
    throw new Error("Could not reach the gateway. Try again.");
  }
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) {
    throw new Error(data?.message ?? (response.status === 403 ? "You do not have permission to make this change." : "The request failed. Try again."));
  }
  return data;
}

function body(method: string, data: object, avatar?: File): RequestInit {
  if (!avatar) return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) };
  const form = new FormData();
  form.set("fields", JSON.stringify(data));
  form.set("image", avatar);
  return { method, body: form };
}

export type CreationGateway = { name?: string; label: string };
export async function fetchCreationGateways(): Promise<CreationGateway[]> {
  const signal = AbortSignal.timeout(5_000);
  const canCreate = (name?: string) => request<{ canCreate: boolean }>("/api/agent-management/permissions", name, { signal })
    .then(({ canCreate }) => canCreate === true, () => false);
  const local = canCreate();
  const linked = fetchGatewayList(signal).then(async (list) => {
    if (list.state !== "ready") return [];
    const choices = await Promise.all(list.names.map(async (name) => await canCreate(name) ? [{ name, label: name }] : []));
    return choices.flat();
  }, () => []);
  const [hasLocal, choices] = await Promise.all([local, linked]);
  return [...(hasLocal ? [{ label: "This computer" }] : []), ...choices];
}

export async function fetchAgentModels(gateway?: GatewayName): Promise<Model[]> {
  return (await request<{ models: Model[] }>("/api/agent-management/models", gateway)).models;
}
export function createAgent(
  draft: { name: string; purpose: string; requestId: string; model: ModelChoice; avatar: number },
  gateway?: GatewayName,
  image?: File,
) {
  return request<{ id: string }>("/api/agent-management/agents", gateway, body("POST", draft, image));
}
const settingsPath = (agentId: string) => `/api/agents/${encodeURIComponent(agentId)}/settings`;
export const fetchAgentSettings = (agentId: string, gateway?: GatewayName) => request<AgentSettings>(settingsPath(agentId), gateway);
export const saveAgentSettings = (agentId: string, patch: AgentSettingsPatch, gateway?: GatewayName, avatar?: File) => request(settingsPath(agentId), gateway, body("PATCH", patch, avatar));
export const saveWorkspaceSkills = (agentId: string, disabled: string[], gateway?: GatewayName) => request(`${settingsPath(agentId)}/agent-skills`, gateway, body("PUT", { disabled }));
export const savePersonalSkills = (agentId: string, ids: string[], gateway?: GatewayName) => request(`${settingsPath(agentId)}/user-skills`, gateway, body("PUT", { ids }));
export const fetchManagementMode = () => request<ManagementModeSetting>("/api/admin/agent-management");
export const saveManagementMode = (mode: ManagementMode) => request<ManagementModeSetting>("/api/admin/agent-management", undefined, body("PUT", { mode }));
