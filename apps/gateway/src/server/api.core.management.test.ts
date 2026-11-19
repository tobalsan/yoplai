import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { parse } from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig, GatewayConfig } from "@yoplai/shared";
import { createAccessResolver } from "../../../../packages/extensions/multi-user/src/access.js";
import { ensureAgentForksTable, ensureTeamMembersTable, ensureTeamsTable } from "../../../../packages/extensions/multi-user/src/db.js";
import { createForkStore } from "../../../../packages/extensions/multi-user/src/forks.js";
import { createMembershipStore } from "../../../../packages/extensions/multi-user/src/membership.js";
import { createTeamStore } from "../../../../packages/extensions/multi-user/src/teams.js";
import { forwardAuthContextToRequest } from "../../../../packages/extensions/multi-user/src/middleware.js";
import type { MultiUserRuntime } from "../../../../packages/extensions/multi-user/src/runtime-state.js";
import { googleProvider } from "../../../../packages/shared/src/oauth/__tests__/providers.fixture.js";

const state = vi.hoisted(() => ({
  dir: "",
  config: {} as GatewayConfig,
  rawConfig: undefined as GatewayConfig | undefined,
  runtime: null as Pick<MultiUserRuntime, "db" | "membership" | "forks" | "access" | "getPoolAgentIds"> | null,
}));
vi.mock("../audit/store.js", () => ({ recordSettingsChange: () => undefined, getAuditActor: async () => ({}) }));
vi.mock("../config/index.js", () => ({
  get CONFIG_DIR() { return state.dir; },
  loadConfig: () => state.config,
  getRawLoadedConfig: () => state.rawConfig ?? state.config,
  getAgent: (id: string) => state.config.agents.find((agent) => agent.id === id),
  getActiveAgents: () => state.config.agents,
  isAgentActive: () => true,
  resolveWorkspaceDir: (dir: string) => dir,
  resolveAgentEnv: () => ({}),
}));
vi.mock("../extensions/registry.js", () => ({
  isExtensionLoaded: (id: string) => id === "multiUser",
  getLoadedExtensions: () => [],
  hasAgentRootConfig: () => false,
  getExternalExtensionsPath: () => path.join(state.dir, "external"),
  getBuiltInExtensionRegistrations: () => [
    { id: "token", load: async () => ({ id: "token", displayName: "Token", description: "Token", requiredSecrets: ["apiKey"], configJsonSchema: { properties: { apiKey: { type: "string" }, region: { type: "string" } } } }) },
    { id: "oauth", load: async () => ({ id: "oauth", displayName: "OAuth", description: "OAuth", oauth: { provider: "google", scopes: [] }, configJsonSchema: { properties: { allowWrite: { type: "boolean" } } } }) },
    { id: "settings", load: async () => ({ id: "settings", displayName: "Settings", description: "Settings", configJsonSchema: { properties: { region: { type: "string" } } } }) },
    ...["slack", "telegram"].map((id) => ({ id, load: async () => ({ id, displayName: id, description: id }) })),
  ],
  getExtensionRuntime: () => ({ getCapabilities: () => ({ multiUser: true }) }),
}));
vi.mock("../extensions/reload.js", () => ({
  reloadAfterExtensionWrite: async () => {
    const agent = parse(fs.readFileSync(path.join(state.dir, "agents/alpha/agent.yaml"), "utf8")) as AgentConfig;
    const resolvedExtensions = state.config.agents[0].extensions;
    state.config.agents = [{ ...agent, workspace: path.join(state.dir, "agents/alpha"), workspaceDir: path.join(state.dir, "agents/alpha") }];
    if (state.rawConfig) {
      state.rawConfig = { ...state.config, agents: [{ ...state.config.agents[0] }] };
      state.config.agents[0].extensions = { ...agent.extensions, telegram: resolvedExtensions?.telegram ?? {} };
    }
    return state.config;
  },
}));

let api: typeof import("./api.core.js")["api"];

