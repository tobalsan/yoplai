import { API_BASE, apiFetch as fetch } from "./core";

export type DeviceMode = "ask" | "workspace" | "full";

export type DeviceLink = { name: string; connected: boolean };

export type DeviceSettings = {
  workspaceFolder: string | null;
  full: boolean;
  mode: DeviceMode;
};

async function readJson<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body as T;
}

function settingsUrl(agentId: string, sessionId: string): string {
  return `${API_BASE}/relay/device-settings?agentId=${encodeURIComponent(agentId)}&sessionId=${encodeURIComponent(sessionId)}`;
}

function agentSettingsUrl(agentId: string): string {
  return `${API_BASE}/relay/agent-settings?agentId=${encodeURIComponent(agentId)}`;
}

function putJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

export async function fetchDeviceLinks(): Promise<DeviceLink[]> {
  return readJson<DeviceLink[]>(await fetch(`${API_BASE}/relay/device-links`));
}

export async function fetchDeviceSettings(agentId: string, sessionId: string): Promise<DeviceSettings> {
  return readJson<DeviceSettings>(await fetch(settingsUrl(agentId, sessionId)));
}

export async function saveDeviceSettings(
  agentId: string,
  sessionId: string,
  change: { workspaceFolder?: string | null; full?: boolean }
): Promise<DeviceSettings> {
  return readJson<DeviceSettings>(await putJson(settingsUrl(agentId, sessionId), change));
}

export async function fetchFullBackground(agentId: string): Promise<boolean> {
  return (await readJson<{ fullBackground: boolean }>(await fetch(agentSettingsUrl(agentId)))).fullBackground;
}

export async function saveFullBackground(agentId: string, fullBackground: boolean): Promise<boolean> {
  return (await readJson<{ fullBackground: boolean }>(await putJson(agentSettingsUrl(agentId), { fullBackground }))).fullBackground;
}
