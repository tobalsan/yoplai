import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type DashboardRegistration = {
  id: string;
  agentId: string;
  slug: string;
};

type Registry = { dashboards: DashboardRegistration[] };

export class DashboardRegistry {
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  private async read(): Promise<Registry> {
    try {
      return JSON.parse(await fs.readFile(this.file, "utf8")) as Registry;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { dashboards: [] };
      }
      throw error;
    }
  }

  async get(id: string): Promise<DashboardRegistration | undefined> {
    return (await this.read()).dashboards.find((entry) => entry.id === id);
  }

  async list(agentId: string): Promise<DashboardRegistration[]> {
    return (await this.read()).dashboards.filter(
      (entry) => entry.agentId === agentId
    );
  }

  async link(agentId: string, slug: string): Promise<DashboardRegistration> {
    let result: DashboardRegistration | undefined;
    const write = async () => {
      const registry = await this.read();
      const existing = registry.dashboards.find(
        (entry) => entry.agentId === agentId && entry.slug === slug
      );
      if (existing) {
        result = existing;
        return;
      }

      result = {
        id: randomBytes(24).toString("base64url"),
        agentId,
        slug,
      };
      registry.dashboards.push(result);
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
      await fs.writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`);
      await fs.rename(temporary, this.file);
    };
    const operation = this.pendingWrite.then(write, write);
    this.pendingWrite = operation.then(
      () => undefined,
      () => undefined
    );
    await operation;
    if (!result) throw new Error("Dashboard registry write failed");
    return result!;
  }
}
