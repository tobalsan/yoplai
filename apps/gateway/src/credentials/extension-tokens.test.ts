import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AgentConfig, Extension, GatewayConfig } from "@yoplai/shared";
import { GatewayConfigSchema, resolveExtensionOAuth } from "@yoplai/shared";
import { CredentialStore } from "./store.js";
import { deletePersonalExtensionTokens, extensionTokenIntegration, getPersonalExtensionTokens, resolveExtensionTokenConfig, savePersonalExtensionTokens, storePersonalExtensionTokens } from "./extension-tokens.js";
import { ExtensionRuntime } from "../extensions/runtime.js";
import { getOAuthService } from "../oauth/service.js";

const state = vi.hoisted(() => ({ dir: "", env: {} as Record<string, string> }));
vi.mock("../config/index.js", () => ({
  get CONFIG_DIR() { return state.dir; },
  resolveAgentEnv: () => state.env,
  loadConfig: () => ({ oauth: { encryptionKey: "fixture-encryption-key" } }),
}));

// Match external factory extensions: validate merged config and capture a
// client in the hook closure, without depending on a shared SDK resolver.
function tokenExtension(id: "zendesk" | "pennylane", request: (authorization: string) => Promise<unknown>): Extension {
  const field = id === "zendesk" ? "apiKey" : "apiToken";
  return {
    id, displayName: id, description: id, dependencies: [], routePrefixes: [],
    configSchema: z.object({}), requiredSecrets: [field],
    validateConfig: () => ({ valid: true, errors: [] }),
    registerRoutes: () => undefined, start: async () => undefined, stop: async () => undefined, capabilities: () => [],
    getAgentTools(agent, context) {
      const root = context?.config.extensions?.[id] as Record<string, unknown> | undefined;
      const cfg = { ...root, ...agent.extensions?.[id] } as Record<string, unknown>;
      if (cfg.enabled === false) return [];
      z.object({ [field]: z.string().min(1) }).parse(cfg);
      const authorization = id === "zendesk"
        ? `Basic ${Buffer.from(`${cfg.email}/token:${cfg[field]}`).toString("base64")}`
        : `Bearer ${cfg[field]}`;
      return [{ name: `${id}_list`, description: "List records", parameters: { type: "object" }, execute: () => request(authorization) }];
    },
    getSystemPromptContributions: () => "Use the integration tools.",
  };
}

let agent: AgentConfig;
let config: GatewayConfig;
let store: CredentialStore;
beforeEach(() => {
  state.dir = fs.mkdtempSync(path.join(os.tmpdir(), "extension-tokens-"));
  state.env = { TEAM_ZENDESK: "team-zendesk", TEAM_PENNYLANE: "team-pennylane" };
  agent = { id: "support", name: "Support", workspace: state.dir, queueMode: "queue", model: { provider: "openai", model: "test" }, extensions: {
    zendesk: { enabled: true }, pennylane: { enabled: true },
  } };
  config = GatewayConfigSchema.parse({ version: 2, agents: [agent], ui: { port: 3000 }, extensions: {
    zendesk: { apiKey: "$env:TEAM_ZENDESK", email: "shared@example.test", subdomain: "fixture" },
    pennylane: { apiToken: "$env:TEAM_PENNYLANE" },
  } });
  store = new CredentialStore();
});
afterEach(() => fs.rmSync(state.dir, { recursive: true, force: true }));

function save(id: string, userId: string, fields: Record<string, string>) {
  storePersonalExtensionTokens(store, userId, id, fields);
}

