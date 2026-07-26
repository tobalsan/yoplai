import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createThreadSessionBindingStore,
  type ThreadSessionBindingStore,
} from "./thread-session-bindings.js";

describe("thread session bindings", () => {
  let dir: string;
  let store: ThreadSessionBindingStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-discord-bindings-"));
    store = createThreadSessionBindingStore(dir);
  });

  afterEach(async () => {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("round-trips a thread session binding", () => {
    const created = store.setBinding({
      threadId: "thread-1",
      sessionId: "session-1",
      agentId: "agent-1",
      channelId: "channel-1",
    });

    expect(store.getBinding("thread-1")).toEqual(created);
    expect(created.createdAt).toEqual(expect.any(Number));
    expect(store.getBinding("missing")).toBeUndefined();
  });

  it("stores one session per agent in a Discord thread", () => {
    const first = store.setBinding({
      threadId: "thread-1",
      sessionId: "session-1",
      agentId: "agent-1",
      channelId: "channel-1",
    });
    const second = store.setBinding({
      threadId: "thread-1",
      sessionId: "session-2",
      agentId: "agent-2",
      channelId: "channel-1",
    });

    expect(store.getBinding("thread-1", "agent-1")).toEqual(first);
    expect(store.getBinding("thread-1", "agent-2")).toEqual(second);
    expect(store.getBindings("thread-1")).toEqual([first, second]);
  });

  it("enforces one session per agent in a Discord thread", () => {
    store.setBinding({
      threadId: "thread-1",
      sessionId: "session-1",
      agentId: "agent-1",
      channelId: "channel-1",
    });

    expect(() =>
      store.setBinding({
        threadId: "thread-1",
        sessionId: "session-2",
        agentId: "agent-1",
        channelId: "channel-2",
      })
    ).toThrow(/UNIQUE constraint failed/);

    expect(store.getBinding("thread-1")?.sessionId).toBe("session-1");
  });
});
