import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createManagedSkillsStaging, getBuiltInSkillsDir } from "./skills.js";
import { SkillStore } from "../../skills/store.js";
import { SkillAccessPolicy } from "../../skills/access.js";
import { resolveRunSkills } from "../../skills/resolver.js";

let home: string;
beforeEach(async () => { home = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-skill-loader-")); });
afterEach(async () => { await fs.rm(home, { recursive: true, force: true }); });

async function loadedSkills(paths: string[]) {
  const loader = new DefaultResourceLoader({
    cwd: home, agentDir: home,
    settingsManager: SettingsManager.inMemory({}),
    noExtensions: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalSkillPaths: paths,
  });
  await loader.reload();
  return loader.getSkills().skills;
}

describe("Pi managed skills loading", () => {
  it("loads the dashboard and skill-creator built-ins", async () => {
    const skills = await loadedSkills([getBuiltInSkillsDir()]);
    expect(skills.map((skill) => skill.name)).toEqual(expect.arrayContaining(["dashboard", "skill-creator"]));
  });
  it("loads the requester’s enabled skills on the next run and excludes them for another requester", async () => {
    const store = new SkillStore(home);
    const { skill } = await store.create("alice", { files: [{ path: "SKILL.md", content: "---\nname: personal-writing\ndescription: Personal writing guidance\n---\nUse short sentences." }] });
    await store.setEnabled("alice", skill.id, true);
    const policy = new SkillAccessPolicy({ multiUser: true, getEligibleAccount: (id) => ({ id, role: "user" }) });
    async function loadFor(userId: string) {
      const selected = await resolveRunSkills(store, { agentId: "assistant", userId, multiUser: true, policy });
      const staging = await createManagedSkillsStaging(selected.skills);
      try { return await loadedSkills([staging.directory]); }
      finally { await staging.cleanup(); }
    }
    expect((await loadFor("alice")).map((item) => item.name)).toContain("personal-writing");
    expect((await loadFor("bob")).map((item) => item.name)).not.toContain("personal-writing");
    await store.setEnabled("alice", skill.id, false);
    expect((await loadFor("alice")).map((item) => item.name)).not.toContain("personal-writing");
  });
  it("keeps a superadmin’s private-skill inspection access out of runtime selection", async () => {
    const store = new SkillStore(home);
    const { skill } = await store.create("alice", { files: [{ path: "SKILL.md", content: "---\nname: private-alice\ndescription: Alice only\n---\nPrivate guidance." }] });
    await store.setEnabled("root", skill.id, true);
    const policy = new SkillAccessPolicy({ multiUser: true, getEligibleAccount: (id) => ({ id, role: id === "root" ? "superadmin" : "user" }) });
    const selected = await resolveRunSkills(store, { agentId: "assistant", userId: "root", multiUser: true, policy });
    const staging = await createManagedSkillsStaging(selected.skills);
    try { expect((await loadedSkills([staging.directory])).map((item) => item.name)).not.toContain("private-alice"); }
    finally { await staging.cleanup(); }
  });
  it("uses the local owner for userless single-user jobs and defaults only for multi-user Team runs", async () => {
    const store = new SkillStore(home);
    const { skill } = await store.create("local", { files: [{ path: "SKILL.md", content: "---\nname: local-writing\ndescription: Local guidance\n---\nLocal only." }] });
    await store.setEnabled("local", skill.id, true);
    const defaultDir = path.join(home, "skill-library/default/standard-writing");
    await fs.mkdir(defaultDir, { recursive: true });
    await fs.writeFile(path.join(defaultDir, "SKILL.md"), "---\nname: standard-writing\ndescription: Standard guidance\n---\nStandard.");
    for (const multiUser of [false, true]) {
      const policy = new SkillAccessPolicy({ multiUser });
      const selected = await resolveRunSkills(store, { agentId: "assistant", multiUser, policy });
      const staging = await createManagedSkillsStaging(selected.skills);
      try {
        const names = (await loadedSkills([staging.directory])).map((item) => item.name);
        expect(names).toContain("standard-writing");
        if (multiUser) expect(names).not.toContain("local-writing");
        else expect(names).toContain("local-writing");
      } finally { await staging.cleanup(); }
    }
  });
  it("honors default restrictions and requester disables while preserving defaults for ineligible users", async () => {
    const store = new SkillStore(home);
    const directory = path.join(home, "skill-library/default/hr-writing");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "SKILL.md"), "---\nname: hr-writing\ndescription: HR guidance\n---\nHR only.");
    await fs.writeFile(path.join(directory, ".yoplai.json"), JSON.stringify({ agents: ["hr"] }));
    let eligible = true;
    const policy = new SkillAccessPolicy({ multiUser: true, getEligibleAccount: (id) => eligible ? { id, role: "user" } : undefined });
    async function names(agentId: string) {
      const selected = await resolveRunSkills(store, { agentId, userId: "alice", multiUser: true, policy });
      const staging = await createManagedSkillsStaging(selected.skills);
      try { return (await loadedSkills([staging.directory])).map((item) => item.name); }
      finally { await staging.cleanup(); }
    }
    expect(await names("hr")).toContain("hr-writing");
    expect(await names("assistant")).not.toContain("hr-writing");
    await store.setEnabled("alice", "default:hr-writing", false);
    expect(await names("hr")).not.toContain("hr-writing");
    eligible = false;
    expect(await names("hr")).toContain("hr-writing");
  });
  it("removes a revoked share from the recipient’s next loaded skills", async () => {
    const store = new SkillStore(home);
    const { skill } = await store.create("alice", { files: [{ path: "SKILL.md", content: "---\nname: shared-writing\ndescription: Shared guidance\n---\nShared." }] });
    await store.shares(skill.id, [{ kind: "user", id: "bob", mode: "read" }]);
    await store.setEnabled("bob", skill.id, true);
    const policy = new SkillAccessPolicy({ multiUser: true, getEligibleAccount: (id) => ({ id, role: "user" }) });
    async function names() {
      const selected = await resolveRunSkills(store, { agentId: "assistant", userId: "bob", multiUser: true, policy });
      const staging = await createManagedSkillsStaging(selected.skills);
      try { return (await loadedSkills([staging.directory])).map((item) => item.name); }
      finally { await staging.cleanup(); }
    }
    expect(await names()).toContain("shared-writing");
    await store.shares(skill.id, []);
    expect(await names()).not.toContain("shared-writing");
  });
  it("excludes an admin-disabled skill even for its owner after platform sharing is withdrawn", async () => {
    const store = new SkillStore(home);
    const { skill } = await store.create("alice", { files: [{ path: "SKILL.md", content: "---\nname: moderated-writing\ndescription: Moderated guidance\n---\nModerated." }] });
    await store.shares(skill.id, [{ kind: "all", mode: "read" }]);
    await store.setEnabled("alice", skill.id, true);
    await store.setAdminDisabled(skill.id, true);
    await store.shares(skill.id, []);
    const policy = new SkillAccessPolicy({ multiUser: true, getEligibleAccount: (id) => ({ id, role: "user" }) });
    const selected = await resolveRunSkills(store, { agentId: "assistant", userId: "alice", multiUser: true, policy });
    const staging = await createManagedSkillsStaging(selected.skills);
    try { expect((await loadedSkills([staging.directory])).map((item) => item.name)).not.toContain("moderated-writing"); }
    finally { await staging.cleanup(); }
  });
  it("reports managed name collisions and lets an existing workspace skill shadow the winner", async () => {
    const store = new SkillStore(home);
    const { skill } = await store.create("alice", { files: [{ path: "SKILL.md", content: "---\nname: collision-writing\ndescription: Alice guidance\n---\nAlice." }] });
    await store.setEnabled("alice", skill.id, true);
    const directory = path.join(home, "skill-library/default/collision-writing");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "SKILL.md"), "---\nname: collision-writing\ndescription: Default guidance\n---\nDefault.");
    const policy = new SkillAccessPolicy({ multiUser: true, getEligibleAccount: (id) => ({ id, role: "user" }) });
    const selected = await resolveRunSkills(store, { agentId: "assistant", userId: "alice", multiUser: true, policy });
    expect(selected.diagnostics).toEqual([{ id: skill.id, name: "collision-writing", winnerId: "default:collision-writing" }]);
    const staging = await createManagedSkillsStaging(selected.skills);
    try {
      expect((await loadedSkills([staging.directory])).find((item) => item.name === "collision-writing")?.description).toBe("Default guidance");
      const legacy = path.join(home, "workspace-skills/collision-writing");
      await fs.mkdir(legacy, { recursive: true });
      await fs.writeFile(path.join(legacy, "SKILL.md"), "---\nname: collision-writing\ndescription: Workspace guidance\n---\nLegacy.");
      expect((await loadedSkills([path.dirname(legacy), staging.directory])).find((item) => item.name === "collision-writing")?.description).toBe("Workspace guidance");
    } finally { await staging.cleanup(); }
  });
});
