import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSurfaceIdentityProvider } from "@yoplai/shared";
import { createSurfaceLinkService } from "./surface-links.js";

describe("surface account linking", () => {
  let dataDir: string;
  let db: Database.Database;
  let service: ReturnType<typeof createSurfaceLinkService>;
  let unregister: () => void;
  const lookup = vi.fn();
  const identity = { surface: "threadit" as const, scope: "https://board.example.test/", externalId: "17", username: "alice" };
  const user = { id: "alice", email: " Alice@Example.test " };
  const tokenFrom = (url: string) => new URL(url).pathname.split("/").at(-1)!;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-surface-links-"));
    db = new Database(path.join(dataDir, "auth.db"));
    db.pragma("foreign_keys = ON");
    db.exec("CREATE TABLE user (id TEXT PRIMARY KEY); INSERT INTO user VALUES ('alice'), ('bob')");
    lookup.mockReset().mockResolvedValue({ username: "alice", email: "alice@example.test", isAgent: false });
    unregister = registerSurfaceIdentityProvider({ ...identity, lookup });
    service = createSurfaceLinkService(db, "https://gateway.example.test");
  });
  afterEach(async () => {
    vi.useRealTimers();
    unregister();
    db.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it("links a matching account once and persists its normalized scope across restart", async () => {
    const link = await service.issue(identity);
    expect(link).toMatch(/^https:\/\/gateway.example.test\/api\/surface-links\/pair\/[\w-]{43}$/);
    const token = tokenFrom(link);
    expect(service.inspect(token)).toEqual({ ...identity, scope: "https://board.example.test" });
    await service.redeem(token, user);
    expect(service.resolve("threadit", "https://BOARD.example.test///", "17")).toBe("alice");
    expect(service.list("alice")).toEqual([{ ...identity, scope: "https://board.example.test", id: expect.any(String), linkedAt: expect.any(Number) }]);
    service = createSurfaceLinkService(db, "https://gateway.example.test");
    expect(service.resolve("threadit", identity.scope, "17")).toBe("alice");
    await expect(service.redeem(token, user)).rejects.toThrow("already been used");
  });
  it("checks fresh surface email and leaves a mismatched token redeemable", async () => {
    const token = tokenFrom(await service.issue(identity));
    lookup.mockResolvedValue({ username: "alice-renamed", email: "bob@example.test", isAgent: false });
    await expect(service.redeem(token, user)).rejects.toThrow("another Threadit account");
    expect(service.resolve("threadit", identity.scope, "17")).toBeUndefined();
    lookup.mockResolvedValue({ username: "alice-renamed", email: "alice@example.test", isAgent: false });
    await service.redeem(token, user);
    expect(service.list("alice")[0]?.username).toBe("alice-renamed");
  });
  it.each([
    { username: "alice", email: undefined, isAgent: false },
    { username: "alice", email: "   ", isAgent: false },
    { username: "bot", email: "alice@example.test", isAgent: true },
  ])("refuses unavailable email and agent accounts without consuming the link: %j", async (account) => {
    const token = tokenFrom(await service.issue(identity));
    lookup.mockResolvedValue(account);
    await expect(service.redeem(token, user)).rejects.toThrow(/unavailable|agent accounts/);
    expect(service.resolve("threadit", identity.scope, "17")).toBeUndefined();
    lookup.mockResolvedValue({ username: "alice", email: "alice@example.test", isAgent: false });
    await service.redeem(token, user);
    expect(service.resolve("threadit", identity.scope, "17")).toBe("alice");
  });
  it("bounds a hung lookup to five seconds and allows the token to be retried", async () => {
    vi.useFakeTimers();
    const token = tokenFrom(await service.issue(identity));
    lookup.mockImplementation(() => new Promise(() => {}));
    const pending = service.redeem(token, user).then(() => "linked", (error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await Promise.race([pending, Promise.resolve("still waiting")])).toContain("unavailable");
    expect(service.resolve("threadit", identity.scope, "17")).toBeUndefined();
    lookup.mockResolvedValue({ username: "alice", email: "alice@example.test", isAgent: false });
    await service.redeem(token, user);
    expect(service.resolve("threadit", identity.scope, "17")).toBe("alice");
  });
  it("expires a link after ten minutes", async () => {
    vi.useFakeTimers();
    const token = tokenFrom(await service.issue(identity));
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(() => service.inspect(token)).toThrow("expired");
    await expect(service.redeem(token, user)).rejects.toThrow("expired");
    expect(service.resolve("threadit", identity.scope, "17")).toBeUndefined();
  });
  it("replaces a prior owner when the same surface account links again", async () => {
    await service.redeem(tokenFrom(await service.issue(identity)), user);
    const originalId = service.list("alice")[0]!.id;
    lookup.mockResolvedValue({ username: "alice", email: "bob@example.test", isAgent: false });
    await service.redeem(tokenFrom(await service.issue(identity)), { id: "bob", email: "bob@example.test" });
    expect(service.resolve("threadit", identity.scope, "17")).toBe("bob");
    expect(service.list("alice")).toEqual([]);
    expect(service.list("bob")).toMatchObject([{ id: originalId, externalId: "17" }]);
  });
  it("keeps two surfaces, two board scopes and several accounts distinct", async () => {
    const otherBoard = { ...identity, scope: "https://other-board.example.test" };
    const mattermost = { ...identity, surface: "mattermost" as const };
    const removeBoard = registerSurfaceIdentityProvider({ ...otherBoard, lookup });
    const removeMattermost = registerSurfaceIdentityProvider({ ...mattermost, lookup });
    try {
      for (const account of [identity, otherBoard, mattermost, { ...identity, externalId: "18" }]) {
        await service.redeem(tokenFrom(await service.issue(account)), user);
      }
      expect(service.list("alice")).toHaveLength(4);
      expect(service.resolve("threadit", otherBoard.scope, "17")).toBe("alice");
      expect(service.resolve("mattermost", identity.scope, "17")).toBe("alice");
      const boardLink = service.list("alice").find((link) => link.scope === otherBoard.scope)!;
      service.unlink("bob", boardLink.id);
      expect(service.resolve("threadit", otherBoard.scope, "17")).toBe("alice");
      service.unlink("alice", boardLink.id);
      expect(service.resolve("threadit", otherBoard.scope, "17")).toBeUndefined();
      expect(service.resolve("threadit", identity.scope, "17")).toBe("alice");
    } finally {
      removeBoard();
      removeMattermost();
    }
  });
  it("consumes a token once under concurrent redemption", async () => {
    const token = tokenFrom(await service.issue(identity));
    const results = await Promise.allSettled([service.redeem(token, user), service.redeem(token, user)]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(service.list("alice")).toHaveLength(1);
  });
  it("removes a deleted gateway user's links and keeps their consumed token unusable", async () => {
    const token = tokenFrom(await service.issue(identity));
    await service.redeem(token, user);
    db.prepare("DELETE FROM user WHERE id = ?").run("alice");
    expect(service.list("alice")).toEqual([]);
    expect(service.resolve("threadit", identity.scope, "17")).toBeUndefined();
    expect(() => service.inspect(token)).toThrow("expired or already been used");
  });
  it("keeps the board available when another agent's provider stops", async () => {
    const token = tokenFrom(await service.issue(identity));
    const stopOtherAgent = registerSurfaceIdentityProvider({ ...identity, lookup });
    stopOtherAgent();
    await service.redeem(token, user);
    expect(service.resolve("threadit", identity.scope, "17")).toBe("alice");
  });
});
