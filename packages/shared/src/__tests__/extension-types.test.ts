import { describe, expect, it } from "vitest";
import {
  CapabilitiesResponseSchema,
  ExtensionsConfigSchema,
  DiscordExtensionConfigSchema,
  LangfuseExtensionConfigSchema,
  IrcAgentConfigSchema,
  IrcExtensionConfigSchema,
  AgentYamlConfigSchema,
  TelegramExtensionConfigSchema,
  GatewayConfigSchema,
  type Extension,
  type ExtensionContext,
  type ValidationResult,
} from "../types.js";

describe("extension config schemas", () => {
  it("parses discord extension config", () => {
    const result = DiscordExtensionConfigSchema.parse({
      token: "$env:DISCORD_TOKEN",
      channels: {
        "123": { agent: "main" },
      },
      dm: { enabled: true, agent: "main" },
      historyLimit: 20,
      replyToMode: "off",
    });

    expect(result.channels?.["123"]?.agent).toBe("main");
    expect(result.dm?.agent).toBe("main");
  });

  it("rejects invalid discord extension config", () => {
    const result = DiscordExtensionConfigSchema.safeParse({
      token: "$env:DISCORD_TOKEN",
      historyLimit: -1,
    });

    expect(result.success).toBe(false);
  });

  it("parses top-level agent IRC config without route agent fields", () => {
    const result = AgentYamlConfigSchema.parse({
      id: "main",
      name: "Main",
      model: { provider: "anthropic", model: "claude" },
      irc: {
        host: "irc.example.com",
        nick: "main-bot",
        password: "$env:IRC_PASSWORD",
        channels: { "#team": { mode: "reply-all" } },
        dm: { enabled: true, allowFrom: ["alice"], debounceMs: 10 },
        debounceMs: 1500,
      },
    });
    expect(result.irc?.channels["#team"]?.mode).toBe("reply-all");
    expect(result.irc?.password).toBe("$env:IRC_PASSWORD");
    expect(result.irc?.debounceMs).toBe(1500);
    expect(IrcAgentConfigSchema.safeParse({ host: "irc", nick: "bot", channels: { "#team": { agent: "other" } } }).success).toBe(false);
  });

  it("parses top-level debounceMs on the shared irc extension config", () => {
    const result = IrcExtensionConfigSchema.parse({
      host: "irc.example.com",
      nick: "yoplai",
      channels: { "#team": { agent: "main", mode: "mention-only" } },
      debounceMs: 1500,
    });
    expect(result.debounceMs).toBe(1500);
  });

  it("parses telegram extension config with an $env token", () => {
    const result = TelegramExtensionConfigSchema.parse({
      enabled: true,
      token: "$env:TELEGRAM_TOKEN",
    });
    expect(result.token).toBe("$env:TELEGRAM_TOKEN");
    expect(result.enabled).toBe(true);
  });

  it("wires telegram into the extension map", () => {
    const result = ExtensionsConfigSchema.parse({
      telegram: { token: "$env:TELEGRAM_TOKEN" },
    });
    expect(result?.telegram?.token).toBe("$env:TELEGRAM_TOKEN");
  });

  it("parses and rejects langfuse extension config", () => {
    const valid = LangfuseExtensionConfigSchema.parse({
      enabled: true,
      baseUrl: "https://cloud.langfuse.com",
      publicKey: "$env:LANGFUSE_PUBLIC_KEY",
      secretKey: "$env:LANGFUSE_SECRET_KEY",
      flushAt: 15,
      flushInterval: 10000,
      debug: false,
      env: "test",
    });

    const invalid = LangfuseExtensionConfigSchema.safeParse({
      enabled: true,
      debug: "no",
    });

    expect(valid.flushAt).toBe(15);
    expect(valid.env).toBe("test");
    expect(invalid.success).toBe(false);
  });

  it("parses extension map", () => {
    const result = ExtensionsConfigSchema.parse({
      scheduler: { enabled: true },
      heartbeat: { enabled: true },
      projects: { root: "~/projects" },
      subagents: {
        profiles: [{ name: "Worker", cli: "codex" }],
      },
      orchestrator: {
        projectsRoot: "~/projects",
        projects: ["~/projects/yoplai"],
      },
      langfuse: {
        enabled: true,
        publicKey: "$env:LANGFUSE_PUBLIC_KEY",
        secretKey: "$env:LANGFUSE_SECRET_KEY",
      },
    });

    if (!result) {
      throw new Error("Expected extensions config");
    }
    expect(result.scheduler?.enabled).toBe(true);
    expect(result.projects?.root).toBe("~/projects");
    expect(result.orchestrator?.projectsRoot).toBe("~/projects");
    expect(result.subagents?.profiles[0]?.cli).toBe("codex");
    expect(result.langfuse?.enabled).toBe(true);
  });

  it("parses configured subagent templates with cli", () => {
    const result = GatewayConfigSchema.parse({
      agents: [],
      subagents: [
        {
          name: "Worker",
          cli: "codex",
          model: "gpt-5.3-codex",
          reasoning: "medium",
          type: "worker",
          runMode: "worktree",
        },
      ],
    });

    expect(result.subagents?.[0]?.cli).toBe("codex");
  });

  it("parses capabilities response", () => {
    const result = CapabilitiesResponseSchema.parse({
      version: 2,
      extensions: { scheduler: true, projects: false },
      agents: ["main"],
      multiUser: false,
      agentFab: false,
    });

    expect(result.extensions.scheduler).toBe(true);
  });

  it("exports extension contracts", async () => {
    const validation: ValidationResult = { valid: true, errors: [] };
    const ctx = {} as ExtensionContext;
    const extension: Extension = {
      id: "scheduler",
      displayName: "Scheduler",
      description: "Runs schedules",
      dependencies: [],
      configSchema: ExtensionsConfigSchema,
      routePrefixes: ["/api/schedules"],
      validateConfig: () => validation,
      registerRoutes: () => undefined,
      start: async (_context) => {
        void _context;
      },
      stop: async () => undefined,
      capabilities: () => ["schedules"],
      getAgentTools: () => [
        {
          name: "sample.tool",
          description: "Sample tool",
          parameters: { type: "object", properties: {} },
          execute: () => ({ ok: true }),
        },
      ],
    };

    expect(extension.validateConfig({})).toEqual(validation);
    const tools = await extension.getAgentTools?.({} as never);
    expect(tools?.[0]?.name).toBe("sample.tool");
    expect(ctx).toBeDefined();
  });
});
