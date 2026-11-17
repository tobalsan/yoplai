import { createHash, randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { getSurfaceIdentityProvider, normalizeSurfaceScope, type SurfaceLinkIdentity, type SurfaceLinkService, type SurfaceLink, type SurfaceIdentity } from "@yoplai/shared";

type TokenRow = {
  hash: string; surface: SurfaceLinkIdentity["surface"]; scope: string;
  external_id: string; username: string; expires_at: number; consumed_at: number | null;
};
export class SurfaceLinkError extends Error {}
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const invalidLink = () => new SurfaceLinkError("This pairing link has expired or already been used. Request a new link with !pair.");

export function createSurfaceLinkService(db: Database.Database, baseUrl: string): SurfaceLinkService {
  db.exec(`
    CREATE TABLE IF NOT EXISTS surface_links (
      id TEXT PRIMARY KEY, surface TEXT NOT NULL, scope TEXT NOT NULL,
      external_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      username TEXT NOT NULL, linked_at INTEGER NOT NULL,
      UNIQUE (surface, scope, external_id)
    );
    CREATE TABLE IF NOT EXISTS surface_link_tokens (
      hash TEXT PRIMARY KEY, surface TEXT NOT NULL, scope TEXT NOT NULL,
      external_id TEXT NOT NULL, username TEXT NOT NULL, expires_at INTEGER NOT NULL,
      consumed_at INTEGER, user_id TEXT REFERENCES user(id) ON DELETE CASCADE
    );
  `);
  const getToken = (token: string): TokenRow => {
    const row = db.prepare("SELECT * FROM surface_link_tokens WHERE hash = ?").get(hashToken(token)) as TokenRow | undefined;
    if (!row || row.consumed_at !== null || row.expires_at <= Date.now()) throw invalidLink();
    return row;
  };
  return {
    baseUrl,
    async issue(identity) {
      const token = randomBytes(32).toString("base64url");
      db.prepare("DELETE FROM surface_link_tokens WHERE expires_at <= ?").run(Date.now());
      db.prepare("INSERT INTO surface_link_tokens (hash, surface, scope, external_id, username, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(hashToken(token), identity.surface, normalizeSurfaceScope(identity.scope), identity.externalId, identity.username, Date.now() + 10 * 60 * 1000);
      return new URL(`/api/surface-links/pair/${token}`, baseUrl).href;
    },
    inspect(token) {
      const row = getToken(token);
      return { surface: row.surface, scope: row.scope, externalId: row.external_id, username: row.username };
    },
    async redeem(token, user) {
      const row = getToken(token);
      const provider = getSurfaceIdentityProvider(row.surface, row.scope);
      if (!provider) throw new SurfaceLinkError("Surface identity is unavailable. Request a new link with !pair.");
      let timer: ReturnType<typeof setTimeout> | undefined;
      let account: SurfaceIdentity;
      try {
        account = await Promise.race([
          provider.lookup(row.external_id),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("Identity lookup timed out")), 5000);
          }),
        ]);
      } catch {
        throw new SurfaceLinkError("Surface identity is unavailable. Please try again.");
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (account.isAgent) throw new SurfaceLinkError("Cannot link agent accounts.");
      if (!account.email?.trim() || !user.email.trim()) throw new SurfaceLinkError("Surface email is unavailable. Please try again.");
      if (account.email?.trim().toLowerCase() !== user.email.trim().toLowerCase()) {
        const surface = row.surface === "threadit" ? "Threadit" : "Mattermost";
        throw new SurfaceLinkError(`This link was created for another ${surface} account.`);
      }
      db.transaction(() => {
        const now = Date.now();
        const consumed = db.prepare("UPDATE surface_link_tokens SET consumed_at = ?, user_id = ? WHERE hash = ? AND consumed_at IS NULL AND expires_at > ?")
          .run(now, user.id, row.hash, now);
        if (consumed.changes !== 1) throw invalidLink();
        db.prepare(`INSERT INTO surface_links (id, surface, scope, external_id, user_id, username, linked_at)
          VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (surface, scope, external_id)
          DO UPDATE SET user_id = excluded.user_id, username = excluded.username, linked_at = excluded.linked_at`)
          .run(randomUUID(), row.surface, row.scope, row.external_id, user.id, account.username, now);
      })();
    },
    resolve(surface, scope, externalId) {
      return (db.prepare("SELECT user_id FROM surface_links WHERE surface = ? AND scope = ? AND external_id = ?")
        .get(surface, normalizeSurfaceScope(scope), externalId) as { user_id: string } | undefined)?.user_id;
    },
    list(userId) {
      return db.prepare("SELECT id, surface, scope, external_id AS externalId, username, linked_at AS linkedAt FROM surface_links WHERE user_id = ? ORDER BY linked_at DESC, id")
        .all(userId) as SurfaceLink[];
    },
    unlink(userId, linkId) {
      db.prepare("DELETE FROM surface_links WHERE user_id = ? AND id = ?").run(userId, linkId);
    },
  };
}
