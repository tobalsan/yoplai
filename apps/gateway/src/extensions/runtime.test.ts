import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  GatewayConfigSchema,
  registerCredentialConnectLinkProvider,
  type AgentConfig,
  getOAuthProvider,
  type Extension,
} from "@yoplai/shared";
import { ExtensionRuntime } from "./runtime.js";
import { getOAuthService } from "../oauth/service.js";

function extension(overrides: Partial<Extension> & { id: string }): Extension {
  const { id, ...rest } = overrides;
  return {
    id,
    displayName: id,
    description: id,
    dependencies: [],
    configSchema: z.object({}),
    routePrefixes: [],
    validateConfig: () => ({ valid: true, errors: [] }),
    registerRoutes: () => undefined,
    start: async () => undefined,
    stop: async () => undefined,
    capabilities: () => [],
    ...rest,
  };
}

const agent: AgentConfig = {
  id: "main",
  name: "Main",
  workspace: "~/agents/main",
  queueMode: "queue",
  model: { provider: "anthropic", model: "claude" },
};

const config = GatewayConfigSchema.parse({
  version: 2,
  agents: [agent],
  extensions: {
    sample: { enabled: true },
  },
});

describe("ExtensionRuntime", () => {
  it("refuses a missing token with the trusted Slack flow link without executing the extension", async () => {
    const execute = vi.fn();
    const provider = vi.fn(async () => "<slack-pair-link>");
    const unregister = registerCredentialConnectLinkProvider(provider);
    const runtime = new ExtensionRuntime();
    runtime.load([extension({ id: "sample", requiredSecrets: ["token"], getAgentTools: async () => [{ name: "sample_send", description: "Send", parameters: {}, execute }] })]);
    const requester = { ...agent, extensions: { sample: { enabled: true } } };
    try {
      const result = await runtime.executeTool(requester, "sample_send", {}, config, "session");
      expect(result.result).toMatchObject({ error: "extension_credentials_required", connectUrl: "<slack-pair-link>" });
      expect(provider).toHaveBeenCalledWith(expect.objectContaining({ agent: requester, sessionId: "session" }), { kind: "token", extensionId: "sample" });
      expect(execute).not.toHaveBeenCalled();
    } finally { unregister(); }
  });

  it("refuses a disconnected external OAuth extension with the trusted Slack flow link", async () => {
    const execute = vi.fn();
    const provider = vi.fn(async () => "<slack-pair-link>");
    const unregister = registerCredentialConnectLinkProvider(provider);
    const resolveToken = vi.spyOn(getOAuthService(), "resolveToken").mockResolvedValue({ connected: false, provider: "google", reason: "not_connected", message: "not connected" });
    const oauth = { provider: "google", scopes: ["gmail"] };
    const runtime = new ExtensionRuntime();
    runtime.load([extension({ id: "sample", oauth, getAgentTools: async () => [{ name: "sample_send", description: "Send", parameters: {}, execute }] })]);
    try {
      const result = await runtime.executeTool(agent, "sample_send", {}, config, "session");
      expect(result.result).toMatchObject({ error: "oauth_connection_required", authorizeUrl: "<slack-pair-link>" });
      expect(provider).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "session" }), { kind: "oauth", ...oauth });
      expect(execute).not.toHaveBeenCalled();
    } finally { unregister(); resolveToken.mockRestore(); }
  });

  it("passes config-dependent scopes to the external OAuth connect flow", async () => {
    const execute = vi.fn();
    const provider = vi.fn(async () => "<slack-pair-link>");
    const unregister = registerCredentialConnectLinkProvider(provider);
    const resolveToken = vi.spyOn(getOAuthService(), "resolveToken").mockResolvedValue({ connected: false, provider: "google", reason: "insufficient_scope", message: "Reconnect" });
    const runtime = new ExtensionRuntime();
    runtime.load([extension({ id: "sample", oauth: (resolved) => ({ provider: "google", scopes: resolved.merged.allowWrite ? ["read", "write"] : ["read"] }), getAgentTools: async () => [{ name: "sample_send", description: "Send", parameters: {}, execute }] })]);
    const writeConfig = { ...config, extensions: { sample: { allowWrite: true } } };
    const requester = { ...agent, extensions: { sample: { enabled: true, allowWrite: false } } };
    try {
      const result = await runtime.executeTool(requester, "sample_send", {}, writeConfig, "session");
      expect(result.result).toMatchObject({ connected: false, reason: "insufficient_scope", authorizeUrl: "<slack-pair-link>" });
      expect(resolveToken).toHaveBeenLastCalledWith("main", { provider: "google", scopes: ["read"] }, undefined);
      expect(provider).toHaveBeenLastCalledWith(expect.anything(), { kind: "oauth", provider: "google", scopes: ["read"] });
      await runtime.executeTool(agent, "sample_send", {}, writeConfig, "session");
      expect(provider).toHaveBeenLastCalledWith(expect.anything(), { kind: "oauth", provider: "google", scopes: ["read", "write"] });
      expect(execute).not.toHaveBeenCalled();
    } finally { unregister(); resolveToken.mockRestore(); }
  });

  it("owns loaded extension state and capabilities", () => {
    const runtime = new ExtensionRuntime();
    runtime.load(
      [
        extension({
          id: "sample",
          capabilities: () => ["sample-capability"],
        }),
      ],
      "sample"
    );

    expect(runtime.getLoadedExtensions().map((item) => item.id)).toEqual([
      "sample",
    ]);
    expect(runtime.isEnabled("sample")).toBe(true);
    expect(runtime.getHomeExtension()).toBe("sample");
    expect(runtime.getCapabilities()).toEqual({
      extensions: { sample: true },
      capabilities: { sample: ["sample-capability"] },
      multiUser: false,
      home: "sample",
    });
  });

  it("builds route matchers from metadata", () => {
    const runtime = new ExtensionRuntime([
      {
        id: "sample",
        routePrefixes: ["/api/sample", "/api/agents/:id/sample"],
        allowWhenDisabled: true,
      },
    ]);

    const matchers = runtime.getRouteMatchers();
    expect(
      matchers.find((matcher) => matcher.matches("/api/sample/item"))?.extension
    ).toBe("sample");
    const agentMatcher = matchers.find((matcher) =>
      matcher.matches("/api/agents/main/sample")
    );
    expect(agentMatcher?.extension).toBe("sample");
    expect(agentMatcher?.allowWhenDisabled).toBe(true);
    expect(
      matchers.some((matcher) => matcher.matches("/api/agents/main/other"))
    ).toBe(false);
  });

  it("merges loaded extension routes without replacing known metadata", () => {
    const runtime = new ExtensionRuntime([
      {
        id: "scheduler",
        routePrefixes: ["/api/schedules"],
        allowWhenDisabled: true,
      },
    ]);

    runtime.load([
      extension({ id: "scheduler", routePrefixes: ["/api/other-schedules"] }),
      extension({
        id: "external",
        routePrefixes: ["/api/thing", "/api/agents/:id/thing"],
      }),
    ]);

    const matchers = runtime.getRouteMatchers();
    expect(
      matchers.find((matcher) => matcher.matches("/api/schedules"))
        ?.allowWhenDisabled
    ).toBe(true);
    expect(
      matchers.some((matcher) => matcher.matches("/api/other-schedules"))
    ).toBe(false);
    expect(
      matchers.find((matcher) => matcher.matches("/api/thing/sub"))?.extension
    ).toBe("external");
    expect(
      matchers.find((matcher) =>
        matcher.matches("/api/agents/main/thing")
      )?.extension
    ).toBe("external");
  });

  it("resolves prompt and tool lookups through loaded extensions", async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    const runtime = new ExtensionRuntime();
    runtime.load([
      extension({
        id: "sample",
        getSystemPromptContributions: () => ["Use sample.", " "],
        getAgentTools: () => [
          {
            name: "sample_run",
            description: "Run sample",
            parameters: { type: "object" },
            execute,
          },
        ],
      }),
    ]);

    await expect(
      runtime.getPromptContributions(agent, config)
    ).resolves.toEqual(["Use sample."]);
    await expect(runtime.getTools(agent, config)).resolves.toMatchObject([
      { extensionId: "sample", name: "sample_run" },
    ]);
    await expect(
      runtime.executeTool(agent, "sample_run", { value: 1 }, config)
    ).resolves.toEqual({ found: true, result: { ok: true } });
    expect(execute).toHaveBeenCalledWith(
      { value: 1 },
      expect.objectContaining({
        agent,
        config,
        env: expect.objectContaining(process.env),
      })
    );
  });

  it("passes requester identity into extension hooks and tool execution", async () => {
    let promptUserId: string | undefined;
    let toolUserId: string | undefined;
    const runtime = new ExtensionRuntime();
    runtime.load([
      extension({
        id: "identity",
        getSystemPromptContributions: (_agent, context) => {
          promptUserId = context?.userId;
          return "identity prompt";
        },
        getAgentTools: (_agent, context) => {
          expect(context?.userId).toBe("user-1");
          return [{
            name: "identity_run",
            description: "Run identity",
            parameters: {},
            execute: async (_args, toolContext) => {
              toolUserId = toolContext.userId;
            },
          }];
        },
      }),
    ]);

    await runtime.getPromptContributions(agent, config, "user-1");
    await runtime.executeTool(agent, "identity_run", {}, config, undefined, "user-1");

    expect(promptUserId).toBe("user-1");
    expect(toolUserId).toBe("user-1");
  });

  it("rejects duplicate tool names", async () => {
    const runtime = new ExtensionRuntime();
    runtime.load([
      extension({
        id: "one",
        getAgentTools: () => [
          {
            name: "duplicate",
            description: "One",
            parameters: {},
            execute: async () => undefined,
          },
        ],
      }),
      extension({
        id: "two",
        getAgentTools: () => [
          {
            name: "duplicate",
            description: "Two",
            parameters: {},
            execute: async () => undefined,
          },
        ],
      }),
    ]);

    await expect(runtime.getTools(agent, config)).rejects.toThrow(
      "Duplicate extension agent tool: duplicate"
    );
  });

  it("skips a failing extension without exposing its secret", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const runtime = new ExtensionRuntime();
    runtime.load([
      extension({ id: "broken", getAgentTools: () => { throw new Error('missing required secret "token" value=super-secret'); }, getSystemPromptContributions: () => { throw new Error('missing required secret "token" value=super-secret'); } }),
      extension({ id: "healthy", getAgentTools: () => [{ name: "ok", description: "ok", parameters: {}, execute: async () => undefined }], getSystemPromptContributions: () => "healthy" }),
    ]);

    await expect(runtime.getTools(agent, config)).resolves.toMatchObject([{ name: "ok" }]);
    await expect(runtime.getPromptContributions(agent, config)).resolves.toEqual(["healthy"]);
    expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ extensionId: "broken", agentId: "main", fields: ["token"] }));
    expect(JSON.stringify(warn.mock.calls)).not.toContain("super-secret");
    warn.mockRestore();
  });
});

describe("ExtensionRuntime OAuth provider registration", () => {
  const descriptor = {
    id: "runtime-test-provider",
    displayName: "Runtime Test",
    authorizeUrl: "https://example.test/authorize",
    tokenUrl: "https://example.test/token",
    defaultScopes: ["read"],
  };

  it("registers descriptors shipped by loaded extensions, tolerating equivalent duplicates", () => {
    new ExtensionRuntime().load([
      extension({ id: "one", oauthProviders: [descriptor] }),
      extension({ id: "two", oauthProviders: [{ ...descriptor }] }),
    ]);
    expect(getOAuthProvider("runtime-test-provider")).toBe(descriptor);
  });

  it("fails load with a clear error on a conflicting descriptor", () => {
    expect(() =>
      new ExtensionRuntime().load([
        extension({ id: "one", oauthProviders: [descriptor] }),
        extension({
          id: "two",
          oauthProviders: [{ ...descriptor, tokenUrl: "https://other.test/token" }],
        }),
      ])
    ).toThrow(
      'Extension "two" cannot register OAuth provider: OAuth provider "runtime-test-provider" is already registered with a conflicting descriptor'
    );
  });
});
