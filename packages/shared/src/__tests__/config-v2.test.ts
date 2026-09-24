import { describe, expect, it } from "vitest";
import { GatewayConfigSchema } from "../types.js";

describe("GatewayConfigSchema v2", () => {
  it("parses v1 config without version", () => {
    const result = GatewayConfigSchema.parse({
      agents: [
        {
          id: "main",
          name: "Main",
          workspace: "~/agents/main",
          model: { provider: "anthropic", model: "claude" },
        },
      ],
      extensions: {
        scheduler: { enabled: true },
      },
    });

    expect(result.version).toBeUndefined();
    expect(result.extensions?.scheduler?.enabled).toBe(true);
  });

  it("parses v2 config with onecli and extensions", () => {
    const result = GatewayConfigSchema.parse({
      version: 2,
      agents: [
        {
          id: "main",
          name: "Main",
          workspace: "~/agents/main",
          model: { provider: "anthropic", model: "claude" },
        },
      ],
      onecli: {
        enabled: true,
        gatewayUrl: "http://localhost:10255",
      },
      extensions: {
        scheduler: { enabled: true },
        heartbeat: { enabled: true },
      },
    });

    expect(result.version).toBe(2);
    expect(result.onecli?.gatewayUrl).toBe("http://localhost:10255");
    expect(result.extensions?.scheduler?.enabled).toBe(true);
  });

  it("allows disabled multiUser without oauth config", () => {
    const result = GatewayConfigSchema.parse({
      version: 2,
      agents: [
        {
          id: "main",
          name: "Main",
          workspace: "~/agents/main",
          model: { provider: "anthropic", model: "claude" },
        },
      ],
      extensions: {
        multiUser: {
          enabled: false,
        },
      },
    });

    expect(result.extensions?.multiUser).toEqual({ enabled: false });
  });

  it("requires at least one auth method when multiUser is enabled", () => {
    for (const methods of [{}, { emailAndPassword: { enabled: false } }]) {
      expect(() =>
        GatewayConfigSchema.parse({
          version: 2,
          agents: [
            {
              id: "main",
              name: "Main",
              workspace: "~/agents/main",
              model: { provider: "anthropic", model: "claude" },
            },
          ],
          extensions: {
            multiUser: {
              enabled: true,
              sessionSecret: "secret",
              ...methods,
            },
          },
        })
      ).toThrow(/at least one auth method/);
    }
  });

  it("accepts emailAndPassword as the only multiUser auth method", () => {
    const result = GatewayConfigSchema.parse({
      version: 2,
      agents: [
        {
          id: "main",
          name: "Main",
          workspace: "~/agents/main",
          model: { provider: "anthropic", model: "claude" },
        },
      ],
      extensions: {
        multiUser: {
          enabled: true,
          sessionSecret: "secret",
          emailAndPassword: { enabled: true },
        },
      },
    });

    expect(result.extensions?.multiUser).toMatchObject({
      enabled: true,
      emailAndPassword: { enabled: true },
    });
  });
});
