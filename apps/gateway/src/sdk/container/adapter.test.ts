import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import {
  AgentConfigSchema,
  type AgentConfig,
  type GatewayConfig,
} from "@yoplai/shared";
import {
  clearConfigCacheForTests,
  setLoadedConfig,
} from "../../config/index.js";
import { getContainerAdapter } from "./adapter.js";
import { validateContainerToken } from "./tokens.js";
import type { SdkRunParams } from "../types.js";

const mockGetExtensionAgentTools = vi.hoisted(() =>
  vi.fn<(agent: unknown) => unknown[]>(() => [])
);

vi.mock("../../extensions/tools.js", () => ({
  getExtensionAgentTools: mockGetExtensionAgentTools,
}));

vi.mock("@yoplai/shared/node/system-files", () => ({
  resolveSystemFiles: vi.fn(async () => [{ path: "SOUL.md", content: "soul" }]),
}));

vi.mock("../../agents/workspace.js", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  return {
    FIRST_RUN_BOOTSTRAP_PROMPT: "first run bootstrap",
    ensureWorkspaceFiles: vi.fn(async (workspaceDir: string) => {
      fs.mkdirSync(workspaceDir, { recursive: true });
      fs.writeFileSync(path.join(workspaceDir, "SOUL.md"), "soul");
      return false;
    }),
  };
});

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
  execFile: vi.fn(),
  execFileSync: vi.fn(),
}));

const OUTPUT_START = "---YOPLAI_OUTPUT_START---";
const OUTPUT_END = "---YOPLAI_OUTPUT_END---";
const EVENT_PREFIX = "---YOPLAI_EVENT---";

class FakeDockerProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  stdinChunks: string[] = [];
  stdin = new Writable({
    write: (chunk, _encoding, callback) => {
      this.stdinChunks.push(chunk.toString());
      callback();
    },
  });

  emitOutput(output: unknown): void {
    this.stdout.write(
      `${OUTPUT_START}\n${JSON.stringify(output)}\n${OUTPUT_END}\n`
    );
  }

  emitStreamEvent(event: unknown, split = false): void {
    const line = `${EVENT_PREFIX}${JSON.stringify(event)}\n`;
    if (!split) {
      this.stdout.write(line);
      return;
    }
    const middle = Math.floor(line.length / 2);
    this.stdout.write(line.slice(0, middle));
    this.stdout.write(line.slice(middle));
  }

  finish(code: number): void {
    this.exitCode = code;
    this.stdout.end();
    this.stderr.end();
    this.emit("exit", code, null);
    this.emit("close", code, null);
  }
}

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "yoplai-container-adapter-")
  );
  tempDirs.push(dir);
  return dir;
}

/** Flush microtask queue so the async run() reaches spawn. */
const tick = async () => {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
};

function createAgent(
  root: string,
  sandbox: Partial<NonNullable<AgentConfig["sandbox"]>> = {}
): AgentConfig {
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "SOUL.md"), "soul");
  return AgentConfigSchema.parse({
    id: "cloud",
    name: "Cloud",
    workspace,
    model: {
      provider: "anthropic",
      model: "claude-sonnet",
      auth_token: "secret-token",
    },
    sandbox: {
      enabled: true,
      image: "yoplai-agent:latest",
      memory: "2g",
      cpus: 1,
      workspaceWritable: false,
      ...sandbox,
    },
  });
}

function setConfig(
  agent: AgentConfig,
  root: string,
  options: { onecliSandboxNetwork?: string } = {}
): void {
  fs.writeFileSync(path.join(root, "onecli-ca.pem"), "cert");
  setLoadedConfig({
    agents: [agent],
    extensions: {},
    sandbox: {
      sharedDir: path.join(root, "shared"),
    },
    onecli: {
      enabled: true,
      mode: "proxy",
      gatewayUrl: "http://onecli:4141",
      ca: { source: "file", path: path.join(root, "onecli-ca.pem") },
      sandbox: options.onecliSandboxNetwork
        ? {
            network: options.onecliSandboxNetwork,
            url: "http://onecli:4141",
          }
        : undefined,
    },
    server: { baseUrl: "http://gateway:4000" },
  } as GatewayConfig);
}

