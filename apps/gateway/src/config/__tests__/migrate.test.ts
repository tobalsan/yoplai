import { describe, expect, it } from "vitest";
import { GatewayConfigSchema } from "@yoplai/shared";
import { migrateConfigV1toV2 } from "../migrate.js";

describe("migrateConfigV1toV2", () => {
  it("moves legacy config into extensions", () => {
    const { config, warnings } = migrateConfigV1toV2(
      GatewayConfigSchema.parse({
      agents: [
        {
          id: "main",
          name: "Main",
          workspace: "~/agents/main",
          model: { provider: "anthropic", model: "claude" },
          discord: {
            token: "$env:DISCORD_TOKEN",
            channelId: "123",
            dm: { enabled: true, groupEnabled: false },
          },
          heartbeat: { every: "30m" },
        },
      ],
      scheduler: { enabled: true },
      projects: { root: "~/projects" },
      })
    );

    expect(warnings).toEqual([]);
    expect(config.version).toBe(2);
    expect(config.extensions?.discord?.channels?.["123"]?.agent).toBe("main");
    expect(config.extensions?.heartbeat?.enabled).toBe(true);
    expect(config.extensions?.scheduler?.enabled).toBe(true);
    expect(config.extensions?.projects?.root).toBe("~/projects");
    expect(config.agents[0]?.discord?.token).toBe("$env:DISCORD_TOKEN");
  });

  it("warns when multiple discord tokens exist", () => {
    const { warnings } = migrateConfigV1toV2(
      GatewayConfigSchema.parse({
      agents: [
        {
          id: "main",
          name: "Main",
          workspace: "~/agents/main",
          model: { provider: "anthropic", model: "claude" },
          discord: { token: "token-a", channelId: "123" },
        },
        {
          id: "ops",
          name: "Ops",
          workspace: "~/agents/ops",
          model: { provider: "anthropic", model: "claude" },
          discord: { token: "token-b", channelId: "456" },
        },
      ],
      })
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Multiple Discord tokens found");
  });
});
