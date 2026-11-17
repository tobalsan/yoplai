import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChatShareStore } from "./store.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })));
});

describe("chat share persistence", () => {
  it("retains distinct links across store instances", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-chat-shares-"));
    homes.push(home);
    const file = path.join(home, "chat-shares.json");
    const store = new ChatShareStore(file);
    const first = await store.create("alice", "sales", "chat-one");
    const second = await store.create("alice", "sales", "chat-two");
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(second.token).not.toBe(first.token);
    const reopened = new ChatShareStore(file);
    expect(await reopened.getByToken(first.token)).toMatchObject({
      ownerUserId: "alice", agentId: "sales", sessionId: "chat-one",
    });
    expect(await reopened.findBySession("alice", "sales", "chat-two")).toMatchObject({ token: second.token });
  });
});
