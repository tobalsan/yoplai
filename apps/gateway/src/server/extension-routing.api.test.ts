import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import os from "node:os";
import { GatewayConfigSchema, type RunAgentParams } from "@yoplai/shared";

describe("extension route mounting", () => {
  let tmpDir: string;
  let dataDir: string;
  const runParams: RunAgentParams[] = [];
  let extensions: Array<{
    id: string;
    registerRoutes: (api: unknown) => void;
    start?: (ctx: unknown) => Promise<void>;
    stop?: () => Promise<void>;
  }> = [];

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "yoplai-component-routes-")
    );
    dataDir = path.join(tmpDir, ".yoplai");
    const projectsRoot = path.join(tmpDir, "projects");
    await fs.mkdir(projectsRoot, { recursive: true });

    vi.resetModules();
    const { clearConfigCacheForTests, setLoadedConfig } =
      await import("../config/index.js");
    clearConfigCacheForTests();
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
              prompt: "Payload: $WEBHOOK_PAYLOAD",
            },
          },
        },
      ],
      extensions: {
        projects: { enabled: true, root: projectsRoot },
      },
    });
    setLoadedConfig(config);
    const { loadExtensions } = await import("../extensions/registry.js");
    const { api } = await import("./api.core.js");
    extensions = (await loadExtensions(config)) as typeof extensions;
    for (const extension of extensions) {
      extension.registerRoutes(api);
    }

    const mockCtx = {
      getConfig: () => config,
      getDataDir: () => dataDir,
      getAgents: () => config.agents ?? [],
      getAgent: (id: string) => config.agents?.find((a) => a.id === id),
      isAgentActive: () => true,
      isAgentStreaming: () => false,
      resolveWorkspaceDir: () => tmpDir,
      runAgent: async (params: RunAgentParams) => {
        runParams.push(params);
        return { payloads: [], meta: { durationMs: 0, sessionId: "session" } };
      },
      getSubagentTemplates: () => [],
      resolveSessionId: async () => undefined,
      getSessionEntry: async () => undefined,
      clearSessionEntry: async () => undefined,
      restoreSessionUpdatedAt: () => {},
      deleteSession: () => {},
      invalidateHistoryCache: async () => {},
      getSessionHistory: async () => [],
      subscribe: () => () => {},
      emit: () => {},
      logger: console,
    };
    for (const extension of extensions) {
      await extension.start?.(mockCtx as never);
    }
  });

  afterAll(async () => {
    for (const extension of extensions) {
      await extension.stop?.();
    }
    const { clearConfigCacheForTests } = await import("../config/index.js");
    clearConfigCacheForTests();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("serves routes registered by enabled extensions through the main app", async () => {
    const { app } = await import("./index.js");

    const projectsResponse = await Promise.resolve(
      app.request("/api/projects")
    );
    expect(projectsResponse.status).toBe(200);
    await expect(projectsResponse.json()).resolves.toEqual(expect.any(Array));
  });

  it("serves webhooks extension routes outside the api prefix", async () => {
    const { app } = await import("./index.js");
    const secrets = JSON.parse(
      await fs.readFile(path.join(dataDir, "webhook-secrets.json"), "utf8")
    ) as Record<string, string>;
    const secret = secrets["main:notion"];

    const response = await Promise.resolve(
      app.request(`/hooks/main/notion/${secret}`, {
        method: "POST",
        body: "hello",
      })
    );

    expect(response.status).toBe(200);
    for (let attempt = 0; attempt < 10 && runParams.length === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(runParams.at(-1)).toMatchObject({
      agentId: "main",
      message: "Payload: hello",
      source: "webhook",
    });
    expect(runParams.at(-1)?.sessionKey).toMatch(/^webhook:main:notion:/);
  });
});