function createParams(agent: AgentConfig): SdkRunParams {
  const abortController = new AbortController();
  return {
    agentId: agent.id,
    agent,
    userId: "user-1",
    sessionId: "session-1",
    message: "hello",
    workspaceDir: agent.workspace,
    thinkLevel: "medium",
    onEvent: vi.fn(),
    onHistoryEvent: vi.fn(),
    onSessionHandle: vi.fn(),
    abortSignal: abortController.signal,
  };
}

function mockSpawn(): {
  processes: FakeDockerProcess[];
  spy: MockInstance;
} {
  const processes: FakeDockerProcess[] = [];
  const spy = vi
    .mocked(childProcess.spawn)
    .mockImplementation((_command, _args, _options) => {
      const process = new FakeDockerProcess();
      processes.push(process);
      return process as never;
    });
  return { processes, spy };
}

function mockExecFile(complete = true): MockInstance {
  return vi
    .mocked(childProcess.execFile)
    .mockImplementation((_file, _args, _options, callback) => {
      if (complete && typeof callback === "function") {
        callback(null, "", "");
      }
      return new EventEmitter() as never;
    });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetExtensionAgentTools.mockReturnValue([]);
  delete process.env.YOPLAI_HOME;
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  clearConfigCacheForTests();
  delete process.env.YOPLAI_HOME;
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("container adapter", () => {
  it("spawns docker and writes ContainerInput to stdin", async () => {
    const root = tempDir();
    const homeDir = path.join(root, "yoplai");
    process.env.YOPLAI_HOME = homeDir;
    const agent = createAgent(root);
    setConfig(agent, root);
    mockGetExtensionAgentTools.mockResolvedValue([
      {
        extensionId: "board",
        name: "scratchpad.read",
        description: "Read scratchpad",
        parameters: { type: "object", properties: {} },
      },
    ]);

    const { processes, spy } = mockSpawn();
    mockExecFile();
    const params = createParams(agent);

    const run = getContainerAdapter().run(params);
    await tick();
    const dockerProcess = processes[0];
    const input = JSON.parse(dockerProcess.stdinChunks.join(""));
    expect(validateContainerToken(input.agentToken, "cloud")).toBe(true);

    dockerProcess.emitOutput({ text: "hello back" });
    dockerProcess.finish(0);

    await expect(run).resolves.toEqual({
      text: "hello back",
      aborted: undefined,
    });
    expect(validateContainerToken(input.agentToken, "cloud")).toBe(false);

    expect(spy).toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining(["run", "-i", "--rm"]),
      { stdio: ["pipe", "pipe", "pipe"] }
    );
    expect(input).toMatchObject({
      agentId: "cloud",
      sessionId: "session-1",
      userId: "user-1",
      message: "hello",
      workspaceDir: "/workspace",
      sessionDir: "/sessions",
      ipcDir: "/workspace/ipc",
      gatewayUrl: "http://host.docker.internal:4000",
      onecli: {
        enabled: true,
        url: "http://onecli:4141",
        caPath: "/usr/local/share/ca-certificates/onecli-ca.pem",
      },
      extensionTools: [
        {
          extensionId: "board",
          name: "scratchpad.read",
          description: "Read scratchpad",
          parameters: { type: "object", properties: {} },
        },
      ],
      sdkConfig: {
        sdk: "pi",
        model: { provider: "anthropic", model: "claude-sonnet" },
      },
    });
    expect(input.sdkConfig.model.auth_token).toBeUndefined();
    expect(input.agentToken).toEqual(expect.any(String));
    expect(params.onSessionHandle).toHaveBeenCalledWith(
      expect.objectContaining({
        containerName: expect.stringMatching(/^yoplai-agent-cloud-/),
        ipcDir: path.join(homeDir, "ipc", "cloud"),
      })
    );
    expect(params.onEvent).toHaveBeenCalledWith({
      type: "text",
      data: "hello back",
    });
    expect(params.onEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "done" })
    );
  });

  it("surfaces docker run stderr when extra network attach races a failed container start", async () => {
    const root = tempDir();
    process.env.YOPLAI_HOME = path.join(root, "yoplai");
    const agent = createAgent(root);
    setConfig(agent, root, { onecliSandboxNetwork: "config_onecli" });

    const { processes } = mockSpawn();
    vi.mocked(childProcess.execFile).mockImplementation(
      (_file, _args, _options, callback) => {
        setTimeout(() => {
          if (typeof callback === "function") {
            callback(new Error("No such container"), "", "No such container");
          }
        }, 10);
        return new EventEmitter() as never;
      }
    );

    const run = getContainerAdapter().run(createParams(agent));
    await tick();

    processes[0].stderr.write(
      'docker: Error response from daemon: invalid mount config for type "bind": bind source path does not exist: /missing/data\n'
    );
    processes[0].finish(125);

    await expect(run).rejects.toThrow(
      'invalid mount config for type "bind": bind source path does not exist: /missing/data'
    );
  });

  it("streams history events in real time from stdout", async () => {
    const root = tempDir();
    process.env.YOPLAI_HOME = path.join(root, "yoplai");
    const agent = createAgent(root);
    setConfig(agent, root);
    const { processes } = mockSpawn();
    mockExecFile();
    const params = createParams(agent);

    const run = getContainerAdapter().run(params);
    await tick();
    const dockerProcess = processes[0];

    dockerProcess.emitStreamEvent(
      { type: "assistant_thinking", text: "plan", timestamp: 1 },
      true
    );
    dockerProcess.emitStreamEvent({
      type: "assistant_text",
      text: "hello",
      timestamp: 2,
    });

    expect(params.onHistoryEvent).toHaveBeenCalledWith({
      type: "assistant_thinking",
      text: "plan",
      timestamp: 1,
    });
    expect(params.onEvent).toHaveBeenCalledWith({
      type: "thinking",
      data: "plan",
    });
    expect(params.onHistoryEvent).toHaveBeenCalledWith({
      type: "assistant_text",
      text: "hello",
      timestamp: 2,
    });
    expect(params.onEvent).toHaveBeenCalledWith({
      type: "text",
      data: "hello",
    });

    dockerProcess.emitOutput({
      text: "hello back",
      history: [
        { type: "assistant_thinking", text: "plan", timestamp: 1 },
        { type: "assistant_text", text: "hello", timestamp: 2 },
      ],
    });
    dockerProcess.finish(0);

    await expect(run).resolves.toEqual({
      text: "hello back",
      aborted: undefined,
    });
    // 1 synthetic user event + 2 streaming events
    expect(params.onHistoryEvent).toHaveBeenCalledTimes(3);
    expect(params.onHistoryEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "user", text: "hello" })
    );
    expect(params.onEvent).not.toHaveBeenCalledWith({
      type: "text",
      data: "hello back",
    });
  });

  it("emits system_context from gateway for container runs", async () => {
    const root = tempDir();
    process.env.YOPLAI_HOME = path.join(root, "yoplai");
    const agent = createAgent(root);
    setConfig(agent, root);
    const { processes } = mockSpawn();
    mockExecFile();
    const params = createParams(agent);
    params.context = {
      kind: "slack",
      blocks: [
        {
          type: "metadata",
          channel: "slack",
          place: "direct message / Floriane",
          conversationType: "direct_message",
          sender: "Floriane",
        },
      ],
    };

    const run = getContainerAdapter().run(params);
    await tick();
    const dockerProcess = processes[0];

    expect(params.onHistoryEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        type: "system_context",
        rendered: expect.stringContaining("[CHANNEL CONTEXT]"),
      })
    );
    expect(params.onHistoryEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ type: "user", text: "hello" })
    );

    dockerProcess.emitOutput({ text: "hello back" });
    dockerProcess.finish(0);

    await expect(run).resolves.toEqual({
      text: "hello back",
      aborted: undefined,
    });
  });

  it("copies file_output events to outbound media", async () => {
    const root = tempDir();
    const homeDir = path.join(root, "yoplai");
    process.env.YOPLAI_HOME = homeDir;
    const agent = createAgent(root);
    setConfig(agent, root);
    const { processes } = mockSpawn();
    mockExecFile();
    const params = createParams(agent);

    const run = getContainerAdapter().run(params);
    await tick();
    const dockerProcess = processes[0];
    const dataPath = path.join(
      homeDir,
      "agents",
      "cloud",
      "data",
      "report.csv"
    );
    fs.writeFileSync(dataPath, "a,b\n1,2\n");

    dockerProcess.emitStreamEvent({
      type: "file_output",
      path: "/workspace/data/report.csv",
      filename: "report.csv",
      mimeType: "text/csv",
      size: 99,
    });
    dockerProcess.emitOutput({ text: "done" });
    dockerProcess.finish(0);

    await expect(run).resolves.toEqual({ text: "done", aborted: undefined });
    expect(params.onEvent).toHaveBeenCalledWith({
      type: "file_output",
      fileId: expect.any(String),
      filename: "report.csv",
      mimeType: "text/csv",
      size: 8,
    });
    expect(params.onHistoryEvent).toHaveBeenCalledWith({
      type: "assistant_file",
      fileId: expect.any(String),
      filename: "report.csv",
      mimeType: "text/csv",
      size: 8,
      direction: "outbound",
      timestamp: expect.any(Number),
    });

    const event = vi
      .mocked(params.onEvent)
      .mock.calls.find(([value]) => value.type === "file_output")?.[0];
    expect(event).toBeDefined();
    if (!event || event.type !== "file_output") return;

    const outboundPath = path.join(
      homeDir,
      "media",
      "outbound",
      `${event.fileId}.csv`
    );
    expect(fs.readFileSync(outboundPath, "utf8")).toBe("a,b\n1,2\n");

    const metadata = JSON.parse(
      fs.readFileSync(path.join(homeDir, "media", "metadata.json"), "utf8")
    );
    expect(metadata[event.fileId]).toMatchObject({
      direction: "outbound",
      filename: "report.csv",
      storedFilename: `${event.fileId}.csv`,
      mimeType: "text/csv",
      size: 8,
      agentId: "cloud",
      sessionId: "session-1",
    });
  });

  it("writes queued messages to the IPC input dir", async () => {
    const root = tempDir();
    const ipcDir = path.join(root, "ipc", "cloud");
    vi.spyOn(Date, "now").mockReturnValue(123);

    const recordQueuedMessageActivity = vi.fn();

    await getContainerAdapter().queueMessage?.(
      { containerName: "container", ipcDir, recordQueuedMessageActivity },
      "follow up"
    );

    expect(
      JSON.parse(
        fs.readFileSync(path.join(ipcDir, "input", "123.json"), "utf8")
      )
    ).toEqual({ message: "follow up", timestamp: 123 });
    expect(recordQueuedMessageActivity).toHaveBeenCalledTimes(1);
  });

  it("writes close sentinel and stops on abort", () => {
    const root = tempDir();
    const ipcDir = path.join(root, "ipc", "cloud");
    const execSpy = mockExecFile();

    getContainerAdapter().abort?.({ containerName: "container", ipcDir });

    expect(fs.existsSync(path.join(ipcDir, "input", "_close"))).toBe(true);
    expect(execSpy).toHaveBeenCalledWith(
      "docker",
      ["stop", "container"],
      { timeout: 10_000 },
      expect.any(Function)
    );
  });

  it("stops then kills on legacy hard runtime timeout", async () => {
    vi.useFakeTimers();
    const root = tempDir();
    process.env.YOPLAI_HOME = path.join(root, "yoplai");
    const agent = createAgent(root, { timeout: 1 });
    setConfig(agent, root);
    const { processes } = mockSpawn();
    const execSpy = mockExecFile(false);

    const run = getContainerAdapter().run(createParams(agent));
    await vi.advanceTimersByTimeAsync(0);
    vi.advanceTimersByTime(1_000);
    expect(execSpy).toHaveBeenCalledWith(
      "docker",
      ["stop", expect.stringMatching(/^yoplai-agent-cloud-/)],
      { timeout: 10_000 },
      expect.any(Function)
    );

    vi.advanceTimersByTime(10_000);
    expect(execSpy).toHaveBeenCalledWith(
      "docker",
      ["kill", expect.stringMatching(/^yoplai-agent-cloud-/)],
      { timeout: 5_000 },
      expect.any(Function)
    );

    processes[0].finish(137);
    await expect(run).rejects.toThrow("Container exceeded max runtime after 1s");
  });

  it("stops then kills on idle timeout", async () => {
    vi.useFakeTimers();
    const root = tempDir();
    process.env.YOPLAI_HOME = path.join(root, "yoplai");
    const agent = createAgent(root, { idleTimeout: 1, maxRunTime: 100 });
    setConfig(agent, root);
    const { processes } = mockSpawn();
    const execSpy = mockExecFile(false);

    const run = getContainerAdapter().run(createParams(agent));
    await vi.advanceTimersByTimeAsync(0);
    vi.advanceTimersByTime(1_000);
    expect(execSpy).toHaveBeenCalledWith(
      "docker",
      ["stop", expect.stringMatching(/^yoplai-agent-cloud-/)],
      { timeout: 10_000 },
      expect.any(Function)
    );

    vi.advanceTimersByTime(10_000);
    expect(execSpy).toHaveBeenCalledWith(
      "docker",
      ["kill", expect.stringMatching(/^yoplai-agent-cloud-/)],
      { timeout: 5_000 },
      expect.any(Function)
    );

    processes[0].finish(137);
    await expect(run).rejects.toThrow(
      "Container idle timed out after 1s without activity"
    );
  });

  it("resets idle timeout on protocol activity", async () => {
    vi.useFakeTimers();
    const root = tempDir();
    process.env.YOPLAI_HOME = path.join(root, "yoplai");
    const agent = createAgent(root, { idleTimeout: 1, maxRunTime: 100 });
    setConfig(agent, root);
    const { processes } = mockSpawn();
    const execSpy = mockExecFile(false);

    const run = getContainerAdapter().run(createParams(agent));
    await vi.advanceTimersByTimeAsync(0);
    vi.advanceTimersByTime(800);
    processes[0].emitStreamEvent({
      type: "assistant_text",
      text: "still working",
      timestamp: Date.now(),
    });
    vi.advanceTimersByTime(999);
    expect(execSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(execSpy).toHaveBeenCalledWith(
      "docker",
      ["stop", expect.stringMatching(/^yoplai-agent-cloud-/)],
      { timeout: 10_000 },
      expect.any(Function)
    );

    processes[0].finish(137);
    await expect(run).rejects.toThrow(
      "last activity was history_assistant_text 1s ago"
    );
  });

  it("rejects non-zero exits without protocol output", async () => {
    const root = tempDir();
    process.env.YOPLAI_HOME = path.join(root, "yoplai");
    const agent = createAgent(root);
    setConfig(agent, root);
    const { processes } = mockSpawn();
    mockExecFile();

    const run = getContainerAdapter().run(createParams(agent));
    await tick();
    processes[0].stderr.write("boom");
    processes[0].finish(1);

    await expect(run).rejects.toThrow("boom");
  });

  it("does not expose benign runner startup stderr as the failure", async () => {
    const root = tempDir();
    process.env.YOPLAI_HOME = path.join(root, "yoplai");
    const agent = createAgent(root);
    setConfig(agent, root);
    const { processes } = mockSpawn();
    mockExecFile();

    const run = getContainerAdapter().run(createParams(agent));
    await tick();
    processes[0].stderr.write("[agent-runner] Running agent henry with SDK pi\n");
    processes[0].finish(1);

    await expect(run).rejects.toThrow(
      "Container exited without protocol output (code 1)"
    );
  });

  it("embeds per-agent onecli token into proxy URL", async () => {
    const root = tempDir();
    process.env.YOPLAI_HOME = path.join(root, "yoplai");
    const agent = createAgent(root);
    // Override config with top-level onecli that has per-agent token
    setLoadedConfig({
      agents: [{ ...agent, onecliToken: "tok-sally-123" }],
      extensions: {},
      onecli: {
        enabled: true,
        mode: "proxy",
        gatewayUrl: "http://onecli:10255",
      },
      sandbox: {},
    } as GatewayConfig);

    const { processes } = mockSpawn();
    mockExecFile();
    const params = createParams(agent);

    const run = getContainerAdapter().run(params);
    await tick();
    const dockerProcess = processes[0];
    const input = JSON.parse(dockerProcess.stdinChunks.join(""));

    dockerProcess.emitOutput({ text: "ok" });
    dockerProcess.finish(0);

    await expect(run).resolves.toEqual({ text: "ok", aborted: undefined });
    expect(input.onecli.url).toBe("http://onecli:tok-sally-123@onecli:10255");
  });

  it("rejects successful exits with missing sentinels", async () => {
    const root = tempDir();
    process.env.YOPLAI_HOME = path.join(root, "yoplai");
    const agent = createAgent(root);
    setConfig(agent, root);
    const { processes } = mockSpawn();
    mockExecFile();

    const run = getContainerAdapter().run(createParams(agent));
    await tick();
    processes[0].stdout.write("plain stdout");
    processes[0].finish(0);

    await expect(run).rejects.toThrow(
      "Container exited without protocol output (code 0)"
    );
  });
});
