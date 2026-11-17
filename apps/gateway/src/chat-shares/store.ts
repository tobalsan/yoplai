import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { writeJsonAtomic } from "../util/atomic-write.js";
import { serializeByKey } from "../util/serialize.js";

export type ChatShare = {
  token: string;
  ownerUserId: string;
  agentId: string;
  sessionId: string;
  createdAt: number;
};

const pendingWrites = new Map<string, Promise<void>>();

export class ChatShareStore {
  constructor(private readonly file: string) {}

  private async read(): Promise<ChatShare[]> {
    try {
      return JSON.parse(await fs.readFile(this.file, "utf8")) as ChatShare[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async create(ownerUserId: string, agentId: string, sessionId: string): Promise<ChatShare> {
    return serializeByKey(pendingWrites, this.file, async () => {
      const shares = await this.read();
      const existing = shares.find((share) => share.ownerUserId === ownerUserId && share.agentId === agentId && share.sessionId === sessionId);
      if (existing) return existing;
      const share = { token: randomBytes(32).toString("base64url"), ownerUserId, agentId, sessionId, createdAt: Date.now() };
      await writeJsonAtomic(this.file, [...shares, share]);
      return share;
    });
  }

  async getByToken(token: string): Promise<ChatShare | undefined> {
    return (await this.read()).find((share) => share.token === token);
  }

  async findBySession(ownerUserId: string, agentId: string, sessionId: string): Promise<ChatShare | undefined> {
    return (await this.read()).find((share) => share.ownerUserId === ownerUserId && share.agentId === agentId && share.sessionId === sessionId);
  }

  async revoke(ownerUserId: string, agentId: string, sessionId: string): Promise<void> {
    await serializeByKey(pendingWrites, this.file, async () => {
      const shares = await this.read();
      await writeJsonAtomic(this.file, shares.filter((share) => !(share.ownerUserId === ownerUserId && share.agentId === agentId && share.sessionId === sessionId)));
    });
  }
}
