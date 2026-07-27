import { beforeEach, describe, expect, it, vi } from "vitest";

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

describe("runEval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const config = { agents: [{ id: "alpha" }] };
    loadConfig.mockReturnValue(config);
    resolveStartupConfig.mockResolvedValue(config);
    loadExtensions.mockResolvedValue([]);
    prepareStartupConfig.mockResolvedValue({ resolvedConfig: config });
    getAgent.mockReturnValue({
      id: "alpha",
      model: { provider: "anthropic", model: "configured-model" },
    });
    runAgent.mockResolvedValue({
      meta: { durationMs: 12, sessionId: "eval-session" },
    });
  });

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
});
