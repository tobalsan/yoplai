import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GatewayConfigSchema } from "@yoplai/shared";
import { loadExtensions } from "../extensions/registry.js";

async function loadedIds(extensions?: Record<string, unknown>) {
  const config = GatewayConfigSchema.parse({
    version: 2,
    extensionsPath: await mkdtemp(path.join(tmpdir(), "yoplai-empty-extensions-")),
    agents: [{ id: "main", name: "Main", workspace: "~/agents/main", model: { provider: "anthropic", model: "claude" }, extensions }],
  });
  return (await loadExtensions(config)).map((e) => e.id);
}

describe("chat-shape registration", () => {
  it("is off by default and when disabled", async () => {
    expect(await loadedIds()).not.toContain("chat-shape");
    expect(await loadedIds({ "chat-shape": { enabled: false } })).not.toContain("chat-shape");
  });
  it("loads when an agent has the block", async () => {
    expect(await loadedIds({ "chat-shape": {} })).toContain("chat-shape");
  });
});
