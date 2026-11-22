import { once } from "node:events";
import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { writeTestV3Config } from "../test-utils/v3-config.js";

const model = { provider: "fictional-provider", model: "fictional-model" };
vi.mock("../desktop/model-access.js", async (importOriginal) => {
  const { createModelAccess } = await importOriginal<typeof import("../desktop/model-access.js")>();
  return {
    createModelAccess(home: string) {
      return {
        ...createModelAccess(home),
        listModels: async () => [{ ...model, name: "Example Model", ready: true }],
        getAuth: async () => { throw new Error("provider unavailable"); },
      };
    },
  };
});

type Account = { id: string; cookie: string };
const modePath = "/api/admin/agent-management";

// ALG-751 Testing Decisions and the 16:11 Groom GO approve real HTTP here.
describe("agent management over HTTP", () => {
  let home: string;
  let origin: string;
  let server: ReturnType<typeof import("./index.js").startServer>;
  let stopAuth: (() => Promise<void>) | undefined;
  let superadmin: Account;
  let admin: Account;
  let member: Account;
  let other: Account;

  const get = (url: string, account: Account) => fetch(origin + url, { headers: { Cookie: account.cookie } });
  const write = (method: string, url: string, account: Account, body: unknown) => fetch(origin + url, {
    method, headers: { Cookie: account.cookie, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const putMode = (account: Account, mode: string) => write("PUT", modePath, account, { mode });

  async function signUp(name: string): Promise<Account> {
    const response = await fetch(origin + "/api/auth/sign-up/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email: `${name}@example.test`, password: "agent-management-fixture-password" }),
    });
    expect(response.status).toBe(200);
    const { user } = await response.json() as { user: { id: string } };
    const cookie = response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    expect(cookie).not.toBe("");
    return { id: user.id, cookie };
  }

  beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-management-"));
    vi.stubEnv("YOPLAI_HOME", home);
    vi.stubEnv("YOPLAI_DESKTOP", undefined);
    await writeTestV3Config(home, {
      agents: [{ id: "shared" }, { id: "status" }],
      extensions: { multiUser: { enabled: true, autoApprove: true, emailAndPassword: { enabled: true }, sessionSecret: "agent-management-fixture-session-secret" } },
      extraConfig: { agents: "agents/*" },
    });
    const settingsFile = path.join(home, "agents", "shared", "agent.yaml");
    await fs.appendFile(settingsFile, '  base_url: https://operator.example.test/v1 # operator URL\n  auth_token: $env:SAMPLE_AGENT_TOKEN\nrole: Harbor Dispatcher\n');
    vi.stubEnv("SAMPLE_AGENT_TOKEN", "synthetic-operator-token");
    vi.resetModules();
    const { loadConfig } = await import("../config/index.js");
    const { createExtensionContext } = await import("../extensions/context.js");
    const { getExtensionRuntime } = await import("../extensions/registry.js");
    const { multiUserExtension } = await import("@yoplai/extension-multi-user");
    const runtime = getExtensionRuntime();
    runtime.load([multiUserExtension]);
    await multiUserExtension.start(createExtensionContext(loadConfig()));
    stopAuth = () => multiUserExtension.stop();
    const { api } = await import("./api.core.js");
    multiUserExtension.registerRoutes(api);
    const { startServer } = await import("./index.js");
    server = startServer(0, "127.0.0.1", runtime);
    if (!server.listening) await once(server, "listening");
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    superadmin = await signUp("iman");
    admin = await signUp("javon");
    member = await signUp("mira");
    other = await signUp("noel");
    expect((await write("PATCH", `/api/admin/users/${admin.id}`, superadmin, { role: "admin" })).status).toBe(200);
  }, 30_000);

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await stopAuth?.();
    vi.unstubAllEnvs();
    if (home) await fs.rm(home, { recursive: true, force: true, maxRetries: 3 });
  });

  it("lets a superadmin change the mode live and audits the change", async () => {
    expect(await (await get(modePath, superadmin)).json()).toEqual({ mode: "off", source: "default", locked: false });
    for (const account of [admin, member]) {
      expect((await get(modePath, account)).status).toBe(403);
      expect((await putMode(account, "anyone")).status).toBe(403);
    }
    expect((await putMode(superadmin, "everyone")).status).toBe(400);
    expect(await (await putMode(superadmin, "anyone")).json()).toEqual({ mode: "anyone", value: "anyone", source: "ui", locked: false });
    const permissions = await get("/api/agent-management/permissions", other);
    expect(await permissions.json()).toEqual({ canCreate: true });
    const audit = await get("/api/audit/settings?action=agent_management.update", superadmin);
    expect(await audit.json()).toMatchObject({ entries: [{ actorUserId: superadmin.id, changes: [{ field: "mode", before: "off", after: "anyone" }] }] });
  });

  it("publishes a private agent before reload and scopes retries to its creator", async () => {
    expect((await putMode(superadmin, "anyone")).status).toBe(200);
    const create = (account: Account) => write("POST", "/api/agent-management/agents", account, {
      name: "Trip Planner", purpose: "Plan routes.", avatar: 2, model,
      requestId: "6fca3412-6437-4931-805f-623ada959e73",
    });
    const { getMultiUserRuntime } = await import("@yoplai/extension-multi-user");
    const rename = fs.rename;
    let publications = 0;
    const spy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (typeof to === "string" && path.dirname(to) === path.join(home, "agents")) {
        const row = getMultiUserRuntime()?.forks.getForkByAgentId(path.basename(to));
        expect(row).toMatchObject({ public: false, assignment: { teamIds: [] } });
        const owner = JSON.parse(await fs.readFile(path.join(String(from), ".created-by.json"), "utf8"));
        expect(row?.createdBy).toBe(owner.userId);
        publications++;
      }
      return rename(from, to);
    });
    try {
      const result = await create(member);
      expect(result.status).toBe(201);
      expect(await result.json()).toEqual({ id: "trip-planner", instructions: "template" });
      expect((await get("/api/agents/trip-planner/history", member)).status).toBe(200);
      expect((await get("/api/agents/trip-planner/history", other)).status).toBe(403);
      const list = await get("/api/agents", other);
      expect(await list.json()).not.toContainEqual(expect.objectContaining({ id: "trip-planner" }));
      const retry = await create(member);
      expect(retry.status).toBe(200);
      expect(await retry.json()).toMatchObject({ id: "trip-planner" });
      const second = await create(other);
      expect(second.status).toBe(201);
      expect(await second.json()).toMatchObject({ id: "trip-planner-2" });
      const staff = await create(admin);
      expect(staff.status).toBe(201);
      expect((await get("/api/agents/trip-planner-3/history", member)).status).toBe(403);
      expect(publications).toBe(3);
    } finally {
      spy.mockRestore();
    }
  });

  it("lets an eligible owner edit and share an agent, then keeps chat access when management changes", async () => {
    await putMode(superadmin, "anyone");
    const created = await write("POST", "/api/agent-management/agents", member, {
      name: "Garden Guide", avatar: 4, model, requestId: "411ae8d5-b415-4996-a398-c54c8b4bbcc1",
    });
    expect(created.status).toBe(201);
    const url = "/api/agents/garden-guide/settings";
    const patch = (account: Account, body: unknown) => write("PATCH", url, account, body);
    const before = await get(url, member);
    expect(before.status).toBe(200);
    expect(await before.json()).toMatchObject({
      name: "Garden Guide", canEditAgent: true, canSetPublic: true, public: false, model, instructions: "You are Garden Guide.\nAsk for details when you need them.\n",
    });
    expect((await patch(member, { public: true, name: "Greenhouse Guide", instructions: "Help plan plantings.", reasoning: "medium" })).status).toBe(200);
    const view = await get(url, other);
    expect(view.status).toBe(200);
    const readOnly = await view.json();
    expect(readOnly).toMatchObject({ name: "Greenhouse Guide", canEditAgent: false, public: true, canSetPublic: false });
    expect(readOnly).not.toHaveProperty("model");
    expect(readOnly).not.toHaveProperty("instructions");
    expect((await patch(other, { public: false })).status).toBe(403);
    expect((await patch(member, { public: false })).status).toBe(200);
    expect((await get(url, other)).status).toBe(403);
    const audit = await get("/api/audit/settings?action=admin.fork_visibility&agentId=garden-guide", superadmin);
    expect(await audit.json()).toMatchObject({ entries: expect.arrayContaining([
      expect.objectContaining({ actorUserId: member.id, changes: [{ field: "public", before: false, after: true }] }),
      expect.objectContaining({ actorUserId: member.id, changes: [{ field: "public", before: true, after: false }] }),
    ]) });
    await putMode(superadmin, "admin");
    expect((await patch(member, { public: true })).status).toBe(403);
    expect((await get("/api/agents/garden-guide/history", member)).status).toBe(200);
    expect(await (await get(url, member)).json()).toMatchObject({ canEditAgent: false, public: false, canSetPublic: false });
    expect((await patch(superadmin, { public: true })).status).toBe(200);
    await putMode(superadmin, "off");
    expect((await patch(superadmin, { public: false })).status).toBe(403);
    expect(await (await get(url, superadmin)).json()).toMatchObject({ canEditAgent: false, public: true, canSetPublic: false });
  });

  it("leaves a reservation behind only after publication and never reuses a stale or reserved ID", async () => {
    await putMode(superadmin, "anyone");
    const { getMultiUserRuntime } = await import("@yoplai/extension-multi-user");
    const forks = getMultiUserRuntime()!.forks;
    const release = forks.reservePrivate("stone-guide", other.id);
    const create = (name: string, requestId: string) => write("POST", "/api/agent-management/agents", member, { name, requestId, avatar: 1, model });
    const requestId = "c1554cfc-e6b7-4bdb-9050-66b3cd6fc6fc";
    const rename = fs.rename;
    const spy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to) === path.join(home, "agents", "stone-guide-2")) throw new Error("Fixture publication failure");
      return rename(from, to);
    });
    try {
      const failure = await create("Stone Guide", requestId);
      expect(failure.status).toBe(500);
      expect(await failure.json()).toMatchObject({ error: "write_failed" });
      expect(forks.getForkByAgentId("stone-guide-2")).toBeNull();
      expect(forks.getForkByAgentId("stone-guide")?.createdBy).toBe(other.id);
    } finally {
      spy.mockRestore();
    }
    const reload = await import("../extensions/reload.js");
    const reloadFailure = vi.spyOn(reload, "reloadAfterExtensionWrite").mockRejectedValueOnce(new Error("Fixture reload failure"));
    try {
      const failure = await create("Stone Guide", requestId);
      expect(failure.status).toBe(500);
      expect(await failure.json()).toMatchObject({ error: "reload_failed" });
      expect(forks.getForkByAgentId("stone-guide-2")).toMatchObject({ public: false, createdBy: member.id });
      expect((await get("/api/agents/stone-guide-2/history", other)).status).toBe(403);
      const retry = await create("Stone Guide", requestId);
      expect(retry.status).toBe(200);
      expect(await retry.json()).toMatchObject({ id: "stone-guide-2" });
      expect((await get("/api/agents/stone-guide-2/history", member)).status).toBe(200);
    } finally {
      reloadFailure.mockRestore();
      release();
    }
    const reserved = await create("Sessions", "d4b7660d-c53c-4108-9f9e-142c00ffd6aa");
    expect(reserved.status).toBe(201);
    expect(await reserved.json()).toMatchObject({ id: "sessions-2" });
  });

  it("enforces access at the new handlers even for an aggregate agent ID", async () => {
    await putMode(superadmin, "anyone");
    expect((await write("PATCH", "/api/admin/forks/status/visibility", superadmin, { public: false })).status).toBe(200);
    for (const [method, suffix, body] of [
      ["PATCH", "", { name: "No access" }], ["PUT", "/user-skills", { ids: [] }],
      ["PUT", "/agent-skills", { disabled: [] }], ["PUT", "/avatar", { avatar: 2 }], ["DELETE", "/avatar", { avatar: 2 }],
    ] as const) {
      expect((await write(method, `/api/agents/status/settings${suffix}`, member, body)).status).toBe(403);
    }
    expect((await get("/api/agents/status/settings", member)).status).toBe(403);
  });

  it("preserves operator model settings while publishing settings and versioning validated images", async () => {
    await putMode(superadmin, "admin");
    const endpoint = "/api/agents/shared/settings";
    const url = "/api/agents/shared";
    const patch = (body: unknown) => write("PATCH", endpoint, superadmin, body);
    expect((await write("PATCH", endpoint, member, { name: "Denied" })).status).toBe(403);
    expect((await write("POST", "/api/agent-management/agents", member, {})).status).toBe(403);
    expect((await patch({ description: "$env:SAMPLE_AGENT_TOKEN" })).status).toBe(400);
    expect((await patch({ model: { provider: "unknown", model: "unknown" } })).status).toBe(400);
    expect((await patch({ model, avatar: 3 })).status).toBe(200);
    expect(await (await get(endpoint, superadmin)).json()).toMatchObject({ canEditAgent: true, model, hasCustomAvatar: false, defaultFace: 3 });
    const settings = await (await get(endpoint, superadmin)).text();
    expect(settings).not.toContain("operator.example.test");
    expect(settings).not.toContain("synthetic-operator-token");
    const yaml = await fs.readFile(path.join(home, "agents", "shared", "agent.yaml"), "utf8");
    expect(yaml).toContain("base_url: https://operator.example.test/v1 # operator URL");
    expect(yaml).toContain("auth_token: $env:SAMPLE_AGENT_TOKEN");
    const getAvatar = async () => (await (await get(url, superadmin)).json()).avatar as string;
    const before = await getAvatar();
    expect(before).toMatch(/\/avatar\?v=/);
    const upload = (image: Blob, filename: string) => {
      const data = new FormData();
      data.set("fields", JSON.stringify({ avatar: 3 }));
      data.set("image", image, filename);
      return fetch(origin + endpoint, { method: "PATCH", headers: { Cookie: superadmin.cookie }, body: data });
    };
    for (const invalid of [new Blob(["<svg/>"], { type: "image/svg+xml" }), new Blob(["not a PNG"], { type: "image/png" })]) {
      expect((await upload(invalid, "fake.png")).status).toBe(400);
    }
    expect((await upload(new Blob([new Uint8Array(2 * 1024 * 1024 + 1)]), "big.png")).status).toBe(413);
    expect(await getAvatar()).toBe(before);
    const bytes = await fs.readFile(new URL("../../../web/public/avatars/default-7.webp", import.meta.url));
    const avatarDirectory = path.join(home, "agents", "shared");
    const original = (await fs.readdir(avatarDirectory)).find((name) => name.startsWith("avatar-"));
    expect(original).toBeDefined();
    const reload = await import("../extensions/reload.js");
    const reloadFailure = vi.spyOn(reload, "reloadAfterExtensionWrite").mockRejectedValueOnce(new Error("Fixture reload failure"));
    try {
      expect((await upload(new Blob([new Uint8Array(bytes)]), "garden.webp")).status).toBe(500);
      expect((await get(before, superadmin)).status).toBe(200);
    } finally {
      reloadFailure.mockRestore();
    }
    expect((await upload(new Blob([new Uint8Array(bytes)], { type: "image/png" }), "wrong.png")).status).toBe(200);
    expect((await fs.readdir(avatarDirectory)).filter((name) => name.startsWith("avatar-"))).toHaveLength(1);
    const after = await getAvatar();
    expect(after).not.toBe(before);
    const image = await get(after, superadmin);
    expect(image.headers.get("content-type")).toBe("image/webp");
    expect(image.headers.get("cache-control")).toBe("private, max-age=3600");
    expect(Buffer.from(await image.arrayBuffer())).toEqual(bytes);
    expect(await (await get(endpoint, superadmin)).json()).toMatchObject({ hasCustomAvatar: true, defaultFace: 3 });
    expect((await write("DELETE", endpoint + "/avatar", superadmin, { avatar: 3 })).status).toBe(200);
    expect(await getAvatar()).not.toBe(after);
    expect(await (await get(endpoint, superadmin)).json()).toMatchObject({ hasCustomAvatar: false, defaultFace: 3 });
  });

  // ALG-772 Testing Decisions, approved in Thinh's Groom GO, cover this HTTP seam.
  it("saves a description for a legacy agent and rejects role edits over HTTP", async () => {
    expect((await putMode(superadmin, "admin")).status).toBe(200);
    const agentPath = "/api/agents/shared";
    const settingsPath = `${agentPath}/settings`;
    expect((await write("PATCH", settingsPath, superadmin, { role: "Dock Coordinator" })).status).toBe(400);
    expect((await write("PATCH", settingsPath, superadmin, { description: "Coordinates dock arrivals." })).status).toBe(200);

    const settings = await get(settingsPath, superadmin);
    const detail = await get(agentPath, superadmin);
    const list = await get("/api/agents", superadmin);
    expect(settings.status).toBe(200);
    expect(detail.status).toBe(200);
    expect(list.status).toBe(200);
    const listedAgent = (await list.json() as Array<{ id: string }>).find((agent) => agent.id === "shared");
    for (const payload of [await settings.json(), await detail.json(), listedAgent]) {
      expect(payload).toMatchObject({ description: "Coordinates dock arrivals." });
      expect(payload).not.toHaveProperty("role");
    }
  });

  it("uses the same default filter for runs and settings, and saves only the linked gateway's personal state with management off", async () => {
    await putMode(superadmin, "off");
    const { SkillStore } = await import("../skills/store.js");
    const { getSkillContext } = await import("../skills/context.js");
    const { resolveRunSkills } = await import("../skills/resolver.js");
    const { store, policy } = await getSkillContext();
    const personal = await store.create(member.id, { files: [{ path: "SKILL.md", content: "---\nname: portrait-notes\ndescription: Help describe portraits\n---\nUse short phrases.\n" }] });
    const defaults = path.join(store.root, "default", "harbor-notes");
    await fs.mkdir(defaults, { recursive: true });
    await fs.writeFile(path.join(defaults, "SKILL.md"), "---\nname: harbor-notes\ndescription: Guide boats\n---\nCheck the harbor.\n");
    await fs.writeFile(path.join(defaults, ".yoplai.json"), '{"agents":["other-agent"]}');
    const endpoint = "/api/agents/shared/settings";
    const before = await (await get(endpoint, member)).json();
    expect(before).toMatchObject({ canEditAgent: false, skills: { user: [expect.objectContaining({ id: personal.skill.id, enabled: false })] } });
    expect(before.skills.global).not.toContainEqual(expect.objectContaining({ id: "default:harbor-notes" }));
    expect((await write("PUT", endpoint + "/user-skills", other, { ids: [personal.skill.id] })).status).toBe(404);
    expect((await write("PUT", endpoint + "/user-skills", member, { ids: ["builtin:dashboard"] })).status).toBe(400);

    const { getMultiUserRuntime } = await import("@yoplai/extension-multi-user");
    const { key } = await getMultiUserRuntime()!.auth.api.createApiKey({ body: { userId: member.id, name: "relay-test-key" } });
    if (typeof key !== "string") throw new Error("Fixture key creation failed");
    const { relayConfiguration, isResponse } = await import("../relay/configuration.js");
    const { fetchRemote } = await import("../relay/remote.js");
    const localStore = new SkillStore(path.join(home, "relay-local"));
    const request = new Request("http://localhost:3000/api/relay/gateways/east/api/agents/shared%40east/settings/user-skills", {
      method: "PUT", headers: { Origin: "http://localhost:3000", "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [personal.skill.id] }),
    });
    const answer = await relayConfiguration(request, [{ name: "east", url: origin, token: key }], async (req, gateway, path) =>
      fetchRemote(gateway, path, { method: req.method, headers: req.headers, body: await req.text() }));
    expect(isResponse(answer)).toBe(true);
    expect((answer as Response).status).toBe(200);
    expect((await localStore.getState(member.id)).agents).toBeUndefined();
    expect(await (await get(endpoint, member)).json()).toMatchObject({ skills: { user: [expect.objectContaining({ id: personal.skill.id, enabled: true })] } });
    const current = await resolveRunSkills(store, { agentId: "shared", userId: member.id, multiUser: true, policy });
    expect(current.skills.map((skill) => skill.id)).toContain(personal.skill.id);
    expect(current.skills.map((skill) => skill.id)).not.toContain("default:harbor-notes");
    const otherAgent = await resolveRunSkills(store, { agentId: "other-agent", userId: member.id, multiUser: true, policy });
    expect(otherAgent.skills.map((skill) => skill.id)).toEqual(["default:harbor-notes"]);
  });

  it("locks the admin mode when the root config supplies a value", async () => {
    const configFile = path.join(home, "yoplai.json");
    const before = await fs.readFile(configFile, "utf8");
    const { reloadConfig } = await import("../config/index.js");
    try {
      await fs.writeFile(configFile, JSON.stringify({ ...JSON.parse(before), agentManagement: false }));
      reloadConfig();
      expect(await (await get(modePath, superadmin)).json()).toEqual({ mode: "off", value: false, source: "config", locked: true });
      expect((await putMode(superadmin, "anyone")).status).toBe(403);
      expect((await write("POST", "/api/agent-management/agents", superadmin, {})).status).toBe(403);
    } finally {
      await fs.writeFile(configFile, before);
      reloadConfig();
    }
  });
});
