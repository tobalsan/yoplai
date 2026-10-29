import { describe, expect, it } from "vitest";
import { GatewayConfigSchema, GatewayRootConfigSchema } from "../types.js";

function agent(id: string) {
  return {
    id,
    name: id,
    workspace: `~/agents/${id}`,
    model: { provider: "anthropic", model: "claude" },
  };
}

describe("session auto-title config", () => {
  it("accepts an optional root maintenance model", () => {
    const root = GatewayRootConfigSchema.safeParse({
      version: 3,
      agents: "agents/*",
      maintenance: { provider: "anthropic", model: "claude-haiku" },
    });
    const resolved = GatewayConfigSchema.safeParse({
      agents: [agent("pom")],
      extensions: {},
      maintenance: { provider: "anthropic", model: "claude-haiku" },
    });

    expect(root.success).toBe(true);
    expect(resolved.success).toBe(true);
  });

  it("rejects missing or empty maintenance model fields", () => {
    for (const maintenance of [
      { provider: "anthropic" },
      { model: "claude-haiku" },
      { provider: "", model: "claude-haiku" },
      { provider: "anthropic", model: "" },
    ]) {
      expect(
        GatewayRootConfigSchema.safeParse({ version: 3, maintenance }).success
      ).toBe(false);
    }
  });
});
