import { createEffect, createSignal } from "solid-js";
import { capabilities } from "../lib/capabilities";
import { API_BASE, apiFetch } from "./core";

type DurableMode = { enabled: boolean };
const account = () => capabilities.multiUser ? capabilities.user?.id : "local";
const [mode, setMode] = createSignal<{ owner: string; data: DurableMode }>();
const [durableModeVersion, setDurableModeVersion] = createSignal(0);
let pendingRead: { owner: string; request: Promise<DurableMode> } | undefined;
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
  const data: DurableMode = await response.json();
  return { enabled: data?.enabled === true };
}

export function getDurableMode(): Promise<DurableMode> {
  const owner = account();
  if (!owner) return requestDurableMode();
  const cached = mode();
  if (cached?.owner === owner) return Promise.resolve(cached.data);
  if (pendingRead?.owner === owner) return pendingRead.request;
  const version = durableModeVersion();
  const request = requestDurableMode().then((data) => {
    if (owner === account() && version === durableModeVersion()) setMode({ owner, data });
    return data;
  }).finally(() => {
    if (pendingRead?.request === request) pendingRead = undefined;
  });
  pendingRead = { owner, request };
  return request;
}

export function useDurableMode() {
  createEffect(() => {
    if (account()) void getDurableMode().catch(() => undefined);
  });
  return () => {
    const result = mode();
    return result?.owner === account() && result?.data.enabled === true;
  };
}

export function saveDurableMode(enabled: boolean) {
  const owner = account();
  const request = requestDurableMode(enabled).then((data) => {
    if (owner && owner === account()) {
      setMode({ owner, data });
      setDurableModeVersion((version) => version + 1);
    }
    return data;
  });
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

export { durableModeVersion };
