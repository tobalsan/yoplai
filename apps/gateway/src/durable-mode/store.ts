import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getUserSessionsPath } from "@yoplai/extension-multi-user/isolation";

export type DurableMode = { enabled: boolean; updatedAt?: string };

const writes = new Map<string, Promise<DurableMode>>();

export function durableModeTime(updatedAt: unknown): number {
  const time = typeof updatedAt === "string" ? Date.parse(updatedAt) : NaN;
  return Number.isFinite(time) ? time : -Infinity;
}

export class DurableModeStore {
  private readonly file: string;

  constructor(dataDir: string, userId?: string) {
    if (userId !== undefined && !/^[a-zA-Z0-9_-]{1,100}$/.test(userId)) throw new Error("Invalid user id");
    this.file = path.join(path.dirname(getUserSessionsPath(userId, dataDir)), "durable-mode.json");
  }

  async get(): Promise<boolean> {
    return (await this.read()).enabled;
  }

  async read(): Promise<DurableMode> {
    try {
      const setting = JSON.parse(await fs.readFile(this.file, "utf8")) as Partial<DurableMode> | null;
      const updatedAt = setting?.updatedAt;
      return {
        enabled: setting?.enabled === true,
        ...(typeof updatedAt === "string" && durableModeTime(updatedAt) !== -Infinity ? { updatedAt } : {}),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { enabled: false };
      throw error;
    }
  }

  async set(enabled: boolean, updatedAt?: string): Promise<DurableMode> {
    const write = (writes.get(this.file)?.catch(() => undefined) ?? Promise.resolve())
      .then(() => this.write(enabled, updatedAt));
    writes.set(this.file, write);
    try {
      return await write;
    } finally {
      if (writes.get(this.file) === write) writes.delete(this.file);
    }
  }

  private async write(enabled: boolean, updatedAt: string | undefined): Promise<DurableMode> {
    const time = updatedAt === undefined ? Date.now() : durableModeTime(updatedAt);
    if (updatedAt !== undefined) {
      const current = await this.read();
      if (time <= durableModeTime(current.updatedAt)) return current;
    }
    const setting = { enabled, updatedAt: new Date(time).toISOString() };
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(setting), "utf8");
      await fs.rename(temporary, this.file);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    return setting;
  }
}
