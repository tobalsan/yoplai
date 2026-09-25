import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type DashboardRegistration = {
  id: string;
  agentId: string;
  slug: string;
  versions?: DashboardVersion[];
};

export type DashboardVersion = {
  id: string;
  createdAt: string;
  hash: string;
};

export const DASHBOARD_VERSION_LIMIT = 20;

type Registry = { dashboards: DashboardRegistration[] };

const pendingWrites = new Map<string, Promise<void>>();

export class DashboardRegistry {
  constructor(private readonly file: string) {}

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const previous = pendingWrites.get(this.file) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    const settled = current.then(
      () => undefined,
      () => undefined
    );
    pendingWrites.set(this.file, settled);
    try {
      return await current;
    } finally {
      if (pendingWrites.get(this.file) === settled) {
        pendingWrites.delete(this.file);
      }
    }
  }

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

  async delete(
    agentId: string,
    slug: string
  ): Promise<{ registration?: DashboardRegistration; versions: boolean }> {
    let registration: DashboardRegistration | undefined;
    let versions = false;
    await this.mutate(async () => {
      const registry = await this.read();
      const index = registry.dashboards.findIndex(
        (entry) => entry.agentId === agentId && entry.slug === slug
      );
      if (index === -1) return;

      [registration] = registry.dashboards.splice(index, 1);
      if (!/^[A-Za-z0-9_-]{32}$/.test(registration!.id)) {
        throw new Error("Invalid dashboard registration id");
      }
      const directory = path.join(
        path.dirname(this.file),
        "versions",
        registration!.id
      );
      try {
        await fs.lstat(directory);
        versions = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await fs.rm(directory, { recursive: true, force: true });
      await this.write(registry);
    });
    return { registration, versions };
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
    await this.mutate(write);
    if (!result) throw new Error("Dashboard registry write failed");
    return result!;
  }

  async recordVersion(
    registrationId: string,
    content: string
  ): Promise<DashboardVersion | undefined> {
    let result: DashboardVersion | undefined;
    const write = async () => {
      const registry = await this.read();
      const entry = registry.dashboards.find(
        (dashboard) => dashboard.id === registrationId
      );
      if (!entry) throw new Error("Dashboard registration not found");

      const hash = createHash("sha256").update(content).digest("hex");
      if (entry.versions?.at(-1)?.hash === hash) return;

      result = {
        id: `${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`,
        createdAt: new Date().toISOString(),
        hash,
      };
      const directory = path.join(
        path.dirname(this.file),
        "versions",
        registrationId
      );
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, `${result.id}.html`), content);

      const versions = [...(entry.versions ?? []), result];
      const pruned = versions.slice(0, -DASHBOARD_VERSION_LIMIT);
      entry.versions = versions.slice(-DASHBOARD_VERSION_LIMIT);
      await this.write(registry);
      await Promise.all(
        pruned.map((version) =>
          fs.rm(path.join(directory, `${version.id}.html`), { force: true })
        )
      );
    };
    await this.mutate(write);
    return result;
  }

  async listVersions(registrationId: string): Promise<DashboardVersion[]> {
    const entry = (await this.read()).dashboards.find(
      (dashboard) => dashboard.id === registrationId
    );
    return [...(entry?.versions ?? [])].reverse();
  }

  async readVersion(
    registrationId: string,
    versionId: string
  ): Promise<string> {
    const entry = (await this.read()).dashboards.find(
      (dashboard) => dashboard.id === registrationId
    );
    if (!entry?.versions?.some((version) => version.id === versionId)) {
      throw new Error("Dashboard version not found");
    }
    return fs.readFile(
      path.join(
        path.dirname(this.file),
        "versions",
        registrationId,
        `${versionId}.html`
      ),
      "utf8"
    );
  }

  private async write(registry: Registry): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`);
    await fs.rename(temporary, this.file);
  }
}

const registries = new Map<string, DashboardRegistry>();

export function getDashboardRegistry(file: string): DashboardRegistry {
  let registry = registries.get(file);
  if (!registry) {
    registry = new DashboardRegistry(file);
    registries.set(file, registry);
  }
  return registry;
}
