import { createSignal } from "solid-js";
import { capabilities } from "./capabilities";

const [revision, setRevision] = createSignal(0);
const [visible, setVisible] = createSignal(document.visibilityState === "visible");
const inMemory = new Map<string, number>();
const seenKey = (agentId: string, threadId?: string) =>
  "yoplai:durable-seen:" + JSON.stringify([capabilities.user?.id ?? "local", agentId, threadId]);

export function durableUnread(agentId: string, timestamp: number, threadId?: string) {
  revision();
  const key = seenKey(agentId, threadId);
  let seen = inMemory.get(key) ?? 0;
  try { seen = Math.max(seen, Number(localStorage.getItem(key)) || 0); } catch { /* Storage is optional. */ }
  return timestamp > seen;
}

export function markDurableSeen(agentId: string, timestamp: number, threadId?: string) {
  if (!visible() || !durableUnread(agentId, timestamp, threadId)) return;
  const key = seenKey(agentId, threadId);
  inMemory.set(key, timestamp);
  try { localStorage.setItem(key, String(timestamp)); } catch { /* Storage is optional. */ }
  setRevision((value) => value + 1);
}

window.addEventListener("storage", (event) => {
  if (!event.key || event.key.startsWith("yoplai:durable-seen:")) setRevision((value) => value + 1);
});

document.addEventListener("visibilitychange", () => setVisible(document.visibilityState === "visible"));
