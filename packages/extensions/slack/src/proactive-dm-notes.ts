import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export type ProactiveDmNote = {
  text: string;
  createdAt: number;
};

type ProactiveDmNoteRow = {
  text: string;
  created_at: number;
};

export class ProactiveDmNoteStore {
  private readonly db: Database.Database;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new Database(path.join(dataDir, "slack-proactive-dm-notes.db"));
    this.db.exec(`CREATE TABLE IF NOT EXISTS proactive_dm_notes (
  id INTEGER PRIMARY KEY,
  agent_id TEXT NOT NULL,
  recipient_type TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS proactive_dm_notes_recipient
  ON proactive_dm_notes (agent_id, recipient_type, recipient_id, id);
CREATE TABLE IF NOT EXISTS proactive_dm_messages (
  agent_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  replies INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, channel_id, ts)
);`);
  }

  trackMessage(agentId: string, channelId: string, ts: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO proactive_dm_messages (agent_id, channel_id, ts)
         VALUES (?, ?, ?)`
      )
      .run(agentId, channelId, ts);
  }

  isTracked(agentId: string, channelId: string, ts: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM proactive_dm_messages
           WHERE agent_id = ? AND channel_id = ? AND ts = ?`
        )
        .get(agentId, channelId, ts)
    );
  }

  /** Atomically count one reply; false when untracked or the limit is reached. */
  claimReply(
    agentId: string,
    channelId: string,
    ts: string,
    maxReplies: number | undefined
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE proactive_dm_messages SET replies = replies + 1
         WHERE agent_id = ? AND channel_id = ? AND ts = ?
           AND (? IS NULL OR replies < ?)`
      )
      .run(agentId, channelId, ts, maxReplies ?? null, maxReplies ?? null);
    return result.changes > 0;
  }

  addNote(
    agentId: string,
    recipientType: "user" | "channel",
    recipientId: string,
    text: string
  ): void {
    this.db
      .prepare(
        `INSERT INTO proactive_dm_notes
          (agent_id, recipient_type, recipient_id, text, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(agentId, recipientType, recipientId, text, Date.now());
  }

  takeNotes(
    agentId: string,
    userId: string | undefined,
    channelId: string
  ): ProactiveDmNote[] {
    const take = this.db.transaction(() => {
      const clauses = ["(recipient_type = 'channel' AND recipient_id = ?)"];
      const values: string[] = [agentId, channelId];
      if (userId) {
        clauses.push("(recipient_type = 'user' AND recipient_id = ?)");
        values.push(userId);
      }
      const where = `agent_id = ? AND (${clauses.join(" OR ")})`;
      const rows = this.db
        .prepare(
          `SELECT id, text, created_at FROM proactive_dm_notes WHERE ${where} ORDER BY id`
        )
        .all(...values) as Array<ProactiveDmNoteRow & { id: number }>;
      if (rows.length > 0) {
        this.db
          .prepare(`DELETE FROM proactive_dm_notes WHERE ${where}`)
          .run(...values);
      }
      return rows.map(({ text, created_at }) => ({
        text,
        createdAt: created_at,
      }));
    });
    return take();
  }

  close(): void {
    this.db.close();
  }
}

export function createProactiveDmNoteStore(
  dataDir: string
): ProactiveDmNoteStore {
  return new ProactiveDmNoteStore(dataDir);
}
