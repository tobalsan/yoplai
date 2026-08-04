import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ExtensionContext, GatewayConfig } from "@yoplai/shared";
import { subagentsExtension } from "./index.js";

function context(
  config: Omit<GatewayConfig, "agentFab"> & { agentFab?: boolean },
  dataDir = "/tmp/yoplai-subagents-test"
): ExtensionContext {
  const normalizedConfig: GatewayConfig = {
    ...config,
    agentFab: config.agentFab ?? false,
  };
  return {
    getConfig: () => normalizedConfig,
    getDataDir: () => dataDir,
    reloadConfig: () => undefined,
    getAgent: () => undefined,
    getAgents: () => [],
    isAgentActive: () => false,
    isAgentStreaming: () => false,
    resolveWorkspaceDir: () => "",
    runAgent: async () => ({
      payloads: [],
      meta: { durationMs: 0, sessionId: "test" },
    }),
    getSubagentTemplates: () => normalizedConfig.subagents ?? [],
    resolveSessionId: async () => undefined,
    getSessionEntry: async () => undefined,
    clearSessionEntry: async () => undefined,
    restoreSessionUpdatedAt: () => undefined,
    deleteSession: () => undefined,
    invalidateHistoryCache: async () => undefined,
    getSessionHistory: async () => [],
    registerDeliverySink: () => () => undefined,
    getDeliverySink: () => undefined,
    subscribe: () => () => undefined,
    emit: () => undefined,
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  };
}

async function writeRun(
  dataDir: string,
  runId: string,
  cwd: string,
  archived = false
) {
  const runDir = path.join(dataDir, "sessions", "subagents", "runs", runId);
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(
    path.join(runDir, "config.json"),
    JSON.stringify({
      id: runId,
      label: runId,
      cli: "codex",
      cwd,
      prompt: "test",
      createdAt: "2026-04-27T00:00:00.000Z",
      archived,
    }),
    "utf8"
  );
  await fs.writeFile(
    path.join(runDir, "state.json"),
    JSON.stringify({
      startedAt: "2026-04-27T00:00:00.000Z",
      status: "done",
      exitCode: 0,
    }),
    "utf8"
  );
  await fs.writeFile(path.join(runDir, "logs.jsonl"), "", "utf8");
}

async function writeProjectSubagentRun(
  projectsRoot: string,
  params: {
    projectId: string;
    sliceId: string;
    slug: string;
    source: "manual" | "orchestrator";
  }
) {
  const runDir = path.join(
    projectsRoot,
    `${params.projectId}_test`,
    "sessions",
    params.slug
  );
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(
    path.join(runDir, "config.json"),
    JSON.stringify({
      type: "subagent",
      cli: "codex",
      name: "Worker",
      projectId: params.projectId,
      sliceId: params.sliceId,
      source: params.source,
    }),
    "utf8"
  );
  await fs.writeFile(
    path.join(runDir, "state.json"),
    JSON.stringify({
      supervisor_pid: process.pid,
      project_id: params.projectId,
      slice_id: params.sliceId,
      started_at: new Date().toISOString(),
    }),
    "utf8"
  );
  await fs.writeFile(path.join(runDir, "history.jsonl"), "", "utf8");
  await fs.writeFile(
    path.join(runDir, "logs.jsonl"),
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "done" },
    }),
    "utf8"
  );
}

async function writeResumableProjectSubagentRun(
  projectsRoot: string,
  params: {
    projectId: string;
    slug: string;
    sessionId: string;
  }
) {
  const projectDir = path.join(projectsRoot, `${params.projectId}_test`);
  const runDir = path.join(projectDir, "sessions", params.slug);
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(
    path.join(runDir, "config.json"),
    JSON.stringify({
      type: "subagent",
      cli: "codex",
      name: "Worker",
      projectId: params.projectId,
      source: "manual",
      runMode: "none",
    }),
    "utf8"
  );
  await fs.writeFile(
    path.join(runDir, "state.json"),
    JSON.stringify({
      session_id: params.sessionId,
      run_mode: "none",
      worktree_path: projectDir,
      status: "interrupted",
    }),
    "utf8"
  );
  await fs.writeFile(path.join(runDir, "history.jsonl"), "", "utf8");
  await fs.writeFile(path.join(runDir, "logs.jsonl"), "", "utf8");
}

