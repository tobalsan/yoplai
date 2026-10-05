import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AgentConfig, Extension, GatewayConfig } from "@yoplai/shared";
import { GatewayConfigSchema } from "@yoplai/shared";
import { CredentialStore } from "./store.js";
import { extensionTokenIntegration, resolveExtensionTokenConfig, savePersonalExtensionTokens } from "./extension-tokens.js";
import { ExtensionRuntime } from "../extensions/runtime.js";

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
  store.save({ agentId: agent.id, integration: extensionTokenIntegration(id), scope: { type: "personal", userId } }, fields);
}

describe("requester extension API tokens", () => {
  it("saves only declared validated personal fields without changing team config", () => {
    const extension = tokenExtension("pennylane", async () => undefined);
    const before = JSON.stringify({ agent, config });
    savePersonalExtensionTokens(extension, agent, config, "alice", { apiToken: "alice-new" }, store);
    expect(store.get({ agentId: agent.id, integration: extensionTokenIntegration("pennylane"), scope: { type: "personal", userId: "alice" } })).toEqual({ apiToken: "alice-new" });
    expect(store.get({ agentId: agent.id, integration: extensionTokenIntegration("pennylane"), scope: { type: "personal", userId: "bob" } })).toBeUndefined();
    expect(JSON.stringify({ agent, config })).toBe(before);
    const invalid: Record<string, string>[] = [{ apiToken: "$env:HOST_SECRET" }, { apiToken: "********" }, { unexpected: "value" }, { apiToken: "" }];
    for (const secrets of invalid) {
      expect(() => savePersonalExtensionTokens(extension, agent, config, "alice", secrets, store)).toThrow("Invalid personal credential fields");
    }
    extension.validateAgentConfig = () => ({ valid: false, errors: ["apiToken"] });
    expect(() => savePersonalExtensionTokens(extension, agent, config, "alice", { apiToken: "rejected" }, store)).toThrow("Extension configuration is invalid");
    expect(store.get({ agentId: agent.id, integration: extensionTokenIntegration("pennylane"), scope: { type: "personal", userId: "alice" } })).toEqual({ apiToken: "alice-new" });
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
