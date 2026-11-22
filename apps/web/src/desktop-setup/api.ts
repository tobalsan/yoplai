import type { DesktopSetupState, ModelSource } from "@yoplai/shared/types";
import { apiFetch } from "../api/core";

export class SetupError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

async function setupRequest(path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<Response> {
  const response = await apiFetch(`/api/${path}`, {
    method, signal,
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const reply = await response.json().catch(() => null);
    throw new SetupError(reply?.error ?? "request_failed", reply?.message ?? "The request failed. Try again.");
  }
  return response;
}

export async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  return (await setupRequest(path, method, body)).json();
}

export const readSetup = () => request<DesktopSetupState>("desktop-setup");
export type SetupUpdate = Partial<DesktopSetupState> & { retryOf?: string };
export const saveSetup = (body: SetupUpdate) => request<DesktopSetupState>("desktop-setup", "PUT", body);

export type Model = { provider: string; model: string; name: string; source: ModelSource; credentialType: "oauth" | "api_key"; native?: true; default: boolean; ready: boolean; free: boolean };
export type Attempt = { provider: string; handle: string; state: "waiting-browser" | "waiting-code" | "done" | "failed" | "cancelled"; message?: string };
export type Source = { source: string; detected: boolean; enabled: boolean; denied: boolean; message?: string; path?: string; version?: string; warningRequired?: boolean };
export type Access = { owned: { providerId: string; type: string }[]; external: Source[]; attempts: Attempt[]; apiKeyProviders: { id: string; name: string }[] };
export const readAccess = async (): Promise<Access> => (await setupRequest("model-access", "GET", undefined, AbortSignal.timeout(8_000))).json();
export const signOutProvider = async (provider: string) => {
  await setupRequest(`model-access/${encodeURIComponent(provider)}`, "DELETE", undefined, AbortSignal.timeout(8_000));
};
export const readModels = async () => {
  const response = await setupRequest("model-access/models", "GET", undefined, AbortSignal.timeout(8_000));
  return (await response.json() as { models: Model[] }).models;
};
export const modelKey = (model: Pick<Model, "provider" | "model"> & { source?: ModelSource }) => JSON.stringify([model.source, model.provider, model.model]);
const sourceOrder: ModelSource[] = ["owned", "codex", "claude-code", "opencode", "pi", "environment"];
export function resolveModelChoice(models: Model[], choice: { provider?: string; model: string; source?: ModelSource }, authMode?: "oauth" | "api_key" | "proxy") {
  const matches = models.filter((row) => row.provider === choice.provider && row.model === choice.model);
  if (choice.source) return matches.find((row) => row.source === choice.source);
  for (const source of sourceOrder) {
    const match = matches.find((row) => row.source === source && (authMode === "api_key" ? row.credentialType === "api_key" && !row.native
      : authMode === "oauth" ? row.credentialType === "oauth" : true));
    if (match) return match;
  }
}
export const errorText = (error: unknown) => error instanceof SetupError ? error.message : "The request failed. Try again.";
