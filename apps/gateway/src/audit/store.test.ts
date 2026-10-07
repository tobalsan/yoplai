import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsAuditStore } from "./store.js";
import { diffSettings } from "./diff.js";

const homes: string[] = [];
const stores: SettingsAuditStore[] = [];
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "audit-test-"));
  homes.push(home);
  const filename = path.join(home, "audit.db");
  const store = new SettingsAuditStore(filename);
  stores.push(store);
  return { store, filename };
}
afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
  homes.splice(0).forEach((home) => fs.rmSync(home, { recursive: true, force: true }));
  vi.restoreAllMocks();
});
const entry = { action: "extension.update", targetType: "extension", targetId: "crm", agentId: "sales", scope: "team" as const, actorUserId: "alice", actorEmail: "alice@test.invalid", changes: [{ field: "region", before: "eu", after: "us" }] };

describe("settings audit", () => {
  it("opens on first effective write, redacts secrets and persists across reopen", () => {
    const { store, filename } = fixture();
    expect(store.list()).toEqual({ entries: [], nextCursor: null });
    store.record({ ...entry, changes: [] });
    expect(fs.existsSync(filename)).toBe(false);
    store.record({ ...entry, impersonatorUserId: "admin", changes: [...entry.changes, { field: "apiKey", secret: "set", before: "old-sensitive-secret", after: "submitted-sensitive-secret" }] });
    store.close();
    expect(fs.readFileSync(filename).includes(Buffer.from("submitted-sensitive-secret"))).toBe(false);
    expect(fs.readFileSync(filename).includes(Buffer.from("old-sensitive-secret"))).toBe(false);
    expect(store.list().entries[0]).toMatchObject({ ...entry, impersonatorUserId: "admin", changes: [...entry.changes, { field: "apiKey", secret: "set" }] });
  });
  it("filters, paginates ties without duplicates, and caps the limit", () => {
    const { store } = fixture();
    vi.spyOn(Date.prototype, "toISOString").mockReturnValue("2026-10-07T12:00:00.000Z");
    for (let i = 0; i < 502; i++) store.record(entry);
    store.record({ ...entry, actorUserId: "bob", agentId: "support", action: "oauth.connect" });
    const first = store.list({ agentId: "sales", actorUserId: "alice", action: "extension.update", since: "2026-10-07", until: "2026-10-08", limit: 999 });
    expect(first.entries).toHaveLength(500);
    const second = store.list({ agentId: "sales", cursor: first.nextCursor!, limit: 500 });
    expect(second.entries).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.entries, ...second.entries].map((row) => row.id)).size).toBe(502);
    expect(() => store.list({ cursor: "missing" })).toThrow("Invalid audit cursor");
  });
  it("warns and does not throw when the database rejects an insert", () => {
    const { store, filename } = fixture();
    store.record(entry);
    const db = new Database(filename);
    db.exec("CREATE TRIGGER reject_audit BEFORE INSERT ON settings_audit BEGIN SELECT RAISE(FAIL, 'read-only'); END");
    db.close();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => store.record(entry)).not.toThrow();
    expect(warn).toHaveBeenCalledWith("[audit] Failed to record settings change");
    expect(store.list().entries).toHaveLength(1);
  });
});

describe("settings diff", () => {
  it("compares nested values and records removals without secret values", () => {
    expect(diffSettings({ same: { a: [1] }, region: "eu", apiKey: "old", password: "old" }, { same: { a: [1] }, region: "us", apiKey: "new" }, ["apiKey", "password"]))
      .toEqual([{ field: "region", before: "eu", after: "us" }, { field: "apiKey", secret: "set" }, { field: "password", secret: "removed" }]);
    expect(diffSettings({ apiKey: "same", enabled: true }, { apiKey: "same", enabled: true }, ["apiKey"])).toEqual([]);
  });
});