describe("requester extension API tokens", () => {
  it("saves only declared validated personal fields without changing team config", () => {
    const extension = tokenExtension("pennylane", async () => undefined);
    const before = JSON.stringify({ agent, config });
    savePersonalExtensionTokens(extension, agent, config, "alice", { apiToken: "alice-new" }, store);
    expect(getPersonalExtensionTokens(store, agent.id, "alice", "pennylane")).toEqual({ apiToken: "alice-new" });
    expect(getPersonalExtensionTokens(store, agent.id, "bob", "pennylane")).toBeUndefined();
    expect(JSON.stringify({ agent, config })).toBe(before);
    const invalid: Record<string, string>[] = [{ apiToken: "$env:HOST_SECRET" }, { apiToken: "********" }, { unexpected: "value" }, { apiToken: "" }];
    for (const secrets of invalid) {
      expect(() => savePersonalExtensionTokens(extension, agent, config, "alice", secrets, store)).toThrow("Invalid personal credential fields");
    }
    extension.validateAgentConfig = () => ({ valid: false, errors: ["apiToken"] });
    expect(() => savePersonalExtensionTokens(extension, agent, config, "alice", { apiToken: "rejected" }, store)).toThrow("Extension configuration is invalid");
    expect(getPersonalExtensionTokens(store, agent.id, "alice", "pennylane")).toEqual({ apiToken: "alice-new" });
  });
  it.each(["zendesk", "pennylane"] as const)("uses personal → existing team credentials for %s, including captured tools", async (id) => {
    const request = vi.fn(async () => ({ records: [] }));
    const runtime = new ExtensionRuntime();
    runtime.load([tokenExtension(id, request)]);
    const field = id === "zendesk" ? "apiKey" : "apiToken";
    save(id, "alice", { [field]: "alice-token" });
    save(id, "bob", { [field]: "bob-token" });
    const [tool] = await runtime.getTools(agent, config, "alice");
    // Rotate after collection; execute uses the call's requester, never the
    // user/token captured when the model first received tool metadata.
    save(id, "alice", { [field]: "alice-rotated" });
    const expected = (token: string) => id === "zendesk"
      ? `Basic ${Buffer.from(`shared@example.test/token:${token}`).toString("base64")}` : `Bearer ${token}`;
    const requests: Array<[string | undefined, string]> = [["alice", "alice-rotated"], ["bob", "bob-token"], ["charlie", `team-${id}`], [undefined, `team-${id}`]];
    for (const [userId, token] of requests) {
      await tool.execute({}, { agent, config, env: state.env, userId });
      expect(request).toHaveBeenLastCalledWith(expected(token));
    }
    expect(await runtime.getPromptContributions(agent, config, "alice")).toEqual(["Use the integration tools."]);
    expect(JSON.stringify(tool)).not.toContain("alice-rotated");
    expect(JSON.stringify(config)).not.toContain("alice-token");
    for (const file of fs.readdirSync(path.join(state.dir, "credentials"))) {
      expect(fs.readFileSync(path.join(state.dir, "credentials", file), "utf8")).not.toMatch(/alice|bob|apiKey|apiToken/);
    }
  });

  it("lets a requester override shared settings such as the account email", async () => {
    const request = vi.fn(async () => ({ records: [] }));
    const extension = tokenExtension("zendesk", request);
    extension.configJsonSchema = { properties: { apiKey: { type: "string" }, email: { type: "string" }, subdomain: { type: "string" } } };
    // The web form replaces setting overrides wholesale; secrets are kept.
    savePersonalExtensionTokens(extension, agent, config, "alice", { apiKey: "alice-token", email: "old@example.test" }, store);
    savePersonalExtensionTokens(extension, agent, config, "alice", { email: "alice@example.test" }, store, true);
    expect(() => savePersonalExtensionTokens(extension, agent, config, "alice", { email: "$env:HOST_EMAIL" }, store)).toThrow("Invalid personal credential fields");
    const runtime = new ExtensionRuntime();
    runtime.load([extension]);
    const [tool] = await runtime.getTools(agent, config, "alice");
    await tool.execute({}, { agent, config, env: state.env, userId: "alice" });
    expect(request).toHaveBeenLastCalledWith(`Basic ${Buffer.from("alice@example.test/token:alice-token").toString("base64")}`);
    await tool.execute({}, { agent, config, env: state.env, userId: "bob" });
    expect(request).toHaveBeenLastCalledWith(`Basic ${Buffer.from("shared@example.test/token:team-zendesk").toString("base64")}`);
  });

  it("refuses missing credentials with the exact form link and keeps unrelated tools working", async () => {
    state.env = {};
    const request = vi.fn(async () => ({ records: [] }));
    const runtime = new ExtensionRuntime();
    const unrelated = { ...tokenExtension("pennylane", request), id: "plain", requiredSecrets: [], getAgentTools: () => [{ name: "plain_ping", description: "Ping", parameters: {}, execute: async () => "pong" }] };
    runtime.load([tokenExtension("zendesk", request), unrelated]);
    const [tool] = await runtime.getTools(agent, config, "alice");
    const refusal = await tool.execute({}, { agent, config, env: state.env, userId: "alice" });
    expect(refusal).toMatchObject({ error: "extension_credentials_required", connectUrl: "http://localhost:3000/agents/support/extensions/zendesk/config" });
    expect(JSON.stringify(refusal)).toContain("Just me");
    expect(request).not.toHaveBeenCalled();
    expect(await runtime.executeTool(agent, "plain_ping", {}, config)).toEqual({ found: true, result: "pong" });
    expect((await runtime.getPromptContributions(agent, config, "alice"))[0]).toContain("http://localhost:3000/agents/support/extensions/zendesk/config");
    save("zendesk", "alice", { apiKey: "now-connected" });
    await tool.execute({}, { agent, config, env: state.env, userId: "alice" });
    expect(request).toHaveBeenCalledOnce();
  });

  it("does not fabricate optional credential fields, and redacts metadata credentials by schema", () => {
    const ext = tokenExtension("zendesk", async () => undefined);
    ext.configJsonSchema = { properties: { optionalPassword: { type: "string", writeOnly: true } } };
    const resolved = resolveExtensionTokenConfig(ext, agent, config, "alice", store);
    expect(resolved.agent.extensions?.zendesk).not.toHaveProperty("optionalPassword");
    expect(resolved.config.extensions?.zendesk).not.toHaveProperty("optionalPassword");
    expect(resolved.missing).toEqual([]);
  });

  it("never resolves a personal token as a reference to a host secret", async () => {
    state.env.HOST_ADMIN_SECRET = "admin-only";
    save("pennylane", "alice", { apiToken: "$env:HOST_ADMIN_SECRET" });
    const request = vi.fn(async () => "ok");
    const runtime = new ExtensionRuntime();
    runtime.load([tokenExtension("pennylane", request)]);
    const result = await runtime.executeTool(agent, "pennylane_list", {}, config, undefined, "alice");
    expect(result.result).toMatchObject({ error: "extension_credentials_required" });
    expect(request).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("admin-only");
  });

  it("keeps unrelated calls progressing when an integration request fails", async () => {
    const runtime = new ExtensionRuntime();
    runtime.load([tokenExtension("pennylane", async () => { throw new Error("request timed out"); }), {
      ...tokenExtension("zendesk", async () => "ok"), id: "plain", requiredSecrets: [],
      getAgentTools: () => [{ name: "plain_ping", description: "Ping", parameters: {}, execute: async () => "pong" }],
    }]);
    await expect(runtime.executeTool(agent, "pennylane_list", {}, config, undefined, "alice")).rejects.toThrow("request timed out");
    expect(await runtime.executeTool(agent, "plain_ping", {}, config)).toEqual({ found: true, result: "pong" });
  });
});

