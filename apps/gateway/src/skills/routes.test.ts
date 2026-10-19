import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { getEligibleAccount } from "@yoplai/extension-multi-user";
import { SkillStore } from "./store.js";
import { SkillAccessPolicy } from "./access.js";
import { createSkillRoutes } from "./routes.js";
import { ImportTokenStore } from "./import-tokens.js";
import { SettingsAuditStore } from "../audit/store.js";

let home: string;
let db: Database.Database | undefined;
const auditStores: SettingsAuditStore[] = [];
beforeEach(async () => { home = await fs.mkdtemp(path.join(os.tmpdir(), "skills-http-")); });
afterEach(async () => { db?.close(); db = undefined; for (const audit of auditStores.splice(0)) audit.close(); await fs.rm(home, { recursive: true, force: true }); });
const skillText = "---\nname: meeting-notes\ndescription: Summarize a meeting.\n---\nWrite three bullets.";
function upload(text = skillText) {
  const body = new FormData();
  body.append("files", new File([text], "SKILL.md"));
  return body;
}
function setup(multiUser = false, agents: { id: string; name: string; directory: string }[] = []) {
  const store = new SkillStore(home);
  if (multiUser) {
    db = new Database(":memory:");
    db.exec("CREATE TABLE user(id TEXT, name TEXT, email TEXT, role TEXT, approved INTEGER, banned INTEGER)");
    const insert = db.prepare("INSERT INTO user VALUES (?, ?, ?, ?, ?, ?)");
    for (const id of ["alice", "bob", "carol", "dave", "root", "banned", "pending"]) insert.run(id, id, `${id}@test.invalid`, id === "root" ? "superadmin" : "user", id === "pending" ? 0 : 1, id === "banned" ? 1 : 0);
  }
  const policy = new SkillAccessPolicy({ multiUser, getEligibleAccount: (id) => db ? getEligibleAccount(db, id) : undefined });
  const tokens = new ImportTokenStore(home);
  const audit = new SettingsAuditStore(path.join(home, "audit.db"));
  auditStores.push(audit);
  const routes = createSkillRoutes({
    getContext: async () => ({ store, policy, multiUser }), tokens,
    getActor: async (c) => {
      if (!multiUser) return { userId: "local", role: "superadmin" };
      const account = db && getEligibleAccount(db, c.req.header("x-test-user") ?? "alice");
      return account ? { userId: account.id, role: account.role } : undefined;
    },
    getAgents: async () => agents, getOwnerName: async () => "You",
    getRecipients: async () => multiUser ? ["alice", "bob", "carol", "dave", "root"].map((id) => ({ id, name: id, email: `${id}@test.invalid` })) : [], publicBaseUrl: () => "https://skills.example.test",
    audit: async (c, action, targetId, changes) => audit.record({ actorUserId: c.req.header("x-test-user") ?? (multiUser ? "alice" : "local"), action, targetType: "skill", targetId, changes }),
  });
  return { routes, store, tokens, audit };
}

