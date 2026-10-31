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
import { ensureWorkspaceFiles } from "../../agents/workspace.js";
import { getContainerAdapter } from "./adapter.js";
import { isRunSettledError } from "../run-settled.js";
import { getContainerTokenContext } from "./tokens.js";
import type { SdkRunParams } from "../types.js";

const mockGetExtensionAgentTools = vi.hoisted(() =>
  vi.fn<(agent: unknown) => unknown[]>(() => [])
);
const mockResolveOAuthTokens = vi.hoisted(() => vi.fn());

vi.mock("../../extensions/tools.js", () => ({
  getExtensionAgentTools: mockGetExtensionAgentTools,
}));

vi.mock("./oauth-tokens.js", () => ({
  resolveOAuthTokens: mockResolveOAuthTokens,
}));

vi.mock("../../skills/resolver.js", () => ({
  resolveRunSkills: vi.fn(async () => ({ skills: [], diagnostics: [] })),
}));

vi.mock("../../media/describe.js", () => ({
  configuredModelSupportsImages: vi.fn(async () => true),
  describeImage: vi.fn(async () => ""),
}));

vi.mock("@yoplai/shared/node/system-files", () => ({
  resolveSystemFiles: vi.fn(async () => [{ path: "USER.md", content: "user" }]),
}));

