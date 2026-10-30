import { describe, it, expect } from "vitest";
import {
  AgentConfigSchema,
  AgentContextSchema,
  ContainerFileOutputRequestSchema,
  ContainerInputSchema,
  ContainerOutputSchema,
  ContainerRunnerProtocolEventSchema,
  GatewayConfigSchema,
  HistoryEventSchema,
  MultiUserConfigSchema,
  ProjectsOrchestratorConfigSchema,
  ScheduleSchema,
  StreamEventSchema,
} from "./types.js";

describe("multi-user legacy config compatibility", () => {
  it("loads the retired auto-join key without enabling enrollment", () => {
    expect(MultiUserConfigSchema.parse({ enabled: true, emailAndPassword: { enabled: true }, sessionSecret: "legacy-config-secret", autoJoinPublicTeams: true })).toEqual({
      enabled: true, emailAndPassword: { enabled: true }, sessionSecret: "legacy-config-secret",
    });
  });
});

describe("Mattermost config schemas", () => {
  const agent = {
    id: "main",
    name: "Main",
    workspace: "~/main",
    model: { provider: "anthropic", model: "claude" },
  };

  it("accepts a root bot with routed channels and DMs, and a per-agent bot", () => {
    const config = GatewayConfigSchema.parse({
      version: 2,
      agents: [
        {
          ...agent,
          mattermost: {
            url: "https://chat.example.test",
            token: "$env:MATTERMOST_BOT_TOKEN",
            channels: { chan1: { requireMention: false } },
            dm: { enabled: true, allowFrom: ["alice"] },
          },
        },
      ],
      extensions: {
        mattermost: {
          enabled: true,
          url: "https://chat.example.test",
          token: "$env:MATTERMOST_BOT_TOKEN",
          channels: { chan1: { agent: "main", requireMention: true, threadUnlock: true } },
          dm: { enabled: true, agent: "main" },
          acknowledgeMessages: false,
        },
      },
    });
    expect(config.extensions?.mattermost?.channels?.chan1.agent).toBe("main");
    expect(config.agents[0].mattermost?.dm?.allowFrom).toEqual(["alice"]);
  });

  it("rejects a non-http url and a channel without an agent", () => {
    const base = { version: 2, agents: [agent] };
    expect(
      GatewayConfigSchema.safeParse({
        ...base,
        extensions: { mattermost: { url: "ftp://chat.example.test", token: "t" } },
      }).success
    ).toBe(false);
    expect(
      GatewayConfigSchema.safeParse({
        ...base,
        extensions: {
          mattermost: { url: "https://chat.example.test", token: "t", channels: { c: {} } },
        },
      }).success
    ).toBe(false);
  });
});

describe("bare human-chat extension key", () => {
  it("parses `human-chat:` (null) as an empty block", () => {
    const parsed = AgentConfigSchema.parse({
      id: "main",
      name: "Main",
      workspace: "~/main",
      model: { provider: "anthropic", model: "claude" },
      extensions: { "human-chat": null },
    });
    expect(parsed.extensions).toEqual({ "human-chat": {} });
  });
});

describe("ScheduleSchema", () => {
  it("requires exactly one schedule kind", () => {
    expect(
      ScheduleSchema.safeParse({ cron: "0 9 * * *", tz: "UTC" }).success
    ).toBe(true);
    expect(
      ScheduleSchema.safeParse({ runAt: "2026-05-11T09:00:00Z" }).success
    ).toBe(true);
    expect(ScheduleSchema.safeParse({}).success).toBe(false);
    expect(
      ScheduleSchema.safeParse({
        cron: "0 9 * * *",
        tz: "UTC",
        runAt: "2026-05-11T09:00:00Z",
      }).success
    ).toBe(false);
    expect(
      ScheduleSchema.safeParse({
        runAt: "2026-05-11T09:00:00Z",
        startAt: "2026-05-01T09:00:00Z",
      }).success
    ).toBe(false);
    expect(ScheduleSchema.safeParse({ runAt: "tomorrow" }).success).toBe(false);
  });
});