describe("Skills HTTP", () => {
  it("creates a private disabled skill, confirms an own-name conflict before replacing, and exposes its files", async () => {
    const { routes } = setup();
    const created = await routes.request("/skills", { method: "POST", body: upload() });
    expect(created.status).toBe(201);
    const { id } = await created.json();
    expect(await (await routes.request("/skills")).json()).toMatchObject({ mine: [{ id, name: "meeting-notes", enabled: false, canManage: true }] });
    const conflict = await routes.request("/skills", { method: "POST", body: upload(skillText + "\nNew draft") });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "skill_exists", id });
    expect(await (await routes.request(`/skills/${id}`)).json()).toMatchObject({ skillMd: skillText, files: [{ path: "SKILL.md", size: Buffer.byteLength(skillText) }] });
    expect((await routes.request(`/skills/${id}/content`, { method: "PUT", body: upload(skillText + "\nNew draft") })).status).toBe(200);
    expect(await (await routes.request(`/skills/${id}`)).json()).toMatchObject({ skillMd: skillText + "\nNew draft" });
    expect(await fs.readFile(path.join(home, "skill-library/users/local/meeting-notes/SKILL.md"), "utf8")).toBe(skillText + "\nNew draft");
  });

  it("shares read/write content independently of ownership, validates recipients, and preserves grants through restore", async () => {
    const { routes } = setup(true);
    const request = (suffix: string, method = "GET", body?: unknown, user = "alice") => routes.request(`/skills${suffix}`, { method, headers: { "x-test-user": user, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const { id } = await (await routes.request("/skills", { method: "POST", body: upload() })).json();
    const shares = [{ kind: "user", id: "bob", mode: "read" }, { kind: "user", id: "carol", mode: "write" }];
    expect((await request(`/${id}/shares`, "PUT", { shares })).status).toBe(200);
    for (const invalid of [[{ kind: "all", mode: "write" }], [{ kind: "user", id: "banned", mode: "read" }], [{ kind: "user", id: "pending", mode: "read" }]]) {
      expect((await request(`/${id}/shares`, "PUT", { shares: invalid })).status).toBe(400);
    }
    expect(await (await request("", "GET", undefined, "bob")).json()).toMatchObject({ mine: [], sharedWithMe: [{ id, canRead: true, canWrite: false, canManage: false }] });
    expect((await request(`/${id}/enabled`, "PUT", { enabled: true }, "bob")).status).toBe(200);
    expect((await request(`/${id}/shares`, "PUT", { shares: [] }, "carol")).status).toBe(403);
    expect((await routes.request(`/skills/${id}/content`, { method: "PUT", body: upload(skillText + "\nWriter revision"), headers: { "x-test-user": "carol" } })).status).toBe(200);
    expect((await routes.request(`/skills/${id}/content`, { method: "PUT", body: upload(), headers: { "x-test-user": "bob" } })).status).toBe(404);
    expect((await request(`/${id}/versions`, "GET", undefined, "bob")).status).toBe(404);
    const { versions } = await (await request(`/${id}/versions`, "GET", undefined, "carol")).json();
    expect(versions).toHaveLength(1);
    expect((await request(`/${id}/versions/${versions[0].id}/restore`, "POST", {}, "carol")).status).toBe(200);
    expect(await (await request(`/${id}`)).json()).toMatchObject({ skillMd: skillText, shares });
    expect((await request(`/${id}`, "DELETE", undefined, "carol")).status).toBe(403);
    expect((await request(`/${id}/shares`, "PUT", { shares: [] })).status).toBe(200);
    expect(await (await request("", "GET", undefined, "bob")).json()).toMatchObject({ sharedWithMe: [] });
    expect((await request(`/${id}`, "GET", undefined, "bob")).status).toBe(404);
    expect((await request(`/${id}`, "DELETE")).status).toBe(200);
    expect((await request(`/${id}`)).status).toBe(404);
  });

  it("groups curated, locked built-in and legacy agent skills with read-only detail and per-user default switches", async () => {
    const agentDir = path.join(home, "agents/hr/skills");
    const defaultDir = path.join(home, "skill-library/default/meeting-notes");
    await fs.mkdir(path.join(agentDir, "meeting-notes"), { recursive: true });
    await fs.mkdir(defaultDir, { recursive: true });
    await fs.writeFile(path.join(agentDir, "meeting-notes/SKILL.md"), skillText);
    await fs.writeFile(path.join(defaultDir, "SKILL.md"), skillText);
    const { routes } = setup(false, [{ id: "hr", name: "HR", directory: agentDir }]);
    const list = await (await routes.request("/skills")).json();
    expect(list).toMatchObject({ default: expect.arrayContaining([
      expect.objectContaining({ id: "default:meeting-notes", enabled: true, locked: false }),
      expect.objectContaining({ id: "builtin:dashboard", enabled: true, locked: true }),
    ]), agent: [expect.objectContaining({ id: "agent:hr:meeting-notes", agentId: "hr", agentName: "HR", locked: true })], sharedWithMe: [] });
    for (const id of ["default:meeting-notes", "agent:hr:meeting-notes", "builtin:dashboard"]) {
      expect((await routes.request(`/skills/${encodeURIComponent(id)}`)).status).toBe(200);
      expect((await routes.request(`/skills/${encodeURIComponent(id)}/content`, { method: "PUT", body: upload() })).status).toBe(404);
    }
    const enable = (id: string) => routes.request(`/skills/${encodeURIComponent(id)}/enabled`, { method: "PUT", headers: { "content-type": "application/json" }, body: '{"enabled":false}' });
    expect((await enable("default:meeting-notes")).status).toBe(200);
    expect((await enable("builtin:dashboard")).status).toBe(400);
    expect((await enable("agent:hr:meeting-notes")).status).toBe(400);
    expect(await (await routes.request("/skills")).json()).toMatchObject({ default: expect.arrayContaining([expect.objectContaining({ id: "default:meeting-notes", enabled: false })]) });
    const collision = await routes.request("/skills", { method: "POST", body: upload() });
    expect(collision.status).toBe(409);
    expect(await collision.json()).toEqual({ error: "name_taken", kind: "default" });
  });

  it("imports with a one-time displayed token, replaces only its owner's skills, and rejects revoked, expired and foreign tokens", async () => {
    const { routes, store, tokens } = setup(true);
    const created = await routes.request("/skills/import-token", { method: "POST" });
    expect(created.status).toBe(201);
    const token = await created.json();
    expect(token.expiresAt - token.createdAt).toBe(86_400_000);
    expect(token.prompt.includes(token.token)).toBe(true);
    expect(token.prompt).toContain("https://skills.example.test/api/skills/import");
    expect(token.prompt).toContain("SKILL.md");
    const listed = await (await routes.request("/skills/import-token")).json();
    expect(listed.tokens).toEqual([{ id: token.id, createdAt: token.createdAt, expiresAt: token.expiresAt }]);
    expect((await fs.readFile(path.join(home, "skill-library/import-tokens.json"), "utf8")).includes(token.token)).toBe(false);
    const send = (bearer: string, text = skillText) => routes.request("/skills/import", { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: JSON.stringify({ name: "meeting-notes", files: [{ path: "SKILL.md", content: text }] }) });
    const imported = await send(token.token);
    expect(imported.status).toBe(201);
    const { id } = await imported.json();
    expect((await store.get(id))?.ownerId).toBe("alice");
    expect(await store.getState("alice")).toMatchObject({ enabled: [] });
    expect(await (await send(token.token, skillText + "\nImported update")).json()).toMatchObject({ id, replaced: true });
    const foreign = await tokens.create("bob");
    expect((await send(foreign.token)).status).toBe(409);
    expect((await routes.request(`/skills/import-token/${token.id}`, { method: "DELETE", headers: { "x-test-user": "bob" } })).status).toBe(404);
    expect((await routes.request(`/skills/import-token/${token.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await send(token.token)).status).toBe(401);
    const old = await new ImportTokenStore(home, { now: () => Date.now() - 86_400_001 }).create("alice");
    expect((await send(old.token)).status).toBe(401);
    expect((await send("unrelated-token")).status).toBe(401);
    expect((await routes.request("/skills", { headers: { authorization: `Bearer ${foreign.token}` } })).status).toBe(401);
    const banned = await tokens.create("banned");
    expect((await send(banned.token)).status).toBe(403);
  });

  it("lets superadmins inspect all skills and disable platform shares without gaining content or sharing control", async () => {
    const { routes, store } = setup(true);
    const { skill } = await store.create("alice", { files: [{ path: "SKILL.md", content: skillText }] });
    const { id } = skill;
    const request = (suffix: string, method = "GET", body?: unknown, user = "root") => routes.request(suffix, { method, headers: { "x-test-user": user, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    expect((await request("/admin/skills", "GET", undefined, "alice")).status).toBe(403);
    expect(await (await request("/admin/skills")).json()).toMatchObject({ skills: [{ id, ownerId: "alice", enabledCount: 0, canWrite: false, canManage: false, collisions: [] }] });
    expect((await request(`/skills/${id}/shares`, "PUT", { shares: [] })).status).toBe(403);
    expect((await request(`/skills/${id}/admin`, "PUT", { disabledByAdmin: true })).status).toBe(400);
    await store.shares(id, [{ kind: "all", mode: "read" }]);
    await store.setEnabled("alice", id, true);
    expect((await request(`/skills/${id}/admin`, "PUT", { disabledByAdmin: true })).status).toBe(200);
    expect((await store.get(id))?.disabledByAdmin).toBe(true);
    await store.shares(id, []);
    expect((await request(`/skills/${id}/admin`, "PUT", { disabledByAdmin: false })).status).toBe(200);
    expect((await store.get(id))?.disabledByAdmin).toBe(false);
    expect((await request(`/skills/${id}`, "DELETE")).status).toBe(403);
    await store.shares(id, [{ kind: "all", mode: "read" }]);
    expect((await request(`/skills/${id}`, "DELETE")).status).toBe(200);
  });

  it("reports managed-name shadowing without applying agent restrictions and clears it when the default is disabled", async () => {
    const { routes, store } = setup();
    const { skill } = await store.create("local", { files: [{ path: "SKILL.md", content: skillText }] });
    await store.setEnabled("local", skill.id, true);
    const directory = path.join(home, "skill-library/default/meeting-notes");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "SKILL.md"), skillText);
    await fs.writeFile(path.join(directory, ".yoplai.json"), '{"agents":["hr"]}');
    expect(await (await routes.request("/skills")).json()).toMatchObject({ mine: [{ id: skill.id, shadowed: true }] });
    await store.setEnabled("local", "default:meeting-notes", false);
    expect(await (await routes.request("/skills")).json()).toMatchObject({ mine: [{ id: skill.id, shadowed: false }] });
  });

  it("bounds announced and streamed upload bodies, preserves nested paths, and accepts a valid upload after rejection", async () => {
    const { routes } = setup();
    expect((await routes.request("/skills", { method: "POST", headers: { "content-length": String(26 * 1024 * 1024) }, body: "x" })).status).toBe(413);
    let chunks = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      if (chunks++ < 26) controller.enqueue(new Uint8Array(1024 * 1024));
      else controller.close();
    } });
    const streamed = new Request("http://localhost/skills", { method: "POST", body, duplex: "half" } as RequestInit & { duplex: "half" });
    expect((await routes.request(streamed)).status).toBe(413);
    expect(await fs.readdir(home)).toEqual([]);
    const valid = upload();
    valid.append("files", new File(["echo ok"], "scripts/run.sh"));
    const created = await routes.request("/skills", { method: "POST", body: valid });
    expect(created.status).toBe(201);
    const { id } = await created.json();
    expect(await (await routes.request(`/skills/${id}`)).json()).toMatchObject({ files: [{ path: "scripts/run.sh", size: 7 }, { path: "SKILL.md", size: Buffer.byteLength(skillText) }] });
  });

  it("audits sharing, admin disable, deletion and token lifecycle without token plaintext", async () => {
    const { routes, store, audit } = setup(true);
    const { skill } = await store.create("alice", { files: [{ path: "SKILL.md", content: skillText }] });
    const request = (url: string, method: string, body?: unknown, user = "alice") => routes.request(url, { method, headers: { "x-test-user": user, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const token = await (await request("/skills/import-token", "POST")).json();
    expect((await request(`/skills/import-token/${token.id}`, "DELETE")).status).toBe(200);
    expect((await request(`/skills/${skill.id}/shares`, "PUT", { shares: [{ kind: "all", mode: "read" }] })).status).toBe(200);
    expect((await request(`/skills/${skill.id}/admin`, "PUT", { disabledByAdmin: true }, "root")).status).toBe(200);
    expect((await request(`/skills/${skill.id}`, "DELETE")).status).toBe(200);
    const entries = audit.list().entries;
    expect(entries.map((entry) => entry.action).sort()).toEqual(["skill.admin", "skill.delete", "skill.import_token_create", "skill.import_token_revoke", "skill.shares"]);
    expect(JSON.stringify(entries).includes(token.token)).toBe(false);
  });

  it("shows legacy skills with Pi's directory-name fallback and nested discovery unchanged", async () => {
    const directory = path.join(home, "agent-skills");
    await fs.mkdir(path.join(directory, "legacy"), { recursive: true });
    await fs.mkdir(path.join(directory, "category/folder-name"), { recursive: true });
    const fallback = "---\ndescription: A legacy skill without a name.\n---\nKeep legacy behavior.";
    await fs.writeFile(path.join(directory, "legacy/SKILL.md"), fallback);
    await fs.writeFile(path.join(directory, "category/folder-name/SKILL.md"), "---\nname: canonical-name\ndescription: A nested legacy skill.\n---\nNested behavior.");
    const { routes } = setup(false, [{ id: "hr", name: "HR", directory }]);
    const list = await (await routes.request("/skills")).json();
    expect(list.agent.map((skill: { name: string }) => skill.name).sort()).toEqual(["canonical-name", "legacy"]);
    const row = list.agent.find((skill: { name: string }) => skill.name === "legacy");
    expect(await (await routes.request(`/skills/${encodeURIComponent(row.id)}`)).json()).toMatchObject({ skillMd: fallback, locked: true });
  });
});
