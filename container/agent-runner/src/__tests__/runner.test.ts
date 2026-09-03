import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContainerInput } from "@yoplai/shared";
import { runAgent, sendFollowUpMessage } from "../runner.js";

const proxyFetchMock = vi.hoisted(() => vi.fn());

const piMock = vi.hoisted(() => {
  const subscribers: Array<(event: unknown) => void> = [];
  const setRuntimeApiKey = vi.fn();
  const sessionManagerOpen = vi.fn(() => ({}));
  const model = {
    provider: "anthropic",
    id: "claude-sonnet-4-6",
    model: "claude-sonnet-4-6",
  };
  const session = {
    messages: [] as unknown[],
    agent: {
      state: {
        systemPrompt: "You are Sally.\n\n[CHANNEL CONTEXT]\nchannel: slack",
      },
    },
    subscribe: vi.fn((listener: (event: unknown) => void) => {
      subscribers.push(listener);
      return vi.fn();
    }),
    prompt: vi.fn(async () => undefined),
    sendUserMessage: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    dispose: vi.fn(),
  };

  return {
    subscribers,
    setRuntimeApiKey,
    sessionManagerOpen,
    model,
    session,
    createAgentSession: vi.fn(async (_options: unknown) => ({ session })),
    resourceReload: vi.fn(async () => undefined),
    reset() {
      subscribers.length = 0;
      session.messages = [];
      session.subscribe.mockClear();
      session.prompt.mockReset();
      session.prompt.mockResolvedValue(undefined);
      session.sendUserMessage.mockClear();
      session.abort.mockClear();
      session.dispose.mockClear();
      this.createAgentSession.mockClear();
      this.resourceReload.mockClear();
      setRuntimeApiKey.mockClear();
      sessionManagerOpen.mockClear();
    },
  };
});

vi.mock("@earendil-works/pi-ai", () => ({
  InMemoryCredentialStore: class {},
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  ModelRuntime: {
    create: vi.fn(async () => ({
      setRuntimeApiKey: piMock.setRuntimeApiKey,
      getModel: vi.fn(() => piMock.model),
    })),
  },
  SessionManager: {
    open: piMock.sessionManagerOpen,
  },
  SettingsManager: {
    create: vi.fn(() => ({})),
  },
  DefaultResourceLoader: vi.fn(function (
    this: {
      reload: () => Promise<void>;
      options?: unknown;
    },
    options: unknown
  ) {
    this.reload = piMock.resourceReload;
    this.options = options;
  }),
  createAgentSession: piMock.createAgentSession,
}));

afterEach(() => {
  piMock.reset();
  proxyFetchMock.mockReset();
  vi.restoreAllMocks();
});

