import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig, Extension, GatewayConfig } from "@yoplai/shared";
import type { SdkRunParams } from "../../types.js";
import {
  clearConfigCacheForTests,
  setLoadedConfig,
} from "../../../config/index.js";

const mockCreateAgentSession = vi.fn();
const mockGetEnvApiKey = vi.fn(() => "env-api-key");
const mockEnsureWorkspaceFiles = vi.fn(async () => undefined);
const mockLoadWorkspaceFiles = vi.fn(async () => []);
const mockBuildWorkspaceContextFiles = vi.fn(() => []);
const mockGetLoadedExtensions = vi.fn<() => Partial<Extension>[]>(() => []);
const mockGetExtensionAgentTools = vi.fn<() => Promise<unknown[]>>(
  async () => []
);
const tempDirs: string[] = [];

vi.mock("../../agents/workspace.js", () => ({
  FIRST_RUN_BOOTSTRAP_PROMPT: "first run bootstrap",
  ensureWorkspaceFiles: mockEnsureWorkspaceFiles,
  loadWorkspaceFiles: mockLoadWorkspaceFiles,
  buildWorkspaceContextFiles: mockBuildWorkspaceContextFiles,
}));

vi.mock("../../sessions/store.js", () => ({
  getSessionCreatedAt: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../sessions/files.js", () => ({
  resolveSessionDataFile: vi.fn(
    async () => "/tmp/yoplai-test/sessions/session-1.jsonl"
  ),
}));

vi.mock("../../extensions/registry.js", () => ({
  getLoadedExtensions: mockGetLoadedExtensions,
}));

vi.mock("../../../extensions/tools.js", () => ({
  getExtensionAgentTools: mockGetExtensionAgentTools,
}));

vi.mock("@earendil-works/pi-ai", () => ({
  getEnvApiKey: mockGetEnvApiKey,
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession: mockCreateAgentSession,
  SessionManager: {
    open: vi.fn(() => ({ close: vi.fn() })),
  },
  SettingsManager: {
    create: vi.fn(() => ({})),
  },
  readStoredCredential: vi.fn(() => undefined),
  ModelRuntime: {
    create: vi.fn(async () => ({
      getModel: vi.fn(() => ({ provider: "anthropic" })),
      getAuth: vi.fn(async () => ({ auth: { apiKey: "runtime-key" } })),
      setRuntimeApiKey: vi.fn(async () => undefined),
    })),
  },
  DefaultResourceLoader: class {
    async reload() {
      return undefined;
    }
  },
}));

function makeAgent(id = "pi-agent"): AgentConfig {
  return {
    id,
    name: "Pi Agent",
    workspace: "~/agents/pi-agent",
    sdk: "pi",
    queueMode: "queue",
    model: {
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
    },
  };
}

function makeRunParams(agent: AgentConfig): SdkRunParams {
  return {
    agentId: agent.id,
    agent,
    sessionId: "session-1",
    message: "hello",
    workspaceDir: "/tmp/workspace",
    onEvent: vi.fn(),
    onHistoryEvent: vi.fn(),
    abortSignal: new AbortController().signal,
  };
}

