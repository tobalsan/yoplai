import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import os from "node:os";
import { writeTestV3Config } from "../test-utils/v3-config.js";

describe("areas + tasks API", () => {
  let tmpDir: string;
  let projectsRoot: string;
  let api: {
    request: (
      input: RequestInfo,
      init?: RequestInit
    ) => Response | Promise<Response>;
  };
  let prevHome: string | undefined;
  let prevHomeDir: string | undefined;
  let prevUserProfile: string | undefined;
  let extensions: Array<{
    id: string;
    registerRoutes: (api: unknown) => void;
    start?: (ctx: unknown) => Promise<void>;
    stop?: () => Promise<void>;
  }> = [];

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-areas-tasks-api-"));
    projectsRoot = path.join(tmpDir, "projects");

    prevHomeDir = process.env.YOPLAI_HOME;
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    process.env.YOPLAI_HOME = path.join(tmpDir, ".yoplai");
    process.env.HOME = tmpDir;
    process.env.USERPROFILE = tmpDir;

    await writeTestV3Config(path.join(tmpDir, ".yoplai"), {
      agents: [
        {
          id: "test-agent",
          name: "Test Agent",
          model: {
            provider: "anthropic",
            model: "claude-3-5-sonnet-20241022",
          },
        },
      ],
      extensions: {
        projects: { enabled: true, root: projectsRoot },
      },
    });

    vi.resetModules();
    const { clearConfigCacheForTests, loadConfig } =
      await import("../config/index.js");
    clearConfigCacheForTests();
    const { loadExtensions } = await import("../extensions/registry.js");
    const mod = await import("./api.core.js");
    api = mod.api;
    const config = loadConfig();
    extensions = (await loadExtensions(config)) as typeof extensions;
    for (const extension of extensions) {
      extension.registerRoutes(api as never);
    }

    const mockCtx = {
      getConfig: () => config,
      getDataDir: () => path.join(tmpDir, ".yoplai"),
      getAgents: () => config.agents ?? [],
      getAgent: (id: string) => config.agents?.find((a) => a.id === id),
      isAgentActive: () => true,
      isAgentStreaming: () => false,
      resolveWorkspaceDir: () => tmpDir,
      runAgent: async () => ({ ok: true, data: {} }),
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
    if (prevHomeDir === undefined) delete process.env.YOPLAI_HOME;
    else process.env.YOPLAI_HOME = prevHomeDir;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("supports area CRUD and migration", async () => {
    const createRes = await Promise.resolve(
      api.request("/areas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "custom",
          title: "Custom",
          color: "#000000",
          repo: "~/code/custom",
        }),
      })
    );
    expect(createRes.status).toBe(201);

    const listRes = await Promise.resolve(api.request("/areas"));
    expect(listRes.status).toBe(200);
    const listed = await listRes.json();
    expect(listed.some((item: { id: string }) => item.id === "custom")).toBe(
      true
    );

    const patchRes = await Promise.resolve(
      api.request("/areas/custom", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Custom Updated" }),
      })
    );
    expect(patchRes.status).toBe(200);
    const patched = await patchRes.json();
    expect(patched.title).toBe("Custom Updated");

    await fs.mkdir(path.join(projectsRoot, "PRO-99_yoplai_seed"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(projectsRoot, "PRO-99_yoplai_seed", "README.md"),
      '---\nid: "PRO-99"\ntitle: "Seed"\n---\n# Seed\n',
      "utf8"
    );

    const migrateRes = await Promise.resolve(
      api.request("/areas/migrate", { method: "POST" })
    );
    expect(migrateRes.status).toBe(200);
    const migrate = await migrateRes.json();
    expect(migrate.updatedProjects).toContain("PRO-99_yoplai_seed");

    const readme = await fs.readFile(
      path.join(projectsRoot, "PRO-99_yoplai_seed", "README.md"),
      "utf8"
    );
    expect(readme).toContain('area: "yoplai"');

    const deleteRes = await Promise.resolve(
      api.request("/areas/custom", { method: "DELETE" })
    );
    expect(deleteRes.status).toBe(200);
  });

  it("supports tasks and spec endpoints", async () => {
    const createProjectRes = await Promise.resolve(
      api.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Task Parsing Project" }),
      })
    );
    expect(createProjectRes.status).toBe(201);
    const created = await createProjectRes.json();

    const putSpecRes = await Promise.resolve(
      api.request(`/projects/${created.id}/spec`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: [
            "# Spec",
            "",
            "## Tasks",
            "",
            "- [ ] **Initial task** `status:todo`",
            "",
          ].join("\n"),
        }),
      })
    );
    expect(putSpecRes.status).toBe(200);

    const listTasksRes = await Promise.resolve(
      api.request(`/projects/${created.id}/tasks`)
    );
    expect(listTasksRes.status).toBe(200);
    const tasksBody = await listTasksRes.json();
    expect(tasksBody.progress).toEqual({ done: 0, total: 1 });
    expect(tasksBody.tasks[0].title).toBe("Initial task");

    const patchTaskRes = await Promise.resolve(
      api.request(`/projects/${created.id}/tasks/0`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ checked: true, agentId: "codex-123" }),
      })
    );
    expect(patchTaskRes.status).toBe(200);
    const patched = await patchTaskRes.json();
    expect(patched.task.checked).toBe(true);
    expect(patched.task.status).toBe("done");
    expect(patched.task.agentId).toBe("codex-123");

    const postTaskRes = await Promise.resolve(
      api.request(`/projects/${created.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Second task",
          description: "Implement endpoint",
          status: "in_progress",
        }),
      })
    );
    expect(postTaskRes.status).toBe(201);

    const deleteTaskRes = await Promise.resolve(
      api.request(`/projects/${created.id}/tasks/1`, { method: "DELETE" })
    );
    expect(deleteTaskRes.status).toBe(200);

    const getSpecRes = await Promise.resolve(
      api.request(`/projects/${created.id}/spec`)
    );
    expect(getSpecRes.status).toBe(200);
    const spec = await getSpecRes.json();
    expect(spec.content).toContain(
      "- [x] **Initial task** `status:done` `agent:codex-123`"
    );
    expect(spec.content).not.toContain("Second task");
  });
});
