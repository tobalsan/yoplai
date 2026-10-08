import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createConnectPromptStore } from "./connect-prompt.js";
import { ensureUserAgentConnectPromptTable } from "./db.js";

describe("connect prompt store", () => {
  it("tracks seen per user and agent", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec("CREATE TABLE user (id TEXT PRIMARY KEY)");
    db.exec("INSERT INTO user (id) VALUES ('a'), ('b')");
    ensureUserAgentConnectPromptTable(db);
    const store = createConnectPromptStore(db);
    expect(store.get("a", "x")).toEqual({ seen: false, at: null });
    const marked = store.markSeen("a", "x");
    expect(marked.seen).toBe(true);
    expect(marked.at).toBeTruthy();
    expect(store.markSeen("a", "x").seen).toBe(true);
    expect(store.get("a", "y").seen).toBe(false);
    expect(store.get("b", "x").seen).toBe(false);
    expect(store.clear("a", "x")).toEqual({ seen: false, at: null });
    db.exec("DELETE FROM user WHERE id = 'a'");
    store.markSeen("b", "x");
    db.exec("DELETE FROM user WHERE id = 'b'");
    expect(store.get("b", "x").seen).toBe(false);
    db.close();
  });
});