describe("shared personal extension tokens", () => {
  const withAgent = (id: string, extensions: AgentConfig["extensions"]): AgentConfig => ({ ...agent, id, name: id, extensions });
  const legacy = (agentId: string, userId: string, fields: Record<string, string>) =>
    store.save({ agentId, integration: extensionTokenIntegration("zendesk"), scope: { type: "personal", userId } }, fields);
  const resolvedKey = (forAgent: AgentConfig, userId?: string) =>
    (resolveExtensionTokenConfig(tokenExtension("zendesk", async () => undefined), forAgent, config, userId, store).agent.extensions?.zendesk as Record<string, unknown>)?.apiKey;
  const sally = () => withAgent("sally", { zendesk: { enabled: true } });
  const cira = () => withAgent("cira", { zendesk: { enabled: true } });

  it("resolves a token saved via sally on cira, and never for others or unattended runs", () => {
    const extension = tokenExtension("zendesk", async () => undefined);
    savePersonalExtensionTokens(extension, sally(), config, "alice", { apiKey: "alice-token" }, store);
    expect(resolvedKey(cira(), "alice")).toBe("alice-token");
    expect(resolvedKey(cira(), "bob")).toBe("team-zendesk");
    expect(resolvedKey(cira())).toBe("team-zendesk");
  });

  it("does not enable the extension where it is off", () => {
    savePersonalExtensionTokens(tokenExtension("zendesk", async () => undefined), sally(), config, "alice", { apiKey: "alice-token" }, store);
    const off = withAgent("cira", {});
    const resolved = resolveExtensionTokenConfig(tokenExtension("zendesk", async () => undefined), off, config, "alice", store);
    expect(resolved.agent.extensions?.zendesk).toBeUndefined();
  });

  it("promotes a legacy per-agent record and deletes the legacy copy", () => {
    legacy("sally", "alice", { apiKey: "legacy-token" });
    expect(getPersonalExtensionTokens(store, "sally", "alice", "zendesk")).toEqual({ apiKey: "legacy-token" });
    expect(store.get({ agentId: "sally", integration: extensionTokenIntegration("zendesk"), scope: { type: "personal", userId: "alice" } })).toBeUndefined();
    expect(getPersonalExtensionTokens(store, "cira", "alice", "zendesk")).toEqual({ apiKey: "legacy-token" });
  });

  it("remove is not undone by legacy rows on other agents and a re-save works everywhere", () => {
    const extension = tokenExtension("zendesk", async () => undefined);
    legacy("sally", "alice", { apiKey: "legacy-sally" });
    legacy("third", "alice", { apiKey: "legacy-third" });
    expect(getPersonalExtensionTokens(store, "sally", "alice", "zendesk")).toBeDefined();
    deletePersonalExtensionTokens(store, "cira", "alice", "zendesk");
    expect(getPersonalExtensionTokens(store, "sally", "alice", "zendesk")).toBeUndefined();
    expect(getPersonalExtensionTokens(store, "third", "alice", "zendesk")).toBeUndefined();
    expect(resolvedKey(sally(), "alice")).toBe("team-zendesk");
    savePersonalExtensionTokens(extension, cira(), config, "alice", { apiKey: "fresh" }, store);
    expect(resolvedKey(sally(), "alice")).toBe("fresh");
    expect(resolvedKey(cira(), "alice")).toBe("fresh");
  });

  it("a tombstone for alice does not affect bob", () => {
    legacy("sally", "bob", { apiKey: "bob-token" });
    deletePersonalExtensionTokens(store, "sally", "alice", "zendesk");
    expect(getPersonalExtensionTokens(store, "sally", "bob", "zendesk")).toEqual({ apiKey: "bob-token" });
  });
});

