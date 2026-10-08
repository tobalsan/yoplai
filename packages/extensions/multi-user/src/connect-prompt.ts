import type Database from "better-sqlite3";

export type ConnectPromptState = {
  seen: boolean;
  at: string | null;
};

export type ConnectPromptStore = {
  get(userId: string, agentId: string): ConnectPromptState;
  markSeen(userId: string, agentId: string): ConnectPromptState;
  clear(userId: string, agentId: string): ConnectPromptState;
};

export function createConnectPromptStore(db: Database.Database): ConnectPromptStore {
  const get = (userId: string, agentId: string): ConnectPromptState => {
    const row = db
      .prepare("SELECT at FROM user_agent_connect_prompt WHERE userId = ? AND agentId = ?")
      .get(userId, agentId) as { at: string } | undefined;
    return row ? { seen: true, at: row.at } : { seen: false, at: null };
  };
  return {
    get,
    markSeen(userId, agentId) {
      db.prepare(
        `INSERT INTO user_agent_connect_prompt (userId, agentId, at) VALUES (?, ?, ?)
         ON CONFLICT(userId, agentId) DO UPDATE SET at = excluded.at`
      ).run(userId, agentId, new Date().toISOString());
      return get(userId, agentId);
    },
    clear(userId, agentId) {
      db.prepare("DELETE FROM user_agent_connect_prompt WHERE userId = ? AND agentId = ?").run(userId, agentId);
      return get(userId, agentId);
    },
  };
}
