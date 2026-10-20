import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { getEligibleAccount } from "@yoplai/extension-multi-user";
import { SkillAccessPolicy } from "./access.js";
import type { SkillRow } from "./types.js";

it("grants content writes without management and rechecks both viewer and owner eligibility", async () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE user (id TEXT PRIMARY KEY, email TEXT, approved INTEGER, role TEXT, banned INTEGER)");
    const insert = db.prepare("INSERT INTO user VALUES (?, ?, ?, ?, ?)");
    for (const id of ["owner", "reader", "writer", "other"]) insert.run(id, `${id}@example.com`, 1, "user", 0);
    insert.run("root", "root@example.com", 0, "superadmin", 0);
    insert.run("admin", "admin@example.com", 0, "admin", 0);
    insert.run("banned", "banned@example.com", 1, "user", 1);
    const row: SkillRow = { id: "s1", name: "sample", description: "Sample", ownerId: "owner", shares: [{ kind: "user", id: "reader", mode: "read" }, { kind: "user", id: "writer", mode: "write" }], createdAt: 1, updatedAt: 1, disabledByAdmin: false };
    const policy = new SkillAccessPolicy({ multiUser: true, getEligibleAccount: (id) => getEligibleAccount(db, id) });
    expect(await policy.permissions(row, { userId: "owner" })).toEqual({ canRead: true, canWrite: true, canManage: true });
    expect(await policy.permissions(row, { userId: "reader" })).toEqual({ canRead: true, canWrite: false, canManage: false });
    expect(await policy.permissions(row, { userId: "writer" })).toEqual({ canRead: true, canWrite: true, canManage: false });
    expect(await policy.permissions(row, { userId: "root" })).toEqual({ canRead: true, canWrite: false, canManage: false });
    expect(await policy.canRead(row, { userId: "admin" })).toBe(false);
    expect(await policy.canRead(row, { userId: "other" })).toBe(false);
    row.shares.push({ kind: "all", mode: "read" });
    expect(await policy.canRead(row, { userId: "admin" })).toBe(true);
    expect(await policy.canRead(row, { userId: "banned" })).toBe(false);
    expect(await policy.canRead(row, { userId: "missing" })).toBe(false);
    db.prepare("UPDATE user SET banned = 1 WHERE id = 'writer'").run();
    expect(await policy.canWrite(row, { userId: "writer" })).toBe(false);
    db.prepare("DELETE FROM user WHERE id = 'owner'").run();
    expect(await policy.filterVisible([row], { userId: "reader" })).toEqual([]);
  } finally { db.close(); }
});