describe("public agent team configuration permissions", () => {
  beforeEach(async () => {
    vi.resetModules();
    state.rawConfig = undefined;
    (await import("@yoplai/shared")).registerOAuthProvider(googleProvider);
    state.dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-management-"));
    const db = new Database(path.join(state.dir, "auth.db"));
    db.pragma("foreign_keys = ON");
    db.exec("CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT, email TEXT)");
    for (const id of ["foreign", "manager", "super", "member"]) db.prepare("INSERT INTO user (id) VALUES (?)").run(id);
    ensureTeamsTable(db);
    ensureTeamMembersTable(db);
    ensureAgentForksTable(db);
    const membership = createMembershipStore(db);
    const teams = createTeamStore(db, membership);
    const team = teams.createTeam({ name: "Owners", createdBy: "super" });
    membership.setMembers(team.id, { mode: "list", userIds: ["manager"] }, "super");
    const foreignTeam = teams.createTeam({ name: "Other team", createdBy: "super" });
    membership.setMembers(foreignTeam.id, { mode: "list", userIds: ["foreign"] }, "super");
    const poolDir = path.join(state.dir, "pool/alpha");
    fs.mkdirSync(poolDir, { recursive: true });
    fs.writeFileSync(path.join(poolDir, "agent.yaml"), "id: alpha\nname: Alpha\nmodel:\n  provider: anthropic\n  model: claude\nextensions:\n  token:\n    enabled: true\n  oauth:\n    enabled: true\n  settings:\n    enabled: true\n");
    const forks = createForkStore({ db, getPoolAgent: () => ({ id: "alpha", workspaceDir: poolDir }), getForksDir: () => path.join(state.dir, "agents") });
    forks.setTeams("alpha", { mode: "list", teamIds: [team.id] }, "super");
    forks.setPublic("alpha", true);
    state.runtime = { db, membership, forks, access: createAccessResolver({ membership, forks }), getPoolAgentIds: () => ["alpha"] };
    state.config = {
      agents: [{ id: "alpha", name: "Alpha", queueMode: "queue", model: { provider: "anthropic", model: "claude" }, workspace: path.join(state.dir, "agents/alpha"), extensions: { token: { enabled: true }, oauth: { enabled: true }, settings: { enabled: true } } }],
      oauth: { encryptionKey: "management-test-key", redirectBaseUrl: "http://localhost:4000", providers: { google: { clientId: "test", clientSecret: "test" } } },
      extensions: {}, sessions: { idleMinutes: 360 },
    };
    const { setMultiUserRuntime } = await import("../../../../packages/extensions/multi-user/src/runtime-state.js");
    setMultiUserRuntime(state.runtime as MultiUserRuntime);
    api = (await import("./api.core.js")).api;
  });

  afterEach(async () => {
    const { setMultiUserRuntime } = await import("../../../../packages/extensions/multi-user/src/runtime-state.js");
    setMultiUserRuntime(null);
    state.runtime?.db.close();
    state.runtime = null;
    fs.rmSync(state.dir, { recursive: true, force: true });
  });

  function request(userId: string, role: string, url: string, method = "GET", body?: unknown) {
    const request = new Request(`http://localhost${url}`, { method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
    return api.request(forwardAuthContextToRequest(request, { user: { id: userId, role, approved: true }, session: { id: `session-${userId}`, userId } }));
  }

  it("masks channel tokens for Public readers and preserves them during a manager edit", async () => {
    const agentFile = path.join(state.dir, "agents/alpha/agent.yaml");
    const channelYaml = `  slack:
    token: canary-slack-token
    requireMention: true
  telegram:
    token: $env:CANARY_TELEGRAM_TOKEN
    allowedChats: [$env:CANARY_TELEGRAM_CHAT]
`;
    fs.appendFileSync(agentFile, channelYaml);
    const rawExtensions = {
      ...state.config.agents[0].extensions,
      slack: { token: "canary-slack-token", requireMention: true },
      telegram: { token: "$env:CANARY_TELEGRAM_TOKEN", allowedChats: ["$env:CANARY_TELEGRAM_CHAT"] },
    };
    state.rawConfig = { ...state.config, agents: [{ ...state.config.agents[0], extensions: rawExtensions }] };
    state.config.agents[0].extensions = {
      ...rawExtensions,
      telegram: { token: "canary-telegram-token", allowedChats: ["canary-telegram-chat"] },
    };

    const catalogUrl = "/agents/alpha/extensions";
    async function expectChannelValues(response: Response, requireMention: boolean) {
      expect(response.status).toBe(200);
      const body = await response.text();
      for (const value of ["canary-slack-token", "canary-telegram-token", "canary-telegram-chat"]) {
        expect(body).not.toContain(value);
      }
      expect(JSON.parse(body).extensions).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "slack", configValues: { token: "********", requireMention } }),
        expect.objectContaining({ id: "telegram", configValues: { token: "********", allowedChats: ["$env:CANARY_TELEGRAM_CHAT"] } }),
      ]));
    }

    await expectChannelValues(await request("member", "user", catalogUrl), true);
    const saved = await request("manager", "admin", `${catalogUrl}/slack`, "PATCH", { config: { requireMention: false } });
    await expectChannelValues(saved, false);
    expect(fs.readFileSync(agentFile, "utf8")).toContain("    token: canary-slack-token\n");
    await expectChannelValues(await request("member", "user", catalogUrl), false);
  });

  it("keeps foreign admins and regular Public users out of team settings while allowing their personal connections", async () => {
    for (const [userId, role] of [["foreign", "admin"], ["member", "user"]] as const) {
      const catalog = await request(userId, role, "/agents/alpha/extensions");
      expect(catalog.status).toBe(200);
      expect((await catalog.json()).extensions).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "token", canConfigureTeam: false }),
        expect.objectContaining({ id: "oauth", canConfigureTeam: false }),
        expect.objectContaining({ id: "settings", canConfigureTeam: false }),
      ]));
      for (const [extension, patch] of [["token", { secrets: { apiKey: "example-value" } }], ["token", { config: { region: "eu" } }], ["token", { enabled: false }], ["oauth", { config: { allowWrite: true } }], ["oauth", { enabled: false }], ["settings", { config: { region: "eu" } }], ["settings", { enabled: false }]] as const) {
        expect((await request(userId, role, `/agents/alpha/extensions/${extension}`, "PATCH", patch)).status).toBe(403);
      }
      expect((await request(userId, role, "/agents/alpha/extensions/token/credentials", "DELETE")).status).toBe(403);
      const personal = await request(userId, role, "/agents/alpha/extensions/token", "PATCH", { credentialScope: "personal", secrets: { apiKey: "example-personal" } });
      expect(personal.status).toBe(200);
      expect((await personal.json()).extensions).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "token", personalSecretFields: ["apiKey"], canConfigureTeam: false }),
      ]));
    }
  });

  it("allows owning admins and superadmins to configure team extensions", async () => {
    for (const [userId, role] of [["manager", "admin"], ["super", "superadmin"]] as const) {
      const catalog = await request(userId, role, "/agents/alpha/extensions");
      expect(catalog.status).toBe(200);
      expect((await catalog.json()).extensions).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "token", canConfigureTeam: true }),
        expect.objectContaining({ id: "oauth", canConfigureTeam: true }),
        expect.objectContaining({ id: "settings", canConfigureTeam: true }),
      ]));
      const saved = await request(userId, role, "/agents/alpha/extensions/token", "PATCH", { secrets: { apiKey: "example-team" }, config: { region: "eu" } });
      expect(saved.status).toBe(200);
      expect((await saved.json()).extensions).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "token", configValues: { apiKey: "********", region: "eu" } }),
      ]));
      expect((await request(userId, role, "/agents/alpha/extensions/oauth", "PATCH", { config: { allowWrite: true } })).status).toBe(200);
      expect((await request(userId, role, "/agents/alpha/extensions/settings", "PATCH", { config: { region: "eu" } })).status).toBe(200);
      for (const extension of ["token", "oauth", "settings"]) {
        expect((await request(userId, role, `/agents/alpha/extensions/${extension}`, "PATCH", { enabled: false })).status).toBe(200);
        expect((await request(userId, role, `/agents/alpha/extensions/${extension}`, "PATCH", { enabled: true })).status).toBe(200);
      }
      const removed = await request(userId, role, "/agents/alpha/extensions/token/credentials", "DELETE");
      expect(removed.status).toBe(200);
      expect((await removed.json()).extensions).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "token", configValues: { region: "eu" } }),
      ]));
    }
  });

  it("uses agent ownership for team OAuth while preserving personal OAuth for every Public user", async () => {
    for (const [userId, role, canConfigureTeam, mutationStatus] of [
      ["foreign", "admin", false, 403],
      ["member", "user", false, 403],
      ["manager", "admin", true, 302],
      ["super", "superadmin", true, 302],
    ] as const) {
      for (const scope of ["personal", "team"]) {
        const status = await request(userId, role, `/oauth/google/status?agent=alpha&scope=${scope}`);
        expect(status.status).toBe(200);
        expect(await status.json()).toMatchObject({ canConfigureTeam });
      }
      expect((await request(userId, role, "/oauth/google/authorize?agent=alpha&scope=team")).status).toBe(mutationStatus);
      expect((await request(userId, role, "/oauth/google/disconnect?agent=alpha&scope=team", "POST")).status).toBe(canConfigureTeam ? 200 : 403);
      expect((await request(userId, role, "/oauth/google/authorize?agent=alpha&scope=personal")).status).toBe(302);
      expect((await request(userId, role, "/oauth/google/disconnect?agent=alpha&scope=personal", "POST")).status).toBe(200);
    }
  });
});
