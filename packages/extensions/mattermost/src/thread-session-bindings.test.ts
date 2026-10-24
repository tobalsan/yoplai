import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ThreadSessionBindingStore,
  withThreadBindings,
} from "./thread-session-bindings.js";

describe("Mattermost thread session bindings", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "yoplai-mattermost-bindings-")
    );
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("round-trips a binding and survives reopening the store", () => {
    const created = withThreadBindings(dir, (store) =>
      store.setBinding({
        channelId: "c1",
        rootId: "r1",
        agentId: "a1",
        sessionId: "s1",
        source: "inbound",
      })
    );
    const store = new ThreadSessionBindingStore(dir);
    try {
      expect(store.getBinding("r1", "a1")).toEqual(created);
      expect(store.getBinding("r1", "a2")).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("uses its own database file, apart from Discord and Slack", async () => {
    withThreadBindings(dir, () => undefined);
    expect(await fs.readdir(dir)).toEqual(["mattermost-thread-sessions.db"]);
  });

  it("keeps one session per agent and thread, replacing on rebind", () => {
    withThreadBindings(dir, (store) => {
      store.setBinding({
        channelId: "c1",
        rootId: "r1",
        agentId: "a1",
        sessionId: "s1",
        source: "agent",
      });
      store.setBinding({
        channelId: "c1",
        rootId: "r1",
        agentId: "a2",
        sessionId: "s2",
        source: "inbound",
      });
      store.setBinding({
        channelId: "c1",
        rootId: "r1",
        agentId: "a1",
        sessionId: "s3",
        source: "agent",
      });
      expect(store.getBinding("r1", "a1")?.sessionId).toBe("s3");
      expect(store.getBinding("r1", "a2")?.sessionId).toBe("s2");
      store.deleteBinding("r1", "a1");
      expect(store.getBinding("r1", "a1")).toBeUndefined();
    });
  });
});
