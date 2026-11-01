import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic, writeJsonAtomic } from "../util/atomic-write.js";
import { serializeByKey } from "../util/serialize.js";

export type DashboardShare =
  | { kind: "user"; id: string; mode: "read" | "write" }
  | { kind: "all"; mode: "read" | "write" };

export type DashboardRegistration = {
  id: string;
  agentId: string;
  slug: string;
  ownerUserId?: string;
  shares?: DashboardShare[];
  publishedAt?: string;
  publishedHash?: string;
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
const pendingOperations = new Map<string, Promise<void>>();

function invalidInput(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "invalid_input" });
}

export class DashboardRegistry {
  constructor(private readonly file: string) {}

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    return serializeByKey(pendingWrites, this.file, operation);
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

  async all(): Promise<DashboardRegistration[]> {
    return (await this.read()).dashboards;
  }

  async find(
    agentId: string,
    slug: string
  ): Promise<DashboardRegistration | undefined> {
    return (await this.list(agentId)).find((entry) => entry.slug === slug);
  }

  withRegistration<T>(
    id: string,
    operation: (entry: DashboardRegistration) => Promise<T>
  ): Promise<T> {
    return serializeByKey(pendingOperations, `${this.file}:${id}`, async () => {
      const entry = await this.get(id);
      if (!entry) throw invalidInput("Dashboard not found");
      return operation(entry);
    });
  }

  private publishedFile(id: string, hash: string): string {
    if (!/^[A-Za-z0-9_-]{32}$/.test(id) || !/^[a-f0-9]{64}$/.test(hash)) {
      throw new Error("Invalid dashboard publication identity");
    }
    return path.join(path.dirname(this.file), "published", id, `${hash}.html`);
  }

  private async writePublication(
    entry: DashboardRegistration,
    html: string
  ): Promise<void> {
    const hash = createHash("sha256").update(html).digest("hex");
    await writeFileAtomic(this.publishedFile(entry.id, hash), html);
    entry.publishedHash = hash;
    entry.publishedAt = new Date().toISOString();
  }

  private async prunePublications(entry: DashboardRegistration): Promise<void> {
    const current = this.publishedFile(entry.id, entry.publishedHash!);
    const directory = path.dirname(current);
    for (const name of await fs.readdir(directory)) {
      if (name !== path.basename(current)) {
        await fs.rm(path.join(directory, name), { force: true });
      }
    }
  }

  async createOwned(
    agentId: string,
    slug: string,
    ownerUserId: string,
    html: string
  ): Promise<DashboardRegistration> {
    return this.mutate(async () => {
      const data = await this.read();
      if (
        data.dashboards.some(
          (entry) => entry.agentId === agentId && entry.slug === slug
        )
      ) {
        throw invalidInput("Dashboard not found");
      }
      const entry: DashboardRegistration = {
        id: randomBytes(24).toString("base64url"),
        agentId,
        slug,
        ownerUserId,
        shares: [],
      };
      await this.writePublication(entry, html);
      data.dashboards.push(entry);
      await this.write(data);
      await this.prunePublications(entry);
      return entry;
    });
  }

  async readPublished(id: string): Promise<string> {
    return this.mutate(async () => {
      const entry = await this.get(id);
      if (!entry?.publishedHash)
        throw new Error("Dashboard publication not found");
      return fs.readFile(this.publishedFile(id, entry.publishedHash), "utf8");
    });
  }

  async publish(id: string, html: string): Promise<void> {
    await this.mutate(async () => {
      const data = await this.read();
      const entry = data.dashboards.find((candidate) => candidate.id === id);
      if (!entry) throw invalidInput("Dashboard not found");
      await this.writePublication(entry, html);
      await this.write(data);
      await this.prunePublications(entry);
    });
  }

  async claim(
    id: string,
    ownerUserId: string,
    html: string
  ): Promise<DashboardRegistration> {
    return this.mutate(async () => {
      const data = await this.read();
      const entry = data.dashboards.find((candidate) => candidate.id === id);
      if (!entry || entry.ownerUserId)
        throw new Error("Dashboard already claimed or not found");
      await this.writePublication(entry, html);
      entry.ownerUserId = ownerUserId;
      entry.shares = [];
      await this.write(data);
      await this.prunePublications(entry);
      return entry;
    });
  }

  async replaceShares(id: string, shares: DashboardShare[]): Promise<void> {
    await this.mutate(async () => {
      const data = await this.read();
      const entry = data.dashboards.find((candidate) => candidate.id === id);
      if (!entry?.ownerUserId) throw invalidInput("Dashboard not found");
      entry.shares = shares;
      await this.write(data);
    });
  }

  async deleteId(
    id: string
  ): Promise<{ registration?: DashboardRegistration; versions: boolean }> {
    return this.mutate(async () => {
      const data = await this.read();
      const index = data.dashboards.findIndex((entry) => entry.id === id);
      if (index === -1) return { versions: false };
      const [registration] = data.dashboards.splice(index, 1);
      if (!/^[A-Za-z0-9_-]{32}$/.test(id))
        throw new Error("Invalid dashboard registration id");
      const directory = path.join(path.dirname(this.file), "versions", id);
      const versions = await fs.lstat(directory).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
          return false;
        }
      );
      await this.write(data);
      await fs.rm(directory, { recursive: true, force: true });
      await fs.rm(path.join(path.dirname(this.file), "published", id), {
        recursive: true,
        force: true,
      });
      return { registration, versions };
    });
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
    const entry = await this.find(agentId, slug);
    if (!entry) return { versions: false };
    return this.withRegistration(entry.id, () => this.deleteId(entry.id));
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
      await this.write(registry);
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
    await writeJsonAtomic(this.file, registry);
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
