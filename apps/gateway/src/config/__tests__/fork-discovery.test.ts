import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearConfigCacheForTests, loadConfig, reloadConfig } from "../index.js";

async function writeAgent(dir: string, id = path.basename(dir)) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "agent.yaml"),
    `id: ${id}\nname: ${id}\nmodel:\n  provider: anthropic\n  model: claude\n`
  );
}

describe("agent discovery through an explicit glob", () => {
  const prevHome = process.env.YOPLAI_HOME;

  let tmpDir: string;
  afterEach(async () => {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
    clearConfigCacheForTests();
    if (prevHome === undefined) delete process.env.YOPLAI_HOME;
    else process.env.YOPLAI_HOME = prevHome;
  });

  it("picks up a new plain agent on reload even with a legacy pool key", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-agent-glob-"));
    await writeAgent(path.join(tmpDir, "pool", "retired"));
    await fs.writeFile(
      path.join(tmpDir, "yoplai.json"),
      JSON.stringify({
        version: 3,
        agents: "./agents/*",
        pool: "./pool/*",
      })
    );
    process.env.YOPLAI_HOME = tmpDir;

    expect(loadConfig().agents).toEqual([]);
    await writeAgent(path.join(tmpDir, "agents", "scribe"));

    const reloaded = reloadConfig();
    expect(reloaded.agents.map((agent) => agent.id)).toEqual(["scribe"]);
    expect(reloaded.agents[0].workspaceDir).toBe(path.join(tmpDir, "agents", "scribe"));
  });
});
