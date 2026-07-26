// The project was renamed aihub -> yoplai. Persisted browser state still lives
// under the legacy `aihub`-prefixed keys for anyone upgrading, so every read of
// a renamed key goes through here: new key wins, otherwise the legacy value is
// adopted once and rewritten under the new key.
function legacyKey(key: string): string | null {
  if (!key.startsWith("yoplai")) return null;
  return `aihub${key.slice("yoplai".length)}`;
}

export function readMigratedLocal(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    const current = localStorage.getItem(key);
    if (current !== null) return current;
    const legacy = legacyKey(key);
    if (!legacy) return null;
    const value = localStorage.getItem(legacy);
    if (value === null) return null;
    try {
      localStorage.setItem(key, value);
      localStorage.removeItem(legacy);
    } catch {
      // Leave the legacy value in place so the next read retries the migration.
    }
    return value;
  } catch {
    return null;
  }
}
