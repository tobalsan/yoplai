import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { registerCredentialConnectLinkProvider } from "../credential-connect.js";
import { defineToolExtension } from "../tool-extension.js";
import type { AgentConfig, GatewayConfig } from "../types.js";
import type { OAuthRequirement, ResolvedOAuth } from "./types.js";

function makeAgent(): AgentConfig {
  return {
    id: "a1",
    extensions: { demo: {} },
  } as unknown as AgentConfig;
}

function makeConfig(): GatewayConfig {
  return { agents: [], extensions: {} } as unknown as GatewayConfig;
}

describe("defineToolExtension oauth injection", () => {
  const extension = defineToolExtension({
    id: "demo",
    displayName: "Demo",
    description: "demo",
    configSchema: z.object({}).passthrough(),
    requiredSecrets: [],
    oauth: { provider: "google", scopes: ["scope-a"] },
    createTools(config) {
      return [
        {
          name: "check",
          description: "check",
          parameters: z.object({}),
          execute: async () => config.oauth,
        },
      ];
    },
  });

  it.each(["not_connected", "needs_reconnect"] as const)("returns one trusted Slack connect placeholder for %s without executing the provider tool", async (reason) => {
    const provider = vi.fn(async () => "<slack-pair-link>");
    const unregister = registerCredentialConnectLinkProvider(provider);
    try {
      const tools = await extension.getAgentTools!(makeAgent(), { config: makeConfig(), resolveOAuth: async () => ({ connected: false, provider: "google", reason, message: "Connect" }) });
      const context = { agent: makeAgent(), config: makeConfig(), userId: "alice", sessionId: "session" };
      expect(await tools[0].execute({}, context)).toEqual({ error: "oauth_connection_required", authorizeUrl: "<slack-pair-link>", message: "Connect your personal google account at <slack-pair-link>, then try again." });
      expect(provider).toHaveBeenCalledWith(context, { kind: "oauth", provider: "google", scopes: ["scope-a"] });
    } finally { unregister(); }
  });

  it("resolves config-dependent scopes with agent overrides at mount and execution", async () => {
    const dynamic = defineToolExtension({
      id: "demo", displayName: "Demo", description: "demo",
      configSchema: z.object({ allowWrite: z.boolean().default(false) }), requiredSecrets: [],
      oauth: (config) => ({ provider: "google", scopes: config.merged.allowWrite ? ["read", "write"] : ["read"] }),
      createTools: (config) => [{ name: "check", description: "check", parameters: z.object({}), execute: async () => config.oauth }],
    });
    const resolveOAuth = vi.fn(async () => ({ connected: true as const, provider: "google", accessToken: "test", scopes: ["read", "write"] }));
    const config = { ...makeConfig(), extensions: { demo: { allowWrite: true } } } as unknown as GatewayConfig;
    const agent = { ...makeAgent(), extensions: { demo: { allowWrite: false } } } as unknown as AgentConfig;
    const tools = await dynamic.getAgentTools!(agent, { config, resolveOAuth });
    await tools[0].execute({}, { agent, config, userId: "alice" });
    expect(resolveOAuth).toHaveBeenLastCalledWith(agent, { provider: "google", scopes: ["read"] }, "alice");
    const writeAgent = makeAgent();
    await dynamic.getAgentTools!(writeAgent, { config, resolveOAuth });
    expect(resolveOAuth).toHaveBeenLastCalledWith(writeAgent, { provider: "google", scopes: ["read", "write"] }, undefined);
    const noHost = await dynamic.getAgentTools!(agent, { config });
    expect(await noHost[0].execute({}, { agent, config })).toMatchObject({ reason: "provider_not_configured", provider: "google" });
  });

  it("passes the declared requirement to resolveOAuth and injects the result", async () => {
    const resolved: ResolvedOAuth = {
      connected: true,
      provider: "google",
      accessToken: "token-1",
      account: "alice@example.com",
      scopes: ["scope-a"],
    };
    const resolveOAuth = vi.fn(async () => resolved);

    const tools = await extension.getAgentTools!(makeAgent(), {
      config: makeConfig(),
      resolveOAuth,
    });
    const check = tools.find((tool) => tool.name === "demo_check")!;
    const result = await check.execute({}, {
      agent: makeAgent(),
      config: makeConfig(),
    });

    expect(resolveOAuth).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a1" }),
      { provider: "google", scopes: ["scope-a"] },
      undefined
    );
    expect(result).toEqual(resolved);
  });

  it("injects provider_not_configured when the host provides no resolver", async () => {
    const tools = await extension.getAgentTools!(makeAgent(), {
      config: makeConfig(),
    });
    const check = tools.find((tool) => tool.name === "demo_check")!;
    const result = (await check.execute({}, {
      agent: makeAgent(),
      config: makeConfig(),
    })) as ResolvedOAuth;

    expect(result.connected).toBe(false);
    if (!result.connected) expect(result.reason).toBe("provider_not_configured");
  });

  it("resolves OAuth again for each tool caller instead of reusing the mounted grant", async () => {
    const resolveOAuth = vi.fn(async (
      _agent: AgentConfig,
      _requirement: OAuthRequirement,
      userId?: string
    ) => ({
      connected: true as const,
      provider: "google",
      accessToken: `token-${userId}`,
      scopes: ["scope-a"],
    }));
    const tools = await extension.getAgentTools!(makeAgent(), {
      config: makeConfig(),
      resolveOAuth,
    });
    const check = tools.find((tool) => tool.name === "demo_check")!;

    const alice = await check.execute(
      {},
      { agent: makeAgent(), config: makeConfig(), userId: "alice" }
    );
    const bob = await check.execute(
      {},
      { agent: makeAgent(), config: makeConfig(), userId: "bob" }
    );

    expect(alice).toMatchObject({ accessToken: "token-alice" });
    expect(bob).toMatchObject({ accessToken: "token-bob" });
    expect(resolveOAuth).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a1" }),
      { provider: "google", scopes: ["scope-a"] },
      "alice"
    );
    expect(resolveOAuth).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a1" }),
      { provider: "google", scopes: ["scope-a"] },
      "bob"
    );
  });
});

