import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkillStore } from "./store.js";

let home: string;
beforeEach(async () => { home = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-skills-")); });
afterEach(async () => { await fs.rm(home, { recursive: true, force: true }); });
const input = (body = "Use a friendly greeting.") => ({ files: [{ path: "SKILL.md", content: `---\nname: greetings\ndescription: Friendly greetings\n---\n${body}` }] });

describe("user skills", () => {
  it("stores a validated skill privately and leaves it off until enabled", async () => {
    const store = new SkillStore(home);
    const { skill } = await store.create("alice", input());
    expect(await fs.readFile(path.join(home, "skill-library/users/alice/greetings/SKILL.md"), "utf8")).toContain("Use a friendly greeting.");
    expect((await store.detail(skill.id)).skillMd).toContain("description: Friendly greetings");
    expect((await store.getState("alice")).enabled).toEqual([]);
    await store.setEnabled("alice", skill.id, true);
    expect((await store.getState("alice")).enabled).toEqual([skill.id]);
  });
});

it("requires explicit replacement, preserves access, and retains ten restorable revisions", async () => {
  const store = new SkillStore(home);
  const { skill } = await store.create("alice", input("First release"));
  await store.shares(skill.id, [{ kind: "user", id: "bob", mode: "write" }]);
  await store.setEnabled("bob", skill.id, true);
  await expect(store.create("alice", input("Conflict"))).rejects.toMatchObject({ code: "skill_exists", status: 409, details: { id: skill.id } });
  expect((await store.detail(skill.id)).skillMd).toContain("First release");
  await expect(store.create("bob", input())).rejects.toMatchObject({ code: "name_taken", details: { kind: "user" } });
  await expect(store.replace(skill.id, { files: [{ path: "SKILL.md", content: "---\nname: renamed\ndescription: Nope\n---\nRejected" }] })).rejects.toMatchObject({ code: "name_mismatch" });
  for (let revision = 2; revision <= 12; revision++) await store.replace(skill.id, input(`Release ${revision}`));
  expect((await store.get(skill.id))?.shares).toEqual([{ kind: "user", id: "bob", mode: "write" }]);
  expect((await store.getState("bob")).enabled).toEqual([skill.id]);
  const versions = await store.versions(skill.id);
  expect(versions).toHaveLength(10);
  await store.restore(skill.id, versions[versions.length - 1].id);
  expect((await store.detail(skill.id)).skillMd).toContain("Release 2");
  expect(await store.versions(skill.id)).toHaveLength(10);
  await store.delete(skill.id);
  expect(await store.get(skill.id)).toBeNull();
  expect((await store.getState("bob")).enabled).toEqual([]);
  await expect(fs.stat(path.join(home, "skill-library/users/alice/greetings"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("rejects unsafe paths and invalid metadata before writing any user files", async () => {
  const store = new SkillStore(home);
  for (const unsafe of ["../outside", "/absolute", "a//b", "a/../b", "a\\b", ".hidden/inside", "C:/drive", `${"a/".repeat(20)}file`, "a".repeat(201)]) {
    await expect(store.create("alice", { files: [...input().files, { path: unsafe, content: "untrusted" }] })).rejects.toMatchObject({ code: "invalid_path" });
  }
  await expect(store.create("alice", { files: [...input().files, ...input().files] })).rejects.toMatchObject({ code: "duplicate_path" });
  await expect(store.create("alice", { files: [{ path: "SKILL.md", content: "---\nname: Bad--Name\ndescription: invalid\n---\nNo" }] })).rejects.toMatchObject({ code: "invalid_name" });
  await expect(store.create("alice", { files: [{ path: "SKILL.md", content: "---\nname: valid\n---\nNo" }] })).rejects.toMatchObject({ code: "missing_description" });
  await expect(store.create("alice", { name: "different", files: input().files })).rejects.toMatchObject({ code: "name_mismatch" });
  await expect(store.create("alice", { files: [...input().files, ...Array.from({ length: 200 }, (_, i) => ({ path: `f${i}`, content: "" }))] })).rejects.toMatchObject({ code: "too_many_entries" });
  await expect(store.create("alice", { files: [...input().files, { path: "large", content: "x".repeat(25 * 1024 * 1024) }] })).rejects.toMatchObject({ code: "content_too_large" });
  expect(await store.list()).toEqual([]);
  expect(await fs.readdir(home)).toEqual([]);
  const { skill } = await store.create("alice", { files: [...input().files, { path: ".env", content: "discard" }, { path: "references/context.txt", content: Buffer.from("binary\u0000context").toString("base64"), encoding: "base64" }] });
  expect((await store.detail(skill.id)).files.map((file) => file.path)).toEqual(["references/context.txt", "SKILL.md"]);
  expect(await fs.readFile(path.join(store.directory(skill), "references/context.txt"))).toEqual(Buffer.from("binary\u0000context"));
});

it("imports a wrapping zip and enforces expanded limits and special-entry rejection before writes", async () => {
  const archive = await fs.readFile(new URL("./fixtures/greetings.zip", import.meta.url));
  const store = new SkillStore(home);
  const { skill } = await store.create("alice", { zip: archive });
  expect((await store.detail(skill.id)).skillMd).toContain("A greeting from a zip.");
  expect((await store.detail(skill.id)).files.map((file) => file.path)).toEqual(["references/example.txt", "SKILL.md"]);
  const symbolic = Buffer.from(archive);
  let offset = symbolic.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  // The archive's first central record is a directory; mark the next file as a Unix symlink.
  offset = symbolic.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), offset + 4);
  symbolic.writeUInt32LE(0xa1ff0000, offset + 38);
  await expect(store.replace(skill.id, { zip: symbolic })).rejects.toMatchObject({ code: "special_entry" });
  const oversized = Buffer.from(archive);
  oversized.writeUInt32LE(25 * 1024 * 1024 + 1, offset + 24);
  await expect(store.replace(skill.id, { zip: oversized })).rejects.toMatchObject({ code: "content_too_large" });
  expect((await store.detail(skill.id)).skillMd).toContain("A greeting from a zip.");
  expect(await store.versions(skill.id)).toEqual([]);
});

it("bounds actual zip expansion even when the central directory lies about size", async () => {
  const store = new SkillStore(home);
  const archive = await fs.readFile(new URL("./fixtures/expanded.zip", import.meta.url));
  const central = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  archive.writeUInt32LE(1, central + 24);
  await expect(store.create("alice", { zip: archive })).rejects.toMatchObject({ code: "content_too_large", status: 413 });
  const many = await fs.readFile(new URL("./fixtures/greetings.zip", import.meta.url));
  const end = many.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  many.writeUInt16LE(201, end + 10);
  await expect(store.create("alice", { zip: many })).rejects.toMatchObject({ code: "too_many_entries" });
  const hidden = await fs.readFile(new URL("./fixtures/greetings.zip", import.meta.url));
  for (let i = 0; i < hidden.length - 9; i++) if (hidden.subarray(i, i + 9).toString() === "greetings") hidden.write("../escape", i);
  await expect(store.create("alice", { zip: hidden })).rejects.toMatchObject({ code: "invalid_path" });
  expect(await fs.readdir(home)).toEqual([]);
});

it("rejects oversized decoded base64 content with the documented size error", async () => {
  const store = new SkillStore(home);
  const encoded = Buffer.alloc(25 * 1024 * 1024 + 1, 65).toString("base64");
  await expect(store.create("alice", { files: [...input().files, { path: "large.bin", content: encoded, encoding: "base64" }] })).rejects.toMatchObject({ code: "content_too_large", status: 413 });
  expect(await fs.readdir(home)).toEqual([]);
});

it("skips a curated skill when its present agent-restriction sidecar is null", async () => {
  const directory = path.join(home, "skill-library/default/greetings");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "SKILL.md"), input().files[0].content);
  await fs.writeFile(path.join(directory, ".yoplai.json"), "null");
  const store = new SkillStore(home);
  expect(await store.defaults()).toEqual([]);
  await fs.rm(path.join(directory, ".yoplai.json"));
  expect((await store.defaults()).map((skill) => skill.name)).toEqual(["greetings"]);
});
