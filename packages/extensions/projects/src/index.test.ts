import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayConfig, AgentConfig } from "@yoplai/shared";
import {
  interruptCancelledOrchestratorRuns,
  projectsExtension,
} from "./index.js";
import { clearProjectsContext, setProjectsContext } from "./context.js";

let tmpDir: string | undefined;

afterEach(async () => {
  clearProjectsContext();
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

describe("projects extension agent tools", () => {
  it("registers project tools through the extension model", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-project-tools-"));
    const projectsRoot = path.join(tmpDir, "projects");
    const agent = {
      id: "agent-1",
      name: "Agent One",
      workspace: tmpDir,
      model: { model: "test" },
    } as AgentConfig;
    const config = {
      agents: [agent],
      extensions: { projects: { enabled: true, root: projectsRoot } },
      projects: { root: projectsRoot },
    } as unknown as GatewayConfig;
    setProjectsContext({
      getConfig: () => config,
      getDataDir: () => path.join(tmpDir, ".yoplai"),
      getAgents: () => [agent],
      getAgent: () => agent,
      isAgentActive: () => true,
      isAgentStreaming: () => false,
      resolveWorkspaceDir: () => tmpDir,
      runAgent: async () => ({ ok: true as const, data: {} }),
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
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    } as never);

    const tools = await projectsExtension.getAgentTools?.(agent, { config });

    expect(tools?.map((tool) => tool.name)).toEqual([
      "project.create",
      "project.get",
      "project.update",
      "project.comment",
    ]);

    const createTool = tools?.find((tool) => tool.name === "project.create");
    const getTool = tools?.find((tool) => tool.name === "project.get");
    const updateTool = tools?.find((tool) => tool.name === "project.update");

    const created = await createTool?.execute(
      { title: "Extension Tool Project", pitch: "Initial pitch" },
      { agent, config, env: {} }
    );
    expect(created).toMatchObject({
      id: "PRO-1",
      title: "Extension Tool Project",
    });

    const fetched = await getTool?.execute(
      { projectId: "PRO-1" },
      { agent, config, env: {} }
    );
    expect(fetched).toMatchObject({
      id: "PRO-1",
      title: "Extension Tool Project",
    });

    const updated = await updateTool?.execute(
      { projectId: "PRO-1", updates: { title: "Updated Extension Project" } },
      { agent, config, env: {} }
    );
    expect(updated).toMatchObject({
      id: "PRO-1",
      title: "Updated Extension Project",
    });
  });
});

describe("cancel interrupt filtering", () => {
  it("interrupts only running orchestrator runs matching cascaded slice ids", async () => {
    const config = { agents: [] } as unknown as GatewayConfig;
    const listSubagentsFn = vi.fn(async () => ({
      ok: true as const,
      data: {
        items: [
          {
            slug: "match",
            source: "orchestrator",
            status: "running",
            sliceId: "S-1",
          },
          {
            slug: "manual",
            source: "manual",
            status: "running",
            sliceId: "S-1",
          },
          {
            slug: "idle",
            source: "orchestrator",
            status: "idle",
            sliceId: "S-1",
          },
          {
            slug: "other-slice",
            source: "orchestrator",
            status: "running",
            sliceId: "S-2",
          },
        ],
      },
    }));
    const interruptSubagentFn = vi.fn(async () => ({ ok: true as const }));

    await interruptCancelledOrchestratorRuns(config, "PRO-1", ["S-1"], {
      listSubagentsFn,
      interruptSubagentFn,
    });

    expect(interruptSubagentFn).toHaveBeenCalledTimes(1);
    expect(interruptSubagentFn).toHaveBeenCalledWith(config, "PRO-1", "match");
  });
});