describe("personal settings for OAuth extensions", () => {
  function driveExtension(): Extension {
    const merged = (agentConfig: AgentConfig, config: GatewayConfig) => ({ ...config.extensions?.drive as Record<string, unknown>, ...agentConfig.extensions?.drive as Record<string, unknown> });
    return {
      id: "drive", displayName: "Drive", description: "Drive", dependencies: [], routePrefixes: [],
      configSchema: z.object({}), configJsonSchema: { properties: { allowWrite: { type: "boolean" } } },
      oauth: (resolved) => ({ provider: "google", scopes: resolved.merged.allowWrite === true ? ["drive.readonly", "drive.file"] : ["drive.readonly"] }),
      validateConfig: () => ({ valid: true, errors: [] }),
      registerRoutes: () => undefined, start: async () => undefined, stop: async () => undefined, capabilities: () => [],
      getAgentTools: (forAgent, context) => merged(forAgent, context?.config ?? config).allowWrite === true
        ? [{ name: "drive_write", description: "Write", parameters: {}, execute: async () => "written" }]
        : [],
    };
  }
  const grant = (userId: string | undefined) => vi.spyOn(getOAuthService(), "getScopedConnection").mockImplementation((_agent, provider, scope) =>
    userId !== undefined && provider === "google" && scope.type === "personal" && scope.userId === userId
      ? { agentId: "support", provider, accessToken: "token", scopes: [], scope: "personal", userId } as never
      : undefined);
  const toolNames = async (userId?: string) => (await new ExtensionRuntimeWith(driveExtension()).getTools(agent, config, userId)).map((tool) => tool.name);
  class ExtensionRuntimeWith extends ExtensionRuntime {
    constructor(extension: Extension) { super(); this.load([extension]); }
  }
  const scopesFor = (userId?: string) => {
    const resolved = resolveExtensionTokenConfig(driveExtension(), agent, config, userId, store);
    return resolveExtensionOAuth(driveExtension(), resolved.config, resolved.agent)?.scopes;
  };
  beforeEach(() => {
    agent = { ...agent, extensions: { drive: { enabled: true } } };
    config = { ...config, extensions: { drive: {} } };
  });
  afterEach(() => vi.restoreAllMocks());

  it("uses personal allowWrite only when the requester has a personal grant", async () => {
    storePersonalExtensionTokens(store, "alice", "drive", { allowWrite: true });
    grant("alice");
    expect(await toolNames("alice")).toEqual(["drive_write"]);
    expect(scopesFor("alice")).toEqual(["drive.readonly", "drive.file"]);
    expect(await toolNames("bob")).toEqual([]);
    expect(await toolNames()).toEqual([]);
  });

  it("uses the team value for a requester without a personal grant", async () => {
    storePersonalExtensionTokens(store, "alice", "drive", { allowWrite: true });
    grant(undefined);
    expect(await toolNames("alice")).toEqual([]);
    expect(scopesFor("alice")).toEqual(["drive.readonly"]);
  });

  it("does not fall back to the team value when personal is unset", async () => {
    config = { ...config, extensions: { drive: { allowWrite: true } } };
    grant("alice");
    expect(await toolNames("alice")).toEqual([]);
    storePersonalExtensionTokens(store, "alice", "drive", { allowWrite: false });
    expect(await toolNames("alice")).toEqual([]);
    storePersonalExtensionTokens(store, "alice", "drive", { allowWrite: true });
    expect(await toolNames("alice")).toEqual(["drive_write"]);
    expect(await toolNames("bob")).toEqual(["drive_write"]);
  });

  it("refuses a captured personal write tool once the personal grant is gone", async () => {
    storePersonalExtensionTokens(store, "alice", "drive", { allowWrite: true });
    grant("alice");
    const [tool] = await new ExtensionRuntimeWith(driveExtension()).getTools(agent, config, "alice");
    expect(tool?.name).toBe("drive_write");
    vi.restoreAllMocks();
    grant(undefined);
    vi.spyOn(getOAuthService(), "resolveToken").mockResolvedValue({ connected: true, provider: "google", accessToken: "team-token", scopes: ["drive.readonly", "drive.file"] } as never);
    await expect(tool!.execute({}, { agent, config, env: state.env, userId: "alice" })).resolves.toMatchObject({ error: "extension_tool_unavailable" });
  });
});
