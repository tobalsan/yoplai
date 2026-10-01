import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import Database from "better-sqlite3";

export interface SlackPairingClient {
  users?: {
    info(args: { user: string }): Promise<{
      ok?: boolean;
      user?: { id?: string; name?: string; profile?: { email?: string; display_name?: string; real_name?: string } };
    }>;
  };
}

type PairingToken = {
  hash: string;
  workspace_id: string;
  slack_user_id: string;
  identity: string;
  expires_at: number;
  consumed_at: number | null;
};

export class SlackPairingError extends Error {}

const TOKEN_LIFETIME_MS = 10 * 60 * 1000;
const LOOKUP_TIMEOUT_MS = 5000;
const invalidLink = () => new SlackPairingError("This pairing link has expired or already been used. Request a new link in Slack.");
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export class SlackPairingService {
  private readonly db: Database.Database;
  private readonly clients = new Map<string, SlackPairingClient>();

  constructor(dataDir: string, readonly baseUrl: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new Database(path.join(dataDir, "slack-pairing.db"));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS slack_pairings (
        workspace_id TEXT NOT NULL, slack_user_id TEXT NOT NULL,
        yoplai_user_id TEXT NOT NULL, paired_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, slack_user_id)
      );
      CREATE TABLE IF NOT EXISTS slack_pairing_tokens (
        hash TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, slack_user_id TEXT NOT NULL,
        identity TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER
      );
    `);
  }

  resolve(workspaceId: string, slackUserId: string): string | undefined {
    const row = this.db.prepare("SELECT yoplai_user_id FROM slack_pairings WHERE workspace_id = ? AND slack_user_id = ?")
      .get(workspaceId, slackUserId) as { yoplai_user_id: string } | undefined;
    return row?.yoplai_user_id;
  }

  registerClient(workspaceId: string, client: SlackPairingClient): void {
    this.clients.set(workspaceId, client);
  }

  async issue(workspaceId: string, slackUserId: string, client: SlackPairingClient): Promise<string> {
    if (!workspaceId || !slackUserId) throw new SlackPairingError("Slack identity is unavailable.");
    this.registerClient(workspaceId, client);
    const user = await this.lookup(workspaceId, slackUserId);
    const name = user.profile?.display_name || user.profile?.real_name || user.name || slackUserId;
    const identity = user.profile?.email ? `${name} <${user.profile.email.trim()}>` : name;
    const token = randomBytes(32).toString("base64url");
    this.db.prepare("DELETE FROM slack_pairing_tokens WHERE expires_at <= ?").run(Date.now());
    this.db.prepare("INSERT INTO slack_pairing_tokens (hash, workspace_id, slack_user_id, identity, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run(hashToken(token), workspaceId, slackUserId, identity, Date.now() + TOKEN_LIFETIME_MS);
    return new URL(`/api/slack/pair/${token}`, this.baseUrl).href;
  }

  inspect(token: string): { workspaceId: string; slackUserId: string; identity: string } {
    const row = this.getToken(token);
    return { workspaceId: row.workspace_id, slackUserId: row.slack_user_id, identity: row.identity };
  }

  async redeem(token: string, user: { id: string; email: string }): Promise<void> {
    const row = this.getToken(token);
    const slackUser = await this.lookup(row.workspace_id, row.slack_user_id);
    const slackEmail = slackUser.profile?.email?.trim().toLowerCase();
    if (!slackEmail || !user.email.trim()) throw new SlackPairingError("Slack email is unavailable. Please contact your administrator.");
    if (slackEmail !== user.email.trim().toLowerCase()) {
      throw new SlackPairingError("This link was created for another Slack account");
    }
    // Email matching proves the same address, not ownership across identity providers;
    // Slack OIDC would provide a stronger proof if the instance needs that guarantee.
    this.db.transaction(() => {
      const now = Date.now();
      const consumed = this.db.prepare("UPDATE slack_pairing_tokens SET consumed_at = ? WHERE hash = ? AND consumed_at IS NULL AND expires_at > ?")
        .run(now, row.hash, now);
      if (consumed.changes !== 1) throw invalidLink();
      this.db.prepare(`INSERT INTO slack_pairings (workspace_id, slack_user_id, yoplai_user_id, paired_at)
        VALUES (?, ?, ?, ?) ON CONFLICT (workspace_id, slack_user_id)
        DO UPDATE SET yoplai_user_id = excluded.yoplai_user_id, paired_at = excluded.paired_at`)
        .run(row.workspace_id, row.slack_user_id, user.id, now);
    })();
  }

  close(): void { this.db.close(); }

  private getToken(token: string): PairingToken {
    const row = this.db.prepare("SELECT * FROM slack_pairing_tokens WHERE hash = ?").get(hashToken(token)) as PairingToken | undefined;
    if (!row || row.consumed_at !== null || row.expires_at <= Date.now()) throw invalidLink();
    return row;
  }

  private async lookup(workspaceId: string, slackUserId: string) {
    const client = this.clients.get(workspaceId);
    if (!client?.users) throw new SlackPairingError("Slack identity is unavailable. Request a new link in Slack.");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        client.users.info({ user: slackUserId }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Slack lookup timed out")), LOOKUP_TIMEOUT_MS);
        }),
      ]);
      if (!result.ok || !result.user || result.user.id !== slackUserId) throw new Error("Slack identity unavailable");
      return result.user;
    } catch {
      throw new SlackPairingError("Slack identity is unavailable. Please try again.");
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

let pairingService: SlackPairingService | undefined;
export const getSlackPairingService = () => pairingService;
export function setSlackPairingService(service: SlackPairingService | undefined): void {
  pairingService = service;
}
