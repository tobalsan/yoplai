import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearConfigCacheForTests,
  getConfigPath,
  loadConfig,
  reloadConfig,
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

async function setupAgentEnv() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-env-log-"));
  const agentDir = path.join(tmpDir, "agents", "assistant");
  await writeAgent(agentDir);
  await fs.writeFile(
    path.join(tmpDir, "yoplai.json"),
    JSON.stringify({ version: 3, agents: [agentDir] })
  );
  process.env.YOPLAI_HOME = tmpDir;
  const config = loadConfig();
  return { tmpDir, agentDir, envPath: path.join(agentDir, ".env"), config };
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

  it("skips a removed SDK agent while loading valid agents from the same glob", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-config-removed-sdk-"));
    const staleDir = path.join(tmpDir, "agents", "stale");
    await writeAgent(staleDir);
    await fs.appendFile(path.join(staleDir, "agent.yaml"), "sdk: claude\n");
    await writeAgent(path.join(tmpDir, "agents", "valid"));
    await fs.writeFile(
      path.join(tmpDir, "yoplai.json"),
      JSON.stringify({ version: 3, agents: "./agents/*" })
    );
    process.env.YOPLAI_HOME = tmpDir;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(loadConfig().agents.map((agent) => agent.id)).toEqual(["valid"]);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining(
        `[config] invalid ${path.join(staleDir, "agent.yaml")}:`
      ));
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("claude SDK was removed, use pi"));
    } finally {
      warning.mockRestore();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
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

  it("logs agent env only when content changes while returning fresh values", async () => {
    const { tmpDir, envPath, config } = await setupAgentEnv();
    const agent = config.agents[0];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await fs.writeFile(envPath, "ENV_LOG_TOKEN=first-secret\n");
      expect(resolveAgentEnv(agent, config).ENV_LOG_TOKEN).toBe("first-secret");
      expect(resolveAgentEnv(agent, config).ENV_LOG_TOKEN).toBe("first-secret");
      expect(logSpy.mock.calls).toEqual([
        ['[config] loaded agent env for "assistant": ENV_LOG_TOKEN'],
      ]);

      await fs.writeFile(envPath, "ENV_LOG_TOKEN=second-secret\n");
      expect(resolveAgentEnv(agent, config).ENV_LOG_TOKEN).toBe("second-secret");
      expect(logSpy.mock.calls).toEqual([
        ['[config] loaded agent env for "assistant": ENV_LOG_TOKEN'],
        ['[config] loaded agent env for "assistant": ENV_LOG_TOKEN'],
      ]);

      await fs.writeFile(envPath, "ENV_LOG_TOKEN=second-secret\n");
      resolveAgentEnv(agent, config);
      expect(logSpy).toHaveBeenCalledTimes(2);

      await fs.writeFile(
        envPath,
        "ENV_LOG_OTHER=third-secret\nENV_LOG_TOKEN=second-secret\n"
      );
      expect(resolveAgentEnv(agent, config)).toMatchObject({
        ENV_LOG_OTHER: "third-secret",
        ENV_LOG_TOKEN: "second-secret",
      });
      expect(logSpy.mock.calls).toEqual([
        ['[config] loaded agent env for "assistant": ENV_LOG_TOKEN'],
        ['[config] loaded agent env for "assistant": ENV_LOG_TOKEN'],
        ['[config] loaded agent env for "assistant": ENV_LOG_OTHER, ENV_LOG_TOKEN'],
      ]);

      await fs.appendFile(envPath, "# Changed content with the same keys and values\n");
      resolveAgentEnv(agent, config);
      expect(logSpy).toHaveBeenCalledTimes(4);
      expect(logSpy).toHaveBeenLastCalledWith(
        '[config] loaded agent env for "assistant": ENV_LOG_OTHER, ENV_LOG_TOKEN'
      );
    } finally {
      logSpy.mockRestore();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("stays silent for empty or missing env files and logs their recreation", async () => {
    const { tmpDir, envPath, config } = await setupAgentEnv();
    const agent = config.agents[0];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(resolveAgentEnv(agent, config).ENV_LOG_TOKEN).toBeUndefined();
      expect(logSpy).not.toHaveBeenCalled();

      await fs.writeFile(envPath, "ENV_LOG_TOKEN=restored-secret\n");
      expect(resolveAgentEnv(agent, config).ENV_LOG_TOKEN).toBe("restored-secret");
      expect(logSpy).toHaveBeenCalledTimes(1);

      await fs.writeFile(envPath, "");
      expect(resolveAgentEnv(agent, config).ENV_LOG_TOKEN).toBeUndefined();
      expect(logSpy).toHaveBeenCalledTimes(1);

      await fs.writeFile(envPath, "ENV_LOG_TOKEN=restored-secret\n");
      expect(resolveAgentEnv(agent, config).ENV_LOG_TOKEN).toBe("restored-secret");
      expect(logSpy).toHaveBeenCalledTimes(2);

      await fs.unlink(envPath);
      expect(resolveAgentEnv(agent, config).ENV_LOG_TOKEN).toBeUndefined();
      expect(logSpy).toHaveBeenCalledTimes(2);

      await fs.writeFile(envPath, "ENV_LOG_TOKEN=restored-secret\n");
      expect(resolveAgentEnv(agent, config).ENV_LOG_TOKEN).toBe("restored-secret");
      expect(logSpy.mock.calls).toEqual([
        ['[config] loaded agent env for "assistant": ENV_LOG_TOKEN'],
        ['[config] loaded agent env for "assistant": ENV_LOG_TOKEN'],
        ['[config] loaded agent env for "assistant": ENV_LOG_TOKEN'],
      ]);
    } finally {
      logSpy.mockRestore();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("keeps env log history across reloads and clears it for the test reset", async () => {
    const { tmpDir, envPath, config } = await setupAgentEnv();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await fs.writeFile(envPath, "ENV_LOG_TOKEN=unchanged-secret\n");
      resolveAgentEnv(config.agents[0], config);
      const reloaded = reloadConfig();
      resolveAgentEnv(reloaded.agents[0], reloaded);
      expect(logSpy).toHaveBeenCalledTimes(1);

      clearConfigCacheForTests();
      const reset = loadConfig();
      resolveAgentEnv(reset.agents[0], reset);
      expect(logSpy.mock.calls).toEqual([
        ['[config] loaded agent env for "assistant": ENV_LOG_TOKEN'],
        ['[config] loaded agent env for "assistant": ENV_LOG_TOKEN'],
      ]);
    } finally {
      logSpy.mockRestore();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("tracks env content independently for each agent id and absolute path", async () => {
    const { tmpDir, envPath, config } = await setupAgentEnv();
    const agent = config.agents[0];
    const secondDir = path.join(tmpDir, "other-workspace");
    await fs.mkdir(secondDir);
    await fs.writeFile(envPath, "ENV_LOG_TOKEN=shared-secret\n");
    await fs.writeFile(
      path.join(secondDir, ".env"),
      "ENV_LOG_TOKEN=shared-secret\n"
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      resolveAgentEnv(agent, config);
      resolveAgentEnv({ ...agent, id: "second" }, config);
      resolveAgentEnv({ ...agent, workspaceDir: secondDir }, config);
      resolveAgentEnv(agent, config);
      resolveAgentEnv({ ...agent, id: "second" }, config);
      resolveAgentEnv({ ...agent, workspaceDir: secondDir }, config);
      resolveAgentEnv({ ...agent, workspaceDir: "./agents/assistant" }, config);
      expect(logSpy.mock.calls).toEqual([
        ['[config] loaded agent env for "assistant": ENV_LOG_TOKEN'],
        ['[config] loaded agent env for "second": ENV_LOG_TOKEN'],
        ['[config] loaded agent env for "assistant": ENV_LOG_TOKEN'],
      ]);
    } finally {
      logSpy.mockRestore();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
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
