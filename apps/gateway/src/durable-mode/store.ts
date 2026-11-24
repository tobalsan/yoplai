import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getUserSessionsPath } from "@yoplai/extension-multi-user/isolation";

export class DurableModeStore {
  private readonly file: string;

  constructor(dataDir: string, userId?: string) {
    if (userId !== undefined && !/^[a-zA-Z0-9_-]{1,100}$/.test(userId)) throw new Error("Invalid user id");
    this.file = path.join(path.dirname(getUserSessionsPath(userId, dataDir)), "durable-mode.json");
  }

  async get(): Promise<boolean> {
    try {
      const setting = JSON.parse(await fs.readFile(this.file, "utf8")) as { enabled?: unknown } | null;
      return setting?.enabled === true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async set(enabled: boolean): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify({ enabled }), "utf8");
      await fs.rename(temporary, this.file);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }
}
