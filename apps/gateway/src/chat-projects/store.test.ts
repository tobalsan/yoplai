import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatProjectStore, isSafeChatProjectId } from "./store.js";

describe("ChatProjectStore", () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "chat-projects-")); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it("persists CRUD, unique ids and user isolation", async () => {
    const store = new ChatProjectStore(dir, "alice");
    expect(await store.list()).toEqual([]);
    const project = await store.create("  Research  ");
    const other = await store.create("Research");
    expect(project.name).toBe("Research");
    expect(other.id).not.toBe(project.id);
    expect(isSafeChatProjectId(project.id)).toBe(true);
    expect(await new ChatProjectStore(dir, "alice").get(project.id)).toEqual(project);
    expect(await new ChatProjectStore(dir, "bob").get(project.id)).toBeNull();
    expect(await new ChatProjectStore(dir).list()).toEqual([]);
    expect(await store.update(project.id, "Renamed")).toMatchObject({ ...project, name: "Renamed", updatedAt: expect.any(Number) });
    expect(await store.delete(project.id)).toBe(true);
    expect(await store.delete(project.id)).toBe(false);
    expect(await store.list()).toEqual([other]);
    expect(await store.update(project.id, "Missing")).toBeNull();
  });

  it("stores instructions independently of the name and supports clearing them", async () => {
    const store = new ChatProjectStore(dir);
    const project = await store.create("Research");
    await store.update(project.id, { instructions: "Use primary sources." });
    await store.update(project.id, { name: "Work" });
    expect(await store.get(project.id)).toMatchObject({ name: "Work", instructions: "Use primary sources." });
    await store.update(project.id, { instructions: "" });
    expect(await store.get(project.id)).toMatchObject({ instructions: "" });
  });

  it("stores originals, metadata and deletions within the owning user project", async () => {
    const store = new ChatProjectStore(dir, "alice");
    const project = await store.create("Research");
    const file = { id: "file-1", name: "notes.txt", mimeType: "text/plain", size: 5, createdAt: 1, text: "Notes" };
    await store.addFile(project.id, file, Buffer.from("Notes"));
    expect(await fs.readFile(path.join(store.filesDirectory(project.id), file.id), "utf8")).toBe("Notes");
    expect(await store.listFiles(project.id)).toEqual([file]);
    expect(await new ChatProjectStore(dir, "bob").listFiles(project.id)).toEqual([]);
    expect(await store.deleteFile(project.id, "../escape").catch((error: Error) => error.message)).toBe("Invalid file id");
    expect(await store.deleteFile(project.id, file.id)).toBe(true);
    expect(await store.listFiles(project.id)).toEqual([]);
    expect(await fs.readdir(store.filesDirectory(project.id))).toEqual([]);
    expect(await store.deleteFile(project.id, file.id)).toBe(false);
  });

  it("serializes concurrent file mutations across store instances", async () => {
    const store = new ChatProjectStore(dir);
    const project = await store.create("Research");
    const files = Array.from({ length: 10 }, (_, index) => ({ id: "file-" + index, name: "notes.txt", mimeType: "text/plain", size: 5, createdAt: 1 }));
    await Promise.all(files.map((file) => new ChatProjectStore(dir).addFile(project.id, file, Buffer.from("Notes"))));
    expect(await store.listFiles(project.id)).toHaveLength(10);
    await Promise.all(files.map((file) => store.deleteFile(project.id, file.id)));
    expect(await store.listFiles(project.id)).toEqual([]);
  });

  it("keeps one agent-added entry when the same sent name and bytes are repeated", async () => {
    const store = new ChatProjectStore(dir);
    const project = await store.create("Research");
    const file = { id: "first", name: "report.txt", mimeType: "text/plain", size: 5, createdAt: 1 };
    const first = await store.addFileDeduped(project.id, file, Buffer.from("Notes"));
    const repeated = await store.addFileDeduped(project.id, { ...file, id: "second" }, Buffer.from("Notes"));
    expect(first).toMatchObject({ status: "added", file: { id: "first", name: "report.txt", sourceName: "report.txt" } });
    expect(repeated).toEqual({ status: "already_in_project", file: first.file });
    expect(await store.listFiles(project.id)).toEqual([first.file]);
    expect(await fs.readdir(store.filesDirectory(project.id))).toEqual(["first"]);
    expect(await fs.readFile(path.join(store.filesDirectory(project.id), "first"), "utf8")).toBe("Notes");
  });

  it("keeps differing contents under free suffixed names and dedupes a resent version", async () => {
    const store = new ChatProjectStore(dir);
    const project = await store.create("Research");
    const file = { id: "upload", name: "report.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: 3, createdAt: 1 };
    await store.addFile(project.id, file, Buffer.from("old"));
    const second = await store.addFileDeduped(project.id, { ...file, id: "agent-2" }, Buffer.from("new"));
    const third = await store.addFileDeduped(project.id, { ...file, id: "agent-3" }, Buffer.from("now"));
    const resent = await store.addFileDeduped(project.id, { ...file, id: "agent-4" }, Buffer.from("new"));
    expect(second).toMatchObject({ status: "added", file: { name: "report (2).xlsx", sourceName: "report.xlsx" } });
    expect(third).toMatchObject({ status: "added", file: { name: "report (3).xlsx" } });
    expect(resent).toEqual({ status: "already_in_project", file: second.file });
    expect((await store.listFiles(project.id)).map((item) => item.name)).toEqual(["report.xlsx", "report (2).xlsx", "report (3).xlsx"]);
    expect(await fs.readFile(path.join(store.filesDirectory(project.id), "upload"), "utf8")).toBe("old");
    expect(await fs.readFile(path.join(store.filesDirectory(project.id), "agent-2"), "utf8")).toBe("new");
  });

  it("keeps suffixed names within 200 characters while preserving the extension", async () => {
    const store = new ChatProjectStore(dir);
    const project = await store.create("Research");
    const file = { id: "first", name: "x".repeat(196) + ".txt", mimeType: "text/plain", size: 3, createdAt: 1 };
    await store.addFileDeduped(project.id, file, Buffer.from("old"));
    const result = await store.addFileDeduped(project.id, { ...file, id: "second" }, Buffer.from("new"));
    expect(result.file.name).toBe("x".repeat(192) + " (2).txt");
    expect(result.file.name).toHaveLength(200);
  });

  it("does not recreate a deleted project when an agent adds a file", async () => {
    const store = new ChatProjectStore(dir);
    const project = await store.create("Research");
    await store.delete(project.id);
    const file = { id: "late", name: "report.txt", mimeType: "text/plain", size: 3, createdAt: 1 };
    await expect(store.addFileDeduped(project.id, file, Buffer.from("new"))).rejects.toThrow("Project not found");
    expect(await store.get(project.id)).toBeNull();
    await expect(fs.stat(path.dirname(store.filesDirectory(project.id)))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("dedupes concurrent sends across store instances while leaving uploads separate", async () => {
    const store = new ChatProjectStore(dir);
    const project = await store.create("Research");
    const file = { id: "uploaded", name: "report.txt", mimeType: "text/plain", size: 3, createdAt: 1 };
    await store.addFile(project.id, file, Buffer.from("abc"));
    const results = await Promise.all(["first", "second"].map((id) => new ChatProjectStore(dir).addFileDeduped(project.id, { ...file, id }, Buffer.from("abc"))));
    expect(results.map((result) => result.status)).toEqual(["added", "already_in_project"]);
    expect(results[0]!.file).toMatchObject({ name: "report (2).txt", sourceName: "report.txt", sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" });
    expect(await store.listFiles(project.id)).toHaveLength(2);
    expect(results[1]!.file).toEqual(results[0]!.file);
  });

  it("persists project references and notes with isolated, serialized mutations", async () => {
    const store = new ChatProjectStore(dir, "alice");
    const project = await store.create("Memory");
    expect(await store.listReferences(project.id)).toEqual([]);
    expect(await store.getNotes(project.id)).toBe("");
    const references = await Promise.all(Array.from({ length: 5 }, (_, index) => new ChatProjectStore(dir, "alice").addReference(project.id, { title: "Wiki " + index, description: "Useful", path: "/wiki/" + index })));
    expect(await store.listReferences(project.id)).toEqual(references);
    expect(await new ChatProjectStore(dir, "bob").listReferences(project.id)).toEqual([]);
    await expect(new ChatProjectStore(dir, "bob").appendNotes(project.id, "Foreign")).rejects.toThrow("Project not found");
    await Promise.all([store.appendNotes(project.id, "Sally learned this"), new ChatProjectStore(dir, "alice").appendNotes(project.id, "Casey learned that")]);
    expect(await store.getNotes(project.id)).toMatch(/- \[\d{4}-\d{2}-\d{2}\] Sally learned this\n- \[\d{4}-\d{2}-\d{2}\] Casey learned that\n/);
    expect(await new ChatProjectStore(dir, "bob").getNotes(project.id)).toBe("");
    await store.putNotes(project.id, "Edited notes");
    expect(await new ChatProjectStore(dir, "alice").getNotes(project.id)).toBe("Edited notes");
    await store.putNotes(project.id, "");
    expect(await store.getNotes(project.id)).toBe("");
    expect(await store.deleteReference(project.id, references[0]!.id)).toBe(true);
    expect(await store.deleteReference(project.id, references[0]!.id)).toBe(false);
    expect(await store.listReferences(project.id)).toEqual(references.slice(1));
  });

  it("rejects unsafe paths and empty or oversized names", async () => {
    const store = new ChatProjectStore(dir);
    for (const id of ["", "..", "../escape", "a/b", "a\\b", "\0", "a".repeat(101)]) {
      await expect(store.get(id)).rejects.toThrow("Invalid project id");
      await expect(store.update(id, "Name")).rejects.toThrow("Invalid project id");
      await expect(store.delete(id)).rejects.toThrow("Invalid project id");
    }
    expect(() => new ChatProjectStore(dir, "../escape")).toThrow("Invalid user id");
    await expect(store.create(" ")).rejects.toThrow("Project name");
    await expect(store.create("x".repeat(201))).rejects.toThrow("Project name");
    expect(await fs.readdir(dir)).toEqual([]);
  });
});
