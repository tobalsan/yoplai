import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearConfigCacheForTests, loadConfig, reloadConfig } from "../index.js";

/**
 * A fork folder written into the `agents` glob directory must be discovered and
 * made runnable through the unchanged runtime, exactly like a hand-authored
 * agent. This mirrors how the multi-user fork store copies a pool workspace
 * into `$YOPLAI_HOME/agents/<forkId>` and then reloads config. Fork-runtime chat
 * is gated in a later slice; here we prove discovery/glob pickup.
 */
async function writeAgent(dir: string, id = path.basename(dir)) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "agent.yaml"),
    `id: ${id}\nname: ${id}\nmodel:\n  provider: anthropic\n  model: claude\n`
  );
}

describe("fork discovery via agents glob", () => {
  const prevHome = process.env.YOPLAI_HOME;

  afterEach(() => {
    clearConfigCacheForTests();
    if (prevHome === undefined) delete process.env.YOPLAI_HOME;
    else process.env.YOPLAI_HOME = prevHome;
  });

  it("discovers a fork folder copied under agents/* and picks it up on reload", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-fork-glob-"));
    // Pool agent lives under pool/*, fork lands under agents/* — the standard
    // agents glob discovers forks directly while the pool stays inert.
    await writeAgent(path.join(tmpDir, "pool", "scribe"));
    await fs.writeFile(
      path.join(tmpDir, "yoplai.json"),
      JSON.stringify({
        version: 3,
        agents: "./agents/*",
        pool: "./pool/*",
      })
    );
    process.env.YOPLAI_HOME = tmpDir;

    // No fork yet: agents empty, pool has scribe.
    const initial = loadConfig();
    expect(initial.agents.map((a) => a.id)).toEqual([]);
    expect(initial.pool?.map((a) => a.id)).toEqual(["scribe"]);

    // Simulate the fork store: copy the pool workspace with a rewritten id.
    const forkId = "scribe";
    await writeAgent(path.join(tmpDir, "agents", forkId), forkId);

    const reloaded = reloadConfig();
    expect(reloaded.agents.map((a) => a.id)).toEqual([forkId]);
    expect(reloaded.agents[0].workspaceDir).toBe(
      path.join(tmpDir, "agents", forkId)
    );
  });
});
