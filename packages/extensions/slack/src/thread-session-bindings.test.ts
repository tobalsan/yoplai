import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
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

  it.each([
    { owner: "user-1", source: "inbound" as const },
    { owner: null, source: "agent" as const },
  ])(
    "persists owner $owner and source $source across store instances",
    ({ owner, source }) => {
      const created = store.setBinding({
        channelId: "channel-1",
        threadTs: "123.456",
        sessionId: "session-1",
        agentId: "agent-1",
        owner,
        source,
      });

      store.close();
      store = createSlackThreadSessionBindingStore(dataDir);

      expect(store.getBinding("channel-1", "123.456", "agent-1")).toEqual(created);
    }
  );

  it("migrates a legacy SQLite database without owner or source columns", () => {
    store.close();
    const db = new Database(path.join(dataDir, "thread-sessions.db"));
    db.exec(`DROP TABLE thread_sessions; CREATE TABLE thread_sessions (
      channel_id TEXT NOT NULL,
      thread_ts TEXT NOT NULL,
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (channel_id, thread_ts, agent_id)
    );`);
    db.prepare(`INSERT INTO thread_sessions
      (channel_id, thread_ts, session_id, agent_id, created_at)
      VALUES (?, ?, ?, ?, ?)`)
      .run("channel-1", "123.456", "session-1", "agent-1", 1);
    db.close();

    store = createSlackThreadSessionBindingStore(dataDir);

    expect(store.getBinding("channel-1", "123.456", "agent-1")).toMatchObject({
      sessionId: "session-1",
      agentId: "agent-1",
      owner: undefined,
      source: "agent",
    });
  });

  it("replaces stale bindings for one agent while preserving other agents", () => {
    store.setBinding({
      channelId: "channel-1",
      threadTs: "123.456",
      sessionId: "stale-session",
      agentId: "agent-1",
      owner: "old-user",
      source: "inbound",
    });
    const otherAgent = store.setBinding({
      channelId: "channel-1",
      threadTs: "123.456",
      sessionId: "other-session",
      agentId: "agent-2",
      owner: "other-user",
      source: "agent",
    });

    const replacement = store.setBinding({
      channelId: "channel-1",
      threadTs: "123.456",
      sessionId: "fresh-session",
      agentId: "agent-1",
      owner: null,
      source: "agent",
    });

    expect(replacement).toMatchObject({
      sessionId: "fresh-session",
      owner: null,
      source: "agent",
    });
    expect(store.getBinding("channel-1", "123.456", "agent-2")).toEqual(
      otherAgent
    );
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
