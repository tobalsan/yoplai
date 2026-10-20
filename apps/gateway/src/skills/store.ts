import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { writeJsonAtomic } from "../util/atomic-write.js";
import { serializeByKey } from "../util/serialize.js";
import { ingestSkill, readSkillMetadata } from "./ingest.js";
import { SkillError, type SkillDirectory, type SkillInput, type SkillRow, type SkillShare, type SkillState } from "./types.js";

const mutations = new Map<string, Promise<void>>();
async function readJson<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await fs.readFile(file, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw error; }
}

export async function inspectSkillDirectory(directory: string): Promise<{ skillMd: string; files: { path: string; size: number }[] }> {
  const files: { path: string; size: number }[] = [];
  const visit = async (relative: string): Promise<void> => {
    for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile()) files.push({ path: name, size: (await fs.stat(path.join(directory, name))).size });
    }
  };
  await visit("");
  return { skillMd: await fs.readFile(path.join(directory, "SKILL.md"), "utf8"), files: files.sort((a, b) => a.path.localeCompare(b.path)) };
}

export async function scanSkillDirectory(directory: string, id?: string): Promise<SkillDirectory | null> {
  try {
    const metadata = readSkillMetadata(await fs.readFile(path.join(directory, "SKILL.md"), "utf8"));
    if (metadata.name !== path.basename(directory)) throw new SkillError("name_mismatch");
    return { id: id ?? metadata.name, ...metadata, directory };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`Skipping invalid skill directory ${directory}`);
    return null;
  }
}

