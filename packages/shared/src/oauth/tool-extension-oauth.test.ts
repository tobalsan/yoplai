import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
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