vi.mock("../../agents/workspace.js", async () => {
  const fs = await import("node:fs");
  return {
    FIRST_RUN_BOOTSTRAP_PROMPT: "first run bootstrap",
    ensureWorkspaceFiles: vi.fn(async (workspaceDir: string) => {
      fs.mkdirSync(workspaceDir, { recursive: true });
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
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
  }
};

function createAgent(
  root: string,
  sandbox: Partial<NonNullable<AgentConfig["sandbox"]>> = {}
): AgentConfig {
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
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

type ContainerSessionHandleShape = {
  containerName: string;
  ipcDir: string;
  agentId: string;
  sessionId: string;
  runId: string;
};

/** Handle shape the adapter hands to run-lifecycle, keyed to one run. */
function createHandle(
  ipcDir: string,
  extra: Record<string, unknown> = {}
): ContainerSessionHandleShape & Record<string, unknown> {
  const [sessionId, runId] = path.basename(ipcDir).split("-run-");
  return {
    containerName: "container",
    ipcDir,
    agentId: "cloud",
    sessionId,
    runId: `run-${runId}`,
    ...extra,
  };
}

function readQueuedMessages(ipcDir: string): unknown[] {
  const inputDir = path.join(ipcDir, "input");
  return fs
    .readdirSync(inputDir)
    .map((filename) =>
      JSON.parse(fs.readFileSync(path.join(inputDir, filename), "utf8"))
    );
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

function gatewayRunSignal(process: FakeDockerProcess): AbortSignal {
  const input = JSON.parse(process.stdinChunks.join(""));
  return getContainerTokenContext(input.agentToken)!.abortController.signal;
}

function mockExecFile(complete = true): MockInstance {
  return vi
    .mocked(childProcess.execFile)
    .mockImplementation((_file, args, _options, callback) => {
      if (
        (complete || args?.[0] !== "stop") &&
        typeof callback === "function"
      ) {
        callback(null, args?.[0] === "inspect" ? "false" : "", "");
      }
      return new EventEmitter() as never;
    });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetExtensionAgentTools.mockReturnValue([]);
  mockResolveOAuthTokens.mockResolvedValue(undefined);
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
  it("logs invalid-request fallbacks at error across stderr chunk boundaries", async () => {
    const root = tempDir();
    process.env.YOPLAI_HOME = path.join(root, "yoplai");
    const agent = createAgent(root);
    setConfig(agent, root);
    const { processes } = mockSpawn();
    mockExecFile();
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const run = getContainerAdapter().run(createParams(agent));
    await tick();
    const primaryFailure = '400 {"error":{"type":"invalid_request_error","message":"tools.4.custom.input_schema: JSON schema is invalid"}}';
    const fallbackLine = JSON.stringify({
      event: "model_fallback",
      primaryFailureCategory: "invalid_request",
      primaryFailure,
      fallbackOutcome: "success",
    });
    const middle = Math.floor(fallbackLine.length / 2);
    processes[0].stderr.write(fallbackLine.slice(0, middle));
    expect(error).not.toHaveBeenCalled();
    // Finish a split line and deliver another full line in the same chunk.
    processes[0].stderr.write(`${fallbackLine.slice(middle)}\nordinary stderr\n`);
    processes[0].stderr.write(`${fallbackLine}\n${JSON.stringify({
      event: "model_fallback", primaryFailureCategory: "rate_limit", primaryFailure: "429",
    })}\nnull\n`);
    processes[0].emitOutput({ text: "fallback answer" });
    processes[0].finish(0);
    await expect(run).resolves.toMatchObject({ text: "fallback answer" });

    const errors = error.mock.calls.map(([line]) => JSON.parse(String(line)));
    expect(errors).toHaveLength(2);
    for (const entry of errors) {
      expect(entry).toMatchObject({
        level: "error", agentId: "cloud", message: primaryFailure,
        primaryFailureCategory: "invalid_request",
      });
    }
    expect(info.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual(
      expect.objectContaining({ level: "info", msg: "[container] stderr", message: "ordinary stderr" })
    );
  });

  // Startup seams approved by Thinh on ALG-492 (2026-10-17).
  it.each(["setup", "publication", "runner startup"])("honors cancellation during %s and accepts a later run", async (phase) => {
    const root = tempDir();
    process.env.YOPLAI_HOME = path.join(root, "yoplai");
    const agent = createAgent(root);
    setConfig(agent, root);
    const { processes } = mockSpawn();
    mockExecFile();
    let releaseSetup = () => {};
    const setup = new Promise<boolean>((resolve) => {
      releaseSetup = () => resolve(false);
    });
    vi.mocked(ensureWorkspaceFiles).mockReturnValueOnce(setup);
    const controller = new AbortController();
    const params = {
      ...createParams(agent),
      abortSignal: controller.signal,
      onSessionHandle: () => {
        if (phase === "publication") controller.abort();
      },
    };

    const run = getContainerAdapter().run(params);
    if (phase === "setup") controller.abort();
    releaseSetup();
    if (phase === "runner startup") {
      await tick();
      controller.abort();
    }

    await expect(run).resolves.toEqual({ text: "", aborted: true });
    const later = getContainerAdapter().run(createParams(agent));
    await tick();
    processes[1].emitOutput({ text: "later-ok" });
    processes[1].finish(0);
    await expect(later).resolves.toEqual({ text: "later-ok", aborted: undefined });
  });

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
    expect(getContainerTokenContext(input.agentToken)).toMatchObject({
      agentId: "cloud",
      sessionId: "session-1",
      containerName: expect.stringMatching(/^yoplai-agent-cloud-/),
    });
    getContainerTokenContext(input.agentToken)?.emitProgress?.({
      label: "Checkpoint saved.",
      taskId: "task-1",
    });
    expect(params.onEvent).toHaveBeenCalledWith({
      type: "progress",
      label: "Checkpoint saved.",
      taskId: "task-1",
    });

    dockerProcess.emitOutput({ text: "hello back" });
    dockerProcess.finish(0);

    await expect(run).resolves.toEqual({
      text: "hello back",
      aborted: undefined,
    });
    expect(getContainerTokenContext(input.agentToken)).toBeUndefined();

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
      sessionDir: "/users/user-1/sessions/cloud",
      ipcDir: "/workspace/ipc",
      gatewayUrl: expect.any(String),
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
        expect.objectContaining({
          extensionId: "gateway",
          name: "extract_document",
        }),
        expect.objectContaining({ extensionId: "gateway", name: "skill_save" }),
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
        agentId: "cloud",
        sessionId: "session-1",
        runId: input.runId,
        ipcDir: expect.stringContaining(path.join(homeDir, "ipc", "cloud")),
      })
    );
    expect(input.runId).toEqual(expect.any(String));
    expect(params.onEvent).toHaveBeenCalledWith({
      type: "text",
      data: "hello back",
    });
    expect(params.onEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "done" })
    );
  });

  it("scopes OAuth renewal to the override provider seeded for the run", async () => {
    const root = tempDir();
    process.env.YOPLAI_HOME = path.join(root, "yoplai");
    const agent = createAgent(root);
    setConfig(agent, root);
    mockResolveOAuthTokens.mockResolvedValue({
      "openai-codex": { accessToken: "oauth-token", expiresAt: 12345 },
    });
    const { processes } = mockSpawn();
    mockExecFile();
    const params = createParams(agent);
    params.model = { provider: "openai-codex", model: "gpt-5" };

    const run = getContainerAdapter().run(params);
    await tick();
    const dockerProcess = processes[0];
    const input = JSON.parse(dockerProcess.stdinChunks.join(""));

    expect(mockResolveOAuthTokens).toHaveBeenCalledWith(agent, params.model);
    expect(input.oauthTokens).toEqual({
      "openai-codex": { accessToken: "oauth-token", expiresAt: 12345 },
    });
    expect(getContainerTokenContext(input.agentToken)?.oauthProviders).toEqual([
      "openai-codex",
    ]);

    dockerProcess.emitOutput({ text: "done" });
    dockerProcess.finish(0);
    await run;
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

  it("hides lifecycle tool events from the container stream", async () => {
    const root = tempDir();
    process.env.YOPLAI_HOME = path.join(root, "yoplai");
    const agent = createAgent(root);
    setConfig(agent, root);
    mockGetExtensionAgentTools.mockReturnValue([
      {
        extensionId: "taskLifecycle",
        name: "task.adopt",
        description: "Adopt task",
        parameters: { type: "object", properties: {} },
      },
    ]);
    const { processes } = mockSpawn();
    mockExecFile();
    const params = createParams(agent);

    const run = getContainerAdapter().run(params);
    await tick();
    processes[0].emitStreamEvent({
      type: "tool_call",
      id: "task-1",
      name: "task.adopt",
      args: {},
      timestamp: 1,
    });
    processes[0].emitStreamEvent({
      type: "tool_call",
      id: "bash-1",
      name: "bash",
      args: {},
      timestamp: 2,
    });
    processes[0].emitOutput({ text: "done" });
    processes[0].finish(0);

    await expect(run).resolves.toEqual({ text: "done", aborted: undefined });
    expect(params.onHistoryEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: "task.adopt" })
    );
    expect(params.onEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "task.adopt" })
    );
    expect(params.onHistoryEvent).toHaveBeenCalledWith(
      expect.objectContaining({ name: "bash" })
    );
    expect(params.onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "bash" })
    );
  });

  it("hides lifecycle tool events from final container history", async () => {
    const root = tempDir();
    process.env.YOPLAI_HOME = path.join(root, "yoplai");
    const agent = createAgent(root);
    setConfig(agent, root);
    mockGetExtensionAgentTools.mockReturnValue([
      {
        extensionId: "taskLifecycle",
        name: "task.adopt",
        description: "Adopt task",
        parameters: { type: "object", properties: {} },
      },
    ]);
    const { processes } = mockSpawn();
    mockExecFile();
    const params = createParams(agent);

    const run = getContainerAdapter().run(params);
    await tick();
    processes[0].emitOutput({
      text: "done",
      history: [
        {
          type: "tool_call",
          id: "task-1",
          name: "task.adopt",
          args: {},
          timestamp: 1,
        },
        {
          type: "tool_result",
          id: "task-1",
          name: "task.adopt",
          content: "ok",
          isError: false,
          timestamp: 2,
        },
        {
          type: "tool_call",
          id: "bash-1",
          name: "bash",
          args: {},
          timestamp: 3,
        },
      ],
    });
    processes[0].finish(0);

    await expect(run).resolves.toEqual({ text: "done", aborted: undefined });
    expect(params.onHistoryEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: "task.adopt" })
    );
    expect(params.onHistoryEvent).toHaveBeenCalledWith(
      expect.objectContaining({ name: "bash" })
    );
  });

  it.each(["streaming", "final"])("preserves nested tool parents in %s container output", async (mode) => {
    const root = tempDir();
    process.env.YOPLAI_HOME = path.join(root, "yoplai");
    const agent = createAgent(root);
    setConfig(agent, root);
    const { processes } = mockSpawn();
    mockExecFile();
    const params = createParams(agent);
    const run = getContainerAdapter().run(params);
    await tick();
    const history = [
      { type: "tool_call", id: "batch/0", parentToolCallId: "batch", name: "read", args: { path: "a" }, timestamp: 1 },
      { type: "tool_result", id: "batch/0", parentToolCallId: "batch", name: "read", content: "child", isError: false, timestamp: 2 },
    ];
    if (mode === "streaming") {
      for (const event of history) processes[0].emitStreamEvent(event, true);
    }
    processes[0].emitOutput({ text: "done", history });
    processes[0].finish(0);
    await run;
    for (const type of ["tool_call", "tool_result"]) {
      expect(params.onHistoryEvent).toHaveBeenCalledWith(expect.objectContaining({ type, id: "batch/0", parentToolCallId: "batch" }));
      if (mode === "streaming") {
        expect(params.onEvent).toHaveBeenCalledWith(expect.objectContaining({ type, id: "batch/0", parentToolCallId: "batch" }));
      }
    }
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

  it("logs legacy file_output failure with run identity and path", async () => {
    const root = tempDir();
    process.env.YOPLAI_HOME = path.join(root, "yoplai");
    const agent = createAgent(root);
    setConfig(agent, root);
    const { processes } = mockSpawn();
    mockExecFile();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const params = createParams(agent);
    const run = getContainerAdapter().run(params);
    await tick();
    processes[0].emitStreamEvent({
      type: "file_output",
      path: "/workspace/data/missing.csv",
    });
    processes[0].emitOutput({ text: "done" });
    processes[0].finish(0);
    await expect(run).resolves.toEqual({ text: "done", aborted: undefined });
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({
      msg: "[container] file_output failed",
      agentId: params.agentId,
      sessionId: params.sessionId,
      runId: expect.any(String),
      path: "/workspace/data/missing.csv",
    });
    expect(params.onEvent).toHaveBeenCalledWith({
      type: "error",
      message: expect.any(String),
    });
    expect(params.onHistoryEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "assistant_file" })
    );
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

  it("writes every queued message to a unique IPC file", async () => {
    const root = tempDir();
    const ipcDir = path.join(root, "ipc", "cloud", "session-1-run-1");
    vi.spyOn(Date, "now").mockReturnValue(123);

    const recordQueuedMessageActivity = vi.fn();
    const handle = createHandle(ipcDir, {
      recordQueuedMessageActivity,
    });

    await getContainerAdapter().queueMessage?.(handle, "first follow up");
    await getContainerAdapter().queueMessage?.(handle, "second follow up", {
      source: "slack",
      slack: { channel: "C1", threadTs: "1.2" },
    });

    const messages = readQueuedMessages(ipcDir);
    expect(messages).toEqual(
      expect.arrayContaining([
        {
          message: "first follow up",
          timestamp: 123,
          agentId: "cloud",
          sessionId: "session-1",
          runId: "run-1",
        },
        {
          message: "second follow up",
          timestamp: 123,
          agentId: "cloud",
          sessionId: "session-1",
          runId: "run-1",
          source: "slack",
          slack: { channel: "C1", threadTs: "1.2" },
        },
      ])
    );
    expect(messages).toHaveLength(2);
    expect(recordQueuedMessageActivity).toHaveBeenCalledTimes(2);
  });

  it("stamps run identity on the queued envelope", async () => {
    const root = tempDir();
    const runOne = path.join(root, "ipc", "cloud", "session-1-run-1");

    await getContainerAdapter().queueMessage?.(
      createHandle(runOne),
      "only for run one"
    );

    expect(readQueuedMessages(runOne)).toEqual([
      expect.objectContaining({
        message: "only for run one",
        agentId: "cloud",
        sessionId: "session-1",
        runId: "run-1",
      }),
    ]);
  });

  it("writes close sentinel and stops on abort", () => {
    const root = tempDir();
    const ipcDir = path.join(root, "ipc", "cloud", "session-1-run-1");
    const execSpy = mockExecFile();

    getContainerAdapter().abort?.(createHandle(ipcDir));

    expect(fs.existsSync(path.join(ipcDir, "input", "_close"))).toBe(true);
    expect(execSpy).toHaveBeenCalledWith(
      "docker",
      ["stop", "container"],
      { timeout: 10_000 },
      expect.any(Function)
    );
  });

  it("isolates follow-ups and aborts between two live runs of one agent", async () => {
    const root = tempDir();
    const homeDir = path.join(root, "yoplai");
    process.env.YOPLAI_HOME = homeDir;
    const agent = createAgent(root);
    setConfig(agent, root);
    const { processes } = mockSpawn();
    mockExecFile();

    // Two concurrent runs of the same agent, with namespaces derived by
    // production code rather than fabricated by the test.
    const paramsOne = createParams(agent);
    const paramsTwo = { ...createParams(agent), sessionId: "session-2" };
    const runOne = getContainerAdapter().run(paramsOne);
    const runTwo = getContainerAdapter().run(paramsTwo);
    await tick();

    const handleOne = vi.mocked(paramsOne.onSessionHandle!).mock
      .calls[0][0] as ContainerSessionHandleShape;
    const handleTwo = vi.mocked(paramsTwo.onSessionHandle!).mock
      .calls[0][0] as ContainerSessionHandleShape;
    expect(handleOne.ipcDir).not.toBe(handleTwo.ipcDir);

    await getContainerAdapter().queueMessage?.(handleOne, "only for run one");
    expect(readQueuedMessages(handleOne.ipcDir)).toEqual([
      expect.objectContaining({
        message: "only for run one",
        runId: handleOne.runId,
      }),
    ]);
    expect(readQueuedMessages(handleTwo.ipcDir)).toEqual([]);

    const signalOne = gatewayRunSignal(processes[0]);
    const signalTwo = gatewayRunSignal(processes[1]);
    getContainerAdapter().abort?.(handleOne);
    expect(signalOne.aborted).toBe(true);
    expect(signalTwo.aborted).toBe(false);
    expect(fs.existsSync(path.join(handleOne.ipcDir, "input", "_close"))).toBe(
      true
    );
    expect(fs.existsSync(path.join(handleTwo.ipcDir, "input", "_close"))).toBe(
      false
    );

    processes[0].emitOutput({ text: "one" });
    processes[0].finish(0);
    processes[1].emitOutput({ text: "two" });
    processes[1].finish(0);
    await Promise.all([runOne, runTwo]);
  });

  it("removes only its own ipc namespace when the run settles", async () => {
    const root = tempDir();
    const homeDir = path.join(root, "yoplai");
    process.env.YOPLAI_HOME = homeDir;
    const agent = createAgent(root);
    setConfig(agent, root);
    const { processes } = mockSpawn();
    mockExecFile();
    const params = createParams(agent);
    const sibling = path.join(homeDir, "ipc", "cloud", "session-9-run-9");
    fs.mkdirSync(path.join(sibling, "input"), { recursive: true });

    const run = getContainerAdapter().run(params);
    await tick();
    const handle = vi.mocked(params.onSessionHandle!).mock
      .calls[0][0] as ContainerSessionHandleShape;
    expect(fs.existsSync(handle.ipcDir)).toBe(true);

    processes[0].emitOutput({ text: "done" });
    processes[0].finish(0);
    await expect(run).resolves.toEqual({ text: "done", aborted: undefined });

    expect(fs.existsSync(handle.ipcDir)).toBe(false);
    expect(fs.existsSync(path.join(sibling, "input"))).toBe(true);
  });

  it("releases the ipc namespace when the run fails before spawning", async () => {
    const root = tempDir();
    const homeDir = path.join(root, "yoplai");
    process.env.YOPLAI_HOME = homeDir;
    const agent = createAgent(root);
    setConfig(agent, root);
    mockSpawn();
    mockExecFile();
    vi.mocked(ensureWorkspaceFiles).mockRejectedValueOnce(
      new Error("workspace unavailable")
    );

    await expect(
      getContainerAdapter().run(createParams(agent))
    ).rejects.toThrow("workspace unavailable");

    // The run Promise's cleanup() never ran, so the pre-spawn path owns the
    // release. Nothing may be left under the agent's ipc root.
    const agentIpcRoot = path.join(homeDir, "ipc", "cloud");
    expect(
      fs.existsSync(agentIpcRoot) ? fs.readdirSync(agentIpcRoot) : []
    ).toEqual([]);
  });

  it("refuses to write into a settled run's removed namespace", async () => {
    vi.useFakeTimers();
    const root = tempDir();
    process.env.YOPLAI_HOME = path.join(root, "yoplai");
    const agent = createAgent(root);
    setConfig(agent, root);
    const { processes } = mockSpawn();
    mockExecFile();
    const params = createParams(agent);

    const run = getContainerAdapter().run(params);
    await tick();
    const handle = vi.mocked(params.onSessionHandle!).mock
      .calls[0][0] as ContainerSessionHandleShape;

    processes[0].emitStreamEvent({
      type: "tool_call", id: "late-deadline", name: "bash", args: {}, timestamp: 0,
    });
    processes[0].emitOutput({ text: "done" });
    processes[0].finish(0);
    await run;

    // The gateway keeps advertising the session as streaming until history is
    // flushed, so a late join can still reach this handle. It must be refused
    // rather than recreating a namespace nothing is polling.
    await expect(
      getContainerAdapter().queueMessage?.(handle, "too late")
    ).rejects.toSatisfy(isRunSettledError);
    getContainerAdapter().abort?.(handle);
    await vi.advanceTimersByTimeAsync(315_000);
    expect(fs.existsSync(handle.ipcDir)).toBe(false);
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
    void run.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    const signal = gatewayRunSignal(processes[0]);
    expect(signal.aborted).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(signal.aborted).toBe(true);
    expect(execSpy).toHaveBeenCalledWith(
      "docker",
      ["stop", expect.stringMatching(/^yoplai-agent-cloud-/)],
      { timeout: 10_000 },
      expect.any(Function)
    );

    await vi.advanceTimersByTimeAsync(10_000);
    expect(execSpy).toHaveBeenCalledWith(
      "docker",
      ["kill", expect.stringMatching(/^yoplai-agent-cloud-/)],
      { timeout: 2_000 },
      expect.any(Function)
    );

    processes[0].finish(137);
    await expect(run).rejects.toThrow(
      "Container exceeded max runtime after 1s"
    );
    await expect(run).rejects.toMatchObject({ kind: "max_run_time" });
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
    void run.catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    const signal = gatewayRunSignal(processes[0]);
    expect(signal.aborted).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(signal.aborted).toBe(true);
    expect(execSpy).toHaveBeenCalledWith(
      "docker",
      ["stop", expect.stringMatching(/^yoplai-agent-cloud-/)],
      { timeout: 10_000 },
      expect.any(Function)
    );

    await vi.advanceTimersByTimeAsync(10_000);
    expect(execSpy).toHaveBeenCalledWith(
      "docker",
      ["kill", expect.stringMatching(/^yoplai-agent-cloud-/)],
      { timeout: 2_000 },
      expect.any(Function)
    );

    processes[0].finish(137);
    await expect(run).rejects.toThrow(
      "Container idle timed out after 1s without activity"
    );
    await expect(run).rejects.toMatchObject({ kind: "idle_timeout" });
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
    void run.catch(() => {});
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
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(run).rejects.toThrow(
      "last activity was history_assistant_text 1s ago"
    );
  });

  it.each([
    { timeout: 400, completeAt: 350 },
    { timeout: 900, completeAt: 900 },
  ])(
    "suspends idle for a silent $timeout second bash and rearms on completion",
    async ({ timeout, completeAt }) => {
      vi.useFakeTimers();
      const root = tempDir();
      process.env.YOPLAI_HOME = path.join(root, "yoplai");
      const agent = createAgent(root, { idleTimeout: 300, maxRunTime: 1800 });
      setConfig(agent, root);
      const { processes } = mockSpawn();
      const execSpy = mockExecFile();
      const run = getContainerAdapter().run(createParams(agent));
      await vi.advanceTimersByTimeAsync(0);
      processes[0].emitStreamEvent({
        type: "tool_call",
        id: "bash-1",
        name: "bash",
        args: { timeout },
        timestamp: 0,
      });
      await vi.advanceTimersByTimeAsync(completeAt * 1000);
      expect(execSpy).not.toHaveBeenCalled();
      processes[0].emitStreamEvent({
        type: "tool_result",
        id: "bash-1",
        name: "bash",
        content: "done",
        isError: false,
        timestamp: 0,
      });
      await vi.advanceTimersByTimeAsync(299_000);
      expect(execSpy).not.toHaveBeenCalled();
      processes[0].emitOutput({ text: "done" });
      processes[0].finish(0);
      await expect(run).resolves.toEqual({ text: "done", aborted: undefined });
    }
  );

  it("kills an overdue call despite queued messages, overlapping completion, and late success output", async () => {
    vi.useFakeTimers();
    const root = tempDir();
    process.env.YOPLAI_HOME = path.join(root, "yoplai");
    const agent = createAgent(root, { idleTimeout: 300, maxRunTime: 1800 });
    setConfig(agent, root);
    const { processes } = mockSpawn();
    const execSpy = mockExecFile();
    const params = createParams(agent);
    const run = getContainerAdapter().run(params);
    const rejection = expect(run).rejects.toMatchObject({
      code: "tool_deadline",
      kind: "tool_deadline",
      message: expect.stringContaining("bash exceeded its deadline after 315s"),
    });
    await vi.advanceTimersByTimeAsync(0);
    const handle = vi.mocked(params.onSessionHandle!).mock.calls[0][0];
    processes[0].emitStreamEvent({
      type: "tool_call",
      id: "long",
      name: "bash",
      args: {},
      timestamp: 0,
    });
    processes[0].emitStreamEvent({
      type: "tool_call",
      id: "other",
      name: "bash",
      args: { timeout: 900 },
      timestamp: 0,
    });
    await vi.advanceTimersByTimeAsync(300_000);
    await getContainerAdapter().queueMessage!(handle, "keep working");
    processes[0].emitStreamEvent({
      type: "assistant_text",
      text: "working",
      timestamp: 0,
    });
    processes[0].emitStreamEvent({
      type: "tool_result",
      id: "other",
      name: "bash",
      content: "done",
      isError: false,
      timestamp: 0,
    });
    expect(execSpy).not.toHaveBeenCalled();
    const signal = gatewayRunSignal(processes[0]);
    expect(signal.aborted).toBe(false);
    vi.advanceTimersByTime(15_000);
    expect(signal.aborted).toBe(true);
    // ALG-566 approves the adapter seam: prove the runner receives a close
    // before Docker exits; this does not exercise the runner's IPC poller.
    expect(fs.existsSync(path.join((handle as ContainerSessionHandleShape).ipcDir, "input", "_close"))).toBe(true);
    processes[0].emitOutput({ text: "late success" });
    processes[0].finish(0);
    await rejection;
    expect(execSpy).toHaveBeenCalledWith(
      "docker",
      ["stop", expect.any(String)],
      { timeout: 10_000 },
      expect.any(Function)
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
    processes[0].stderr.write(
      "[agent-runner] Running agent henry with SDK pi\n"
    );
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
