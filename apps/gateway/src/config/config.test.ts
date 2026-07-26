import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it, expect, vi } from "vitest";
import { AgentYamlConfigSchema, GatewayRootConfigSchema } from "@yoplai/shared";

async function writeAgent(dir: string, id: string) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "agent.yaml"),
    `id: ${id}\nname: ${id}\nmodel:\n  provider: test\n  model: test\n`
  );
}

describe("config validation", () => {
  let tmpDir: string | undefined;

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });
  it("validates a minimal v3 root config with agent globs", () => {
    const result = GatewayRootConfigSchema.safeParse({
      version: 3,
      agents: "./agents/*",
    });
    expect(result.success).toBe(true);
  });

  it("validates a minimal v3 root config with pool globs", () => {
    const result = GatewayRootConfigSchema.safeParse({
      version: 3,
      pool: "./pool/*",
    });
    expect(result.success).toBe(true);
  });

  it("allows omitted agents for empty installs", () => {
    const result = GatewayRootConfigSchema.safeParse({ version: 3 });
    expect(result.success).toBe(true);
  });

  it("keeps legacy records out of v3 discovery shape", () => {
    const result = GatewayRootConfigSchema.safeParse({
      version: 3,
      agents: "./agents/*",
    });
    expect(result.success).toBe(true);
  });

  it("validates agent.yaml fields without workspace", () => {
    const result = AgentYamlConfigSchema.safeParse({
      id: "test-agent",
      name: "Test Agent",
      model: { provider: "anthropic", model: "claude" },
      system_files: ["SOUL.md", { path: "USER.md", required: false }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid thinkLevel in agent.yaml", () => {
    const result = AgentYamlConfigSchema.safeParse({
      id: "test",
      name: "Test",
      model: { provider: "anthropic", model: "test" },
      thinkLevel: "invalid",
    });
    expect(result.success).toBe(false);
  });

  it("discovers agents from nested glob patterns", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-config-"));
    const home = path.join(tmpDir, "home");
    await fs.mkdir(home, { recursive: true });
    await writeAgent(path.join(home, "teams", "alpha", "bot-a"), "bot-a");
    await writeAgent(path.join(home, "teams", "beta", "bot-b"), "bot-b");
    await fs.writeFile(
      path.join(home, "yoplai.json"),
      JSON.stringify({ version: 3, agents: "teams/**/bot-?" })
    );
    vi.stubEnv("YOPLAI_HOME", home);
    const { loadConfig } = await import("./index.js");
    expect(loadConfig().agents.map((agent) => agent.id)).toEqual([
      "bot-a",
      "bot-b",
    ]);
  });

  it("discovers agents from exact directories and brace globs", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-config-"));
    const home = path.join(tmpDir, "home");
    await fs.mkdir(home, { recursive: true });
    await writeAgent(path.join(home, "exact"), "exact");
    await writeAgent(path.join(home, "pool", "red"), "red");
    await writeAgent(path.join(home, "pool", "blue"), "blue");
    await fs.writeFile(
      path.join(home, "yoplai.json"),
      JSON.stringify({ version: 3, agents: ["exact", "pool/{red,blue}"] })
    );
    vi.stubEnv("YOPLAI_HOME", home);
    const { loadConfig } = await import("./index.js");
    expect(loadConfig().agents.map((agent) => agent.id)).toEqual([
      "blue",
      "exact",
      "red",
    ]);
  });

  it("discovers pool agents from a pool glob", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-config-"));
    const home = path.join(tmpDir, "home");
    await fs.mkdir(home, { recursive: true });
    await writeAgent(path.join(home, "pool", "foo"), "foo");
    await writeAgent(path.join(home, "pool", "bar"), "bar");
    await fs.mkdir(path.join(home, "pool", ".git"), { recursive: true });
    await fs.writeFile(
      path.join(home, "yoplai.json"),
      JSON.stringify({ version: 3, pool: "pool/*" })
    );
    vi.stubEnv("YOPLAI_HOME", home);
    const { loadConfig } = await import("./index.js");
    expect(loadConfig().pool?.map((agent) => agent.id)).toEqual([
      "bar",
      "foo",
    ]);
    expect(loadConfig().agents).toEqual([]);
    expect(loadConfig().forkedAgents).toBe(true);
  });

  it("defaults missing agents config to $YOPLAI_HOME/agents", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-config-"));
    const home = path.join(tmpDir, "home");
    await fs.mkdir(home, { recursive: true });
    await writeAgent(path.join(home, "agents", "local"), "local");
    await fs.writeFile(
      path.join(home, "yoplai.json"),
      JSON.stringify({ version: 3 })
    );
    vi.stubEnv("YOPLAI_HOME", home);
    const { loadConfig } = await import("./index.js");
    const config = loadConfig();
    expect(config.agents.map((agent) => agent.id)).toEqual(["local"]);
    expect(config.pool).toBeUndefined();
    expect(config.forkedAgents).toBe(false);
  });

  it("fails clearly when default agents folder is missing", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-config-"));
    const home = path.join(tmpDir, "home");
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(
      path.join(home, "yoplai.json"),
      JSON.stringify({ version: 3 })
    );
    vi.stubEnv("YOPLAI_HOME", home);
    const { loadConfig } = await import("./index.js");
    expect(() => loadConfig()).toThrow(/no valid agents found/);
  });

  it("fails clearly when pool is configured but empty", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-config-"));
    const home = path.join(tmpDir, "home");
    await fs.mkdir(path.join(home, "pool"), { recursive: true });
    await fs.writeFile(
      path.join(home, "yoplai.json"),
      JSON.stringify({ version: 3, pool: "pool/*" })
    );
    vi.stubEnv("YOPLAI_HOME", home);
    const { loadConfig } = await import("./index.js");
    expect(() => loadConfig()).toThrow(
      /pool is configured but no valid agents/
    );
  });
});