describe("subagents extension profile resolution", () => {
  it("contributes subagent command guidance to the system prompt", async () => {
    const contribution = subagentsExtension.getSystemPromptContributions?.({
      id: "lead",
      name: "Lead",
      workspace: "/tmp/yoplai-subagents-test",
      sdk: "pi",
      model: { model: "test" },
      queueMode: "queue",
    });
    const resolved = await Promise.resolve(contribution);
    const text = Array.isArray(resolved)
      ? resolved.join("\n")
      : (resolved ?? "");

    expect(text).toContain("yoplai subagents start");
    expect(text).toContain("yoplai subagents list");
    expect(text).toContain("yoplai subagents interrupt|archive");
  });

  it("uses top-level subagent cli templates as profiles", async () => {
    const app = new Hono();
    await subagentsExtension.start(
      context({
        agents: [],
        sessions: { idleMinutes: 360 },
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
      })
    );
    subagentsExtension.registerRoutes(app);

    const res = await app.request("/subagents", {
      method: "POST",
      body: JSON.stringify({
        profile: "Worker",
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "cwd, prompt, and label are required",
    });
    await subagentsExtension.stop();
  });

  it("returns a clear error for unknown profiles", async () => {
    const app = new Hono();
    await subagentsExtension.start(
      context({
        agents: [],
        sessions: { idleMinutes: 360 },
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
      })
    );
    subagentsExtension.registerRoutes(app);

    const res = await app.request("/subagents", {
      method: "POST",
      body: JSON.stringify({
        profile: "worker",
        cwd: ".",
        prompt: "test",
        label: "test",
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Unknown subagent profile: worker. Available profiles: Worker",
    });
    await subagentsExtension.stop();
  });

  it("filters listed runs by canonical cwd query", async () => {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "yoplai-subagents-")
    );
    const realDir = await fs.mkdtemp(path.join(dataDir, "real-"));
    const linkDir = path.join(dataDir, "link");
    const otherDir = await fs.mkdtemp(path.join(dataDir, "other-"));
    await fs.symlink(realDir, linkDir);
    await writeRun(dataDir, "run-match", linkDir);
    await writeRun(dataDir, "run-other", otherDir);
    const app = new Hono();
    try {
      await subagentsExtension.start(
        context({ agents: [], sessions: { idleMinutes: 360 } }, dataDir)
      );
      subagentsExtension.registerRoutes(app);

      const res = await app.request(
        `/subagents?cwd=${encodeURIComponent(realDir)}`
      );
      const data = (await res.json()) as { items: Array<{ id: string }> };

      expect(data.items.map((run) => run.id)).toEqual(["run-match"]);
    } finally {
      await subagentsExtension.stop();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  it("includes running project orchestrator runs in the default list", async () => {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "yoplai-subagents-")
    );
    const projectsRoot = path.join(dataDir, "projects");
    const app = new Hono();
    try {
      await writeProjectSubagentRun(projectsRoot, {
        projectId: "PRO-1",
        sliceId: "PRO-1-S01",
        slug: "worker",
        source: "orchestrator",
      });
      await subagentsExtension.start(
        context(
          {
            agents: [],
            sessions: { idleMinutes: 360 },
            extensions: { projects: { root: projectsRoot } },
          },
          dataDir
        )
      );
      subagentsExtension.registerRoutes(app);

      const res = await app.request("/subagents?status=running");
      const data = (await res.json()) as {
        items: Array<{
          id?: string;
          projectId?: string;
          sliceId?: string;
          source?: string;
          status?: string;
        }>;
      };

      expect(data.items).toEqual([
        expect.objectContaining({
          id: "PRO-1:worker",
          projectId: "PRO-1",
          sliceId: "PRO-1-S01",
          source: "orchestrator",
          status: "running",
        }),
      ]);
    } finally {
      await subagentsExtension.stop();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  it("filters project runs by project and slice and serves logs by synthetic id", async () => {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "yoplai-subagents-")
    );
    const projectsRoot = path.join(dataDir, "projects");
    const app = new Hono();
    try {
      await writeProjectSubagentRun(projectsRoot, {
        projectId: "PRO-1",
        sliceId: "PRO-1-S01",
        slug: "worker",
        source: "orchestrator",
      });
      await writeProjectSubagentRun(projectsRoot, {
        projectId: "PRO-1",
        sliceId: "PRO-1-S02",
        slug: "reviewer",
        source: "orchestrator",
      });
      await subagentsExtension.start(
        context(
          {
            agents: [],
            sessions: { idleMinutes: 360 },
            extensions: { projects: { root: projectsRoot } },
          },
          dataDir
        )
      );
      subagentsExtension.registerRoutes(app);

      const listRes = await app.request(
        "/subagents?projectId=PRO-1&sliceId=PRO-1-S01"
      );
      const listData = (await listRes.json()) as {
        items: Array<{ id?: string; sliceId?: string }>;
      };

      expect(listData.items).toEqual([
        expect.objectContaining({
          id: "PRO-1:worker",
          sliceId: "PRO-1-S01",
        }),
      ]);

      const logsRes = await app.request("/subagents/PRO-1:worker/logs?since=0");
      const logsData = (await logsRes.json()) as {
        events: Array<{ text?: string }>;
      };

      expect(logsData.events[0]?.text).toBe("done");
    } finally {
      await subagentsExtension.stop();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  it("resumes project runs addressed by synthetic id", async () => {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "yoplai-subagents-")
    );
    const projectsRoot = path.join(dataDir, "projects");
    const binDir = path.join(dataDir, "bin");
    const app = new Hono();
    const previousPath = process.env.PATH;
    try {
      await fs.mkdir(binDir, { recursive: true });
      await fs.writeFile(
        path.join(binDir, "codex"),
        ["#!/bin/sh", 'echo "$@"'].join("\n"),
        { mode: 0o755 }
      );
      process.env.PATH = `${binDir}:${previousPath ?? ""}`;
      await writeResumableProjectSubagentRun(projectsRoot, {
        projectId: "PRO-1",
        slug: "worker",
        sessionId: "codex-session-1",
      });
      await subagentsExtension.start(
        context(
          {
            agents: [],
            sessions: { idleMinutes: 360 },
            extensions: { projects: { root: projectsRoot } },
          },
          dataDir
        )
      );
      subagentsExtension.registerRoutes(app);

      const res = await app.request("/subagents/PRO-1:worker/resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "follow up" }),
      });

      expect(res.status).toBe(201);
      const logsPath = path.join(
        projectsRoot,
        "PRO-1_test",
        "sessions",
        "worker",
        "logs.jsonl"
      );
      const start = Date.now();
      while (Date.now() - start < 2000) {
        const logs = await fs.readFile(logsPath, "utf8");
        if (logs.includes("resume codex-session-1 follow up")) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const logs = await fs.readFile(logsPath, "utf8");
      expect(logs).toContain("resume codex-session-1 follow up");
    } finally {
      process.env.PATH = previousPath;
      await subagentsExtension.stop();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  it("supports cwd home expansion and includeArchived=1", async () => {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "yoplai-subagents-")
    );
    const homeRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "yoplai-subagents-home-root-")
    );
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = homeRoot;
    process.env.USERPROFILE = homeRoot;
    const homeDir = await fs.mkdtemp(
      path.join(os.homedir(), ".yoplai-subagents-home-")
    );
    const app = new Hono();
    try {
      const cwd = path.join(homeDir, "home-run");
      await fs.mkdir(cwd, { recursive: true });
      await writeRun(dataDir, "run-home", cwd, true);
      await writeRun(dataDir, "run-other", dataDir, true);
      await subagentsExtension.start(
        context({ agents: [], sessions: { idleMinutes: 360 } }, dataDir)
      );
      subagentsExtension.registerRoutes(app);

      const res = await app.request(
        `/subagents?includeArchived=1&cwd=${encodeURIComponent(
          `~/${path.relative(os.homedir(), cwd)}`
        )}`
      );
      const data = (await res.json()) as { items: Array<{ id: string }> };

      expect(data.items.map((run) => run.id)).toEqual(["run-home"]);
    } finally {
      await subagentsExtension.stop();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
      await fs.rm(dataDir, { recursive: true, force: true });
      await fs.rm(homeRoot, { recursive: true, force: true });
    }
  });
});
