import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearConfigCacheForTests,
  getConfigPath,
  loadConfig,
  resolveAgentEnv,
} from "../index.js";
import { writeFileSync } from "node:fs";

async function writeAgent(dir: string, id = path.basename(dir)) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "agent.yaml"),
    `id: ${id}\nname: ${id}\nmodel:\n  provider: anthropic\n  model: claude\n`
  );
}

describe("config loading", () => {
  const prevConfig = process.env.YOPLAI_CONFIG;
  const prevHome = process.env.YOPLAI_HOME;

  afterEach(() => {
    clearConfigCacheForTests();
    if (prevConfig === undefined) delete process.env.YOPLAI_CONFIG;
    else process.env.YOPLAI_CONFIG = prevConfig;
    if (prevHome === undefined) delete process.env.YOPLAI_HOME;
    else process.env.YOPLAI_HOME = prevHome;
  });

  it("honors YOPLAI_HOME and exact agent dirs", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-config-"));
    const agentDir = path.join(tmpDir, "agents", "custom");
    await writeAgent(agentDir);
    await fs.writeFile(
      path.join(tmpDir, "yoplai.json"),
      JSON.stringify({ version: 3, agents: [agentDir] })
    );

    process.env.YOPLAI_HOME = tmpDir;

    expect(getConfigPath()).toBe(path.join(tmpDir, "yoplai.json"));
    const agents = loadConfig().agents;
    expect(agents.map((agent) => agent.id)).toEqual(["custom"]);
    expect(agents[0].workspace).toBe(agentDir);
    expect(agents[0].workspaceDir).toBe(agentDir);
  });

  it("loads agents from direct child glob", async () => {
    const tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "yoplai-config-glob-")
    );
    await writeAgent(path.join(tmpDir, "agents", "beta"));
    await writeAgent(path.join(tmpDir, "agents", "alpha"));
    await fs.writeFile(
      path.join(tmpDir, "yoplai.json"),
      JSON.stringify({ version: 3, agents: "./agents/*" })
    );
    process.env.YOPLAI_HOME = tmpDir;

    expect(loadConfig().agents.map((agent) => agent.id)).toEqual([
      "alpha",
      "beta",
    ]);
  });

  it("resolves per-agent env with isolation and documented precedence", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-agent-env-"));
    const sallyDir = path.join(tmpDir, "agents", "sally");
    const caseyDir = path.join(tmpDir, "agents", "casey");
    await writeAgent(sallyDir);
    await writeAgent(caseyDir);
    await fs.writeFile(
      path.join(tmpDir, ".env"),
      "SLACK_TOKEN=home\nHOME_ONLY=home\n"
    );
    await fs.writeFile(
      path.join(sallyDir, ".env"),
      "SLACK_TOKEN=sally\nAGENT_ONLY=sally\n"
    );
    await fs.writeFile(path.join(caseyDir, ".env"), "SLACK_TOKEN=casey\n");
    await fs.writeFile(
      path.join(tmpDir, "yoplai.json"),
      JSON.stringify({
        version: 3,
        agents: "./agents/*",
        env: {
          SLACK_TOKEN: "config",
          HOME_ONLY: "config",
          CONFIG_ONLY: "config",
          PROCESS_ONLY: "config",
        },
      })
    );
    const prevProcessOnly = process.env.PROCESS_ONLY;
    const prevSlackToken = process.env.SLACK_TOKEN;
    const prevHomeOnly = process.env.HOME_ONLY;
    const prevConfigOnly = process.env.CONFIG_ONLY;
    const prevAgentOnly = process.env.AGENT_ONLY;
    process.env.PROCESS_ONLY = "process";
    process.env.YOPLAI_HOME = tmpDir;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const config = loadConfig();
    const sally = config.agents.find((agent) => agent.id === "sally")!;
    const casey = config.agents.find((agent) => agent.id === "casey")!;

    expect(resolveAgentEnv(sally, config)).toMatchObject({
      SLACK_TOKEN: "sally",
      HOME_ONLY: "home",
      CONFIG_ONLY: "config",
      PROCESS_ONLY: "config",
      AGENT_ONLY: "sally",
    });
    expect(resolveAgentEnv(casey, config)).toMatchObject({
      SLACK_TOKEN: "casey",
      HOME_ONLY: "home",
      CONFIG_ONLY: "config",
      PROCESS_ONLY: "config",
    });
    expect(resolveAgentEnv(casey, config).AGENT_ONLY).toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith(
      '[config] loaded agent env for "sally": AGENT_ONLY, SLACK_TOKEN'
    );
    expect(logSpy).toHaveBeenCalledWith(
      '[config] loaded agent env for "casey": SLACK_TOKEN'
    );

    if (prevProcessOnly === undefined) delete process.env.PROCESS_ONLY;
    else process.env.PROCESS_ONLY = prevProcessOnly;
    if (prevSlackToken === undefined) delete process.env.SLACK_TOKEN;
    else process.env.SLACK_TOKEN = prevSlackToken;
    if (prevHomeOnly === undefined) delete process.env.HOME_ONLY;
    else process.env.HOME_ONLY = prevHomeOnly;
    if (prevConfigOnly === undefined) delete process.env.CONFIG_ONLY;
    else process.env.CONFIG_ONLY = prevConfigOnly;
    if (prevAgentOnly === undefined) delete process.env.AGENT_ONLY;
    else process.env.AGENT_ONLY = prevAgentOnly;
    logSpy.mockRestore();
  });

  it("rejects v2 config with migrate message", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-config-v2-"));
    await fs.writeFile(
      path.join(tmpDir, "yoplai.json"),
      JSON.stringify({ version: 2, agents: [] })
    );
    process.env.YOPLAI_HOME = tmpDir;
    expect(() => loadConfig()).toThrow(
      "yoplai.json is version 2. Run `yoplai agents migrate` to upgrade to version 3."
    );
  });

  it("rejects id mismatch", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-config-id-"));
    const agentDir = path.join(tmpDir, "agents", "folder");
    await writeAgent(agentDir, "other");
    await fs.writeFile(
      path.join(tmpDir, "yoplai.json"),
      JSON.stringify({ version: 3, agents: [agentDir] })
    );
    process.env.YOPLAI_HOME = tmpDir;
    expect(() => loadConfig()).toThrow(/id mismatch/);
  });

  it("warns at startup when onecli CA file path does not exist", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-onecli-ca-"));
    await fs.writeFile(
      path.join(tmpDir, "yoplai.json"),
      JSON.stringify({
        version: 3,
        agents: [],
        onecli: {
          enabled: true,
          gatewayUrl: "http://localhost:10255",
          ca: { source: "file", path: "/nonexistent/onecli-ca.pem" },
        },
      })
    );
    process.env.YOPLAI_HOME = tmpDir;

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => loadConfig()).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/CA file not found.*\/nonexistent\/onecli-ca\.pem/)
    );
    warnSpy.mockRestore();
  });

  it("does not throw when onecli CA file path exists", async () => {
    const tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "yoplai-onecli-ca-ok-")
    );
    const caPath = path.join(tmpDir, "ca.pem");
    writeFileSync(
      caPath,
      "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n"
    );
    await fs.writeFile(
      path.join(tmpDir, "yoplai.json"),
      JSON.stringify({
        version: 3,
        agents: [],
        onecli: {
          enabled: true,
          gatewayUrl: "http://localhost:10255",
          ca: { source: "file", path: caPath },
        },
      })
    );
    process.env.YOPLAI_HOME = tmpDir;

    expect(() => loadConfig()).not.toThrow();
  });
});
