import fs from "node:fs/promises";
import path from "node:path";

export type SlackProgressRecord = {
  owner: string;
  channel: string;
  ts: string;
  updatedAt: number;
};

export class SlackProgressStore {
  private saving = Promise.resolve();
  constructor(private readonly dataDir: string) {}

  private get file() {
    return path.join(this.dataDir, "progress-messages.json");
  }

  private async read(): Promise<SlackProgressRecord[]> {
    try {
      return JSON.parse(await fs.readFile(this.file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async write(records: SlackProgressRecord[]) {
    await fs.mkdir(this.dataDir, { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(records));
  }

  async add(record: SlackProgressRecord) {
    await this.enqueue(async () => {
      const records = await this.read();
      await this.write([...records, record]);
    });
  }

  async remove(ts: string) {
    await this.enqueue(async () => {
      await this.write((await this.read()).filter((record) => record.ts !== ts));
    });
  }

  private async enqueue(write: () => Promise<void>) {
    const next = this.saving.then(write);
    this.saving = next.catch(() => undefined);
    await next;
  }

  async recover(
    owners: Iterable<string>,
    update: (record: SlackProgressRecord) => Promise<void>
  ) {
    const ownerSet = new Set(owners);
    const records = (await this.read()).filter((record) => ownerSet.has(record.owner));
    for (const record of records) {
      try {
        await update(record);
      } catch {
        continue;
      }
      await this.remove(record.ts);
    }
  }
}

let activeStore: SlackProgressStore | undefined;

export function setSlackProgressStore(store: SlackProgressStore | undefined) {
  activeStore = store;
}

export function getSlackProgressStore() {
  return activeStore;
}
