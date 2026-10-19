import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { ImportTokenStore } from "./import-tokens.js";

it("issues single-display hashed tokens scoped to one owner, expiring in 24 hours and revocable", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "skill-token-"));
  let now = 1000;
  try {
    const store = new ImportTokenStore(home, { now: () => now });
    const created = await store.create("alice");
    expect(created.expiresAt).toBe(86401000);
    expect(await store.authenticate(created.token)).toBe("alice");
    expect((await fs.readFile(path.join(home, "skill-library/import-tokens.json"), "utf8")).includes(created.token)).toBe(false);
    expect(await new ImportTokenStore(home, { now: () => now }).authenticate(created.token)).toBe("alice");
    expect(await store.list("bob")).toEqual([]);
    expect(await store.list("alice")).toEqual([{ id: created.id, createdAt: 1000, expiresAt: 86401000 }]);
    expect(await store.revoke("bob", created.id)).toBe(false);
    expect(await store.authenticate(created.token)).toBe("alice");
    expect(await store.revoke("alice", created.id)).toBe(true);
    expect(await store.authenticate(created.token)).toBeNull();
    const expiring = await store.create("alice");
    now = 86401000;
    expect(await store.authenticate(expiring.token)).toBeNull();
    expect(await store.list("alice")).toEqual([]);
    expect(await store.authenticate("not-a-token")).toBeNull();
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});
