import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDashboardRegistry } from "../canvas/store.js";

let evalHome: string;

const loadConfig = vi.fn();
const getAgent = vi.fn();
const setLoadedConfig = vi.fn();
const resolveStartupConfig = vi.fn();
const prepareStartupConfig = vi.fn();
const loadExtensions = vi.fn();
const getExtensionRuntime = vi.fn(() => ({ eval: true }));
const runAgent = vi.fn();

vi.mock("../config/index.js", () => ({
  loadConfig,
  getAgent,
  setLoadedConfig,
}));
vi.mock("../config/validate.js", () => ({
  resolveStartupConfig,
  prepareStartupConfig,
}));
vi.mock("../extensions/registry.js", () => ({
  loadExtensions,
  getExtensionRuntime,
}));
vi.mock("../agents/index.js", () => ({ runAgent }));
vi.mock("../extensions/context.js", () => ({
  createExtensionContext: () => ({ ctx: true, getDataDir: () => evalHome }),
  bindExtensionContext: (context: object, extension: { id: string }) => ({ ...context, id: extension.id }),
}));

describe("runEval", () => {
  beforeEach(async () => {
    evalHome = await fs.mkdtemp(path.join(os.tmpdir(), "eval-runtime-"));
    vi.clearAllMocks();
    const config = { agents: [{ id: "alpha" }] };
    loadConfig.mockReturnValue(config);
    resolveStartupConfig.mockResolvedValue(config);
    loadExtensions.mockResolvedValue([]);
    prepareStartupConfig.mockResolvedValue({ resolvedConfig: config });
    getAgent.mockReturnValue({
      id: "alpha",
      workspace: evalHome,
      model: { provider: "anthropic", model: "configured-model" },
    });
    runAgent.mockResolvedValue({
      meta: { durationMs: 12, sessionId: "eval-session" },
    });
  });
  afterEach(async () => { await fs.rm(evalHome, { recursive: true, force: true }); });

  it("loads the exact config override and runs with the requested model", async () => {
    const { runEval } = await import("./runtime.js");

    const outcome = await runEval({
      agentId: "alpha",
      instruction: "Solve this",
      configPath: "/tmp/custom-eval.json",
      modelOverride: "claude-sonnet-4",
    });

    expect(loadConfig).toHaveBeenCalledWith("/tmp/custom-eval.json");
    expect(runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "alpha",
        actorKind: "eval",
        actorUserId: expect.stringMatching(/^eval:/),
        userId: undefined,
        message: "Solve this",
        model: {
          provider: "anthropic",
          model: "claude-sonnet-4",
        },
      })
    );
    expect(outcome.result.model).toBe("anthropic/claude-sonnet-4");
    expect(outcome.trajectory.agent.model).toBe("anthropic/claude-sonnet-4");
  });

  it("uses the configured model when no override is supplied", async () => {
    const { runEval } = await import("./runtime.js");

    const outcome = await runEval({
      agentId: "alpha",
      instruction: "Solve this",
    });

    expect(loadConfig).toHaveBeenCalledWith(undefined);
    expect(runAgent).toHaveBeenCalledWith(
      expect.objectContaining({ model: undefined })
    );
    expect(outcome.result.model).toBe("anthropic/configured-model");
  });

  it("starts Canvas so dashboard tools work, but no other extension", async () => {
    const canvas = { id: "canvas", start: vi.fn() };
    const slack = { id: "slack", start: vi.fn() };
    loadExtensions.mockResolvedValue([canvas, slack]);
    const { runEval } = await import("./runtime.js");

    await runEval({ agentId: "alpha", instruction: "Solve this" });

    expect(canvas.start).toHaveBeenCalledWith(expect.objectContaining({ ctx: true, id: "canvas" }));
    expect(slack.start).not.toHaveBeenCalled();
  });

  it("seeds only the isolated agent's fixture dashboards under the run's synthetic owner", async () => {
    const workspace = path.join(evalHome, "agent");
    await fs.mkdir(path.join(workspace, "data", "dashboards"), { recursive: true });
    await fs.writeFile(path.join(workspace, "data", "dashboards", "fixture.html"), "EVAL-FIXTURE");
    const fixtureAgent = { id: "alpha", workspace, model: { provider: "test", model: "test" } };
    getAgent.mockReturnValue(fixtureAgent);
    const fixtureConfig = { agents: [fixtureAgent] };
    loadConfig.mockReturnValue(fixtureConfig);
    resolveStartupConfig.mockResolvedValue(fixtureConfig);
    prepareStartupConfig.mockResolvedValue({ resolvedConfig: fixtureConfig });
    loadExtensions.mockResolvedValue([{ id: "canvas", start: vi.fn() }]);
    const { runEval } = await import("./runtime.js");
    await runEval({ agentId: "alpha", instruction: "Read fixture", configPath: path.join(evalHome, "config.json") });
    const registry = getDashboardRegistry(path.join(evalHome, "canvas", "registry.json"));
    const fixture = await registry.find("alpha", "fixture.html");
    expect(fixture).toMatchObject({ ownerUserId: `eval:${path.join(evalHome, "config.json")}`, shares: [] });
    expect(await registry.readPublished(fixture!.id)).toBe("EVAL-FIXTURE");
  });
});
