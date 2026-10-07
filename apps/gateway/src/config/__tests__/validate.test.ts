import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineToolExtension, GatewayConfigSchema, type Extension } from "@yoplai/shared";
import { loadExtensions } from "../../extensions/registry.js";
import {
  logComponentSummary,
  prepareStartupConfig,
  resolveStartupConfig,
  validateStartupConfig,
} from "../validate.js";

describe("startup validation", () => {
  it("keeps a personal-only token extension enabled while checking shared settings", async () => {
    const extension = defineToolExtension({ id: "personal", displayName: "Personal", description: "fixture", requiredSecrets: ["apiKey"], configSchema: z.object({ apiKey: z.string().min(1), baseUrl: z.string().url() }), createTools: () => [] });
    const config = GatewayConfigSchema.parse({ version: 2, agents: [{ id: "main", name: "Main", workspace: "~/agents/main", model: { provider: "anthropic", model: "claude" }, extensions: { personal: { enabled: true, baseUrl: "https://fixture.test" } } }] });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const prepared = await prepareStartupConfig(config, [extension]);
      expect(prepared.summary.loaded).toEqual(["personal"]);
      expect(prepared.resolvedConfig.agents[0].extensions?.personal).toEqual({ enabled: true, baseUrl: "https://fixture.test" });
      expect(logged).not.toHaveBeenCalled();
      config.agents[0].extensions!.personal = { enabled: true, baseUrl: "invalid" };
      await prepareStartupConfig(config, [extension]);
      expect(logged).toHaveBeenCalledOnce();
    } finally { logged.mockRestore(); }
  });
  it("warns for missing agent extensions without failing startup", async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.join(" "));
    };

    try {
      const config = GatewayConfigSchema.parse({
        version: 2,
        extensionsPath: await mkdtemp(path.join(tmpdir(), "yoplai-empty-extensions-")),
        agents: [
          {
            id: "main",
            name: "Main",
            workspace: "~/agents/main",
            model: { provider: "anthropic", model: "claude" },
            extensions: {
              missing: {
                enabled: true,
              },
            },
          },
        ],
      });

      const extensions = await loadExtensions(config);
      // Canvas is a core extension; optional extensions must be opted in.
      await expect(validateStartupConfig(config, extensions)).resolves.toEqual({
        loaded: ["canvas"],
        skipped: [],
      });
      expect(
        warnings.filter((warning) => warning.startsWith("[extensions]"))
      ).toEqual([
        '[extensions] agent "main" references unknown extension "missing"',
      ]);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("rejects duplicate agent ids", async () => {
    const config = GatewayConfigSchema.parse({
      version: 2,
      agents: [
        {
          id: "main",
          name: "Main",
          workspace: "~/agents/main",
          model: { provider: "anthropic", model: "claude" },
        },
        {
          id: "main",
          name: "Main 2",
          workspace: "~/agents/main-2",
          model: { provider: "anthropic", model: "claude" },
        },
      ],
      extensions: {
        scheduler: { enabled: true },
      },
    });

    const extensions = await loadExtensions(config);
    await expect(validateStartupConfig(config, extensions)).rejects.toThrow(
      'Duplicate agent id "main"'
    );
  });

  it("rejects unknown component agent references", async () => {
    const config = GatewayConfigSchema.parse({
      version: 2,
      agents: [
        {
          id: "main",
          name: "Main",
          workspace: "~/agents/main",
          model: { provider: "anthropic", model: "claude" },
        },
      ],
      extensions: {
        discord: {
          enabled: true,
          token: "discord-token",
          channels: {
            "123": { agent: "missing" },
          },
        },
      },
    });

    const extensions = await loadExtensions(config);
    await expect(validateStartupConfig(config, extensions)).rejects.toThrow(
      'references unknown agent "missing"'
    );
  });

  it("returns loaded and skipped component summary", async () => {
    const config = GatewayConfigSchema.parse({
      version: 2,
      extensionsPath: await mkdtemp(path.join(tmpdir(), "yoplai-empty-extensions-")),
      agents: [
        {
          id: "main",
          name: "Main",
          workspace: "~/agents/main",
          model: { provider: "anthropic", model: "claude" },
        },
      ],
      extensions: {
        scheduler: { enabled: true },
        heartbeat: { enabled: true },
      },
    });

    const extensions = await loadExtensions(config);
    await expect(validateStartupConfig(config, extensions)).resolves.toEqual({
      loaded: ["canvas", "scheduler", "heartbeat"],
      skipped: [],
    });
  });

  it("logs component summary", () => {
    const info: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      info.push(args.join(" "));
    };

    try {
      logComponentSummary({ loaded: ["scheduler"], skipped: ["discord"] });
    } finally {
      console.log = original;
    }

    expect(info).toHaveLength(2);
  });

  it("resolves agent $env: references from agent-local .env", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "yoplai-agent-env-"));
    await writeFile(
      path.join(dir, ".env"),
      "ONECLI_TOKEN=agent-onecli\nSLACK_BOT_TOKEN=agent-slack\nSLACK_APP_TOKEN=agent-app\nIRC_PASSWORD=agent-irc\nIRC_NICKSERV_PASSWORD=agent-nickserv\n"
    );

    const config = GatewayConfigSchema.parse({
      version: 2,
      agents: [
        {
          id: "main",
          name: "Main",
          workspace: dir,
          model: { provider: "anthropic", model: "claude" },
          onecliToken: "$env:ONECLI_TOKEN",
          slack: {
            token: "$env:SLACK_BOT_TOKEN",
            appToken: "$env:SLACK_APP_TOKEN",
          },
          irc: {
            host: "irc.example.com",
            nick: "main-bot",
            password: "$env:IRC_PASSWORD",
            nickservPassword: "$env:IRC_NICKSERV_PASSWORD",
          },
        },
      ],
      extensions: {},
    });

    await expect(resolveStartupConfig(config)).resolves.toMatchObject({
      agents: [
        expect.objectContaining({
          onecliToken: "agent-onecli",
          slack: expect.objectContaining({
            token: "agent-slack",
            appToken: "agent-app",
          }),
          irc: expect.objectContaining({
            password: "agent-irc",
            nickservPassword: "agent-nickserv",
          }),
        }),
      ],
    });
  });

  it("returns a resolved runtime config", async () => {
    process.env.TEST_RUNTIME_SECRET = "resolved-value";

    const config = GatewayConfigSchema.parse({
      version: 2,
      agents: [
        {
          id: "main",
          name: "Main",
          workspace: "~/agents/main",
          model: { provider: "anthropic", model: "claude" },
        },
      ],
      extensions: {
        discord: {
          enabled: true,
          token: "$env:TEST_RUNTIME_SECRET",
          channels: {
            "123": { agent: "main" },
          },
        },
      },
    });

    await expect(resolveStartupConfig(config)).resolves.toMatchObject({
      extensions: {
        discord: expect.objectContaining({
          token: "resolved-value",
        }),
      },
    });

    delete process.env.TEST_RUNTIME_SECRET;
  });

  it("logs an error but starts when an extension rejects agent config", async () => {
    const config = GatewayConfigSchema.parse({
      version: 2,
      agents: [
        {
          id: "main",
          name: "Main",
          workspace: "~/agents/main",
          model: { provider: "anthropic", model: "claude" },
          extensions: {
            sample: {
              enabled: true,
            },
          },
        },
      ],
      extensions: {},
    });
    const extension: Extension = {
      id: "sample",
      displayName: "Sample",
      description: "Sample extension",
      dependencies: [],
      configSchema: GatewayConfigSchema,
      routePrefixes: [],
      validateConfig: () => ({ valid: true, errors: [] }),
      validateAgentConfigs: () => ({
        valid: false,
        errors: ['Extension "sample" for agent "main" missing required secret "apiKey"'],
      }),
      registerRoutes: () => undefined,
      start: async () => undefined,
      stop: async () => undefined,
      capabilities: () => [],
    };

    const logged: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.join(" "));
    };
    try {
      await expect(prepareStartupConfig(config, [extension])).resolves.toBeDefined();
    } finally {
      console.error = originalError;
    }
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0]!)).toMatchObject({
      level: "error",
      msg: "Extension config invalid; disabled for agent",
      extensionId: "sample",
      message: 'Extension "sample" for agent "main" missing required secret "apiKey"',
    });
  });
});
