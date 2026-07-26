import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GatewayConfigSchema, type Extension } from "@yoplai/shared";
import { loadExtensions } from "../../extensions/registry.js";
import {
  logComponentSummary,
  prepareStartupConfig,
  resolveStartupConfig,
  validateStartupConfig,
} from "../validate.js";

describe("startup validation", () => {
  it("warns for missing agent extensions without failing startup", async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.join(" "));
    };

    try {
      const config = GatewayConfigSchema.parse({
        version: 2,
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
      // no extensions configured — nothing loads (extensions must be opted in)
      await expect(validateStartupConfig(config, extensions)).resolves.toEqual({
        loaded: [],
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
      loaded: ["scheduler", "heartbeat"],
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

  it("fails early when an extension rejects agent config", async () => {
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

    await expect(prepareStartupConfig(config, [extension])).rejects.toThrow(
      'Extension "sample" for agent "main" missing required secret "apiKey"'
    );
  });
});