describe("Pi runner", () => {
  it("retries a zero-output retryable provider failure in the active session", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-runner-"));
    const workspaceDir = path.join(tempDir, "workspace");
    const sessionDir = path.join(tempDir, "sessions");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(sessionDir, { recursive: true });
    const events: unknown[] = [];
    piMock.session.prompt
      .mockRejectedValueOnce(
        Object.assign(new Error("HTTP 503 Service Unavailable"), {
          headers: { "Retry-After": "0" },
        })
      )
      .mockImplementationOnce(async () => {
        piMock.session.messages.push({
          role: "assistant",
          content: [{ type: "text", text: "recovered" }],
          stopReason: "end_turn",
        });
      });

    await expect(
      runAgent(
        createInput({
          workspaceDir,
          sessionDir,
          retry: { maxAttempts: 3, baseDelaySeconds: 2 },
        }),
        (event) => events.push(event)
      )
    ).resolves.toMatchObject({ text: "recovered" });

    expect(piMock.session.prompt).toHaveBeenCalledTimes(2);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "retry", attempt: 1, delaySeconds: 0 })
    );
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("retries a retryable error stop reason without restarting the run", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-runner-"));
    const workspaceDir = path.join(tempDir, "workspace");
    const sessionDir = path.join(tempDir, "sessions");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(sessionDir, { recursive: true });
    piMock.session.prompt
      .mockImplementationOnce(async () => {
        piMock.session.messages.push({
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "Upstream queue backpressure. Retry after 0s.",
        });
      })
      .mockImplementationOnce(async () => {
        piMock.session.messages.push({
          role: "assistant",
          content: [{ type: "text", text: "recovered" }],
          stopReason: "end_turn",
        });
      });

    await expect(
      runAgent(createInput({ workspaceDir, sessionDir }))
    ).resolves.toMatchObject({ text: "recovered" });
    expect(piMock.session.prompt).toHaveBeenCalledTimes(2);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("publishes and cleans up the runtime session when setup fails", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-runner-"));
    const workspaceDir = path.join(tempDir, "workspace");
    const sessionDir = path.join(tempDir, "sessions");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(sessionDir, { recursive: true });
    piMock.resourceReload.mockRejectedValueOnce(new Error("setup failed"));

    await expect(
      runAgent(createInput({ workspaceDir, sessionDir }))
    ).rejects.toThrow("setup failed");

    await expect(
      fs.readFile(path.join(sessionDir, "session-1.jsonl"), "utf8")
    ).resolves.toBe("");
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("runs the Pi session, returns history events, and streams events", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-runner-"));
    const workspaceDir = path.join(tempDir, "workspace");
    const sessionDir = path.join(tempDir, "sessions");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "agent docs");

    piMock.session.prompt.mockImplementationOnce(async () => {
      const assistant = {
        role: "assistant",
        content: [{ type: "text", text: "hello from pi" }],
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        api: "messages",
        usage: { inputTokens: 1, outputTokens: 2 },
        stopReason: "end_turn",
      };

      for (const subscriber of piMock.subscribers) {
        subscriber({
          type: "message_update",
          message: assistant,
          assistantMessageEvent: { type: "text_delta", delta: "hello" },
        });
        subscriber({
          type: "tool_execution_start",
          toolCallId: "tool-1",
          toolName: "bash",
          args: { cmd: "pwd" },
        });
        subscriber({
          type: "tool_execution_end",
          toolCallId: "tool-1",
          toolName: "bash",
          result: { content: [{ type: "text", text: workspaceDir }] },
          isError: false,
        });
        subscriber({ type: "message_end", message: assistant });
      }
      piMock.session.messages.push(assistant);
    });

    const streamedEvents: unknown[] = [];
    const output = await runAgent(
      createInput({ workspaceDir, sessionDir }),
      (event) => {
        streamedEvents.push(event);
      }
    );

    expect(output.text).toBe("hello from pi");
    expect(
      output.history?.map((event) => (event as { type: string }).type)
    ).toEqual([
      "user",
      "system_prompt",
      "assistant_text",
      "tool_call",
      "tool_result",
      "meta",
      "turn_end",
    ]);
    expect(
      streamedEvents.map((event) => (event as { type: string }).type)
    ).toEqual([
      "system_prompt",
      "assistant_text",
      "tool_call",
      "tool_result",
      "meta",
      "turn_end",
    ]);
    expect(piMock.setRuntimeApiKey).toHaveBeenCalledWith(
      "anthropic",
      "onecli-proxy-managed"
    );
    expect(piMock.createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: ["read", "bash", "edit", "write", "send_file"],
      })
    );
    expect(piMock.session.dispose).toHaveBeenCalledTimes(1);

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("registers extension tools from extensionTools", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-runner-"));
    const workspaceDir = path.join(tempDir, "workspace");
    const sessionDir = path.join(tempDir, "sessions");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(sessionDir, { recursive: true });

    proxyFetchMock.mockResolvedValue(
      Response.json({ ok: true, value: 42 }, { status: 200 })
    );
    vi.spyOn(global, "fetch").mockResolvedValue(
      Response.json({ ok: true, value: 42 }, { status: 200 })
    );

    piMock.session.prompt.mockImplementationOnce(async () => {
      piMock.session.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "done" }],
      });
    });

    await runAgent(
      createInput({
        workspaceDir,
        sessionDir,
        extensionSystemPrompts: ["Use extension tools first."],
        extensionTools: [
          {
            extensionId: "board",
            name: "scratchpad.read",
            description: "Read scratchpad",
            parameters: {
              type: "object",
              properties: {},
            },
          },
        ],
      })
    );

    const createAgentSessionCalls = piMock.createAgentSession.mock
      .calls as unknown as Array<
      [
        {
          tools: string[];
          customTools: Array<{
            name: string;
            execute: (_id: string, args: unknown) => Promise<unknown>;
          }>;
          resourceLoader: {
            options?: {
              appendSystemPrompt?: string[];
            };
          };
        },
      ]
    >;
    const createAgentSessionArgs = createAgentSessionCalls[0]?.[0];
    if (!createAgentSessionArgs) {
      throw new Error("createAgentSession was not called");
    }
    const customToolNames = createAgentSessionArgs.customTools.map(
      (tool) => tool.name
    );
    expect(customToolNames).toEqual(["scratchpad_read", "send_file"]);
    expect(createAgentSessionArgs.tools).toEqual([
      "read",
      "bash",
      "edit",
      "write",
      "scratchpad_read",
      "send_file",
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
      customToolNames.every((name) => /^[a-zA-Z0-9_-]{1,128}$/.test(name))
    ).toBe(true);
    const extensionTool = createAgentSessionArgs.customTools.find(
      (tool) => tool.name === "scratchpad_read"
    );

    expect(extensionTool).toBeDefined();
    expect(extensionTool).toMatchObject({
      promptSnippet: "Read scratchpad",
    });
    vi.mocked(global.fetch).mockResolvedValue(
      Response.json({ content: "scratch" }, { status: 200 })
    );
    await extensionTool?.execute("tool-2", {});
    expect(global.fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        href: expect.stringContaining("/internal/tools"),
      }),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "content-type": "application/json",
          "X-Agent-Id": "agent-1",
          "X-Agent-Token": "token-1",
        }),
        body: JSON.stringify({
          tool: "scratchpad.read",
          args: {},
          agentId: "agent-1",
          agentToken: "token-1",
          sessionId: "session-1",
        }),
      })
    );

    expect(
      createAgentSessionArgs.resourceLoader.options?.appendSystemPrompt
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("isolated Yoplai container"),
        "Use extension tools first.",
      ])
    );
    expect(createAgentSessionArgs.resourceLoader.options).not.toHaveProperty(
      "systemPromptOverride"
    );

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("writes large extension tool results to workspace data", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-runner-"));
    const workspaceDir = path.join(tempDir, "workspace");
    const sessionDir = path.join(tempDir, "sessions");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(sessionDir, { recursive: true });

    vi.spyOn(global, "fetch").mockResolvedValue(
      Response.json({ rows: ["x".repeat(25_000)] }, { status: 200 })
    );
    piMock.session.prompt.mockImplementationOnce(async () => {
      piMock.session.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "done" }],
      });
    });

    await runAgent(
      createInput({
        workspaceDir,
        sessionDir,
        extensionTools: [
          {
            extensionId: "gsheets",
            name: "gsheets.read_sheet",
            description: "Read sheet",
            parameters: {
              type: "object",
              properties: {},
            },
          },
        ],
      })
    );

    const createAgentSessionCalls = piMock.createAgentSession.mock
      .calls as unknown as Array<
      [
        {
          customTools: Array<{
            name: string;
            execute: (
              id: string,
              args: unknown
            ) => Promise<{
              content: Array<{ type: "text"; text: string }>;
              details: unknown;
            }>;
          }>;
        },
      ]
    >;
    const tool = createAgentSessionCalls[0]?.[0].customTools.find(
      (candidate) => candidate.name === "gsheets_read_sheet"
    );
    const result = await tool?.execute("tool-2", {});
    const text = result?.content[0]?.text ?? "";
    const match = text.match(/saved to (.+?\.json)/);
    expect(match?.[1]).toBeDefined();
    expect(text).toContain("Use that file path directly");
    expect(text).toContain("Preview:");
    expect(await fs.readFile(String(match?.[1]), "utf8")).toContain(
      "x".repeat(25_000)
    );

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("emits raw container file output requests from send_file", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-runner-"));
    const workspaceDir = path.join(tempDir, "workspace");
    const sessionDir = path.join(tempDir, "sessions");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(sessionDir, { recursive: true });

    piMock.session.prompt.mockImplementationOnce(async () => {
      piMock.session.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "done" }],
      });
    });

    const streamedEvents: unknown[] = [];
    await runAgent(createInput({ workspaceDir, sessionDir }), (event) => {
      streamedEvents.push(event);
    });

    const createAgentSessionArgs = piMock.createAgentSession.mock
      .calls[0]?.[0] as
      | {
          customTools: Array<{
            name: string;
            execute: (_id: string, args: unknown) => Promise<unknown>;
          }>;
        }
      | undefined;
    const sendFile = createAgentSessionArgs?.customTools.find(
      (tool) => tool.name === "send_file"
    );
    await sendFile?.execute("tool-3", {
      path: "/workspace/data/report.csv",
    });

    expect(streamedEvents).toContainEqual({
      type: "file_output",
      path: "/workspace/data/report.csv",
    });

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("steers follow-up IPC messages into the active session", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-runner-"));
    const workspaceDir = path.join(tempDir, "workspace");
    const sessionDir = path.join(tempDir, "sessions");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(sessionDir, { recursive: true });

    piMock.session.prompt.mockImplementationOnce(async () => {
      await sendFollowUpMessage({ message: "keep going" });
      piMock.session.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "done" }],
      });
    });

    await runAgent(createInput({ workspaceDir, sessionDir }));

    expect(piMock.session.sendUserMessage).toHaveBeenCalledWith("keep going", {
      deliverAs: "steer",
    });

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("delivers a matching envelope and suppresses ones addressed elsewhere", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-runner-"));
    const workspaceDir = path.join(tempDir, "workspace");
    const sessionDir = path.join(tempDir, "sessions");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(sessionDir, { recursive: true });

    const owner = {
      agentId: "agent-1",
      sessionId: "session-1",
      runId: "run-1",
    };
    const envelope = (
      overrides: Partial<typeof owner> & { message: string }
    ) => ({
      timestamp: 1,
      agentId: owner.agentId,
      sessionId: owner.sessionId,
      runId: owner.runId,
      ...overrides,
    });

    piMock.session.prompt.mockImplementationOnce(async () => {
      await sendFollowUpMessage(
        envelope({ message: "other session", sessionId: "session-2" }),
        owner
      );
      await sendFollowUpMessage(
        envelope({ message: "other run", runId: "run-2" }),
        owner
      );
      await sendFollowUpMessage(
        envelope({ message: "other agent", agentId: "agent-2" }),
        owner
      );
      await sendFollowUpMessage(envelope({ message: "for me" }), owner);
      piMock.session.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "done" }],
      });
    });

    await runAgent(createInput({ workspaceDir, sessionDir, runId: "run-1" }));

    expect(piMock.session.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(piMock.session.sendUserMessage).toHaveBeenCalledWith("for me", {
      deliverAs: "steer",
    });

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("still delivers legacy identity-free IPC messages", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-runner-"));
    const workspaceDir = path.join(tempDir, "workspace");
    const sessionDir = path.join(tempDir, "sessions");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(sessionDir, { recursive: true });

    piMock.session.prompt.mockImplementationOnce(async () => {
      await sendFollowUpMessage("bare string", {
        agentId: "agent-1",
        sessionId: "session-1",
        runId: "run-1",
      });
      piMock.session.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "done" }],
      });
    });

    await runAgent(createInput({ workspaceDir, sessionDir, runId: "run-1" }));

    expect(piMock.session.sendUserMessage).toHaveBeenCalledWith("bare string", {
      deliverAs: "steer",
    });

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("delivers to a container launched without a runId but still rejects other sessions", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-runner-"));
    const workspaceDir = path.join(tempDir, "workspace");
    const sessionDir = path.join(tempDir, "sessions");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(sessionDir, { recursive: true });

    // Containers from the previous image carry no runId, so ownership falls
    // back to agent + session rather than rejecting every follow-up.
    const legacyOwner = {
      agentId: "agent-1",
      sessionId: "session-1",
      runId: undefined,
    };

    piMock.session.prompt.mockImplementationOnce(async () => {
      await sendFollowUpMessage(
        {
          message: "other session",
          timestamp: 1,
          agentId: "agent-1",
          sessionId: "session-2",
          runId: "run-9",
        },
        legacyOwner
      );
      await sendFollowUpMessage(
        {
          message: "for me",
          timestamp: 1,
          agentId: "agent-1",
          sessionId: "session-1",
          runId: "run-9",
        },
        legacyOwner
      );
      piMock.session.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "done" }],
      });
    });

    await runAgent(createInput({ workspaceDir, sessionDir }));

    expect(piMock.session.sendUserMessage).toHaveBeenCalledTimes(1);
    expect(piMock.session.sendUserMessage).toHaveBeenCalledWith("for me", {
      deliverAs: "steer",
    });

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("queues IPC messages received before the Pi session is ready", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-runner-"));
    const workspaceDir = path.join(tempDir, "workspace");
    const sessionDir = path.join(tempDir, "sessions");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(sessionDir, { recursive: true });
    await sendFollowUpMessage({ message: "already queued" });

    piMock.session.prompt.mockImplementationOnce(async () => {
      piMock.session.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "done" }],
      });
    });

    await runAgent(createInput({ workspaceDir, sessionDir }));

    expect(piMock.session.sendUserMessage).toHaveBeenCalledWith(
      "already queued",
      { deliverAs: "steer" }
    );

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("publishes the Pi session under sessionDir after the runtime ends", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-runner-"));
    const workspaceDir = path.join(tempDir, "workspace");
    const sessionDir = path.join(tempDir, "sessions");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(sessionDir, { recursive: true });

    piMock.session.prompt.mockImplementationOnce(async () => {
      piMock.session.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "done" }],
      });
    });

    await runAgent(createInput({ workspaceDir, sessionDir }));

    expect(piMock.sessionManagerOpen).not.toHaveBeenCalledWith(
      path.join(sessionDir, "session-1.jsonl"),
      sessionDir
    );
    await expect(
      fs.readFile(path.join(sessionDir, "session-1.jsonl"), "utf8")
    ).resolves.toBe("");

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("includes non-image attachment paths in the prompt", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-runner-"));
    const workspaceDir = path.join(tempDir, "workspace");
    const sessionDir = path.join(tempDir, "sessions");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(sessionDir, { recursive: true });

    piMock.session.prompt.mockImplementationOnce(async () => {
      piMock.session.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        stopReason: "end_turn",
      });
    });

    await runAgent(
      createInput({
        workspaceDir,
        sessionDir,
        attachments: [
          {
            path: "/workspace/uploads/1-report.xlsx",
            filename: "report.xlsx",
            mimeType:
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            size: 1234,
          },
        ],
      })
    );

    expect(piMock.session.prompt).toHaveBeenCalledWith(
      expect.stringContaining("/workspace/uploads/1-report.xlsx"),
      undefined
    );
    expect(piMock.session.prompt).toHaveBeenCalledWith(
      expect.stringContaining("Use read/bash to inspect them"),
      undefined
    );

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("does not load image pixels when the gateway supplied image descriptions", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-runner-"));
    const workspaceDir = path.join(tempDir, "workspace");
    const sessionDir = path.join(tempDir, "sessions");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(sessionDir, { recursive: true });
    piMock.session.prompt.mockImplementationOnce(async () => {
      piMock.session.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        stopReason: "end_turn",
      });
    });
    await runAgent(
      createInput({
        workspaceDir,
        sessionDir,
        message:
          "[Image 1 description — generated from, not the original image]",
        attachments: [
          { path: "/workspace/uploads/missing.png", mimeType: "image/png" },
        ],
        imageInputSupported: false,
      })
    );
    expect(piMock.session.prompt).toHaveBeenCalledWith(
      expect.stringContaining("generated from, not the original image"),
      undefined
    );
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("appends channel context to the system prompt and emits full/system context history", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-runner-"));
    const workspaceDir = path.join(tempDir, "workspace");
    const sessionDir = path.join(tempDir, "sessions");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(sessionDir, { recursive: true });

    piMock.session.prompt.mockImplementationOnce(async () => {
      piMock.session.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "done" }],
      });
    });

    const output = await runAgent(
      createInput({
        workspaceDir,
        sessionDir,
        context: {
          kind: "slack",
          blocks: [
            {
              type: "metadata",
              channel: "slack",
              place: "#projects / thread:1.1",
              conversationType: "thread_reply",
              sender: "alice",
            },
            { type: "channel_name", name: "projects" },
          ],
        },
      })
    );

    const createAgentSessionArgs = piMock.createAgentSession.mock
      .calls[0]?.[0] as
      | {
          resourceLoader: {
            options?: {
              appendSystemPrompt?: string[];
            };
          };
        }
      | undefined;
    expect(
      createAgentSessionArgs?.resourceLoader.options?.appendSystemPrompt
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("[CHANNEL CONTEXT]"),
        expect.stringContaining("channel: slack"),
      ])
    );
    expect(piMock.session.prompt).toHaveBeenCalledWith(
      expect.stringContaining("[CHANNEL CONTEXT]"),
      undefined
    );
    expect(
      output.history?.map((event) => (event as { type: string }).type)
    ).toContain("system_prompt");
    expect(
      output.history?.map((event) => (event as { type: string }).type)
    ).toContain("system_context");
    expect(output.history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "system_prompt",
          text: expect.stringContaining("[CHANNEL CONTEXT]"),
        }),
      ])
    );

    await fs.rm(tempDir, { recursive: true, force: true });
  });
});

function createInput(paths: {
  workspaceDir: string;
  sessionDir: string;
  extensionSystemPrompts?: ContainerInput["extensionSystemPrompts"];
  extensionTools?: ContainerInput["extensionTools"];
  context?: ContainerInput["context"];
  attachments?: ContainerInput["attachments"];
  message?: string;
  imageInputSupported?: boolean;
  runId?: string;
  retry?: ContainerInput["retry"];
}): ContainerInput {
  return {
    agentId: "agent-1",
    sessionId: "session-1",
    runId: paths.runId,
    message: paths.message ?? "hello",
    workspaceDir: paths.workspaceDir,
    sessionDir: paths.sessionDir,
    ipcDir: "/ipc",
    gatewayUrl: "http://gateway:3000",
    agentToken: "token-1",
    extensionSystemPrompts: paths.extensionSystemPrompts,
    extensionTools: paths.extensionTools,
    context: paths.context,
    attachments: paths.attachments,
    imageInputSupported: paths.imageInputSupported,
    retry: paths.retry,
    sdkConfig: {
      sdk: "pi",
      model: {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      },
    },
  };
}
