import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

// CONFIG_DIR is bound when ../index.js is first imported, so YOPLAI_HOME and the
// legacy-style config must be in place before the dynamic import below.
const prevHome = process.env.YOPLAI_HOME;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yoplai-legacy-home-"));
const agentDir = path.join(tmpDir, "agents", "alpha");
fs.mkdirSync(agentDir, { recursive: true });
fs.writeFileSync(
  path.join(agentDir, "agent.yaml"),
  "id: alpha\nname: alpha\nmodel:\n  provider: anthropic\n  model: claude\n"
);
fs.writeFileSync(
  path.join(tmpDir, "yoplai.json"),
  JSON.stringify({ version: 3, agents: "$AIHUB_HOME/agents/*" })
);
process.env.YOPLAI_HOME = tmpDir;

const { clearConfigCacheForTests, loadConfig } = await import("../index.js");

describe("legacy $AIHUB_HOME placeholder in config values", () => {
  afterAll(() => {
    clearConfigCacheForTests();
    if (prevHome === undefined) delete process.env.YOPLAI_HOME;
    else process.env.YOPLAI_HOME = prevHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("discovers agents from a pre-rename agents glob, warning once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const agents = loadConfig().agents;

    expect(agents.map((agent) => agent.id)).toEqual(["alpha"]);
    expect(agents[0].workspaceDir).toBe(agentDir);
    expect(warn).toHaveBeenCalledWith(
      "[config] $AIHUB_HOME in config values is deprecated; rewrite it as $YOPLAI_HOME."
    );
    warn.mockRestore();
  });
});
