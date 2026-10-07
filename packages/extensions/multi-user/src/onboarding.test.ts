import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { ensureUserOnboardingTable } from "./db.js";
import { createOnboardingStore } from "./onboarding.js";

describe("onboarding store", () => {
  it("persists, overwrites and clears per-user status", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE user (id TEXT PRIMARY KEY)");
    db.exec("INSERT INTO user (id) VALUES ('a'), ('b')");
    ensureUserOnboardingTable(db);
    const store = createOnboardingStore(db);
    expect(store.get("a")).toEqual({ status: null, at: null });
    expect(store.set("a", "skipped").status).toBe("skipped");
    expect(store.set("a", "done").status).toBe("done");
    expect(store.get("a").at).toBeTruthy();
    expect(store.get("b").status).toBeNull();
    expect(store.clear("a")).toEqual({ status: null, at: null });
    db.close();
  });
});