describe("pi adapter onecli env wiring", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    clearConfigCacheForTests();
    mockGetLoadedExtensions.mockReturnValue([]);
    mockGetExtensionAgentTools.mockResolvedValue([]);
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearConfigCacheForTests();
    process.env = { ...originalEnv };
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sets proxy env before session creation and restores it after the run", async () => {
    const agent = makeAgent();
    const config = {
      agents: [{ ...agent, onecliToken: "token" }],
      onecli: {
        enabled: true,
        mode: "proxy",
        gatewayUrl: "http://localhost:10255",
        ca: {
          source: "file",
          path: "/tmp/onecli-ca.pem",
        },
      },
    } as GatewayConfig;
    const session = {
      messages: [{ role: "assistant", content: "done" }],
      agent: {
        state: {
          messages: [],
          systemPrompt: "You are Sally.\n\n[CHANNEL CONTEXT]\nchannel: slack",
        },
      },
      subscribe: vi.fn(() => vi.fn()),
      prompt: vi.fn(async () => undefined),
      abort: vi.fn(),
      dispose: vi.fn(),
    };
    const capturedEnv: Record<string, string | undefined>[] = [];

    setLoadedConfig(config);
    mockCreateAgentSession.mockImplementation(async () => {
      capturedEnv.push({
        HTTP_PROXY: process.env.HTTP_PROXY,
        HTTPS_PROXY: process.env.HTTPS_PROXY,
        NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
        SSL_CERT_FILE: process.env.SSL_CERT_FILE,
        REQUESTS_CA_BUNDLE: process.env.REQUESTS_CA_BUNDLE,
      });
      return { session };
    });

    process.env.HTTP_PROXY = "http://old-proxy";
    delete process.env.HTTPS_PROXY;
    delete process.env.NODE_EXTRA_CA_CERTS;
    process.env.SSL_CERT_FILE = "/tmp/original-ca.pem";
    delete process.env.REQUESTS_CA_BUNDLE;

    const { piAdapter } = await import("../adapter.js");
    const result = await piAdapter.run(makeRunParams(agent));

    expect(result).toEqual({ text: "done", aborted: false });
    expect(capturedEnv).toEqual([
      {
        HTTP_PROXY: "http://onecli:token@localhost:10255",
        HTTPS_PROXY: "http://onecli:token@localhost:10255",
        NODE_EXTRA_CA_CERTS: "/tmp/onecli-ca.pem",
        SSL_CERT_FILE: "/tmp/onecli-ca.pem",
        REQUESTS_CA_BUNDLE: "/tmp/onecli-ca.pem",
      },
    ]);
    expect(process.env.HTTP_PROXY).toBe("http://old-proxy");
    expect(process.env.HTTPS_PROXY).toBeUndefined();
    expect(process.env.NODE_EXTRA_CA_CERTS).toBeUndefined();
    expect(process.env.SSL_CERT_FILE).toBe("/tmp/original-ca.pem");
    expect(process.env.REQUESTS_CA_BUNDLE).toBeUndefined();
  });

  it("leaves env unchanged when onecli is not enabled", async () => {
    const agent = makeAgent();
    const config = { agents: [agent] } as GatewayConfig;
    const session = {
      messages: [{ role: "assistant", content: "done" }],
      agent: {
        state: {
          messages: [],
          systemPrompt: "You are Sally.\n\n[CHANNEL CONTEXT]\nchannel: slack",
        },
      },
      subscribe: vi.fn(() => vi.fn()),
      prompt: vi.fn(async () => undefined),
      abort: vi.fn(),
      dispose: vi.fn(),
    };
    const capturedEnv: Record<string, string | undefined>[] = [];

    setLoadedConfig(config);
    mockCreateAgentSession.mockImplementation(async () => {
      capturedEnv.push({
        HTTP_PROXY: process.env.HTTP_PROXY,
        HTTPS_PROXY: process.env.HTTPS_PROXY,
        NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
      });
      return { session };
    });

    process.env.HTTP_PROXY = "http://unchanged-proxy";
    process.env.HTTPS_PROXY = "http://unchanged-secure-proxy";
    process.env.NODE_EXTRA_CA_CERTS = "/tmp/unchanged-ca.pem";

    const { piAdapter } = await import("../adapter.js");
    const result = await piAdapter.run(makeRunParams(agent));

    expect(result).toEqual({ text: "done", aborted: false });
    expect(capturedEnv).toEqual([
      {
        HTTP_PROXY: "http://unchanged-proxy",
        HTTPS_PROXY: "http://unchanged-secure-proxy",
        NODE_EXTRA_CA_CERTS: "/tmp/unchanged-ca.pem",
      },
    ]);
    expect(process.env.HTTP_PROXY).toBe("http://unchanged-proxy");
    expect(process.env.HTTPS_PROXY).toBe("http://unchanged-secure-proxy");
    expect(process.env.NODE_EXTRA_CA_CERTS).toBe("/tmp/unchanged-ca.pem");
  });

  it("keeps agent env out of process.env while passing it to extension tools", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "yoplai-pi-agent-env-"));
    tempDirs.push(root);
    const workspace = path.join(root, "agents", "pi-agent");
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(root, ".env"), "SLACK_TOKEN=home\n");
    fs.writeFileSync(path.join(workspace, ".env"), "SLACK_TOKEN=agent\n");
    fs.writeFileSync(
      path.join(root, "yoplai.json"),
      JSON.stringify({ version: 3, agents: [] })
    );
    const agent = { ...makeAgent(), workspace } as AgentConfig;
    const config = {
      agents: [agent],
      env: { SLACK_TOKEN: "config" },
    } as unknown as GatewayConfig;
    const session = {
      messages: [{ role: "assistant", content: "done" }],
      agent: { state: { messages: [] } },
      subscribe: vi.fn(() => vi.fn()),
      prompt: vi.fn(async () => undefined),
      abort: vi.fn(),
      dispose: vi.fn(),
    };
    const captured: Array<string | undefined> = [];
    const execute = vi.fn(async () => ({ ok: true }));

    process.env.YOPLAI_HOME = root;
    process.env.SLACK_TOKEN = "process";
    setLoadedConfig(config);
    vi.spyOn(console, "log").mockImplementation(() => {});
    mockGetExtensionAgentTools.mockResolvedValue([
      {
        extensionId: "slack",
        name: "slack.check",
        description: "Check env",
        parameters: { type: "object", properties: {} },
        execute,
      },
    ]);
    mockCreateAgentSession.mockImplementation(async () => {
      captured.push(process.env.SLACK_TOKEN);
      return { session };
    });

    const { piAdapter } = await import("../adapter.js");
    await piAdapter.run(makeRunParams(agent));

    expect(captured).toEqual(["process"]);
    expect(process.env.SLACK_TOKEN).toBe("process");
    const options = mockCreateAgentSession.mock.calls[0]?.[0] as {
      customTools?: Array<{
        name: string;
        execute: (_id: string, params: unknown) => Promise<unknown>;
      }>;
    };
    await options.customTools?.[0]?.execute("tool-1", {});
    expect(execute).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        agent,
        config,
        env: expect.objectContaining({ SLACK_TOKEN: "agent" }),
      })
    );
  });

  it("serializes concurrent runs so onecli env mutations do not overlap", async () => {
    const firstAgent = {
      ...makeAgent("pi-agent-1"),
      onecliToken: "token-1",
    } as AgentConfig;
    const secondAgent = {
      ...makeAgent("pi-agent-2"),
      onecliToken: "token-2",
    } as AgentConfig;
    const config = {
      agents: [firstAgent, secondAgent],
      onecli: {
        enabled: true,
        mode: "proxy",
        gatewayUrl: "http://localhost:10255",
      },
    } as GatewayConfig;

    let releaseFirstPrompt: (() => void) | undefined;
    const firstPromptStarted = new Promise<void>((resolve) => {
      releaseFirstPrompt = resolve;
    });
    let completeFirstPrompt: (() => void) | undefined;
    const firstPromptCompleted = new Promise<void>((resolve) => {
      completeFirstPrompt = resolve;
    });
    const createOrder: string[] = [];
    const envSnapshots: Array<{
      agentId: string;
      httpProxy: string | undefined;
    }> = [];

    setLoadedConfig(config);
    mockCreateAgentSession.mockImplementation(
      async ({ model }: { model: { provider: string } }) => {
        const agentId =
          process.env.HTTP_PROXY === "http://onecli:token-1@localhost:10255"
            ? firstAgent.id
            : secondAgent.id;
        createOrder.push(agentId);
        envSnapshots.push({
          agentId,
          httpProxy: process.env.HTTP_PROXY,
        });

        return {
          session: {
            messages: [{ role: "assistant", content: agentId }],
            agent: { state: { messages: [] } },
            subscribe: vi.fn(() => vi.fn()),
            prompt: vi.fn(async () => {
              if (model.provider && agentId === firstAgent.id) {
                completeFirstPrompt?.();
                await firstPromptStarted;
              }
            }),
            abort: vi.fn(),
            dispose: vi.fn(),
          },
        };
      }
    );

    const { piAdapter } = await import("../adapter.js");
    const firstRun = piAdapter.run(makeRunParams(firstAgent));
    await firstPromptCompleted;

    const secondRun = piAdapter.run({
      ...makeRunParams(secondAgent),
      sessionId: "session-2",
    });

    await Promise.resolve();
    expect(createOrder).toEqual([firstAgent.id]);
    expect(process.env.HTTP_PROXY).toBe(
      "http://onecli:token-1@localhost:10255"
    );

    releaseFirstPrompt?.();

    const [firstResult, secondResult] = await Promise.all([
      firstRun,
      secondRun,
    ]);

    expect(firstResult).toEqual({ text: firstAgent.id, aborted: false });
    expect(secondResult).toEqual({ text: secondAgent.id, aborted: false });
    expect(createOrder).toEqual([firstAgent.id, secondAgent.id]);
    expect(envSnapshots).toEqual([
      {
        agentId: firstAgent.id,
        httpProxy: "http://onecli:token-1@localhost:10255",
      },
      {
        agentId: secondAgent.id,
        httpProxy: "http://onecli:token-2@localhost:10255",
      },
    ]);
    expect(process.env.HTTP_PROXY).toBeUndefined();
  });

  it("emits the assembled system prompt into history before the run", async () => {
    const agent = makeAgent();
    const config = { agents: [agent] } as GatewayConfig;
    const session = {
      messages: [{ role: "assistant", content: "done" }],
      agent: {
        state: {
          messages: [],
          systemPrompt: "You are Sally.\n\n[CHANNEL CONTEXT]\nchannel: slack",
        },
      },
      subscribe: vi.fn(() => vi.fn()),
      prompt: vi.fn(async () => undefined),
      abort: vi.fn(),
      dispose: vi.fn(),
    };
    const onHistoryEvent = vi.fn();

    setLoadedConfig(config);
    mockCreateAgentSession.mockResolvedValue({ session });

    const { piAdapter } = await import("../adapter.js");
    await piAdapter.run({
      ...makeRunParams(agent),
      onHistoryEvent,
      context: {
        kind: "slack",
        blocks: [
          {
            type: "metadata",
            channel: "slack",
            place: "direct message / Thinh",
            conversationType: "direct_message",
            sender: "Thinh",
          },
        ],
      },
    });

    expect(onHistoryEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "system_prompt",
        text: "You are Sally.\n\n[CHANNEL CONTEXT]\nchannel: slack",
      })
    );
    expect(onHistoryEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "system_context",
        rendered: expect.stringContaining("[CHANNEL CONTEXT]"),
      })
    );
  });

  it("keeps lifecycle tool activity out of stream and history events", async () => {
    const agent = makeAgent();
    const config = { agents: [agent] } as GatewayConfig;
    let listener: ((event: unknown) => void) | undefined;
    const session = {
      messages: [{ role: "assistant", content: "done" }],
      agent: { state: { messages: [], systemPrompt: "You are Sally." } },
      subscribe: vi.fn((callback) => {
        listener = callback;
        return vi.fn();
      }),
      prompt: vi.fn(async () => {
        listener?.({
          type: "tool_execution_start",
          toolName: "task_adopt",
          toolCallId: "task-1",
          args: { title: "A" },
        });
        listener?.({
          type: "tool_execution_end",
          toolName: "task_adopt",
          toolCallId: "task-1",
          result: "ok",
        });
        listener?.({
          type: "tool_execution_start",
          toolName: "bash",
          toolCallId: "bash-1",
          args: { command: "true" },
        });
      }),
      abort: vi.fn(),
      dispose: vi.fn(),
    };
    const onEvent = vi.fn();
    const onHistoryEvent = vi.fn();

    setLoadedConfig(config);
    mockGetExtensionAgentTools.mockResolvedValue([
      {
        extensionId: "taskLifecycle",
        name: "task.adopt",
        description: "Adopt task",
        parameters: { type: "object", properties: {} },
        execute: vi.fn(),
      },
    ]);
    mockCreateAgentSession.mockResolvedValue({ session });

    const { piAdapter } = await import("../adapter.js");
    await piAdapter.run({ ...makeRunParams(agent), onEvent, onHistoryEvent });

    expect(onEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "task_adopt" })
    );
    expect(onHistoryEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: "task_adopt" })
    );
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "bash" })
    );
  });

  it("mounts extension tools in the in-process runtime", async () => {
    const agent = makeAgent();
    const config = { agents: [agent] } as GatewayConfig;
    const execute = vi.fn(async () => ({ content: "scratch" }));
    const session = {
      messages: [{ role: "assistant", content: "done" }],
      agent: { state: { messages: [], systemPrompt: "You are Sally." } },
      subscribe: vi.fn(() => vi.fn()),
      prompt: vi.fn(async () => undefined),
      abort: vi.fn(),
      dispose: vi.fn(),
    };

    setLoadedConfig(config);
    mockGetExtensionAgentTools.mockResolvedValue([
      {
        extensionId: "board",
        name: "scratchpad.read",
        description: "Read scratchpad",
        parameters: { type: "object", properties: {} },
        execute,
      },
    ]);
    mockCreateAgentSession.mockResolvedValue({ session });

    const { piAdapter } = await import("../adapter.js");
    await piAdapter.run(makeRunParams(agent));

    expect(mockGetExtensionAgentTools).toHaveBeenCalledWith(agent, config);
    const options = mockCreateAgentSession.mock.calls[0]?.[0] as {
      tools?: string[];
      customTools?: Array<{
        name: string;
        execute: (_id: string, params: unknown) => Promise<unknown>;
      }>;
    };
    const customToolNames = options.customTools?.map(
      (candidate) => candidate.name
    );
    expect(customToolNames).toEqual(["scratchpad_read"]);
    expect(options.tools).toEqual([
      "read",
      "bash",
      "edit",
      "write",
      "scratchpad_read",
    ]);
    expect(customToolNames).not.toEqual(
      expect.arrayContaining([
        "project_create",
        "project_get",
        "project_update",
        "project_comment",
      ])
    );
    expect(
      options.customTools?.every((candidate) =>
        /^[a-zA-Z0-9_-]{1,128}$/.test(candidate.name)
      )
    ).toBe(true);
    const tool = options.customTools?.find(
      (candidate) => candidate.name === "scratchpad_read"
    );
    expect(tool).toBeDefined();
    await tool?.execute("tool-1", {});
    expect(execute).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        agent,
        config,
        env: expect.any(Object),
      })
    );
  });
});
