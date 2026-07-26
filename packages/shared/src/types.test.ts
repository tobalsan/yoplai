import { describe, it, expect } from "vitest";
import {
  AgentConfigSchema,
  ContainerFileOutputRequestSchema,
  ContainerInputSchema,
  ContainerOutputSchema,
  ContainerRunnerProtocolEventSchema,
  GatewayConfigSchema,
  HistoryEventSchema,
  ProjectsOrchestratorConfigSchema,
  StreamEventSchema,
} from "./types.js";

describe("AgentConfigSchema openclaw model handling", () => {
  it("accepts reasoning as lead-agent thinking config", () => {
    const result = AgentConfigSchema.parse({
      id: "reasoning-agent",
      name: "Reasoning Agent",
      workspace: "~/agents/reasoning",
      model: { provider: "anthropic", model: "claude-sonnet-4" },
      reasoning: "high",
    });

    expect(result.reasoning).toBe("high");
  });

  it("rejects invalid reasoning values", () => {
    const result = AgentConfigSchema.safeParse({
      id: "reasoning-agent",
      name: "Reasoning Agent",
      workspace: "~/agents/reasoning",
      model: { provider: "anthropic", model: "claude-sonnet-4" },
      reasoning: "insane",
    });

    expect(result.success).toBe(false);
  });

  it("allows openclaw agents to omit model", () => {
    const result = AgentConfigSchema.safeParse({
      id: "openclaw-agent",
      name: "OpenClaw Agent",
      workspace: "~/agents/openclaw",
      sdk: "openclaw",
    });

    expect(result.success).toBe(true);
  });

  it("requires model for non-openclaw SDKs", () => {
    const result = AgentConfigSchema.safeParse({
      id: "pi-agent",
      name: "Pi Agent",
      workspace: "~/agents/pi",
      sdk: "pi",
    });

    expect(result.success).toBe(false);
  });

  it("applies default model when openclaw model is omitted", () => {
    const result = AgentConfigSchema.parse({
      id: "openclaw-agent",
      name: "OpenClaw Agent",
      workspace: "~/agents/openclaw",
      sdk: "openclaw",
    });

    expect(result.model).toEqual({ provider: "openclaw", model: "unknown" });
  });

  it("accepts openclaw sessionMode dedicated", () => {
    const result = AgentConfigSchema.safeParse({
      id: "openclaw-agent",
      name: "OpenClaw Agent",
      workspace: "~/agents/openclaw",
      sdk: "openclaw",
      openclaw: {
        token: "token",
        sessionMode: "dedicated",
      },
    });

    expect(result.success).toBe(true);
  });

  it("accepts description and avatar fields", () => {
    const result = AgentConfigSchema.safeParse({
      id: "test-agent",
      name: "Test Agent",
      description: "A helpful assistant",
      avatar: "🤖",
      workspace: "~/agents/test",
      model: { provider: "anthropic", model: "claude-sonnet-4" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.description).toBe("A helpful assistant");
      expect(result.data.avatar).toBe("🤖");
    }
  });

  it("accepts agent-level webhooks config", () => {
    const result = AgentConfigSchema.parse({
      id: "webhook-agent",
      name: "Webhook Agent",
      workspace: "~/agents/webhook",
      model: { provider: "anthropic", model: "claude-sonnet-4" },
      webhooks: {
        notion: {
          prompt: "./webhooks/notion.md",
        },
      },
    });

    expect(result.webhooks?.notion.langfuseTracing).toBe(true);
    expect(result.webhooks?.notion.prompt).toBe("./webhooks/notion.md");
    expect(result.webhooks?.notion.maxPayloadSize).toBe(1048576);
  });

  it("accepts openclaw sessionMode fixed", () => {
    const result = AgentConfigSchema.safeParse({
      id: "openclaw-agent",
      name: "OpenClaw Agent",
      workspace: "~/agents/openclaw",
      sdk: "openclaw",
      openclaw: {
        token: "token",
        sessionMode: "fixed",
      },
    });

    expect(result.success).toBe(true);
  });
});

describe("ProjectsOrchestratorConfigSchema", () => {
  it("accepts done-ping notify channel", () => {
    const result = ProjectsOrchestratorConfigSchema.parse({
      enabled: true,
      notify_channel: "ops",
    });

    expect(result.notify_channel).toBe("ops");
  });
});

describe("sandbox config schemas", () => {
  it("applies per-agent sandbox defaults", () => {
    const result = AgentConfigSchema.parse({
      id: "sandbox-agent",
      name: "Sandbox Agent",
      workspace: "~/agents/sandbox",
      model: { provider: "anthropic", model: "claude" },
      sandbox: {},
    });

    expect(result.sandbox).toMatchObject({
      enabled: false,
      image: "yoplai-agent:latest",
      memory: "2g",
      cpus: 1,
      idleTimeout: 300,
      maxRunTime: 1800,
      workspaceWritable: false,
    });
  });

  it("keeps legacy timeout as the hard runtime when maxRunTime is absent", () => {
    const result = AgentConfigSchema.parse({
      id: "sandbox-agent",
      name: "Sandbox Agent",
      workspace: "~/agents/sandbox",
      model: { provider: "anthropic", model: "claude" },
      sandbox: { timeout: 1200 },
    });

    expect(result.sandbox).toMatchObject({
      timeout: 1200,
      idleTimeout: 300,
      maxRunTime: 1200,
    });
  });

  it("applies global sandbox defaults", () => {
    const result = GatewayConfigSchema.parse({
      agents: [
        {
          id: "sandbox-agent",
          name: "Sandbox Agent",
          workspace: "~/agents/sandbox",
          model: { provider: "anthropic", model: "claude" },
        },
      ],
      sandbox: {
        network: {},
        mountAllowlist: {
          allowedRoots: ["~/agents"],
        },
      },
    });

    expect(result.sandbox?.network).toEqual({
      name: "yoplai-agents",
      internal: true,
    });
    expect(result.sandbox?.mountAllowlist?.blockedPatterns).toEqual([
      ".ssh",
      ".gnupg",
      ".aws",
      ".env",
    ]);
  });
});

describe("Projects orchestrator config", () => {
  it("defaults ready_to_merge concurrency to two", () => {
    const result = GatewayConfigSchema.parse({
      agents: [],
      extensions: {
        projects: {
          orchestrator: {
            statuses: {
              ready_to_merge: { profile: "Merger" },
            },
          },
        },
      },
    });

    expect(
      result.extensions?.projects?.orchestrator?.statuses.ready_to_merge
        ?.max_concurrent
    ).toBe(2);
  });

  it("accepts legacy top-level Merger profiles", () => {
    const result = GatewayConfigSchema.safeParse({
      agents: [],
      subagents: [
        {
          name: "Merger",
          cli: "codex",
          model: "gpt-5.5",
          reasoning: "medium",
          type: "merger",
          runMode: "worktree",
        },
      ],
    });

    expect(result.success).toBe(true);
  });
});

describe("container IPC schemas", () => {
  it("parses container input and output", () => {
    const input = ContainerInputSchema.parse({
      agentId: "sandbox-agent",
      sessionId: "session-1",
      message: "hello",
      workspaceDir: "/workspace",
      sessionDir: "/sessions",
      ipcDir: "/workspace/ipc",
      gatewayUrl: "http://gateway:3000",
      agentToken: "token",
      extensionSystemPrompts: ["Use extension tools when needed."],
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
      sdkConfig: {
        sdk: "pi",
        model: { provider: "anthropic", model: "claude" },
      },
    });
    const output = ContainerOutputSchema.parse({ text: "hello back" });

    expect(input.workspaceDir).toBe("/workspace");
    expect(output.text).toBe("hello back");
  });

  it("keeps raw file output separate from stream downloads and history files", () => {
    expect(
      ContainerFileOutputRequestSchema.parse({
        type: "file_output",
        path: "/workspace/data/report.csv",
      })
    ).toEqual({ type: "file_output", path: "/workspace/data/report.csv" });

    expect(
      StreamEventSchema.parse({
        type: "file_output",
        fileId: "file-1",
        filename: "report.csv",
        mimeType: "text/csv",
        size: 12,
      })
    ).toMatchObject({ fileId: "file-1" });

    expect(
      HistoryEventSchema.safeParse({
        type: "file_output",
        fileId: "file-1",
        filename: "report.csv",
        mimeType: "text/csv",
        size: 12,
        timestamp: 1,
      }).success
    ).toBe(false);
    expect(
      HistoryEventSchema.parse({
        type: "assistant_file",
        fileId: "file-1",
        filename: "report.csv",
        mimeType: "text/csv",
        size: 12,
        direction: "outbound",
        timestamp: 1,
      })
    ).toMatchObject({ type: "assistant_file", fileId: "file-1" });
  });

  it("validates container runner protocol events", () => {
    expect(
      ContainerRunnerProtocolEventSchema.parse({
        type: "file_output",
        path: "/workspace/data/report.csv",
      })
    ).toMatchObject({ type: "file_output" });

    expect(
      ContainerRunnerProtocolEventSchema.parse({
        type: "assistant_text",
        text: "hello",
        timestamp: 1,
      })
    ).toMatchObject({ type: "assistant_text" });

    expect(
      ContainerRunnerProtocolEventSchema.safeParse({
        type: "assistant_text",
        text: "hello",
      }).success
    ).toBe(false);
  });
});
