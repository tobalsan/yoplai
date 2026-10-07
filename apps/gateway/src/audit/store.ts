import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { Context } from "hono";
import type { SettingsAuditEntry } from "@yoplai/shared";
import { CONFIG_DIR } from "../config/index.js";
import { isExtensionLoaded } from "../extensions/registry.js";

export interface SettingsAuditFilters {
  agentId?: string;
  actorUserId?: string;
  action?: string;
  since?: string;
  until?: string;
  limit?: number;
  cursor?: string;
}

type AuditRow = Omit<SettingsAuditEntry, "changes"> & {
  id: string;
  createdAt: string;
  changes: string;
};

/** Gateway-owned, append-only storage. Opening is deferred until the first write. */
export class SettingsAuditStore {
  private db?: Database.Database;
  constructor(private filename = path.join(CONFIG_DIR, "audit.db")) {}

  private open(): Database.Database {
    if (this.db) return this.db;
    fs.mkdirSync(path.dirname(this.filename), { recursive: true });
    const db = new Database(this.filename);
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS settings_audit (
        id TEXT PRIMARY KEY,
        createdAt TEXT NOT NULL,
        actorUserId TEXT,
        actorEmail TEXT,
        impersonatorUserId TEXT,
        action TEXT NOT NULL,
        agentId TEXT,
        targetType TEXT NOT NULL,
        targetId TEXT,
        scope TEXT,
        changes TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_settings_audit_agent ON settings_audit(agentId, createdAt);
      CREATE INDEX IF NOT EXISTS idx_settings_audit_created ON settings_audit(createdAt);`);
      this.db = db;
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  record(entry: SettingsAuditEntry): void {
    if (!entry.changes.length) return;
    try {
      // A secret marker must never persist an accidentally supplied before/after.
      const changes = entry.changes.map((change) => change.secret
        ? { field: change.field, secret: change.secret }
        : change);
      this.open().prepare(`INSERT INTO settings_audit
        (id, createdAt, actorUserId, actorEmail, impersonatorUserId, action, agentId, targetType, targetId, scope, changes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(randomUUID(), new Date().toISOString(), entry.actorUserId ?? null,
          entry.actorEmail ?? null, entry.impersonatorUserId ?? null, entry.action,
          entry.agentId ?? null, entry.targetType, entry.targetId ?? null,
          entry.scope ?? null, JSON.stringify(changes));
    } catch {
      // Do not include payloads or database error strings, which may contain secrets.
      console.warn("[audit] Failed to record settings change");
    }
  }

  list(filters: SettingsAuditFilters = {}) {
    if (!this.db && !fs.existsSync(this.filename)) return { entries: [], nextCursor: null };
    const db = this.open();
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    for (const field of ["agentId", "actorUserId", "action"] as const) {
      if (filters[field] !== undefined) { clauses.push(`${field} = ?`); params.push(filters[field]); }
    }
    if (filters.since) { clauses.push("createdAt >= ?"); params.push(filters.since); }
    if (filters.until) { clauses.push("createdAt <= ?"); params.push(filters.until); }
    if (filters.cursor) {
      const cursor = db.prepare("SELECT createdAt, id FROM settings_audit WHERE id = ?").get(filters.cursor) as { createdAt: string; id: string } | undefined;
      if (!cursor) throw new Error("Invalid audit cursor");
      clauses.push("(createdAt < ? OR (createdAt = ? AND id < ?))");
      params.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    const limit = Math.min(500, Math.max(1, filters.limit ?? 100));
    params.push(limit + 1);
    const rows = db.prepare(`SELECT * FROM settings_audit ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY createdAt DESC, id DESC LIMIT ?`).all(...params) as AuditRow[];
    const entries = rows.slice(0, limit).map((row) => ({ ...row, changes: JSON.parse(row.changes) as SettingsAuditEntry["changes"] }));
    return { entries, nextCursor: rows.length > limit ? entries[entries.length - 1].id : null };
  }

  close(): void { this.db?.close(); this.db = undefined; }
}

const store = new SettingsAuditStore();
export const recordSettingsChange = (entry: SettingsAuditEntry): void => store.record(entry);
export const listSettingsChanges = (filters: SettingsAuditFilters = {}) => store.list(filters);

export async function getAuditActor(c: Context): Promise<Pick<SettingsAuditEntry, "actorUserId" | "actorEmail" | "impersonatorUserId">> {
  if (!isExtensionLoaded("multiUser")) return {};
  const { getForwardedAuthContext } = await import("@yoplai/extension-multi-user");
  const auth = (c.get("multiUserAuthContext") as import("@yoplai/extension-multi-user").RequestAuthContext | undefined) ?? getForwardedAuthContext(c.req.raw.headers);
  return auth ? { actorUserId: auth.user.id, actorEmail: auth.user.email, impersonatorUserId: auth.impersonator?.id } : {};
}
