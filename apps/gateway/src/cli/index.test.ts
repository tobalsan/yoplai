import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { readEnv } from "@yoplai/shared";

const execSync = vi.fn();
const execFileSync = vi.fn();
const spawn = vi.fn();

vi.mock("node:child_process", () => ({
  execSync,
  execFileSync,
  spawn,
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
describe("gateway web UI process management", () => {
  const originalArgv = process.argv;
  const originalPlatform = process.platform;
  const initialListeners = new Map<
    string,
    ReturnType<typeof process.listeners>
  >();

  function mockPreviewListener() {
    const state = {
      listeners: "901\n",
      command: "node /tools/vite/bin/vite.js preview",
      cwd: fileURLToPath(new URL("../../../../apps/web", import.meta.url)),
      pgid: "900\n",
    };
    execFileSync.mockImplementation((command: string, args: string[]) => {
      if (command === "lsof" && args.includes("-t")) return state.listeners;
      if (command === "lsof") return `p901\nn${state.cwd}\n`;
      if (args.includes("command=")) return state.command;
      return args.includes("901") ? state.pgid : "800\n";
    });
    return state;
  }

  beforeEach(() => {
    for (const event of ["uncaughtException", "unhandledRejection"]) {
      initialListeners.set(event, process.listeners(event));
    }
    vi.resetModules();
    vi.clearAllMocks();
    vi.mocked(readEnv).mockReturnValue(undefined);
    execSync.mockReset();
    execFileSync.mockReset();
    execFileSync.mockReturnValue("");
    spawn.mockReset();
    process.argv = ["node", "yoplai"];
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    for (const event of ["uncaughtException", "unhandledRejection"]) {
      for (const listener of process.listeners(event)) {
        if (!initialListeners.get(event)?.includes(listener))
          process.removeListener(event, listener);
      }
    }
    Object.defineProperty(process, "platform", { value: originalPlatform });
    vi.useRealTimers();
    process.argv = originalArgv;
    vi.restoreAllMocks();
  });

  it("binds the UI to loopback when Tailscale serve fronts a LAN-bound UI", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 123,
      kill: vi.fn(),
    });
    spawn.mockReturnValue(child);
    vi.useFakeTimers();
    const mod = await import("./index.js");

    expect(mod.resolveUiHost("lan", true)).toBe("127.0.0.1");
    await mod.startWebUI(
      { bind: "lan", port: 3000, tailscale: { mode: "serve" } },
      4000
    );

    const args = spawn.mock.calls[0][1] as string[];
    expect(args[args.indexOf("--host") + 1]).toBe("127.0.0.1");
    expect(args).toContain("--strictPort");
    expect(spawn.mock.calls[0][2]).toMatchObject({
      ...(process.platform !== "win32" ? { detached: true } : {}),
    });
    vi.useRealTimers();
  });

  it("replaces a stale same-repo preview after its process group frees the port", async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      pid: 123,
      kill: vi.fn(),
    });
    spawn.mockReturnValue(child);
    const root = fileURLToPath(new URL("../../../..", import.meta.url));
    let listening = true;
    execFileSync.mockImplementation((command: string, args: string[]) => {
      if (command === "lsof" && args.includes("-t"))
        return listening ? "901\n" : "";
      if (command === "lsof") return `p901\nn${root}/apps/web\n`;
      if (args.includes("command="))
        return "node /tools/vite/bin/vite.js preview";
      return args.includes("901") ? "900\n" : "800\n";
    });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const mod = await import("./index.js");

    const started = mod.startWebUI({ port: 3003 }, 4000);
    expect(kill).toHaveBeenCalledWith(-900, "SIGTERM");
    expect(spawn).not.toHaveBeenCalled();
    listening = false;
    await vi.advanceTimersByTimeAsync(100);

    expect(await started).toBe(child);
    expect(spawn).toHaveBeenCalledOnce();
  });

  it("leaves a foreign listener alone and logs its pid once", async () => {
    execFileSync.mockImplementation((command: string, args: string[]) => {
      if (command === "lsof" && args.includes("-t")) return "901\n";
      if (command === "lsof") return "p901\nn/tmp\n";
      if (args.includes("command=")) return "node unrelated-server.js";
      return args.includes("901") ? "900\n" : "800\n";
    });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const mod = await import("./index.js");
    const { logError } = await import("../logging.js");

    expect(await mod.startWebUI({ port: 3003 }, 4000)).toBeNull();

    expect(kill).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledOnce();
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining("901"),
      expect.any(Error),
      { port: 3003, pid: 901 }
    );
  });

  it("escalates a stubborn preview once before starting its replacement", async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      pid: 123,
      kill: vi.fn(),
    });
    spawn.mockReturnValue(child);
    const root = fileURLToPath(new URL("../../../..", import.meta.url));
    let listening = true;
    execFileSync.mockImplementation((command: string, args: string[]) => {
      if (command === "lsof" && args.includes("-t"))
        return listening ? "901\n" : "";
      if (command === "lsof") return `p901\nn${root}/apps/web\n`;
      if (args.includes("command="))
        return "node /tools/vite/bin/vite.js preview";
      return args.includes("901") ? "900\n" : "800\n";
    });
    const kill = vi
      .spyOn(process, "kill")
      .mockImplementation((_pid, signal) => {
        if (signal === "SIGKILL") listening = false;
        return true;
      });
    const mod = await import("./index.js");

    const started = mod.startWebUI({ port: 3003 }, 4000);
    await vi.advanceTimersByTimeAsync(5000);

    expect(kill.mock.calls).toEqual([
      [-900, "SIGTERM"],
      [-900, "SIGKILL"],
    ]);
    expect(await started).toBe(child);
  });

  it("reports one structured error when the preview exits unsuccessfully during startup", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 123,
      kill: vi.fn(),
    });
    spawn.mockReturnValue(child);
    const mod = await import("./index.js");
    const { logError } = await import("../logging.js");

    await mod.startWebUI({ port: 3003 }, 4000);
    child.emit("exit", 2, null);
    child.emit("exit", 2, null);

    expect(logError).toHaveBeenCalledOnce();
    expect(logError).toHaveBeenCalledWith(
      "[gateway] web UI exited early",
      expect.any(Error),
      { port: 3003, exitCode: 2 }
    );
  });

  it("does not report the gateway stopping its own preview during startup", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 123,
      kill: vi.fn(),
    });
    spawn.mockReturnValue(child);
    vi.spyOn(process, "kill").mockImplementation(() => true);
    const mod = await import("./index.js");
    const { logError } = await import("../logging.js");

    await mod.startWebUI({ port: 3003 }, 4000);
    mod.stopWebUIProcess(child as never);
    child.emit("exit", null, "SIGTERM");

    expect(logError).not.toHaveBeenCalled();
  });

  it("skips the UI when signalling a verified stale preview fails", async () => {
    spawn.mockReturnValue(
      Object.assign(new EventEmitter(), { pid: 123, kill: vi.fn() })
    );
    const root = fileURLToPath(new URL("../../../..", import.meta.url));
    execFileSync.mockImplementation((command: string, args: string[]) => {
      if (command === "lsof" && args.includes("-t")) return "901\n";
      if (command === "lsof") return `p901\nn${root}/apps/web\n`;
      if (args.includes("command="))
        return "node /tools/vite/bin/vite.js preview";
      return args.includes("901") ? "900\n" : "800\n";
    });
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("EPERM");
    });
    const mod = await import("./index.js");
    const { logError } = await import("../logging.js");

    expect(await mod.startWebUI({ port: 3003 }, 4000)).toBeNull();

    expect(spawn).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledOnce();
  });

  it("does not reclaim an external preview reached through an in-repo symlink", async () => {
    vi.useFakeTimers();
    spawn.mockReturnValue(
      Object.assign(new EventEmitter(), { pid: 123, kill: vi.fn() })
    );
    const root = fileURLToPath(new URL("../../../..", import.meta.url));
    const linkedVite = `${root}/foreign-vite`;
    execFileSync.mockImplementation((command: string, args: string[]) => {
      if (command === "lsof" && args.includes("-t")) return "901\n";
      if (command === "lsof") return "p901\nn/tmp\n";
      if (args.includes("command=")) return `node ${linkedVite} preview`;
      return args.includes("901") ? "900\n" : "800\n";
    });
    const realpath = fs.realpathSync;
    vi.spyOn(fs, "realpathSync").mockImplementation((candidate, options) =>
      String(candidate) === linkedVite
        ? "/tmp/foreign/vite.js"
        : realpath(candidate, options)
    );
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const mod = await import("./index.js");

    const started = mod.startWebUI({ port: 3003 }, 4000);
    await vi.advanceTimersByTimeAsync(10000);
    expect(await started).toBeNull();
    expect(kill).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("never signals the gateway's own process group", async () => {
    mockPreviewListener().pgid = "800\n";
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const mod = await import("./index.js");
    const { logError } = await import("../logging.js");

    expect(await mod.startWebUI({ port: 3003 }, 4000)).toBeNull();

    expect(kill).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledOnce();
  });

  it("does not treat another repo with the same path prefix as this repo", async () => {
    const state = mockPreviewListener();
    state.cwd = `${fs.realpathSync(fileURLToPath(new URL("../../../..", import.meta.url)))}-other/apps/web`;
    const realpath = fs.realpathSync;
    vi.spyOn(fs, "realpathSync").mockImplementation((candidate, options) =>
      String(candidate) === state.cwd ? state.cwd : realpath(candidate, options)
    );
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const mod = await import("./index.js");

    expect(await mod.startWebUI({ port: 3003 }, 4000)).toBeNull();
    expect(kill).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("skips the UI after both bounded shutdown waits expire", async () => {
    vi.useFakeTimers();
    mockPreviewListener();
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const mod = await import("./index.js");
    const { logError } = await import("../logging.js");

    const started = mod.startWebUI({ port: 3003 }, 4000);
    await vi.advanceTimersByTimeAsync(10000);

    expect(await started).toBeNull();
    expect(kill.mock.calls).toEqual([
      [-900, "SIGTERM"],
      [-900, "SIGKILL"],
    ]);
    expect(spawn).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledOnce();
  });

  it("leaves a new foreign listener alone when the owner changes during shutdown", async () => {
    vi.useFakeTimers();
    const state = mockPreviewListener();
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      state.listeners = "902\n";
      return true;
    });
    const mod = await import("./index.js");
    const { logError } = await import("../logging.js");

    const started = mod.startWebUI({ port: 3003 }, 4000);
    await vi.advanceTimersByTimeAsync(5000);

    expect(await started).toBeNull();
    expect(kill.mock.calls).toEqual([[-900, "SIGTERM"]]);
    expect(spawn).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledOnce();
    expect(logError).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Error),
      { port: 3003, pid: 902 }
    );
  });

  it("fails open with one structured error when the port lookup tool is unavailable", async () => {
    execFileSync.mockImplementation(() => {
      throw new Error("spawnSync lsof ENOENT");
    });
    const child = Object.assign(new EventEmitter(), {
      pid: 123,
      kill: vi.fn(),
    });
    spawn.mockReturnValue(child);
    const mod = await import("./index.js");
    const { logError } = await import("../logging.js");

    expect(await mod.startWebUI({ port: 3003 }, 4000)).toBe(child);
    expect(spawn).toHaveBeenCalledOnce();
    expect(logError).toHaveBeenCalledOnce();
    expect(logError).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Error),
      { port: 3003 }
    );
  });

  it("starts quietly when lsof reports no listening sockets with exit status 1", async () => {
    execFileSync.mockImplementation(() => {
      throw Object.assign(new Error("No sockets"), {
        status: 1,
        stdout: "",
        stderr: "",
      });
    });
    const child = Object.assign(new EventEmitter(), {
      pid: 123,
      kill: vi.fn(),
    });
    spawn.mockReturnValue(child);
    const mod = await import("./index.js");
    const { logError } = await import("../logging.js");

    expect(await mod.startWebUI({}, 4000)).toBe(child);
    expect(logError).not.toHaveBeenCalled();
  });

  it("skips every port lookup and spawn when SKIP_WEB is set", async () => {
    vi.mocked(readEnv).mockImplementation((name) =>
      name === "SKIP_WEB" ? "1" : undefined
    );
    const mod = await import("./index.js");

    expect(await mod.startWebUI({ port: 3003 }, 4000)).toBeNull();
    expect(execFileSync).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("preserves the dev server without a port check or early-exit watcher", async () => {
    vi.mocked(readEnv).mockImplementation((name) =>
      name === "WEB_DEV" ? "1" : undefined
    );
    const child = Object.assign(new EventEmitter(), {
      pid: 123,
      kill: vi.fn(),
    });
    spawn.mockReturnValue(child);
    const mod = await import("./index.js");
    const { logError } = await import("../logging.js");

    expect(await mod.startWebUI({ port: 3003 }, 4000)).toBe(child);
    child.emit("exit", 2, null);

    expect(execFileSync).not.toHaveBeenCalled();
    expect(spawn.mock.calls[0][1]).toContain("dev");
    expect(spawn.mock.calls[0][1]).not.toContain("--strictPort");
    expect(logError).not.toHaveBeenCalled();
  });

  it("preserves startup on Windows without inspecting the UI port", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const child = Object.assign(new EventEmitter(), {
      pid: 123,
      kill: vi.fn(),
    });
    spawn.mockReturnValue(child);
    const mod = await import("./index.js");

    expect(await mod.startWebUI({ port: 3003 }, 4000)).toBe(child);
    expect(execFileSync).not.toHaveBeenCalled();
    expect(spawn.mock.calls[0][2]).not.toHaveProperty("detached");
  });

  it.each([
    { code: 0, signal: null, delay: 1000, errors: 0 },
    { code: 2, signal: null, delay: 5000, errors: 0 },
    { code: null, signal: "SIGKILL", delay: 1000, errors: 1 },
  ])(
    "logs $errors errors for exit $code/$signal after $delay ms",
    async ({ code, signal, delay, errors }) => {
      vi.useFakeTimers();
      const child = Object.assign(new EventEmitter(), {
        pid: 123,
        kill: vi.fn(),
      });
      spawn.mockReturnValue(child);
      const mod = await import("./index.js");
      const { logError } = await import("../logging.js");

      await mod.startWebUI({ port: 3003 }, 4000);
      await vi.advanceTimersByTimeAsync(delay);
      child.emit("exit", code, signal);

      expect(logError).toHaveBeenCalledTimes(errors);
      if (errors)
        expect(logError).toHaveBeenCalledWith(
          "[gateway] web UI exited early",
          expect.any(Error),
          { port: 3003, exitCode: null }
        );
    }
  );

  it("terminates the Unix process group and falls back to the child on Windows", async () => {
    const mod = await import("./index.js");
    const child = { pid: 456, kill: vi.fn() };
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);

    mod.stopWebUIProcess(child as never);

    if (process.platform === "win32") {
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    } else {
      expect(kill).toHaveBeenCalledWith(-456, "SIGTERM");
      expect(child.kill).not.toHaveBeenCalled();
    }
  });
});

describe("refreshTailscaleServe", () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    vi.resetModules();
    execSync.mockReset();
    spawn.mockReset();
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
    const legacyCleanupCall = execSync.mock.calls.find((call) =>
      String(call[0]).includes("--set-path=/aihub off")
    );
    expect(legacyCleanupCall?.[1]).toMatchObject({
      stdio: ["ignore", "ignore", "pipe"],
    });

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
