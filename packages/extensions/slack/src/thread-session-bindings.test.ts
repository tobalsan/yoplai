import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSlackThreadSessionBindingStore,
  type SlackThreadSessionBindingStore,
} from "./index.js";

describe("Slack thread session bindings", () => {
  let dataDir: string;
  let store: SlackThreadSessionBindingStore;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-slack-bindings-"));
    store = createSlackThreadSessionBindingStore(dataDir);
  });

  afterEach(async () => {
    store.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it("round-trips bindings and persists them across store instances", () => {
    const created = store.setBinding({
      channelId: "channel-1",
      threadTs: "123.456",
      sessionId: "session-1",
      agentId: "agent-1",
    });

    expect(store.getBinding("channel-1", "123.456")).toEqual(created);
    expect(store.getBinding("channel-1", "missing")).toBeUndefined();

    store.close();
    store = createSlackThreadSessionBindingStore(dataDir);

    expect(store.getBinding("channel-1", "123.456", "agent-1")).toEqual(created);
  });

  it("keeps bindings separate for agents in the same Slack thread", () => {
    const first = store.setBinding({
      channelId: "channel-1",
      threadTs: "123.456",
      sessionId: "session-1",
      agentId: "agent-1",
    });
    const second = store.setBinding({
      channelId: "channel-1",
      threadTs: "123.456",
      sessionId: "session-2",
      agentId: "agent-2",
    });

    expect(store.getBinding("channel-1", "123.456", "agent-1")).toEqual(first);
    expect(store.getBinding("channel-1", "123.456", "agent-2")).toEqual(second);
  });

  it("deletes an agent-scoped binding", () => {
    store.setBinding({
      channelId: "channel-1",
      threadTs: "123.456",
      sessionId: "session-1",
      agentId: "agent-1",
    });

    expect(store.deleteBinding("channel-1", "123.456", "agent-1")).toBe(true);
    expect(store.getBinding("channel-1", "123.456", "agent-1")).toBeUndefined();
    expect(store.deleteBinding("channel-1", "123.456", "agent-1")).toBe(false);
  });
});
