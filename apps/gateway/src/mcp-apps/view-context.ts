type Scope = { agentId: string; sessionId: string; ownerUserId?: string | null };
type ViewContext = { viewKey: string; value: string };
const entries = new Map<string, { scope: string; viewKey: string; value: string; version: number }>();
let version = 0;
const versions = new WeakMap<ReadonlyArray<ViewContext>, ReadonlyArray<{ key: string; version: number }>>();

function scopeKey(scope: Scope): string {
  return JSON.stringify([scope.agentId, scope.sessionId, scope.ownerUserId ?? null]);
}

export function set(scope: Scope, viewKey: string, value: string): void {
  const key = scopeKey(scope);
  const id = JSON.stringify([key, viewKey]);
  entries.delete(id);
  entries.set(id, { scope: key, viewKey, value, version: ++version });
  const sessionEntries = [...entries].filter(([, entry]) => entry.scope === key);
  if (sessionEntries.length > 8) entries.delete(sessionEntries[0][0]);
  if (entries.size > 1000) entries.delete(entries.keys().next().value!);
}

export function snapshot(scope: Scope): ReadonlyArray<ViewContext> {
  const key = scopeKey(scope);
  const selected = [...entries].filter(([, entry]) => entry.scope === key);
  const result = selected.map(([, { viewKey, value }]) => ({ viewKey, value }));
  versions.set(result, selected.map(([key, entry]) => ({ key, version: entry.version })));
  return result;
}

export function consume(captured: ReadonlyArray<ViewContext>): void {
  for (const entry of versions.get(captured) ?? []) {
    if (entries.get(entry.key)?.version === entry.version) entries.delete(entry.key);
  }
}

export function clear(scope: Scope, viewKey: string): void {
  entries.delete(JSON.stringify([scopeKey(scope), viewKey]));
}

export function clearSession(scope: Scope): void {
  const key = scopeKey(scope);
  for (const [id, entry] of entries) if (entry.scope === key) entries.delete(id);
}
