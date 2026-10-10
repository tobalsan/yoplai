import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { GatewayConfigSchema, getOAuthProvider, registerOAuthProvider, resetOAuthProviders, type Extension } from "@yoplai/shared";
import {
  getBuiltInExtensionRegistrations,
  getLoadedExtensions,
  getKnownExtensionRouteMetadata,
  isExtensionLoaded,
  loadExtensions,
  reloadExtensions,
  setExtensionActivator,
  topoSort,
} from "./registry.js";
import { ExtensionRuntime } from "./runtime.js";

const require = createRequire(import.meta.url);

describe("extension registry", () => {
  it("sorts extensions by dependency order", () => {
    const result = topoSort([
      {
        id: "heartbeat",
        displayName: "Heartbeat",
        description: "Heartbeat",
        dependencies: ["scheduler"],
        configSchema: GatewayConfigSchema,
        routePrefixes: ["/api/agents/:id/heartbeat"],
        validateConfig: () => ({ valid: true, errors: [] }),
        registerRoutes: () => undefined,
        start: async () => undefined,
        stop: async () => undefined,
        capabilities: () => [],
      },
      {
        id: "scheduler",
        displayName: "Scheduler",
        description: "Scheduler",
        dependencies: [],
        configSchema: GatewayConfigSchema,
        routePrefixes: ["/api/schedules"],
        validateConfig: () => ({ valid: true, errors: [] }),
        registerRoutes: () => undefined,
        start: async () => undefined,
        stop: async () => undefined,
        capabilities: () => [],
      },
    ] as Extension[]);

    expect(result.filter((extension) => extension.id !== "mcp").map((extension) => extension.id)).toEqual([
      "scheduler",
      "heartbeat",
    ]);
  });

  it("loads enabled extensions and stores them globally", async () => {
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

    const result = await loadExtensions(config);

    expect(result.filter((extension) => extension.id !== "mcp").map((extension) => extension.id)).toEqual([
      "taskLifecycle",
      "capabilityDiscovery",
      "canvas",
      "scheduler",
      "heartbeat",
    ]);
    expect(getLoadedExtensions().filter((extension) => extension.id !== "mcp").map((extension) => extension.id)).toEqual([
      "taskLifecycle",
      "capabilityDiscovery",
      "canvas",
      "scheduler",
      "heartbeat",
    ]);
    expect(isExtensionLoaded("scheduler")).toBe(true);
    expect(isExtensionLoaded("subagents")).toBe(false);
    expect(isExtensionLoaded("multiUser")).toBe(false);
  });

  it("auto-loads IRC from top-level agent config", async () => {
    const config = GatewayConfigSchema.parse({
      version: 2,
      agents: [
        {
          id: "main",
          name: "Main",
          workspace: "~/agents/main",
          model: { provider: "anthropic", model: "claude" },
          irc: {
            host: "irc.example.com",
            nick: "main-bot",
            channels: { "#team": { mode: "reply-all" } },
          },
        },
      ],
    });
    const result = await loadExtensions(config);
    expect(result.filter((extension) => extension.id !== "mcp").map((extension) => extension.id)).toContain("irc");
  });

  it("loads per-agent IRC when shared IRC is disabled", async () => {
    const config = GatewayConfigSchema.parse({
      version: 2,
      agents: [
        {
          id: "main",
          name: "Main",
          workspace: "~/agents/main",
          model: { provider: "anthropic", model: "claude" },
          irc: { host: "irc.example.com", nick: "main-bot" },
        },
      ],
      extensions: {
        irc: { enabled: false, host: "shared.example.com", nick: "shared-bot" },
      },
    });
    const result = await loadExtensions(config);
    expect(result.filter((extension) => extension.id !== "mcp").map((extension) => extension.id)).toContain("irc");
  });

  it("loads multiUser extension when enabled", async () => {
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
        multiUser: {
          enabled: true,
          oauth: {
            google: {
              clientId: "google-client-id",
              clientSecret: "google-client-secret",
            },
          },
          sessionSecret: "test-secret",
        },
      },
    });

    const result = await loadExtensions(config);

    // scheduler and heartbeat must be opted in via config — only multiUser loads here
    expect(result.filter((extension) => extension.id !== "mcp").map((extension) => extension.id)).toEqual([
      "taskLifecycle",
      "capabilityDiscovery",
      "canvas",
      "multiUser",
    ]);
    expect(isExtensionLoaded("multiUser")).toBe(true);
    expect(isExtensionLoaded("scheduler")).toBe(false);
    expect(isExtensionLoaded("heartbeat")).toBe(false);
  });

  it("loads heartbeat extension when any agent has heartbeat config", async () => {
    const config = GatewayConfigSchema.parse({
      version: 2,
      agents: [
        {
          id: "main",
          name: "Main",
          workspace: "~/agents/main",
          model: { provider: "anthropic", model: "claude" },
          heartbeat: { every: "30m" },
        },
      ],
      extensions: {},
    });

    const result = await loadExtensions(config);

    expect(result.filter((extension) => extension.id !== "mcp").map((extension) => extension.id)).toEqual([
      "taskLifecycle",
      "capabilityDiscovery",
      "canvas",
      "heartbeat",
    ]);
    expect(isExtensionLoaded("heartbeat")).toBe(true);
  });

  it("loads webhooks extension when any agent has webhooks config", async () => {
    const config = GatewayConfigSchema.parse({
      version: 2,
      agents: [
        {
          id: "main",
          name: "Main",
          workspace: "~/agents/main",
          model: { provider: "anthropic", model: "claude" },
          webhooks: {
            notion: {
              prompt: "Handle $WEBHOOK_PAYLOAD",
            },
          },
        },
      ],
      extensions: {},
    });

    const result = await loadExtensions(config);

    expect(result.filter((extension) => extension.id !== "mcp").map((extension) => extension.id)).toContain("webhooks");
    expect(isExtensionLoaded("webhooks")).toBe(true);
  });

  it("loads webhooks before slack for per-agent startup", async () => {
    const config = GatewayConfigSchema.parse({
      version: 2,
      agents: [
        {
          id: "main",
          name: "Main",
          workspace: "~/agents/main",
          model: { provider: "anthropic", model: "claude" },
          slack: {
            token: "xoxb-test",
            appToken: "xapp-test",
          },
          webhooks: {
            notion: {
              prompt: "Handle $WEBHOOK_PAYLOAD",
            },
          },
        },
      ],
      extensions: {},
    });

    const result = await loadExtensions(config);
    const ids = result.filter((extension) => extension.id !== "mcp").map((extension) => extension.id);

    expect(ids.indexOf("webhooks")).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf("slack")).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf("webhooks")).toBeLessThan(ids.indexOf("slack"));
  });

  it("fails on invalid extension config", async () => {
    const config = {
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
        scheduler: { enabled: "bad" },
      },
    };

    await expect(loadExtensions(config as never)).rejects.toThrow(
      'Extension "scheduler" config invalid'
    );
  });

  it("loads disabled scheduler for API and CLI routes", async () => {
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
        scheduler: { enabled: false },
      },
    });

    const result = await loadExtensions(config);

    expect(result.filter((extension) => extension.id !== "mcp").map((extension) => extension.id)).toEqual([
      "taskLifecycle",
      "capabilityDiscovery",
      "canvas",
      "scheduler",
    ]);
    expect(isExtensionLoaded("scheduler")).toBe(true);
  });

  it("does not fail heartbeat dependency when scheduler runtime is disabled", async () => {
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
        heartbeat: { enabled: true },
        scheduler: { enabled: false },
      },
    });

    const result = await loadExtensions(config);

    expect(result.filter((extension) => extension.id !== "mcp").map((extension) => extension.id)).toEqual([
      "taskLifecycle",
      "capabilityDiscovery",
      "canvas",
      "scheduler",
      "heartbeat",
    ]);
  });

  it("loads heartbeat without scheduler dependency", async () => {
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
        heartbeat: { enabled: true },
      },
    });

    const result = await loadExtensions(config);

    expect(result.filter((extension) => extension.id !== "mcp").map((extension) => extension.id)).toEqual([
      "taskLifecycle",
      "capabilityDiscovery",
      "canvas",
      "heartbeat",
    ]);
  });

  it("returns known extension route metadata without loading extensions", () => {
    const extensions = getKnownExtensionRouteMetadata();
    const projects = extensions.find(
      (extension) => extension.id === "projects"
    );
    const heartbeat = extensions.find(
      (extension) => extension.id === "heartbeat"
    );
    const multiUser = extensions.find(
      (extension) => extension.id === "multiUser"
    );
    const webhooks = extensions.find(
      (extension) => extension.id === "webhooks"
    );

    expect(projects?.routePrefixes).toContain("/api/projects");
    expect(heartbeat?.routePrefixes).toContain("/api/agents/:id/heartbeat");
    expect(multiUser?.routePrefixes).toContain("/api/auth");
    expect(webhooks?.routePrefixes).toContain("/hooks");
  });

  it("exposes packageName for discord/slack/telegram/webhooks so icon lookup can resolve their package dir", () => {
    // These registrations are inline objects (not built via builtInExtension()),
    // so packageName must be set explicitly for the catalog's icon resolution
    // to find their package directory. Regression test for a bug where these
    // four extensions never got an iconDataUri because packageName was missing.
    const byId = Object.fromEntries(
      getBuiltInExtensionRegistrations().map((r) => [r.id, r])
    );

    expect(byId.discord?.packageName).toBe("@yoplai/extension-discord");
    expect(byId.slack?.packageName).toBe("@yoplai/extension-slack");
    expect(byId.telegram?.packageName).toBe("@yoplai/extension-telegram");
    expect(byId.webhooks?.packageName).toBe("@yoplai/extension-webhooks");
  });

  it("loads external extensions from symlinked directories for agent config", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "yoplai-extensions-"));
    const target = await mkdtemp(
      path.join(os.tmpdir(), "yoplai-extension-target-")
    );
    const zodUrl = pathToFileURL(require.resolve("zod")).href;

    try {
      await writeFile(
        path.join(target, "package.json"),
        JSON.stringify({ type: "module" })
      );
      await writeFile(
        path.join(target, "index.js"),
        [
          `import { z } from ${JSON.stringify(zodUrl)};`,
          "export default {",
          '  id: "sample",',
          '  displayName: "Sample",',
          '  description: "Sample extension",',
          "  dependencies: [],",
          "  configSchema: z.object({ apiKey: z.string() }),",
          '  routePrefixes: ["/api/sample"],',
          "  validateConfig: () => ({ valid: true, errors: [] }),",
          "  registerRoutes: () => undefined,",
          "  start: async () => undefined,",
          "  stop: async () => undefined,",
          "  capabilities: () => [],",
          "};",
        ].join("\n")
      );
      await mkdir(root, { recursive: true });
      await symlink(target, path.join(root, "sample"));

      const config = GatewayConfigSchema.parse({
        version: 2,
        extensionsPath: root,
        agents: [
          {
            id: "main",
            name: "Main",
            workspace: "~/agents/main",
            model: { provider: "anthropic", model: "claude" },
            extensions: {
              sample: { apiKey: "test" },
            },
          },
        ],
        extensions: {},
      });

      const result = await loadExtensions(config);

      expect(result.filter((extension) => extension.id !== "mcp").map((extension) => extension.id)).toContain("sample");
      const runtime = new ExtensionRuntime();
      runtime.load(result);
      expect(
        runtime
          .getRouteMatchers()
          .find((matcher) => matcher.matches("/api/sample/sub"))?.extension
      ).toBe("sample");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(target, { recursive: true, force: true });
    }
  });

  it("always loads the external MCP extension without agent config, even when disabled at root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "yoplai-mcp-extension-"));
    const zodUrl = pathToFileURL(require.resolve("zod")).href;

    try {
      await mkdir(path.join(root, "mcp"), { recursive: true });
      await writeFile(path.join(root, "mcp", "package.json"), JSON.stringify({ type: "module" }));
      await writeFile(path.join(root, "mcp", "index.js"), [
        `import { z } from ${JSON.stringify(zodUrl)};`,
        "export default {",
        '  id: "mcp",',
        '  displayName: "MCP",',
        '  description: "MCP extension",',
        "  dependencies: [],",
        "  configSchema: z.object({}),",
        '  routePrefixes: ["/api/mcp"],',
        "  validateConfig: () => ({ valid: true, errors: [] }),",
        "  registerRoutes: () => undefined,",
        "  start: async () => undefined,",
        "  stop: async () => undefined,",
        "  capabilities: () => [],",
        "};",
      ].join("\n"));

      const config = GatewayConfigSchema.parse({
        version: 2,
        extensionsPath: root,
        agents: [{
          id: "main",
          name: "Main",
          workspace: "~/agents/main",
          model: { provider: "anthropic", model: "claude" },
        }],
        extensions: { mcp: { enabled: false } },
      });

      const result = await loadExtensions(config);

      expect(result.map((extension) => extension.id)).toContain("mcp");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  describe("reloadExtensions OAuth providers", () => {
    afterEach(async () => {
      resetOAuthProviders();
      await loadExtensions(GatewayConfigSchema.parse({ version: 2, agents: [], extensions: {} }));
    });

    async function withOAuthExtension(
      tokenUrl: string,
      run: (config: ReturnType<typeof GatewayConfigSchema.parse>) => Promise<void>
    ) {
      const root = await mkdtemp(path.join(os.tmpdir(), "yoplai-extensions-"));
      const target = await mkdtemp(path.join(os.tmpdir(), "yoplai-extension-target-"));
      const zodUrl = pathToFileURL(require.resolve("zod")).href;
      try {
        await writeFile(path.join(target, "package.json"), JSON.stringify({ type: "module" }));
        await writeFile(
          path.join(target, "index.js"),
          [
            `import { z } from ${JSON.stringify(zodUrl)};`,
            "export default {",
            '  id: "oauthsample",',
            '  displayName: "OAuth Sample",',
            '  description: "Sample extension",',
            "  dependencies: [],",
            "  configSchema: z.object({ apiKey: z.string() }),",
            '  routePrefixes: ["/api/oauthsample"],',
            "  oauthProviders: [{",
            '    id: "reload-test-provider", displayName: "Reload Test",',
            '    authorizeUrl: "https://reload.test/authorize",',
            `    tokenUrl: ${JSON.stringify(tokenUrl)},`,
            "    defaultScopes: [],",
            "  }],",
            "  validateConfig: () => ({ valid: true, errors: [] }),",
            "  registerRoutes: () => undefined,",
            "  start: async () => undefined,",
            "  stop: async () => undefined,",
            "  capabilities: () => [],",
            "};",
          ].join("\n")
        );
        await mkdir(root, { recursive: true });
        await symlink(target, path.join(root, "oauthsample"));
        await run(
          GatewayConfigSchema.parse({
            version: 2,
            extensionsPath: root,
            agents: [
              {
                id: "main",
                name: "Main",
                workspace: "~/agents/main",
                model: { provider: "anthropic", model: "claude" },
                extensions: { oauthsample: { apiKey: "test" } },
              },
            ],
            extensions: {},
          })
        );
      } finally {
        await rm(root, { recursive: true, force: true });
        await rm(target, { recursive: true, force: true });
      }
    }

    it("registers provider descriptors before the extension starts", async () => {
      await withOAuthExtension("https://reload.test/token", async (config) => {
        let providerDuringActivation: unknown;
        setExtensionActivator(async () => {
          providerDuringActivation = getOAuthProvider("reload-test-provider");
        });
        await reloadExtensions(config);
        expect(providerDuringActivation).toMatchObject({ id: "reload-test-provider" });
      });
    });

    it("rejects a conflicting descriptor without activating", async () => {
      await withOAuthExtension("https://reload.test/token", async (config) => {
        registerOAuthProvider({
          id: "reload-test-provider",
          displayName: "Reload Test",
          authorizeUrl: "https://reload.test/authorize",
          tokenUrl: "https://elsewhere.test/token",
          defaultScopes: [],
        });
        let activated = false;
        setExtensionActivator(async () => {
          activated = true;
        });
        await expect(reloadExtensions(config)).rejects.toThrow(/conflicting descriptor/);
        expect(activated).toBe(false);
        expect(isExtensionLoaded("oauthsample")).toBe(false);
      });
    });
  });
});
