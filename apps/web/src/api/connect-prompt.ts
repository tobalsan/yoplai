import { API_BASE, apiFetch as fetch } from "./core";

export type ConnectPromptState = {
  supported: boolean;
  seen: boolean;
  at: string | null;
};

async function parse(res: Response): Promise<ConnectPromptState> {
  if (!res.ok) throw new Error(`connect prompt request failed: ${res.status}`);
  return res.json() as Promise<ConnectPromptState>;
}

const url = (agentId: string) => `${API_BASE}/me/connect-prompt/${encodeURIComponent(agentId)}`;

export async function fetchConnectPrompt(agentId: string): Promise<ConnectPromptState> {
  return parse(await fetch(url(agentId)));
}

export async function markConnectPromptSeen(agentId: string): Promise<ConnectPromptState> {
  return parse(await fetch(url(agentId), { method: "PUT" }));
}

export async function clearConnectPrompt(agentId: string): Promise<ConnectPromptState> {
  return parse(await fetch(url(agentId), { method: "DELETE" }));
}