export class SkillStore {
  readonly root: string;
  constructor(dataDir: string, readonly options: { builtinsDir?: string } = {}) { this.root = path.join(dataDir, "skill-library"); }
  directory(row: SkillRow): string { return path.join(this.root, "users", this.userId(row.ownerId), row.name); }
  private userId(id: string): string {
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(id)) throw new SkillError("invalid_user_id");
    return id;
  }
  private stateFile(userId: string): string { return path.join(this.root, "users", this.userId(userId), "state.json"); }
  private registryFile(): string { return path.join(this.root, "registry.json"); }
  private mutate<T>(operation: () => Promise<T>): Promise<T> { return serializeByKey(mutations, this.root, operation); }
  async list(): Promise<SkillRow[]> { return readJson(this.registryFile(), []); }
  async get(id: string): Promise<SkillRow | null> { return (await this.list()).find((row) => row.id === id) ?? null; }
  private async require(id: string): Promise<SkillRow> { const row = await this.get(id); if (!row) throw new SkillError("not_found", 404); return row; }
  async getState(userId: string): Promise<SkillState> { return readJson(this.stateFile(userId), { enabled: [] }); }
  private async scan(directory: string, prefix: string): Promise<SkillDirectory[]> {
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const result: SkillDirectory[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const skill = await scanSkillDirectory(path.join(directory, entry.name), `${prefix}:${entry.name}`);
      if (skill) result.push(skill);
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }
  async builtins(): Promise<SkillDirectory[]> { return this.scan(this.options.builtinsDir ?? fileURLToPath(new URL("./", import.meta.url)), "builtin"); }
  async defaults(): Promise<SkillDirectory[]> {
    const skills = await this.scan(path.join(this.root, "default"), "default");
    const valid: SkillDirectory[] = [];
    for (const skill of skills) {
      try {
        const sidecar = await readJson<unknown>(path.join(skill.directory, ".yoplai.json"), undefined);
        if (sidecar !== undefined) {
          if (!sidecar || typeof sidecar !== "object" || !Array.isArray((sidecar as { agents?: unknown }).agents) || !(sidecar as { agents: unknown[] }).agents.every((agent) => typeof agent === "string" && agent.length > 0)) throw new Error("invalid sidecar");
          skill.agents = (sidecar as { agents: string[] }).agents;
        }
        valid.push(skill);
      } catch { console.warn(`Skipping skill with malformed sidecar ${skill.directory}`); }
    }
    return valid;
  }
  private async writeContent(row: SkillRow, content: Awaited<ReturnType<typeof ingestSkill>>, replace: boolean): Promise<void> {
    const target = this.directory(row);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temporary = await fs.mkdtemp(path.join(path.dirname(target), ".ingest-"));
    const backup = `${temporary}-previous`;
    let backedUp = false;
    try {
      for (const file of content.files) { const targetFile = path.join(temporary, file.path); await fs.mkdir(path.dirname(targetFile), { recursive: true }); await fs.writeFile(targetFile, file.data); }
      if (replace) { await fs.rename(target, backup); backedUp = true; }
      try { await fs.rename(temporary, target); }
      catch (error) { if (backedUp) { await fs.rename(backup, target); backedUp = false; } throw error; }
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
      if (backedUp) await fs.rm(backup, { recursive: true, force: true });
    }
  }
  async create(ownerId: string, input: SkillInput, options: { replaceOwn?: boolean } = {}): Promise<{ skill: SkillRow; replaced: boolean }> {
    this.userId(ownerId);
    const content = await ingestSkill(input);
    return this.mutate(async () => {
      const rows = await this.list();
      const builtin = (await this.builtins()).some((skill) => skill.name === content.name);
      if (builtin || ["dashboard", "skill-creator"].includes(content.name)) throw new SkillError("name_taken", 409, { kind: "builtin" });
      if ((await this.defaults()).some((skill) => skill.name === content.name)) throw new SkillError("name_taken", 409, { kind: "default" });
      const existing = rows.find((row) => row.name === content.name);
      if (existing) {
        if (existing.ownerId !== ownerId) throw new SkillError("name_taken", 409, { kind: "user" });
        if (!options.replaceOwn) throw new SkillError("skill_exists", 409, { id: existing.id });
        return { skill: await this.replaceContent(existing, content), replaced: true };
      }
      const now = Date.now();
      const skill: SkillRow = { id: randomUUID(), name: content.name, description: content.description, ownerId, createdAt: now, updatedAt: now, shares: [], disabledByAdmin: false };
      await this.writeContent(skill, content, false);
      try { await writeJsonAtomic(this.registryFile(), [...rows, skill]); }
      catch (error) { await fs.rm(this.directory(skill), { recursive: true, force: true }); throw error; }
      return { skill, replaced: false };
    });
  }
  private versionsDirectory(row: SkillRow): string { return path.join(this.root, "users", this.userId(row.ownerId), ".versions", row.name); }
  private async recordVersion(row: SkillRow): Promise<void> {
    const versions = this.versionsDirectory(row);
    await fs.mkdir(versions, { recursive: true });
    await fs.cp(this.directory(row), path.join(versions, `${Date.now()}-${randomUUID()}`), { recursive: true });
    const entries = (await fs.readdir(versions)).sort().reverse();
    for (const entry of entries.slice(10)) await fs.rm(path.join(versions, entry), { recursive: true, force: true });
  }
  private async replaceContent(row: SkillRow, content: Awaited<ReturnType<typeof ingestSkill>>): Promise<SkillRow> {
    if (content.name !== row.name) throw new SkillError("name_mismatch");
    await this.recordVersion(row);
    await this.writeContent(row, content, true);
    const updated = { ...row, description: content.description, updatedAt: Date.now() };
    await writeJsonAtomic(this.registryFile(), (await this.list()).map((item) => item.id === row.id ? updated : item));
    return updated;
  }
  async replace(id: string, input: SkillInput): Promise<SkillRow> {
    const content = await ingestSkill(input);
    return this.mutate(async () => this.replaceContent(await this.require(id), content));
  }
  async detail(id: string): Promise<{ skillMd: string; files: { path: string; size: number }[] }> {
    const row = await this.get(id);
    const directory = row ? this.directory(row) : [...await this.defaults(), ...await this.builtins()].find((skill) => skill.id === id)?.directory;
    if (!directory) throw new SkillError("not_found", 404);
    return inspectSkillDirectory(directory);
  }
  async shares(id: string, shares: SkillShare[]): Promise<SkillRow> {
    if (!Array.isArray(shares) || shares.some((share) => !share || (share.kind === "all" ? share.mode !== "read" : share.kind !== "user" || typeof share.id !== "string" || !share.id || !["read", "write"].includes(share.mode)))) throw new SkillError("invalid_shares");
    return this.mutate(async () => {
      const row = { ...await this.require(id), shares, updatedAt: Date.now() };
      await writeJsonAtomic(this.registryFile(), (await this.list()).map((item) => item.id === id ? row : item));
      return row;
    });
  }
  async setEnabled(userId: string, id: string, enabled: boolean): Promise<void> {
    return this.mutate(async () => {
      const state = await this.getState(userId);
      if (/^(builtin|default|agent):/.test(id)) throw new SkillError("skill_locked");
      await this.require(id);
      state.enabled = state.enabled.filter((item) => item !== id);
      if (enabled) state.enabled.push(id);
      await writeJsonAtomic(this.stateFile(userId), state);
    });
  }
  async versions(id: string): Promise<{ id: string; createdAt: number }[]> {
    const row = await this.require(id);
    let entries: string[];
    try { entries = await fs.readdir(this.versionsDirectory(row)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    return entries.sort().reverse().map((id) => ({ id, createdAt: Number(id.split("-")[0]) }));
  }
  async restore(id: string, versionId: string): Promise<SkillRow> {
    return this.mutate(async () => {
      const row = await this.require(id);
      if (!(await this.versions(id)).some((version) => version.id === versionId)) throw new SkillError("not_found", 404);
      const directory = path.join(this.versionsDirectory(row), versionId);
      const detail = await inspectSkillDirectory(directory);
      const files = await Promise.all(detail.files.map(async (file) => ({ path: file.path, content: (await fs.readFile(path.join(directory, file.path))).toString("base64"), encoding: "base64" as const })));
      return this.replaceContent(row, await ingestSkill({ files }));
    });
  }
  async delete(id: string): Promise<void> {
    return this.mutate(async () => {
      const row = await this.require(id);
      await writeJsonAtomic(this.registryFile(), (await this.list()).filter((item) => item.id !== id));
      await fs.rm(this.directory(row), { recursive: true, force: true });
      await fs.rm(this.versionsDirectory(row), { recursive: true, force: true });
      for (const userId of await this.userDirectories()) {
        const state = await this.getState(userId);
        if (state.enabled.includes(id)) await writeJsonAtomic(this.stateFile(userId), { ...state, enabled: state.enabled.filter((item) => item !== id) });
      }
    });
  }
  private async userDirectories(): Promise<string[]> {
    try { return (await fs.readdir(path.join(this.root, "users"), { withFileTypes: true })).filter((entry) => entry.isDirectory() && /^[a-zA-Z0-9_-]{1,200}$/.test(entry.name)).map((entry) => entry.name); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  }
  async enableCount(id: string): Promise<number> {
    let count = 0;
    for (const userId of await this.userDirectories()) if ((await this.getState(userId)).enabled.includes(id)) count++;
    return count;
  }
  async setAdminDisabled(id: string, disabledByAdmin: boolean): Promise<SkillRow> {
    return this.mutate(async () => {
      const current = await this.require(id);
      if (disabledByAdmin && !current.shares.some((share) => share.kind === "all")) throw new SkillError("not_platform_wide");
      const row = { ...current, disabledByAdmin, updatedAt: Date.now() };
      await writeJsonAtomic(this.registryFile(), (await this.list()).map((item) => item.id === id ? row : item));
      return row;
    });
  }
}
