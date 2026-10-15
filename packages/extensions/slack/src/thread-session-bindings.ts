import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type SlackThreadSessionBinding = {
  channelId: string;
  threadTs: string;
  sessionId: string;
  agentId: string;
  createdAt: number;
  /** null means shared; undefined preserves legacy requester-scoped routing. */
  owner?: string | null;
  source: "agent" | "inbound";
};

export type SetSlackThreadSessionBindingInput = Omit<
  SlackThreadSessionBinding,
  "createdAt" | "source"
> & { source?: "agent" | "inbound" };

type SlackThreadSessionBindingRow = {
  channel_id: string;
  thread_ts: string;
  session_id: string;
  agent_id: string;
  created_at: number;
  owner: string | null;
  source: "agent" | "inbound";
};

export class SlackThreadSessionBindingStore {
  private readonly db: Database.Database;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new Database(path.join(dataDir, "thread-sessions.db"));
    this.db.exec(`CREATE TABLE IF NOT EXISTS thread_sessions (
  channel_id  TEXT NOT NULL,
  thread_ts   TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  agent_id    TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (channel_id, thread_ts, agent_id)
);`);
    const columns = this.db
      .prepare("PRAGMA table_info(thread_sessions)")
      .all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "owner")) {
      this.db.exec("ALTER TABLE thread_sessions ADD COLUMN owner TEXT");
    }
    if (!columns.some((column) => column.name === "source")) {
      this.db.exec(
        "ALTER TABLE thread_sessions ADD COLUMN source TEXT NOT NULL DEFAULT 'agent'"
      );
    }
  }

  getBinding(
    channelId: string,
    threadTs: string,
    agentId?: string
  ): SlackThreadSessionBinding | undefined {
    const row = agentId
      ? this.db
          .prepare(
            "SELECT * FROM thread_sessions WHERE channel_id = ? AND thread_ts = ? AND agent_id = ?"
          )
          .get(channelId, threadTs, agentId)
      : this.db
          .prepare(
            "SELECT * FROM thread_sessions WHERE channel_id = ? AND thread_ts = ? ORDER BY created_at ASC LIMIT 1"
          )
          .get(channelId, threadTs);
    return row
      ? this.rowToBinding(row as SlackThreadSessionBindingRow)
      : undefined;
  }

  setBinding(
    input: SetSlackThreadSessionBindingInput
  ): SlackThreadSessionBinding {
    const createdAt = Date.now();
    this.db
      .prepare(
        `INSERT INTO thread_sessions (channel_id, thread_ts, session_id, agent_id, created_at, owner, source)
VALUES (@channelId, @threadTs, @sessionId, @agentId, @createdAt, @owner, @source)
ON CONFLICT(channel_id, thread_ts, agent_id) DO UPDATE SET
session_id = excluded.session_id, owner = excluded.owner, source = excluded.source`
      )
      .run({
        ...input,
        createdAt,
        owner: input.owner === undefined ? null : JSON.stringify(input.owner),
        source: input.source ?? "agent",
      });
    return this.getBinding(input.channelId, input.threadTs, input.agentId)!;
  }

  deleteBinding(channelId: string, threadTs: string, agentId: string): boolean {
    return (
      this.db
        .prepare(
          "DELETE FROM thread_sessions WHERE channel_id = ? AND thread_ts = ? AND agent_id = ?"
        )
        .run(channelId, threadTs, agentId).changes > 0
    );
  }

  close(): void {
    this.db.close();
  }

  private rowToBinding(
    row: SlackThreadSessionBindingRow
  ): SlackThreadSessionBinding {
    return {
      channelId: row.channel_id,
      threadTs: row.thread_ts,
      sessionId: row.session_id,
      agentId: row.agent_id,
      createdAt: row.created_at,
      owner:
        row.owner === null
          ? undefined
          : (JSON.parse(row.owner) as string | null),
      source: row.source,
    };
  }
}

export function createSlackThreadSessionBindingStore(
  dataDir: string
): SlackThreadSessionBindingStore {
  return new SlackThreadSessionBindingStore(dataDir);
}
