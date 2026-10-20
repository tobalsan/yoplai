import fs from "node:fs/promises";
import { writeJsonAtomic } from "../util/atomic-write.js";
import { serializeByKey } from "../util/serialize.js";

const pendingWrites = new Map<string, Promise<void>>();

export class DashboardPinStore {
  constructor(private readonly file: string) {}

  private async read(): Promise<Record<string, string[]>> {
    try {
      return JSON.parse(await fs.readFile(this.file, "utf8")) as Record<string, string[]>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  async list(userId: string): Promise<Set<string>> {
    const data = await this.read();
    return new Set(Object.hasOwn(data, userId) ? data[userId] : []);
  }

  async set(userId: string, id: string, pinned: boolean): Promise<void> {
    await serializeByKey(pendingWrites, this.file, async () => {
      const data = await this.read();
      const ids = new Set(Object.hasOwn(data, userId) ? data[userId] : []);
      if (pinned) ids.add(id);
      else ids.delete(id);
      await writeJsonAtomic(this.file, { ...data, [userId]: [...ids] });
    });
  }
}
