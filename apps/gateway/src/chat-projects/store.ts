import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getUserSessionsPath } from "@yoplai/extension-multi-user/isolation";

export type ChatProjectFile = { id: string; name: string; mimeType: string; size: number; createdAt: number; text?: string; extractionError?: string; extractionNote?: string; sha256?: string; sourceName?: string };

export type ChatProjectReference = { id: string; title: string; description: string; path: string; createdAt: number };

export type ChatProject = {
  id: string;
  name: string;
  instructions?: string;
  createdAt: number;
  updatedAt: number;
};

export function isSafeChatProjectId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{1,100}$/.test(id);
}

const fileMutations = new Map<string, Promise<void>>();

export class ChatProjectStore {
  private readonly root: string;

  constructor(dataDir: string, userId?: string) {
    if (userId !== undefined && !isSafeChatProjectId(userId)) {
      throw new Error("Invalid user id");
    }
    this.root = path.join(path.dirname(getUserSessionsPath(userId, dataDir)), "chat-projects");
  }

  private file(id: string): string {
    if (!isSafeChatProjectId(id)) throw new Error("Invalid project id");
    return path.join(this.root, id, "project.json");
  }

  async list(): Promise<ChatProject[]> {
    let ids: string[];
    try {
      ids = await fs.readdir(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const projects = await Promise.all(ids.filter(isSafeChatProjectId).map((id) => this.get(id)));
    return projects.filter((project): project is ChatProject => project !== null)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  async get(id: string): Promise<ChatProject | null> {
    const file = this.file(id);
    try {
      return JSON.parse(await fs.readFile(file, "utf8")) as ChatProject;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async write(project: ChatProject): Promise<void> {
    const file = this.file(project.id);
    const tmp = `${file}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(project, null, 2), "utf8");
    await fs.rename(tmp, file);
  }

  async create(name: string): Promise<ChatProject> {
    name = this.validateName(name);
    const now = Date.now();
    const project = { id: crypto.randomUUID(), name, createdAt: now, updatedAt: now };
    await fs.mkdir(this.root, { recursive: true });
    await fs.mkdir(path.dirname(this.file(project.id)));
    await this.write(project);
    return project;
  }

  async update(id: string, patch: string | { name?: string; instructions?: string }): Promise<ChatProject | null> {
    const updates = typeof patch === "string" ? { name: patch } : {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.instructions !== undefined ? { instructions: patch.instructions } : {}),
    };
    if (updates.name !== undefined) updates.name = this.validateName(updates.name);
    const project = await this.get(id);
    if (!project) return null;
    const updated = { ...project, ...updates, updatedAt: Date.now() };
    await this.write(updated);
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    if (!await this.get(id)) return false;
    await fs.rm(path.dirname(this.file(id)), { recursive: true });
    return true;
  }

  filesDirectory(id: string): string {
    return path.join(path.dirname(this.file(id)), "files");
  }

  async listFiles(id: string): Promise<ChatProjectFile[]> {
    try {
      return JSON.parse(await fs.readFile(path.join(path.dirname(this.file(id)), "files.json"), "utf8")) as ChatProjectFile[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async writeFiles(id: string, files: ChatProjectFile[]): Promise<void> {
    const target = path.join(path.dirname(this.file(id)), "files.json");
    const tmp = target + "." + crypto.randomUUID() + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(files), "utf8");
    await fs.rename(tmp, target);
  }

  private async mutateFiles<T>(id: string, mutate: () => Promise<T>): Promise<T> {
    const key = this.file(id);
    const previous = fileMutations.get(key) ?? Promise.resolve();
    const result = previous.then(mutate);
    const settled = result.then(() => {}, () => {});
    fileMutations.set(key, settled);
    try { return await result; }
    finally { if (fileMutations.get(key) === settled) fileMutations.delete(key); }
  }

  async addFile(id: string, file: ChatProjectFile, data: Buffer): Promise<void> {
    if (!isSafeChatProjectId(file.id)) throw new Error("Invalid file id");
    await this.mutateFiles(id, async () => {
      await fs.mkdir(this.filesDirectory(id), { recursive: true });
      await fs.writeFile(path.join(this.filesDirectory(id), file.id), data);
      await this.writeFiles(id, [...await this.listFiles(id), file]);
    });
  }

  async addFileDeduped(id: string, file: ChatProjectFile, data: Buffer): Promise<{ status: "added" | "already_in_project"; file: ChatProjectFile }> {
    if (!isSafeChatProjectId(file.id)) throw new Error("Invalid file id");
    return this.mutateFiles(id, async () => {
      if (!await this.get(id)) throw new Error("Project not found");
      const files = await this.listFiles(id);
      const sha256 = crypto.createHash("sha256").update(data).digest("hex");
      const existing = files.find((item) => item.sha256 === sha256 && item.sourceName === file.name);
      if (existing) return { status: "already_in_project", file: existing };
      let name = file.name;
      const extension = path.extname(name);
      const base = name.slice(0, name.length - extension.length);
      for (let suffix = 2; files.some((item) => item.name === name); suffix++) {
        const ending = " (" + suffix + ")" + extension;
        name = base.slice(0, 200 - ending.length) + ending;
      }
      const added = { ...file, name, sha256, sourceName: file.name };
      await fs.mkdir(this.filesDirectory(id), { recursive: true });
      await fs.writeFile(path.join(this.filesDirectory(id), added.id), data);
      await this.writeFiles(id, [...files, added]);
      return { status: "added", file: added };
    });
  }

  async updateFile(id: string, file: ChatProjectFile): Promise<void> {
    await this.mutateFiles(id, async () => {
      await this.writeFiles(id, (await this.listFiles(id)).map((item) => item.id === file.id ? file : item));
    });
  }

  async deleteFile(id: string, fileId: string): Promise<boolean> {
    if (!isSafeChatProjectId(fileId)) throw new Error("Invalid file id");
    return this.mutateFiles(id, async () => {
      const files = await this.listFiles(id);
      if (!files.some((file) => file.id === fileId)) return false;
      await fs.rm(path.join(this.filesDirectory(id), fileId), { force: true });
      await this.writeFiles(id, files.filter((file) => file.id !== fileId));
      return true;
    });
  }

  async listReferences(id: string): Promise<ChatProjectReference[]> {
    try {
      return JSON.parse(await fs.readFile(path.join(path.dirname(this.file(id)), "references.json"), "utf8")) as ChatProjectReference[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async writeReferences(id: string, references: ChatProjectReference[]): Promise<void> {
    const target = path.join(path.dirname(this.file(id)), "references.json");
    const tmp = target + "." + crypto.randomUUID() + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(references), "utf8");
    await fs.rename(tmp, target);
  }

  async addReference(id: string, input: { title: string; description: string; path: string }): Promise<ChatProjectReference> {
    if (![input.title, input.description, input.path].every((value) => typeof value === "string" && value.trim())) {
      throw new Error("Reference title, description and path are required");
    }
    return this.mutateFiles(id, async () => {
      if (!await this.get(id)) throw new Error("Project not found");
      const reference = { id: crypto.randomUUID(), title: input.title.trim(), description: input.description.trim(), path: input.path.trim(), createdAt: Date.now() };
      await this.writeReferences(id, [...await this.listReferences(id), reference]);
      return reference;
    });
  }

  async deleteReference(id: string, referenceId: string): Promise<boolean> {
    if (!isSafeChatProjectId(referenceId)) throw new Error("Invalid reference id");
    return this.mutateFiles(id, async () => {
      const references = await this.listReferences(id);
      if (!references.some((reference) => reference.id === referenceId)) return false;
      await this.writeReferences(id, references.filter((reference) => reference.id !== referenceId));
      return true;
    });
  }

  async getNotes(id: string): Promise<string> {
    try { return await fs.readFile(path.join(path.dirname(this.file(id)), "NOTES.md"), "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    }
  }

  private async writeNotes(id: string, text: string): Promise<void> {
    const target = path.join(path.dirname(this.file(id)), "NOTES.md");
    const tmp = target + "." + crypto.randomUUID() + ".tmp";
    await fs.writeFile(tmp, text, "utf8");
    await fs.rename(tmp, target);
  }

  async putNotes(id: string, text: string): Promise<void> {
    await this.mutateFiles(id, async () => {
      if (!await this.get(id)) throw new Error("Project not found");
      await this.writeNotes(id, text);
    });
  }

  async appendNotes(id: string, text: string): Promise<void> {
    if (typeof text !== "string" || !text.trim()) throw new Error("Note text is required");
    await this.mutateFiles(id, async () => {
      if (!await this.get(id)) throw new Error("Project not found");
      const notes = await this.getNotes(id);
      const bullet = "- [" + new Date().toISOString().slice(0, 10) + "] " + text.trim().replace(/\r?\n/g, "\n  ") + "\n";
      await this.writeNotes(id, notes + (notes && !notes.endsWith("\n") ? "\n" : "") + bullet);
    });
  }

  private validateName(name: string): string {
    if (typeof name !== "string" || !name.trim() || name.trim().length > 200) {
      throw new Error("Project name must be between 1 and 200 characters");
    }
    return name.trim();
  }
}
