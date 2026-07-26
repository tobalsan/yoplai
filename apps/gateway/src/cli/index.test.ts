import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execSync = vi.fn();

vi.mock("node:child_process", () => ({
  execSync,
  spawn: vi.fn(),
}));

vi.mock("../config/index.js", () => ({
  loadConfig: vi.fn(),
  getAgents: vi.fn(() => []),
  getAgent: vi.fn(),
  CONFIG_DIR: "/tmp/yoplai-test-config",
  setLoadedConfig: vi.fn(),
}));

vi.mock("../agents/index.js", () => ({
  runAgent: vi.fn(),
}));

vi.mock("./subagent.js", () => ({ registerSubagentCommands: vi.fn() }));
vi.mock("./webhooks.js", () => ({ registerWebhookCommands: vi.fn() }));
vi.mock("./user-token.js", () => ({ registerUserTokenCommands: vi.fn() }));
vi.mock("./notify.js", () => ({ registerNotifyCommand: vi.fn() }));
vi.mock("./agents-migrate.js", () => ({
  registerAgentsMigrateCommands: vi.fn(),
}));
vi.mock("./service.js", () => ({ registerGatewayServiceCommands: vi.fn() }));
vi.mock("./gateway.js", () => ({ startGatewayCommand: vi.fn() }));
vi.mock("../evals/cli.js", () => ({ registerEvalCommands: vi.fn() }));
vi.mock("../extensions/registry.js", () => ({
  getExtensionRuntime: vi.fn(),
  loadExtensions: vi.fn(),
}));
vi.mock("../logging.js", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
}));
vi.mock("../config/validate.js", () => ({
  prepareStartupConfig: vi.fn(),
  resolveStartupConfig: vi.fn(),
}));
vi.mock("@yoplai/shared", () => ({
  readEnv: vi.fn(() => undefined),
  resolveBindHost: vi.fn(() => "127.0.0.1"),
}));
vi.mock("@yoplai/extension-scheduler", () => ({
  registerSchedulerCommands: vi.fn(),
}));
vi.mock("@yoplai/extension-orchestrator", () => ({
  registerOrchestratorCommands: vi.fn(),
}));
vi.mock("@yoplai/extension-projects", () => ({
  registerProjectsCommands: vi.fn(),
  registerSlicesCommands: vi.fn(),
}));

// index.ts calls program.parse() at module load and registers a top-level
// uncaughtException/unhandledRejection handler, so keep argv empty (no
// subcommand matches -> no action runs) and neutralize process.exit in case
// any registration path calls it, since this test runs in-process.
describe("refreshTailscaleServe", () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    vi.resetModules();
    execSync.mockReset();
    execSync.mockReturnValue("");
    process.argv = ["node", "yoplai"];
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    // With an empty argv, commander's program.parse() treats the missing
    // subcommand as an error: it prints help to stderr and calls
    // process.exit(1) (mocked above to a no-op). Silence that noise too.
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.restoreAllMocks();
  });

  it("clears the legacy /aihub serve path exactly once before enabling the new paths", async () => {
    const mod = await import("./index.js");
    execSync.mockClear();

    mod.refreshTailscaleServe(3000, 4000);

    const firstRoundCalls = execSync.mock.calls.map((call) => String(call[0]));
    expect(
      firstRoundCalls.some((cmd) => cmd.includes("--set-path=/aihub off"))
    ).toBe(true);
    expect(
      firstRoundCalls.some((cmd) => cmd.includes("--set-path=/yoplai "))
    ).toBe(true);
    expect(
      firstRoundCalls.some((cmd) => cmd.includes("--set-path=/api "))
    ).toBe(true);
    expect(
      firstRoundCalls.some((cmd) => cmd.includes("--set-path=/ws "))
    ).toBe(true);

    execSync.mockClear();
    mod.refreshTailscaleServe(3000, 4000);

    const secondRoundCalls = execSync.mock.calls.map((call) => String(call[0]));
    expect(
      secondRoundCalls.some((cmd) => cmd.includes("--set-path=/aihub off"))
    ).toBe(false);
  });

  it("does not throw when clearing the legacy path fails", async () => {
    const mod = await import("./index.js");
    execSync.mockClear();
    execSync.mockImplementation((cmd: string) => {
      if (String(cmd).includes("--set-path=/aihub off")) {
        throw new Error("tailscale exited with code 1");
      }
      return "";
    });

    expect(() => mod.refreshTailscaleServe(3000, 4000)).not.toThrow();

    const calls = execSync.mock.calls.map((call) => String(call[0]));
    expect(calls.some((cmd) => cmd.includes("--set-path=/yoplai "))).toBe(
      true
    );
  });
});