describe("defineToolExtension oauth mode skips requiredSecrets", () => {
  const extension = defineToolExtension({
    id: "demo",
    displayName: "Demo",
    description: "demo",
    configSchema: z.object({ mode: z.enum(["api_key", "oauth"]).default("api_key") }).passthrough(),
    requiredSecrets: ["apiKey"],
    oauth: (config) => (config.merged.mode === "oauth" ? { provider: "zendesk", scopes: ["read"] } : undefined),
    createTools: () => [{ name: "check", description: "check", parameters: z.object({}), execute: async () => "ok" }],
  });
  const configFor = (demo: Record<string, unknown>) => ({
    config: { agents: [], extensions: {} } as unknown as GatewayConfig,
    agent: { id: "a1", extensions: { demo } } as unknown as AgentConfig,
  });

  it("requires secrets in api_key mode", () => {
    const { config, agent } = configFor({ enabled: true });
    expect(extension.validateAgentConfig?.(agent, config, {})).toEqual({ valid: false, errors: ["apiKey"] });
  });

  it("does not require secrets in oauth mode", () => {
    const { config, agent } = configFor({ enabled: true, mode: "oauth" });
    expect(extension.validateAgentConfig?.(agent, config, {})).toEqual({ valid: true, errors: [] });
  });

  it("runs tools directly when the oauth function yields no requirement", async () => {
    const { config, agent } = configFor({ enabled: true, apiKey: "k" });
    const resolveOAuth = vi.fn();
    const tools = await extension.getAgentTools!(agent, { config, resolveOAuth });
    expect(await tools[0].execute({}, { agent, config })).toBe("ok");
    expect(resolveOAuth).not.toHaveBeenCalled();
  });
});
