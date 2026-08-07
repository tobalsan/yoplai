import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const getAgent = vi.fn();
const resolveWorkspaceDir = vi.fn((workspace: string) => workspace);
const loadConfig = vi.fn(() => ({ dream: { timeoutMs: 1_000 } }));
const runAgent = vi.fn();
let configDir = "";

vi.mock("../config/index.js", () => ({
  get CONFIG_DIR() { return configDir; },
  getAgent,
  resolveWorkspaceDir,
  loadConfig,
}));

vi.mock("../agents/runner.js", () => ({ runAgent }));
vi.mock("../extensions/runtime.js", () => ({
  ExtensionRuntime: class { load() {} },
}));
vi.mock("../extensions/registry.js", () => ({
  getExtensionRuntime: () => ({ getLoadedExtensions: () => [] }),
}));
vi.mock("../history/store.js", () => ({ getFullHistory: vi.fn().mockResolvedValue([]) }));

describe("runDream", () => {
  let root: string;

  afterEach(async () => {
    vi.clearAllMocks();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it("records files deleted by a dream in the journal", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-dream-"));
    configDir = path.join(root, "config");
    const workspace = path.join(root, "workspace");
    const history = path.join(configDir, "history", "session.jsonl");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(path.join(workspace, "obsolete.md"), "remove me");
    await fs.mkdir(path.dirname(history), { recursive: true });
    await fs.writeFile(history, `${JSON.stringify({ agentId: "alpha", sessionId: "session-1", timestamp: Date.now() })}\n`);
    getAgent.mockReturnValue({ id: "alpha", workspace, dream: true });
    runAgent.mockImplementation(async () => {
      await fs.rm(path.join(workspace, "obsolete.md"));
      return { meta: { aborted: false }, payloads: [] };
    });

    const { runDream } = await import("./service.js");
    const result = await runDream("alpha");

    expect(result.status).toBe("ok");
    await expect(fs.readFile(path.join(workspace, "dreams", `${new Date().toISOString().slice(0, 10)}.md`), "utf8"))
      .resolves.toContain("- obsolete.md");
  });

  it("does not re-consolidate prior dream sessions", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-dream-"));
    configDir = path.join(root, "config");
    const workspace = path.join(root, "workspace");
    await fs.mkdir(path.join(configDir, "history"), { recursive: true });
    await fs.writeFile(path.join(configDir, "history", "session.jsonl"), `${JSON.stringify({ agentId: "alpha", sessionId: "dream:2026-07-30T00:00:00.000Z", timestamp: Date.now() })}\n`);
    getAgent.mockReturnValue({ id: "alpha", workspace, dream: true });

    const { runDream } = await import("./service.js");

    await expect(runDream("alpha")).resolves.toMatchObject({ status: "skipped", sessions: [] });
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("redacts fallback journal output", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-dream-"));
    configDir = path.join(root, "config");
    const workspace = path.join(root, "workspace");
    const history = path.join(configDir, "history", "session.jsonl");
    const canary = "dream-private-canary";
    await fs.mkdir(path.dirname(history), { recursive: true });
    await fs.writeFile(
      history,
      `${JSON.stringify({ agentId: "alpha", sessionId: "session-1", timestamp: Date.now() })}\n`
    );
    await fs.mkdir(workspace, { recursive: true });
    getAgent.mockReturnValue({ id: "alpha", workspace, dream: true });
    runAgent.mockResolvedValue({
      meta: { aborted: false },
      payloads: [{ text: `Authorization: Bearer ${canary}` }],
    });

    const { runDream } = await import("./service.js");
    await runDream("alpha");

    const journal = await fs.readFile(
      path.join(workspace, "dreams", `${new Date().toISOString().slice(0, 10)}.md`),
      "utf8"
    );
    expect(journal).not.toContain(canary);
  });
});
