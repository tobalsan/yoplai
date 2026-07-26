import { describe, expect, it } from "vitest";
import type { GatewayConfig } from "@yoplai/shared";
import { spawnProjectSubagent } from "./spawn-project-subagent.js";

describe("spawnProjectSubagent", () => {
  it("requires slug, cli, and prompt for CLI subagent runs", async () => {
    const result = await spawnProjectSubagent(
      { agents: [] } as unknown as GatewayConfig,
      "PRO-1",
      { slug: "worker", cli: "codex" }
    );

    expect(result).toEqual({
      ok: false,
      error: "Missing required fields",
      status: 400,
    });
  });

  it("rejects unsupported CLI values", async () => {
    const result = await spawnProjectSubagent(
      { agents: [] } as unknown as GatewayConfig,
      "PRO-1",
      { slug: "worker", cli: "bogus", prompt: "do work" }
    );

    expect(result).toEqual({
      ok: false,
      error: "Unsupported CLI: bogus. Supported CLIs: claude, codex, pi.",
      status: 400,
    });
  });
});
