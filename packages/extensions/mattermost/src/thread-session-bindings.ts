import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

/**
 * Durable thread ↔ session bindings. A Mattermost thread is identified by its
 * root post; each (thread, agent) pair maps to one agent session, so a thread
 * keeps its conversation across gateway restarts. Bindings are created for
 * threads started by users (`inbound`) and by the `mattermost.create_thread`
 * tool (`agent`), whose replies then continue the session that posted it.
 */
export type ThreadSessionBindingSource = "inbound" | "agent";

export const BINDINGS_FILE = "mattermost-thread-sessions.db";

export type ThreadSessionBinding = {
  channelId: string;
  rootId: string;
  agentId: string;
  sessionId: string;
  source: ThreadSessionBindingSource;
  createdAt: number;
};

export type SetThreadSessionBindingInput = Omit<
  ThreadSessionBinding,
  "createdAt"
>;

type Row = {
  channel_id: string;
  root_id: string;
  agent_id: string;
  session_id: string;
  source: ThreadSessionBindingSource;
  created_at: number;
};

export class ThreadSessionBindingStore {
  private readonly db: Database.Database;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    // Own file: Discord and Slack already share "thread-sessions.db" in the
    // same data dir, with tables of a different shape.
    this.db = new Database(path.join(dataDir, BINDINGS_FILE));
    this.db.exec(`CREATE TABLE IF NOT EXISTS thread_sessions (
  channel_id   TEXT NOT NULL,
  root_id      TEXT NOT NULL,
  agent_id     TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  source       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (root_id, agent_id)
);`);
  }

  getBinding(
    rootId: string,
    agentId: string
  ): ThreadSessionBinding | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM thread_sessions WHERE root_id = ? AND agent_id = ?"
      )
      .get(rootId, agentId) as Row | undefined;
    return row ? toBinding(row) : undefined;
  }

  /** Insert or replace the binding of a thread for one agent. */
  setBinding(input: SetThreadSessionBindingInput): ThreadSessionBinding {
    const createdAt = Date.now();
    this.db
      .prepare(
        `INSERT OR REPLACE INTO thread_sessions (channel_id, root_id, agent_id, session_id, source, created_at)
VALUES (@channelId, @rootId, @agentId, @sessionId, @source, @createdAt)`
      )
      .run({ ...input, createdAt });
    return { ...input, createdAt };
  }

  deleteBinding(rootId: string, agentId: string): void {
    this.db
      .prepare("DELETE FROM thread_sessions WHERE root_id = ? AND agent_id = ?")
      .run(rootId, agentId);
  }

  close(): void {
    this.db.close();
  }
}

function toBinding(row: Row): ThreadSessionBinding {
  return {
    channelId: row.channel_id,
    rootId: row.root_id,
    agentId: row.agent_id,
    sessionId: row.session_id,
    source: row.source,
    createdAt: row.created_at,
  };
}

/** Open the store for one operation and always close it. */
export function withThreadBindings<T>(
  dataDir: string,
  fn: (store: ThreadSessionBindingStore) => T
): T {
  const store = new ThreadSessionBindingStore(dataDir);
  try {
    return fn(store);
  } finally {
    store.close();
  }
}
