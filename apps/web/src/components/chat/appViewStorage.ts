export type SavedAppViews = {
  tabs: { key: string; frame?: { id: string; title: string } }[];
  active?: string;
};

function storageKey(agentId: string, sessionId: string) {
  return `yoplai.chat-panel-tabs.v1:${encodeURIComponent(agentId)}:${encodeURIComponent(sessionId)}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function load(agentId: string, sessionId: string): SavedAppViews | undefined {
  try {
    const raw = sessionStorage.getItem(storageKey(agentId, sessionId));
    if (raw === null) return;
    const value: unknown = JSON.parse(raw);
    if (!isObject(value) || !Array.isArray(value.tabs) || (value.active !== undefined && typeof value.active !== "string")) return;
    const tabs: SavedAppViews["tabs"] = [];
    for (const tab of value.tabs) {
      if (!isObject(tab) || typeof tab.key !== "string" || !tab.key) return;
      if (tab.frame !== undefined) {
        if (!isObject(tab.frame) || typeof tab.frame.id !== "string" || !tab.frame.id || typeof tab.frame.title !== "string") return;
        tabs.push({ key: tab.key, frame: { id: tab.frame.id, title: tab.frame.title } });
      } else tabs.push({ key: tab.key });
    }
    return { tabs, ...(value.active !== undefined ? { active: value.active } : {}) };
  } catch {
    return;
  }
}

export function save(agentId: string, sessionId: string, state: SavedAppViews | undefined) {
  try {
    const key = storageKey(agentId, sessionId);
    if (!state?.tabs.length) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(state));
  } catch {
    // Browser storage may be disabled or full; the panel still works in memory.
  }
}
