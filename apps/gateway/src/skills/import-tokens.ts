import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { writeJsonAtomic } from "../util/atomic-write.js";
import { serializeByKey } from "../util/serialize.js";
import { SkillError } from "./types.js";

type TokenSummary = { id: string; createdAt: number; expiresAt: number };
type TokenRow = TokenSummary & { hash: string; ownerId: string; revoked: boolean };
const mutations = new Map<string, Promise<void>>();
export const SKILL_IMPORT_TOKEN_PREFIX = "yoplai_skill_import_";
export class ImportTokenStore {
  private readonly file: string;
  private readonly now: () => number;
  constructor(dataDir: string, options: { now?: () => number } = {}) {
    this.file = path.join(dataDir, "skill-library", "import-tokens.json");
    this.now = options.now ?? Date.now;
  }
  private async rows(): Promise<TokenRow[]> {
    try { return JSON.parse(await fs.readFile(this.file, "utf8")) as TokenRow[]; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  async create(ownerId: string): Promise<TokenSummary & { token: string }> {
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(ownerId)) throw new SkillError("invalid_user_id");
    return serializeByKey(mutations, this.file, async () => {
      const token = SKILL_IMPORT_TOKEN_PREFIX + randomBytes(32).toString("base64url");
      const createdAt = this.now();
      const summary = { id: randomUUID(), createdAt, expiresAt: createdAt + 24 * 60 * 60 * 1000 };
      await writeJsonAtomic(this.file, [...await this.rows(), { ...summary, hash: createHash("sha256").update(token).digest("hex"), ownerId, revoked: false }]);
      return { ...summary, token };
    });
  }
  async list(ownerId: string): Promise<TokenSummary[]> {
    return (await this.rows()).filter((row) => row.ownerId === ownerId && !row.revoked && row.expiresAt > this.now()).map(({ id, createdAt, expiresAt }) => ({ id, createdAt, expiresAt }));
  }
  async revoke(ownerId: string, id: string): Promise<boolean> {
    return serializeByKey(mutations, this.file, async () => {
      const rows = await this.rows();
      const row = rows.find((entry) => entry.id === id && entry.ownerId === ownerId && !entry.revoked);
      if (!row) return false;
      row.revoked = true;
      await writeJsonAtomic(this.file, rows);
      return true;
    });
  }
  async authenticate(token: string): Promise<string | null> {
    if (!token.startsWith(SKILL_IMPORT_TOKEN_PREFIX) || token.length > 200) return null;
    const hash = createHash("sha256").update(token).digest("hex");
    const row = (await this.rows()).find((entry) => entry.hash === hash);
    return row && !row.revoked && row.expiresAt > this.now() ? row.ownerId : null;
  }
}
