import { describe, expect, it } from "vitest";
import { GatewayConfigSchema, GatewayRootConfigSchema } from "../types.js";

const agent = {
  id: "pom",
  name: "Pom",
  workspace: "~/agents/pom",
  model: { provider: "anthropic", model: "claude" },
};

const commonSettings = {
  defaultProjectManager: "pom",
  sandbox: { sharedDir: "/shared" },
  maintenance: { provider: "anthropic", model: "claude-haiku" },
  imageDescription: { provider: "openai", model: "gpt" },
  extensions: {},
  extensionsPath: "./extensions",
  branding: { name: "Yoplai", logo: "/logo.png" },
  enableCronMonitoring: true,
  canvas: { baseUrl: "https://canvas.example.com" },
  server: { host: "0.0.0.0", port: 3000, baseUrl: "http://x" },
  gateway: { port: 4000, bind: "lan" },
  sessions: { idleMinutes: 30 },
  agentLoop: { maxAgentTurns: 5, maxHops: 0 },
  web: { baseUrl: "http://web" },
  ui: { enabled: true, bind: "tailnet" },
  env: { FOO: "bar" },
};

describe("gateway root and resolved config schemas", () => {
  it("parse shared settings identically, including key order", () => {
    const root = GatewayRootConfigSchema.parse({
      version: 3,
      agents: "agents/*",
      ...commonSettings,
    });
    const resolved = GatewayConfigSchema.parse({
      agents: [agent],
      ...commonSettings,
    });

    const rootCommon: Record<string, unknown> = { ...root };
    delete rootCommon.version;
    delete rootCommon.agents;
    const resolvedCommon: Record<string, unknown> = { ...resolved };
    delete resolvedCommon.agents;
    expect(resolvedCommon).toEqual(rootCommon);
    expect(Object.keys(resolvedCommon)).toEqual(Object.keys(rootCommon));
    // Pinned order is the GatewayCommonFields shape order (zod emits shape order).
    expect(Object.keys(rootCommon)).toEqual(Object.keys(commonSettings));
    expect(rootCommon).toMatchObject(commonSettings);
    expect(rootCommon.canvas).toEqual({
      enabled: true,
      baseUrl: "https://canvas.example.com",
    });
    expect(root.imageDescription?.enabled).toBe(true);
  });

  it("apply the same defaults to an empty config", () => {
    const root = GatewayRootConfigSchema.parse({});
    const resolved = GatewayConfigSchema.parse({ agents: [] });

    expect(root.enableCronMonitoring ?? false).toBe(false);
    expect(root.sessions).toEqual({ idleMinutes: 360 });
    expect(resolved.enableCronMonitoring ?? false).toBe(false);
    expect(resolved.sessions).toEqual({ idleMinutes: 360 });
    expect(Object.keys(resolved)).toEqual(["agents", ...Object.keys(root)]);
  });

  it("reject the same invalid shared settings", () => {
    const invalid = [
      { canvas: { baseUrl: "not a url" } },
      { agentLoop: { maxHops: -1 } },
      { agentLoop: { maxAgentTurns: 0 } },
      { sessions: { idleMinutes: 0 } },
      { gateway: { bind: "public" } },
    ];
    for (const settings of invalid) {
      expect(GatewayRootConfigSchema.safeParse(settings).success).toBe(false);
      expect(
        GatewayConfigSchema.safeParse({ agents: [], ...settings }).success
      ).toBe(false);
    }
  });

  it("keep discovery and resolved agent inputs distinct", () => {
    expect(
      GatewayRootConfigSchema.safeParse({ agents: ["a/*"], pool: "p/*" })
        .success
    ).toBe(true);
    expect(GatewayRootConfigSchema.safeParse({ agents: [agent] }).success).toBe(
      false
    );
    expect(GatewayRootConfigSchema.safeParse({ version: 2 }).success).toBe(
      false
    );

    expect(GatewayConfigSchema.safeParse({ agents: "a/*" }).success).toBe(
      false
    );
    expect(GatewayConfigSchema.safeParse({}).success).toBe(false);
    expect(
      GatewayConfigSchema.parse({ version: 2, agents: [], pool: [agent] })
    ).toMatchObject({ version: 2, pool: [{ id: "pom" }] });
  });

  it("keep forkedAgents only in the resolved config", () => {
    expect(GatewayRootConfigSchema.parse({ forkedAgents: true })).not.toHaveProperty(
      "forkedAgents"
    );
    expect(
      GatewayConfigSchema.parse({ agents: [], forkedAgents: true }).forkedAgents
    ).toBe(true);
  });
});
