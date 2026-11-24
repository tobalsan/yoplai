import { API_BASE, apiFetch } from "./core";

type DurableMode = { enabled: boolean };
let pendingSave: Promise<void> | undefined;

async function requestDurableMode(enabled?: boolean): Promise<DurableMode> {
  const response = await apiFetch(`${API_BASE}/me/durable-mode`, {
    signal: AbortSignal.timeout(15_000),
    ...(enabled === undefined ? {} : {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    }),
  });
  if (!response.ok) throw new Error("Durable mode request failed");
  return response.json();
}

export function getDurableMode() {
  return requestDurableMode();
}

export function saveDurableMode(enabled: boolean) {
  const request = requestDurableMode(enabled);
  const settled = request.then(() => {}, () => {});
  pendingSave = settled;
  void settled.then(() => {
    if (pendingSave === settled) pendingSave = undefined;
  });
  return request;
}

export function pendingDurableModeSave() {
  return pendingSave;
}
