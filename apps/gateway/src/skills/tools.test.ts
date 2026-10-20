import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeSkillSave } from "./tools.js";
import { SkillStore } from "./store.js";

const fixture = vi.hoisted(() => ({ home: "", multiUser: false, db: undefined as Database.Database | undefined }));
vi.mock("../config/index.js", () => ({ get CONFIG_DIR() { return fixture.home; }, loadConfig: () => ({ extensions: { multiUser: { enabled: fixture.multiUser } } }) }));
vi.mock("../extensions/registry.js", async (original) => ({ ...await original<typeof import("../extensions/registry.js")>(), isExtensionLoaded: () => fixture.multiUser }));
vi.mock("@yoplai/extension-multi-user", async (original) => ({
  ...await original<typeof import("@yoplai/extension-multi-user")>(),
  getMultiUserRuntime: () => fixture.db ? { db: fixture.db } : undefined,
}));

beforeEach(async () => {
  fixture.home = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-skill-save-"));
  fixture.multiUser = false;
  fixture.db = new Database(":memory:");
  fixture.db.exec("CREATE TABLE user (id TEXT PRIMARY KEY, email TEXT, approved INTEGER, role TEXT, banned INTEGER)");
  for (const id of ["alice", "bob"]) fixture.db.prepare("INSERT INTO user VALUES (?, ?, 1, 'user', 0)").run(id, `${id}@example.com`);
});
afterEach(async () => { fixture.db?.close(); fixture.db = undefined; await fs.rm(fixture.home, { recursive: true, force: true }); });
const input = (body = "Use concise writing.") => ({ name: "personal-writing", files: [{ path: "SKILL.md", content: `---\nname: personal-writing\ndescription: Writing guidance\n---\n${body}` }] });

describe("skill_save tool", () => {
  it("saves to the local owner in a single-user userless run and replaces by name with a version", async () => {
    const saved = await executeSkillSave(input(), { userId: undefined });
    const store = new SkillStore(fixture.home);
    expect((await store.get(saved.id))?.ownerId).toBe("local");
    expect(saved.url).toBe(`/skills/${saved.id}`);
    const replaced = await executeSkillSave(input("Use clear examples."), { userId: "transport-id" });
    expect(replaced.id).toBe(saved.id);
    expect((await store.detail(saved.id)).skillMd).toContain("Use clear examples.");
    expect(await store.versions(saved.id)).toHaveLength(1);
    expect((await store.getState("local")).enabled).toEqual([]);
  });
  it("lets a named writer replace by id while keeping ownership and sharing", async () => {
    fixture.multiUser = true;
    const store = new SkillStore(fixture.home);
    const { skill } = await store.create("alice", input());
    await store.shares(skill.id, [{ kind: "user", id: "bob", mode: "write" }]);
    const saved = await executeSkillSave({ ...input("Use friendly examples."), skillId: skill.id }, { userId: "bob" });
    expect(saved.id).toBe(skill.id);
    expect((await store.get(skill.id))?.ownerId).toBe("alice");
    expect((await store.get(skill.id))?.shares).toEqual([{ kind: "user", id: "bob", mode: "write" }]);
    expect((await store.detail(skill.id)).skillMd).toContain("Use friendly examples.");
  });
  it("rejects userless multi-user saves, ineligible users, and name collisions without altering a shared skill", async () => {
    fixture.multiUser = true;
    const store = new SkillStore(fixture.home);
    const { skill } = await store.create("alice", input());
    await store.shares(skill.id, [{ kind: "user", id: "bob", mode: "read" }]);
    await expect(executeSkillSave(input(), {})).rejects.toThrow("Team-mode and userless");
    await expect(executeSkillSave(input(), { userId: "missing" })).rejects.toThrow("eligible requesting user");
    await expect(executeSkillSave(input(), { userId: "bob" })).rejects.toThrow("pass skillId");
    await expect(executeSkillSave({ ...input("Changed."), skillId: skill.id }, { userId: "bob" })).rejects.toThrow("not_found");
    expect((await store.detail(skill.id)).skillMd).toContain("Use concise writing.");
  });
  it("saves through the container gateway using its trusted requester rather than submitted identity", async () => {
    fixture.multiUser = true;
    const { createInternalTools } = await import("../server/internal-tools.js");
    const { registerContainerToken, removeContainerToken } = await import("../sdk/container/tokens.js");
    registerContainerToken("skill-save-fixture", { agentId: "assistant", sessionId: "chat", userId: "bob", runId: "run", containerName: "offline", roots: { workspace: fixture.home, data: fixture.home, uploads: fixture.home } });
    try {
      const app = createInternalTools();
      const response = await app.request("/tools", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        tool: "skill_save", agentToken: "skill-save-fixture", agentId: "assistant", sessionId: "chat",
        args: { ...input(), userId: "alice" },
      }) });
      expect(response.status).toBe(200);
      const saved = await response.json() as { id: string };
      expect((await new SkillStore(fixture.home).get(saved.id))?.ownerId).toBe("bob");
    } finally { removeContainerToken("skill-save-fixture"); }
  });
});
