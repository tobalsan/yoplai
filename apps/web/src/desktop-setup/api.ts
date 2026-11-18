import type { DesktopSetupState } from "@yoplai/shared/types";
import { apiFetch } from "../api/core";

export class SetupError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await apiFetch(`/api/${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const reply = await response.json().catch(() => null);
    throw new SetupError(reply?.error ?? "request_failed", reply?.message ?? "The request failed. Try again.");
  }
  return response.json();
}

export const readSetup = () => request<DesktopSetupState>("desktop-setup");
export const saveSetup = (body: Partial<DesktopSetupState>) => request<DesktopSetupState>("desktop-setup", "PUT", body);

export type Model = { provider: string; model: string; name: string; source: string; default: boolean; ready: boolean };
export type Attempt = { provider: string; handle: string; state: "waiting-browser" | "waiting-code" | "done" | "failed" | "cancelled"; message?: string };
export type Source = { source: string; detected: boolean; enabled: boolean; denied: boolean; message?: string };
export type Access = { owned: { providerId: string; type: string }[]; external: Source[]; attempts: Attempt[]; apiKeyProviders: { id: string; name: string }[] };
export const readAccess = () => request<Access>("model-access");
export const readModels = async () => (await request<{ models: Model[] }>("model-access/models")).models;
export const modelKey = (model: Model) => JSON.stringify([model.provider, model.model]);
export const errorText = (error: unknown) => error instanceof SetupError ? error.message : "The request failed. Try again.";