describe("AgentConfigSchema openclaw model handling", () => {
  it("accepts a complete fallback model and rejects incomplete identities", () => {
    expect(
      AgentConfigSchema.parse({
        id: "fallback-agent",
        name: "Fallback Agent",
        workspace: "~/agents/fallback",
        model: { provider: "anthropic", model: "claude" },
        fallback_model: { provider: "openai", model: "gpt-5" },
      }).fallback_model
    ).toEqual({ provider: "openai", model: "gpt-5" });
    expect(
      AgentConfigSchema.safeParse({
        id: "fallback-agent",
        name: "Fallback Agent",
        workspace: "~/agents/fallback",
        model: { provider: "anthropic", model: "claude" },
        fallback_model: { provider: "openai" },
      }).success
    ).toBe(false);
  });

  it("accepts reasoning as lead-agent thinking config", () => {
    const result = AgentConfigSchema.parse({
      id: "reasoning-agent",
      name: "Reasoning Agent",
      workspace: "~/agents/reasoning",
      model: { provider: "anthropic", model: "claude-sonnet-4" },
      reasoning: "max",
    });

    expect(result.reasoning).toBe("max");
  });

  it("accepts agent-level slack channels without an agent field", () => {
    const result = AgentConfigSchema.safeParse({
      id: "slack-agent",
      name: "Slack Agent",
      workspace: "~/agents/slack",
      model: { provider: "anthropic", model: "claude" },
      slack: {
        token: "xoxb-test",
        appToken: "xapp-test",
        channels: { C0123456789: { requireMention: false } },
      },
    });

    expect(result.success).toBe(true);
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

  it("parses reflect config shapes and rejects provider without model", () => {
    const base = {
      id: "r",
      name: "R",
      workspace: "~/agents/r",
      model: { provider: "openai", model: "gpt" },
    };
    expect(AgentConfigSchema.parse({ ...base, reflect: true }).reflect).toBe(true);
    expect(
      AgentConfigSchema.parse({ ...base, reflect: { cadence: 5 } }).reflect
    ).toMatchObject({ enabled: true, cadence: 5 });
    expect(
      AgentConfigSchema.safeParse({ ...base, reflect: { provider: "x" } }).success
    ).toBe(false);
  });

  it("accepts dream shorthand and validates model overrides", () => {
    expect(
      AgentConfigSchema.parse({
        id: "dreamer",
        name: "Dreamer",
        workspace: "~/agents/dreamer",
        model: { provider: "openai", model: "gpt" },
        dream: true,
      }).dream
    ).toBe(true);
    expect(
      AgentConfigSchema.parse({
        id: "dreamer",
        name: "Dreamer",
        workspace: "~/agents/dreamer",
        model: { provider: "openai", model: "gpt" },
        dream: { provider: "anthropic", model: "claude" },
      }).dream
    ).toMatchObject({ enabled: true, time: "00:00" });
    expect(
      AgentConfigSchema.safeParse({
        id: "dreamer",
        name: "Dreamer",
        workspace: "~/agents/dreamer",
        model: { provider: "openai", model: "gpt" },
        dream: { provider: "anthropic" },
      }).success
    ).toBe(false);
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
  it("validates the complete agent context protocol shape", () => {
    expect(AgentContextSchema.safeParse({ kind: "discord" }).success).toBe(
      false
    );
    expect(
      AgentContextSchema.safeParse({
        kind: "telegram",
        blocks: [
          {
            type: "metadata",
            channel: "telegram",
            place: "direct message / alice",
            conversationType: "direct_message",
            sender: "alice",
          },
        ],
      }).success
    ).toBe(true);
    expect(AgentContextSchema.safeParse({ kind: "unknown" }).success).toBe(
      false
    );
    expect(
      AgentContextSchema.safeParse({
        kind: "mattermost",
        blocks: [
          {
            type: "metadata",
            channel: "mattermost",
            place: "#support / thread root1",
            conversationType: "thread_reply",
            sender: "@alice",
            conversationId: "root1",
          },
          { type: "channel_name", name: "support" },
          { type: "thread_starter", author: "@bob", content: "hi", timestamp: 0 },
        ],
      }).success
    ).toBe(true);
  });

  it("parses container input and output", () => {
    const input = ContainerInputSchema.parse({
      context: { kind: "web", project: { instructions: "Read the files", filesPath: "/project-files", files: "notes.txt\nUseful notes" } },
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

    expect(input.context?.project).toEqual({ instructions: "Read the files", filesPath: "/project-files", files: "notes.txt\nUseful notes" });
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
