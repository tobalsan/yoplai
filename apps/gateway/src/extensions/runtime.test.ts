import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  GatewayConfigSchema,
  type AgentConfig,
  type Extension,
} from "@yoplai/shared";
import { ExtensionRuntime } from "./runtime.js";

function extension(overrides: Partial<Extension> & { id: string }): Extension {
  const { id, ...rest } = overrides;
  return {
    id,
    displayName: id,
    description: id,
    dependencies: [],
    configSchema: z.object({}),
    routePrefixes: [],
    validateConfig: () => ({ valid: true, errors: [] }),
    registerRoutes: () => undefined,
    start: async () => undefined,
    stop: async () => undefined,
    capabilities: () => [],
    ...rest,
  };
}

const agent: AgentConfig = {
  id: "main",
  name: "Main",
  workspace: "~/agents/main",
  queueMode: "queue",
  model: { provider: "anthropic", model: "claude" },
};

const config = GatewayConfigSchema.parse({
  version: 2,
  agents: [agent],
  extensions: {
    sample: { enabled: true },
  },
});

describe("ExtensionRuntime", () => {
  it("owns loaded extension state and capabilities", () => {
    const runtime = new ExtensionRuntime();
    runtime.load(
      [
        extension({
          id: "sample",
          capabilities: () => ["sample-capability"],
        }),
      ],
      "sample"
    );

    expect(runtime.getLoadedExtensions().map((item) => item.id)).toEqual([
      "sample",
    ]);
    expect(runtime.isEnabled("sample")).toBe(true);
    expect(runtime.getHomeExtension()).toBe("sample");
    expect(runtime.getCapabilities()).toEqual({
      extensions: { sample: true },
      capabilities: { sample: ["sample-capability"] },
      multiUser: false,
      home: "sample",
    });
  });

  it("builds route matchers from metadata", () => {
    const runtime = new ExtensionRuntime([
      {
        id: "sample",
        routePrefixes: ["/api/sample", "/api/agents/:id/sample"],
        allowWhenDisabled: true,
      },
    ]);

    const matchers = runtime.getRouteMatchers();
    expect(
      matchers.find((matcher) => matcher.matches("/api/sample/item"))?.extension
    ).toBe("sample");
    const agentMatcher = matchers.find((matcher) =>
      matcher.matches("/api/agents/main/sample")
    );
    expect(agentMatcher?.extension).toBe("sample");
    expect(agentMatcher?.allowWhenDisabled).toBe(true);
    expect(
      matchers.some((matcher) => matcher.matches("/api/agents/main/other"))
    ).toBe(false);
  });

  it("merges loaded extension routes without replacing known metadata", () => {
    const runtime = new ExtensionRuntime([
      {
        id: "scheduler",
        routePrefixes: ["/api/schedules"],
        allowWhenDisabled: true,
      },
    ]);

    runtime.load([
      extension({ id: "scheduler", routePrefixes: ["/api/other-schedules"] }),
      extension({
        id: "external",
        routePrefixes: ["/api/thing", "/api/agents/:id/thing"],
      }),
    ]);

    const matchers = runtime.getRouteMatchers();
    expect(
      matchers.find((matcher) => matcher.matches("/api/schedules"))
        ?.allowWhenDisabled
    ).toBe(true);
    expect(
      matchers.some((matcher) => matcher.matches("/api/other-schedules"))
    ).toBe(false);
    expect(
      matchers.find((matcher) => matcher.matches("/api/thing/sub"))?.extension
    ).toBe("external");
    expect(
      matchers.find((matcher) =>
        matcher.matches("/api/agents/main/thing")
      )?.extension
    ).toBe("external");
  });

  it("resolves prompt and tool lookups through loaded extensions", async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    const runtime = new ExtensionRuntime();
    runtime.load([
      extension({
        id: "sample",
        getSystemPromptContributions: () => ["Use sample.", " "],
        getAgentTools: () => [
          {
            name: "sample_run",
            description: "Run sample",
            parameters: { type: "object" },
            execute,
          },
        ],
      }),
    ]);

    await expect(
      runtime.getPromptContributions(agent, config)
    ).resolves.toEqual(["Use sample."]);
    await expect(runtime.getTools(agent, config)).resolves.toMatchObject([
      { extensionId: "sample", name: "sample_run" },
    ]);
    await expect(
      runtime.executeTool(agent, "sample_run", { value: 1 }, config)
    ).resolves.toEqual({ found: true, result: { ok: true } });
    expect(execute).toHaveBeenCalledWith(
      { value: 1 },
      expect.objectContaining({
        agent,
        config,
        env: expect.objectContaining(process.env),
      })
    );
  });

  it("rejects duplicate tool names", async () => {
    const runtime = new ExtensionRuntime();
    runtime.load([
      extension({
        id: "one",
        getAgentTools: () => [
          {
            name: "duplicate",
            description: "One",
            parameters: {},
            execute: async () => undefined,
          },
        ],
      }),
      extension({
        id: "two",
        getAgentTools: () => [
          {
            name: "duplicate",
            description: "Two",
            parameters: {},
            execute: async () => undefined,
          },
        ],
      }),
    ]);

    await expect(runtime.getTools(agent, config)).rejects.toThrow(
      "Duplicate extension agent tool: duplicate"
    );
  });

  it("skips a failing extension without exposing its secret", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const runtime = new ExtensionRuntime();
    runtime.load([
      extension({ id: "broken", getAgentTools: () => { throw new Error('missing required secret "token" value=super-secret'); }, getSystemPromptContributions: () => { throw new Error('missing required secret "token" value=super-secret'); } }),
      extension({ id: "healthy", getAgentTools: () => [{ name: "ok", description: "ok", parameters: {}, execute: async () => undefined }], getSystemPromptContributions: () => "healthy" }),
    ]);

    await expect(runtime.getTools(agent, config)).resolves.toMatchObject([{ name: "ok" }]);
    await expect(runtime.getPromptContributions(agent, config)).resolves.toEqual(["healthy"]);
    expect(warn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ extensionId: "broken", agentId: "main", fields: ["token"] }));
    expect(JSON.stringify(warn.mock.calls)).not.toContain("super-secret");
    warn.mockRestore();
  });
});
