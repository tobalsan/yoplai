import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import os from "node:os";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { Hono } from "hono";

const execFileAsync = promisify(execFile);
let clearProjectsContextForTest: (() => void) | undefined;

describe("subagents API", () => {
  let tmpDir: string;
  let projectsRoot: string;
  let repoTemplateDir: string;
  let api: {
    request: (
      input: RequestInfo,
      init?: RequestInit
    ) => Response | Promise<Response>;
  };
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-subagents-"));
    projectsRoot = path.join(tmpDir, "projects");

    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpDir;
    process.env.USERPROFILE = tmpDir;

    const configDir = path.join(tmpDir, ".yoplai");
    await fs.mkdir(configDir, { recursive: true });
    const config = {
      version: 2,
      agents: [
        {
          id: "test-agent",
          name: "Test Agent",
          workspace: "~/test",
          model: { provider: "anthropic", model: "claude-3-5-sonnet-20241022" },
        },
      ],
      extensions: {
        projects: {
          enabled: true,
          root: projectsRoot,
          // Pin to the legacy on-disk layout so existing path assertions
          // (`<projectsRoot>/.workspaces/<id>/<slug>`) keep holding under the
          // new configurable worktreeDir resolver.
          worktreeDir: ".workspaces",
        },
      },
    };
    await fs.writeFile(
      path.join(configDir, "yoplai.json"),
      JSON.stringify(config, null, 2)
    );

    repoTemplateDir = path.join(tmpDir, "repo-template");
    await fs.mkdir(repoTemplateDir, { recursive: true });
    await execFileAsync("git", ["init", "-b", "main"], { cwd: repoTemplateDir });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], {
      cwd: repoTemplateDir,
    });
    await execFileAsync("git", ["config", "user.name", "Test User"], {
      cwd: repoTemplateDir,
    });
    await fs.writeFile(path.join(repoTemplateDir, "README.md"), "test\n");
    await execFileAsync("git", ["add", "."], { cwd: repoTemplateDir });
    await execFileAsync("git", ["commit", "-m", "init"], {
      cwd: repoTemplateDir,
    });
    await execFileAsync("git", ["checkout", "-b", "dev"], {
      cwd: repoTemplateDir,
    });
    await execFileAsync("git", ["checkout", "main"], { cwd: repoTemplateDir });

    vi.resetModules();
    const { setProjectsContext, clearProjectsContext } = await import(
      "../context.js"
    );
    clearProjectsContextForTest = clearProjectsContext;
    setProjectsContext({
      getConfig: () => config,
      getDataDir: () => path.join(tmpDir, ".yoplai"),
      getAgents: () => config.agents,
      getAgent: (id: string) => config.agents.find((agent) => agent.id === id),
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

    const { clearConfigCacheForTests } = await import(
      "../../../../../apps/gateway/src/config/index.js"
    );
    clearConfigCacheForTests();
    const { registerProjectRoutes } = await import("../index.js");
    api = new Hono();
    api.get("/agents/status", (c) =>
      c.json({ statuses: { "test-agent": "idle" } })
    );
    registerProjectRoutes(api as never);
  });

  afterAll(async () => {
    clearProjectsContextForTest?.();
    clearProjectsContextForTest = undefined;

    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;

    await fs.rm(tmpDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  });

  const createRepoCopy = async (name: string) => {
    const repoDir = path.join(tmpDir, name);
    await fs.cp(repoTemplateDir, repoDir, { recursive: true });
    return repoDir;
  };

  it("lists subagents and returns logs with cursor", async () => {
    const createRes = await Promise.resolve(
      api.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Subagent Test" }),
      })
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    const repoDir = await createRepoCopy("repo");

    const patchRes = await Promise.resolve(
      api.request(`/projects/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: repoDir }),
      })
    );
    expect(patchRes.status).toBe(200);

    const sessionDir = path.join(
      projectsRoot,
      created.path,
      "sessions",
      "alpha"
    );
    await fs.mkdir(sessionDir, { recursive: true });

    const now = new Date().toISOString();
    await fs.writeFile(
      path.join(sessionDir, "config.json"),
      JSON.stringify(
        {
          type: "subagent",
          cli: "codex",
          runMode: "worktree",
          baseBranch: "main",
          created: now,
        },
        null,
        2
      )
    );
    const state = {
      session_id: "s1",
      supervisor_pid: 0,
      started_at: now,
      last_error: "",
      cli: "codex",
      run_mode: "worktree",
      worktree_path: path.join(repoDir, "wt"),
      base_branch: "main",
    };
    await fs.writeFile(
      path.join(sessionDir, "state.json"),
      JSON.stringify(state, null, 2)
    );
    await fs.writeFile(
      path.join(sessionDir, "progress.json"),
      JSON.stringify({ last_active: now, tool_calls: 2 })
    );
    await fs.writeFile(
      path.join(sessionDir, "history.jsonl"),
      JSON.stringify({
        ts: now,
        type: "worker.finished",
        data: { run_id: "r1", outcome: "replied" },
      }) + "\n"
    );
    await fs.writeFile(path.join(sessionDir, "logs.jsonl"), "hello\n");

    const listRes = await Promise.resolve(
      api.request(`/projects/${created.id}/subagents`)
    );
    expect(listRes.status).toBe(200);
    const list = await listRes.json();
    expect(list.items.length).toBe(1);
    expect(list.items[0].slug).toBe("alpha");
    expect(list.items[0].status).toBe("replied");
    expect(list.items[0].cli).toBe("codex");
    expect(list.items[0].type).toBe("subagent");
    expect(list.items[0].sliceId).toBeUndefined();

    const logsRes = await Promise.resolve(
      api.request(`/projects/${created.id}/subagents/alpha/logs?since=0`)
    );
    expect(logsRes.status).toBe(200);
    const logs = await logsRes.json();
    expect(logs.events.length).toBe(1);
    expect(logs.events[0].type).toBe("stdout");
    expect(logs.events[0].text).toContain("hello");
    expect(logs.latestUsage).toBeUndefined();
    expect(logs.latestContextEstimate).toBeUndefined();

    const logsRes2 = await Promise.resolve(
      api.request(
        `/projects/${created.id}/subagents/alpha/logs?since=${logs.cursor}`
      )
    );
    const logs2 = await logsRes2.json();
    expect(logs2.events.length).toBe(0);

    const branchesRes = await Promise.resolve(
      api.request(`/projects/${created.id}/branches`)
    );
    expect(branchesRes.status).toBe(200);
    const branches = await branchesRes.json();
    expect(branches.branches).toContain("main");
    expect(branches.branches).toContain("dev");
  });

  it("migrates legacy sessions from workspaces", async () => {
    const createRes = await Promise.resolve(
      api.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Subagent Migrate" }),
      })
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    const legacyRoot = path.join(projectsRoot, ".workspaces", created.id);
    const legacyDir = path.join(legacyRoot, "legacy");
    await fs.mkdir(legacyDir, { recursive: true });

    const now = new Date().toISOString();
    const state = {
      session_id: "s1",
      supervisor_pid: 0,
      started_at: now,
      last_error: "",
      cli: "claude",
      run_mode: "worktree",
      worktree_path: path.join(tmpDir, "wt-legacy"),
      base_branch: "dev",
    };
    await fs.writeFile(
      path.join(legacyDir, "state.json"),
      JSON.stringify(state, null, 2)
    );
    await fs.writeFile(
      path.join(legacyDir, "progress.json"),
      JSON.stringify({ last_active: now }, null, 2)
    );
    await fs.writeFile(
      path.join(legacyDir, "history.jsonl"),
      JSON.stringify({
        ts: now,
        type: "worker.finished",
        data: { run_id: "r1", outcome: "replied" },
      }) + "\n"
    );
    await fs.writeFile(path.join(legacyDir, "logs.jsonl"), "legacy\n");

    const listRes = await Promise.resolve(
      api.request(`/projects/${created.id}/subagents`)
    );
    expect(listRes.status).toBe(200);
    const list = await listRes.json();
    const migrated = list.items.find(
      (item: { slug: string }) => item.slug === "legacy"
    );
    expect(migrated?.cli).toBe("claude");
    expect(migrated?.runMode).toBe("worktree");

    const sessionDir = path.join(
      projectsRoot,
      created.path,
      "sessions",
      "legacy"
    );
    const config = JSON.parse(
      await fs.readFile(path.join(sessionDir, "config.json"), "utf8")
    );
    expect(config.cli).toBe("claude");
    expect(config.runMode).toBe("worktree");
    expect(config.baseBranch).toBe("dev");
    expect(config.created).toBe(now);

    await expect(fs.stat(legacyRoot)).rejects.toThrow();
  });

  it("archives subagent runs and filters list", async () => {
    const createRes = await Promise.resolve(
      api.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Subagent Archive" }),
      })
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    const sessionDir = path.join(
      projectsRoot,
      created.path,
      "sessions",
      "alpha"
    );
    await fs.mkdir(sessionDir, { recursive: true });
    const now = new Date().toISOString();
    await fs.writeFile(
      path.join(sessionDir, "config.json"),
      JSON.stringify(
        {
          cli: "codex",
          runMode: "worktree",
          baseBranch: "main",
          created: now,
          archived: false,
        },
        null,
        2
      )
    );

    const archiveRes = await Promise.resolve(
      api.request(`/projects/${created.id}/subagents/alpha/archive`, {
        method: "POST",
      })
    );
    expect(archiveRes.status).toBe(200);
    const archived = await archiveRes.json();
    expect(archived.slug).toBe("alpha");
    expect(archived.archived).toBe(true);

    const config = JSON.parse(
      await fs.readFile(path.join(sessionDir, "config.json"), "utf8")
    );
    expect(config.archived).toBe(true);

    const listRes = await Promise.resolve(
      api.request(`/projects/${created.id}/subagents`)
    );
    expect(listRes.status).toBe(200);
    const list = await listRes.json();
    expect(list.items.length).toBe(0);

    const listArchivedRes = await Promise.resolve(
      api.request(`/projects/${created.id}/subagents?includeArchived=true`)
    );
    expect(listArchivedRes.status).toBe(200);
    const listArchived = await listArchivedRes.json();
    expect(listArchived.items.length).toBe(1);
    expect(listArchived.items[0].archived).toBe(true);

    const unarchiveRes = await Promise.resolve(
      api.request(`/projects/${created.id}/subagents/alpha/unarchive`, {
        method: "POST",
      })
    );
    expect(unarchiveRes.status).toBe(200);
    const unarchived = await unarchiveRes.json();
    expect(unarchived.archived).toBe(false);

    const listRes2 = await Promise.resolve(
      api.request(`/projects/${created.id}/subagents`)
    );
    const list2 = await listRes2.json();
    expect(list2.items.length).toBe(1);
    expect(list2.items[0].archived).toBe(false);
  });

  it("renames a subagent and persists name in config + listings", async () => {
    const createRes = await Promise.resolve(
      api.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Subagent Rename" }),
      })
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    const sessionDir = path.join(
      projectsRoot,
      created.path,
      "sessions",
      "alpha"
    );
    await fs.mkdir(sessionDir, { recursive: true });
    const now = new Date().toISOString();
    await fs.writeFile(
      path.join(sessionDir, "config.json"),
      JSON.stringify(
        {
          cli: "codex",
          name: "Worker Alpha",
          runMode: "worktree",
          baseBranch: "main",
          created: now,
        },
        null,
        2
      )
    );

    const renameRes = await Promise.resolve(
      api.request(`/projects/${created.id}/subagents/alpha`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Worker Renamed" }),
      })
    );
    expect(renameRes.status).toBe(200);
    const renamed = await renameRes.json();
    expect(renamed.slug).toBe("alpha");
    expect(renamed.name).toBe("Worker Renamed");

    const config = JSON.parse(
      await fs.readFile(path.join(sessionDir, "config.json"), "utf8")
    );
    expect(config.name).toBe("Worker Renamed");

    const listRes = await Promise.resolve(
      api.request(`/projects/${created.id}/subagents`)
    );
    expect(listRes.status).toBe(200);
    const list = await listRes.json();
    expect(list.items[0].name).toBe("Worker Renamed");

    const listRes2 = await Promise.resolve(
      api.request(`/projects/${created.id}/subagents`)
    );
    expect(listRes2.status).toBe(200);
    const list2 = await listRes2.json();
    expect(list2.items[0].name).toBe("Worker Renamed");
  });

  it("returns 404 when renaming missing subagent slug", async () => {
    const createRes = await Promise.resolve(
      api.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Subagent Rename Missing" }),
      })
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    const renameRes = await Promise.resolve(
      api.request(`/projects/${created.id}/subagents/missing`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Worker Missing" }),
      })
    );
    expect(renameRes.status).toBe(404);
    const body = await renameRes.json();
    expect(body.error).toContain("Subagent not found");
  });

  it("lists all subagents across projects", async () => {
    const createRes = await Promise.resolve(
      api.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Global Subagents" }),
      })
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    const sessionDir = path.join(
      projectsRoot,
      created.path,
      "sessions",
      "main"
    );
    await fs.mkdir(sessionDir, { recursive: true });

    const now = new Date().toISOString();
    await fs.writeFile(
      path.join(sessionDir, "config.json"),
      JSON.stringify(
        { cli: "codex", runMode: "main-run", baseBranch: "main", created: now },
        null,
        2
      )
    );
    await fs.writeFile(
      path.join(sessionDir, "state.json"),
      JSON.stringify(
        { supervisor_pid: 0, last_error: "", cli: "codex" },
        null,
        2
      )
    );
    await fs.writeFile(
      path.join(sessionDir, "progress.json"),
      JSON.stringify({ last_active: now }, null, 2)
    );
    await fs.writeFile(
      path.join(sessionDir, "history.jsonl"),
      JSON.stringify({
        ts: now,
        type: "worker.finished",
        data: { run_id: "r1", outcome: "replied" },
      }) + "\n"
    );

    const listRes = await Promise.resolve(api.request("/subagents"));
    expect(listRes.status).toBe(200);
    const list = await listRes.json();
    const match = list.items.find(
      (item: { projectId: string; slug: string }) =>
        item.projectId === created.id
    );
    expect(match?.slug).toBe("main");
    expect(match?.type).toBe("subagent");
    expect(match?.sliceId).toBeUndefined();
  });

  it("filters /subagents by projectId and sliceId", async () => {
    const firstRes = await Promise.resolve(
      api.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Scoped Subagents A" }),
      })
    );
    const secondRes = await Promise.resolve(
      api.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Scoped Subagents B" }),
      })
    );
    const first = await firstRes.json();
    const second = await secondRes.json();
    const now = new Date().toISOString();

    async function writeRun(projectPath: string, slug: string, sliceId?: string) {
      const sessionDir = path.join(projectsRoot, projectPath, "sessions", slug);
      await fs.mkdir(sessionDir, { recursive: true });
      await fs.writeFile(
        path.join(sessionDir, "config.json"),
        JSON.stringify({ cli: "codex", created: now, sliceId }, null, 2)
      );
      await fs.writeFile(
        path.join(sessionDir, "state.json"),
        JSON.stringify({ supervisor_pid: 0, cli: "codex", slice_id: sliceId }, null, 2)
      );
      await fs.writeFile(
        path.join(sessionDir, "progress.json"),
        JSON.stringify({ last_active: now }, null, 2)
      );
    }

    await writeRun(first.path, "first", "PRO-1-S01");
    await writeRun(first.path, "other-slice", "PRO-1-S02");
    await writeRun(second.path, "second", "PRO-2-S01");

    const listRes = await Promise.resolve(
      api.request(`/subagents?projectId=${first.id}&sliceId=PRO-1-S01&includeArchived=1`)
    );
    expect(listRes.status).toBe(200);
    const list = await listRes.json();
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({
      projectId: first.id,
      sliceId: "PRO-1-S01",
      slug: "first",
    });
  });

  it("propagates sliceId on /projects/:id/subagents spawn and list surfaces", async () => {
    const createRes = await Promise.resolve(
      api.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Subagent Slice Attribution" }),
      })
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    const binDir = path.join(tmpDir, "bin-slice-attribution");
    await fs.mkdir(binDir, { recursive: true });
    const codexPath = path.join(binDir, "codex");
    const script = [
      "#!/bin/sh",
      'echo \'{"type":"thread.started","thread_id":"s-slice"}\'',
      'echo \'{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}\'',
    ].join("\n");
    await fs.writeFile(codexPath, script, { mode: 0o755 });
    const prevPath = process.env.PATH;
    process.env.PATH = `${binDir}:${prevPath ?? ""}`;

    try {
      const spawnRes = await Promise.resolve(
        api.request(`/projects/${created.id}/subagents`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            slug: "worker-slice",
            cli: "codex",
            prompt: "implement",
            mode: "none",
            sliceId: "PRO-1-S01",
          }),
        })
      );
      expect(spawnRes.status).toBe(201);

      const sessionDir = path.join(
        projectsRoot,
        created.path,
        "sessions",
        "worker-slice"
      );
      const config = JSON.parse(
        await fs.readFile(path.join(sessionDir, "config.json"), "utf8")
      );
      const state = JSON.parse(
        await fs.readFile(path.join(sessionDir, "state.json"), "utf8")
      );
      expect(config.sliceId).toBe("PRO-1-S01");
      expect(state.slice_id).toBe("PRO-1-S01");

      const projectListRes = await Promise.resolve(
        api.request(`/projects/${created.id}/subagents`)
      );
      expect(projectListRes.status).toBe(200);
      const projectList = await projectListRes.json();
      expect(projectList.items[0]?.sliceId).toBe("PRO-1-S01");

      const globalListRes = await Promise.resolve(api.request("/subagents"));
      expect(globalListRes.status).toBe(200);
      const globalList = await globalListRes.json();
      const match = globalList.items.find(
        (item: { projectId?: string; slug: string }) =>
          item.projectId === created.id && item.slug === "worker-slice"
      );
      expect(match?.sliceId).toBe("PRO-1-S01");
    } finally {
      process.env.PATH = prevPath;
    }
  });

  it("uses frontmatter runAgent but ignores frontmatter runMode for /projects/:id/start", async () => {
    const createRes = await Promise.resolve(
      api.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Start Frontmatter Fallback" }),
      })
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    const repoDir = await createRepoCopy("repo-frontmatter-start");

    const patchRes = await Promise.resolve(
      api.request(`/projects/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: repoDir }),
      })
    );
    expect(patchRes.status).toBe(200);

    const projectReadmePath = path.join(
      projectsRoot,
      created.path,
      "README.md"
    );
    const readme = await fs.readFile(projectReadmePath, "utf8");
    const updatedReadme = readme.replace(
      /^---\n/,
      "---\nrunAgent: cli:codex\nrunMode: main-run\n"
    );
    await fs.writeFile(projectReadmePath, updatedReadme);

    const binDir = path.join(tmpDir, "bin-frontmatter-start");
    await fs.mkdir(binDir, { recursive: true });
    const codexPath = path.join(binDir, "codex");
    const script = [
      "#!/bin/sh",
      'echo \'{"type":"thread.started","thread_id":"s-frontmatter"}\'',
      'echo \'{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}\'',
    ].join("\n");
    await fs.writeFile(codexPath, script, { mode: 0o755 });
    const prevPath = process.env.PATH;
    process.env.PATH = `${binDir}:${prevPath ?? ""}`;

    const startRes = await Promise.resolve(
      api.request(`/projects/${created.id}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
    );
    expect(startRes.status).toBe(200);
    const started = await startRes.json();
    expect(started.ok).toBe(true);
    expect(started.type).toBe("cli");
    expect(started.slug).toBe("start-frontmatter-fallback");
    expect(started.runMode).toBe("clone");

    const sessionDir = path.join(
      projectsRoot,
      created.path,
      "sessions",
      "start-frontmatter-fallback"
    );
    const start = Date.now();
    while (Date.now() - start < 2000) {
      try {
        await fs.access(path.join(sessionDir, "config.json"));
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    const config = JSON.parse(
      await fs.readFile(path.join(sessionDir, "config.json"), "utf8")
    );
    expect(config.cli).toBe("codex");
    expect(config.runMode).toBe("clone");

    process.env.PATH = prevPath;
  });

  it("injects main repo and space paths in coordinator start prompt context", async () => {
    const createRes = await Promise.resolve(
      api.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Coordinator Context Paths" }),
      })
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    const repoDir = await createRepoCopy("repo-coordinator-context");

    const patchRes = await Promise.resolve(
      api.request(`/projects/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: repoDir }),
      })
    );
    expect(patchRes.status).toBe(200);

    const binDir = path.join(tmpDir, "bin-coordinator-context");
    await fs.mkdir(binDir, { recursive: true });
    const codexPath = path.join(binDir, "codex");
    const script = [
      "#!/bin/sh",
      'echo \'{"type":"thread.started","thread_id":"s-coordinator-context"}\'',
      'echo \'{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}\'',
    ].join("\n");
    await fs.writeFile(codexPath, script, { mode: 0o755 });
    const prevPath = process.env.PATH;
    process.env.PATH = `${binDir}:${prevPath ?? ""}`;

    const startRes = await Promise.resolve(
      api.request(`/projects/${created.id}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runAgent: "cli:codex",
          promptRole: "coordinator",
          model: "gpt-5.3-codex",
          slug: "coord-check",
        }),
      })
    );
    expect(startRes.status).toBe(200);

    const sessionDir = path.join(
      projectsRoot,
      created.path,
      "sessions",
      "coord-check"
    );
    const logsPath = path.join(sessionDir, "logs.jsonl");
    const start = Date.now();
    while (Date.now() - start < 3000) {
      try {
        const logs = await fs.readFile(logsPath, "utf8");
        if (logs.includes("thread.started")) break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const logs = await fs.readFile(logsPath, "utf8");

    expect(logs).toContain("## Main Repository");
    expect(logs).toContain(`Path: ${repoDir}`);
    expect(logs).toContain("## Project Space Worktree");
    expect(logs).toContain(
      path.join(projectsRoot, ".workspaces", created.id, "_space")
    );

    process.env.PATH = prevPath;
  });

  it("spawns mode none without creating a workspace clone", async () => {
    const createRes = await Promise.resolve(
      api.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "No Workspace Spawn" }),
      })
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    const binDir = path.join(tmpDir, "bin-mode-none");
    await fs.mkdir(binDir, { recursive: true });
    const codexPath = path.join(binDir, "codex");
    const script = [
      "#!/bin/sh",
      'echo \'{"type":"thread.started","thread_id":"s-none"}\'',
      'echo \'{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}\'',
    ].join("\n");
    await fs.writeFile(codexPath, script, { mode: 0o755 });
    const prevPath = process.env.PATH;
    process.env.PATH = `${binDir}:${prevPath ?? ""}`;

    const spawnRes = await Promise.resolve(
      api.request(`/projects/${created.id}/subagents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: "reviewer-none",
          cli: "codex",
          prompt: "review changes",
          mode: "none",
        }),
      })
    );
    expect(spawnRes.status).toBe(201);

    const projectDir = path.join(projectsRoot, created.path);
    const sessionDir = path.join(projectDir, "sessions", "reviewer-none");
    const state = JSON.parse(
      await fs.readFile(path.join(sessionDir, "state.json"), "utf8")
    );
    expect(state.run_mode).toBe("none");
    expect(state.worktree_path).toBe(projectDir);

    const workspaceDir = path.join(
      projectsRoot,
      ".workspaces",
      created.id,
      "reviewer-none"
    );
    await expect(fs.stat(workspaceDir)).rejects.toThrow();

    process.env.PATH = prevPath;
  });

  it("applies model/effort and name when spawning from /projects/:id/start", async () => {
    const createRes = await Promise.resolve(
      api.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Start With Options" }),
      })
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    const repoDir = await createRepoCopy("repo-start-options");

    const patchRes = await Promise.resolve(
      api.request(`/projects/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: repoDir }),
      })
    );
    expect(patchRes.status).toBe(200);

    const binDir = path.join(tmpDir, "bin-start-options");
    await fs.mkdir(binDir, { recursive: true });
    const codexPath = path.join(binDir, "codex");
    const script = [
      "#!/bin/sh",
      'echo "$@"',
      'echo \'{"type":"thread.started","thread_id":"s-start-options"}\'',
      'echo \'{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}\'',
    ].join("\n");
    await fs.writeFile(codexPath, script, { mode: 0o755 });
    const prevPath = process.env.PATH;
    process.env.PATH = `${binDir}:${prevPath ?? ""}`;

    const startRes = await Promise.resolve(
      api.request(`/projects/${created.id}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runAgent: "cli:codex",
          runMode: "main-run",
          name: "Worker A",
          model: "gpt-5.2",
          reasoningEffort: "low",
        }),
      })
    );
    expect(startRes.status).toBe(200);

    const sessionDir = path.join(
      projectsRoot,
      created.path,
      "sessions",
      "main"
    );
    const logsPath = path.join(sessionDir, "logs.jsonl");
    const start = Date.now();
    while (Date.now() - start < 2000) {
      try {
        const logs = await fs.readFile(logsPath, "utf8");
        if (logs.includes("thread.started")) break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const logs = await fs.readFile(logsPath, "utf8");
    expect(logs).toContain("-m gpt-5.2");
    expect(logs).toContain("-c reasoning_effort=low");

    const config = JSON.parse(
      await fs.readFile(path.join(sessionDir, "config.json"), "utf8")
    );
    expect(config.name).toBe("Worker A");
    expect(config.model).toBe("gpt-5.2");
    expect(config.reasoningEffort).toBe("low");
    const state = JSON.parse(
      await fs.readFile(path.join(sessionDir, "state.json"), "utf8")
    );
    expect(state.worktree_path).toContain(
      path.join(".workspaces", created.id, "_space")
    );
    await expect(
      fs.stat(path.join(projectsRoot, created.path, "space.json"))
    ).resolves.toBeDefined();

    process.env.PATH = prevPath;
  });

  it("auto-generates run name from name prefix and slug on /projects/:id/start", async () => {
    const createRes = await Promise.resolve(
      api.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Template Name Auto" }),
      })
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    const binDir = path.join(tmpDir, "bin-template-name-auto");
    await fs.mkdir(binDir, { recursive: true });
    const codexPath = path.join(binDir, "codex");
    const script = [
      "#!/bin/sh",
      'echo \'{"type":"thread.started","thread_id":"s-template-name-auto"}\'',
      'echo \'{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}\'',
    ].join("\n");
    await fs.writeFile(codexPath, script, { mode: 0o755 });
    const prevPath = process.env.PATH;
    process.env.PATH = `${binDir}:${prevPath ?? ""}`;

    try {
      const startRes = await Promise.resolve(
        api.request(`/projects/${created.id}/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            runAgent: "cli:codex",
            model: "gpt-5.3-codex",
            runMode: "none",
            slug: "reviewer-foo-bar",
            name: "Reviewer Foo Bar",
          }),
        })
      );
      expect(startRes.status).toBe(200);

      const config = JSON.parse(
        await fs.readFile(
          path.join(
            projectsRoot,
            created.path,
            "sessions",
            "reviewer-foo-bar",
            "config.json"
          ),
          "utf8"
        )
      );
      expect(config.name).toBe("Reviewer Foo Bar");
    } finally {
      process.env.PATH = prevPath;
    }
  });

  it("uses the Space branch for worker template runs from /projects/:id/start", async () => {
    const createRes = await Promise.resolve(
      api.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Worker Space Base" }),
      })
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    const repoDir = await createRepoCopy("repo-worker-space-base");

    const patchRes = await Promise.resolve(
      api.request(`/projects/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: repoDir }),
      })
    );
    expect(patchRes.status).toBe(200);

    const binDir = path.join(tmpDir, "bin-worker-space-base");
    await fs.mkdir(binDir, { recursive: true });
    const codexPath = path.join(binDir, "codex");
    const script = [
      "#!/bin/sh",
      'echo "$@"',
      'echo \'{"type":"thread.started","thread_id":"s-worker-space-base"}\'',
      'echo \'{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}\'',
    ].join("\n");
    await fs.writeFile(codexPath, script, { mode: 0o755 });
    const prevPath = process.env.PATH;
    process.env.PATH = `${binDir}:${prevPath ?? ""}`;

    try {
      const startRes = await Promise.resolve(
        api.request(`/projects/${created.id}/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            runAgent: "cli:codex",
            model: "gpt-5.3-codex",
            runMode: "worktree",
            baseBranch: `space/${created.id}`,
            slug: "worker-space-base",
          }),
        })
      );
      expect(startRes.status).toBe(200);

      const sessionDir = path.join(
        projectsRoot,
        created.path,
        "sessions",
        "worker-space-base"
      );
      const logsPath = path.join(sessionDir, "logs.jsonl");
      const waitStart = Date.now();
      while (Date.now() - waitStart < 2000) {
        try {
          const logs = await fs.readFile(logsPath, "utf8");
          if (logs.includes("thread.started")) break;
        } catch {
          // wait
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      const config = JSON.parse(
        await fs.readFile(path.join(sessionDir, "config.json"), "utf8")
      );
      expect(config.runMode).toBe("worktree");
      expect(config.baseBranch).toBe(`space/${created.id}`);

      const branchRes = await execFileAsync("git", [
        "-C",
        path.join(projectsRoot, ".workspaces", created.id, "worker-space-base"),
        "rev-parse",
        "--abbrev-ref",
        "HEAD",
      ]);
      expect(branchRes.stdout.trim()).toBe(`${created.id}/worker-space-base`);
    } finally {
      process.env.PATH = prevPath;
    }
  }, 15000);

  it("uses explicit name on /projects/:id/subagents", async () => {
    const createRes = await Promise.resolve(
      api.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Template Name Worker" }),
      })
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    const binDir = path.join(tmpDir, "bin-template-name-worker");
    await fs.mkdir(binDir, { recursive: true });
    const codexPath = path.join(binDir, "codex");
    const script = [
      "#!/bin/sh",
      'echo \'{"type":"thread.started","thread_id":"s-template-name-worker"}\'',
      'echo \'{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}\'',
    ].join("\n");
    await fs.writeFile(codexPath, script, { mode: 0o755 });
    const prevPath = process.env.PATH;
    process.env.PATH = `${binDir}:${prevPath ?? ""}`;

    try {
      const spawnRes = await Promise.resolve(
        api.request(`/projects/${created.id}/subagents`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            slug: "worker-model-resume",
            cli: "codex",
            prompt: "implement",
            mode: "none",
            name: "Worker Model Resume",
          }),
        })
      );
      expect(spawnRes.status).toBe(201);

      const config = JSON.parse(
        await fs.readFile(
          path.join(
            projectsRoot,
            created.path,
            "sessions",
            "worker-model-resume",
            "config.json"
          ),
          "utf8"
        )
      );
      expect(config.name).toBe("Worker Model Resume");
    } finally {
      process.env.PATH = prevPath;
    }
  });

  it("uses explicit name on /projects/:id/start", async () => {
    const createRes = await Promise.resolve(
      api.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Template Name Slug Words" }),
      })
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    const binDir = path.join(tmpDir, "bin-template-name-slug-words");
    await fs.mkdir(binDir, { recursive: true });
    const codexPath = path.join(binDir, "codex");
    const script = [
      "#!/bin/sh",
      'echo \'{"type":"thread.started","thread_id":"s-template-name-slug-words"}\'',
      'echo \'{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}\'',
    ].join("\n");
    await fs.writeFile(codexPath, script, { mode: 0o755 });
    const prevPath = process.env.PATH;
    process.env.PATH = `${binDir}:${prevPath ?? ""}`;

    try {
      const startRes = await Promise.resolve(
        api.request(`/projects/${created.id}/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            runAgent: "cli:codex",
            model: "gpt-5.3-codex",
            runMode: "none",
            slug: "reviewer-api-scope-extra",
            name: "Reviewer Api Scope",
          }),
        })
      );
      expect(startRes.status).toBe(200);

      const config = JSON.parse(
        await fs.readFile(
          path.join(
            projectsRoot,
            created.path,
            "sessions",
            "reviewer-api-scope-extra",
            "config.json"
          ),
          "utf8"
        )
      );
      expect(config.name).toBe("Reviewer Api Scope");
    } finally {
      process.env.PATH = prevPath;
    }
  });

  it("keeps explicit name instead of auto-generating", async () => {
    const createRes = await Promise.resolve(
      api.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Template Name Explicit" }),
      })
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    const binDir = path.join(tmpDir, "bin-template-name-explicit");
    await fs.mkdir(binDir, { recursive: true });
    const codexPath = path.join(binDir, "codex");
    const script = [
      "#!/bin/sh",
      'echo \'{"type":"thread.started","thread_id":"s-template-name-explicit"}\'',
      'echo \'{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}\'',
    ].join("\n");
    await fs.writeFile(codexPath, script, { mode: 0o755 });
    const prevPath = process.env.PATH;
    process.env.PATH = `${binDir}:${prevPath ?? ""}`;

    try {
      const startRes = await Promise.resolve(
        api.request(`/projects/${created.id}/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            runAgent: "cli:codex",
            model: "gpt-5.3-codex",
            runMode: "none",
            slug: "reviewer-manual",
            name: "Reviewer Manual",
          }),
        })
      );
      expect(startRes.status).toBe(200);

      const config = JSON.parse(
        await fs.readFile(
          path.join(
            projectsRoot,
            created.path,
            "sessions",
            "reviewer-manual",
            "config.json"
          ),
          "utf8"
        )
      );
      expect(config.name).toBe("Reviewer Manual");
    } finally {
      process.env.PATH = prevPath;
    }
  });

  it("updates subagent model via PATCH", async () => {
    const createRes = await Promise.resolve(
      api.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Patch Subagent Model" }),
      })
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    const sessionDir = path.join(
      projectsRoot,
      created.path,
      "sessions",
      "patch-model"
    );
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, "config.json"),
      JSON.stringify({ cli: "claude", model: "sonnet" }, null, 2)
    );

    const patchRes = await Promise.resolve(
      api.request(`/projects/${created.id}/subagents/patch-model`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "opus" }),
      })
    );
    expect(patchRes.status).toBe(200);
    const payload = await patchRes.json();
    expect(payload.slug).toBe("patch-model");
    expect(payload.model).toBe("opus");

    const config = JSON.parse(
      await fs.readFile(path.join(sessionDir, "config.json"), "utf8")
    ) as { model?: string };
    expect(config.model).toBe("opus");
  });

  it("updates subagent name and model via PATCH", async () => {
    const createRes = await Promise.resolve(
      api.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Patch Subagent Name Model" }),
      })
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    const sessionDir = path.join(
      projectsRoot,
      created.path,
      "sessions",
      "patch-name-model"
    );
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, "config.json"),
      JSON.stringify(
        { cli: "codex", name: "Worker A", model: "gpt-5.3-codex" },
        null,
        2
      )
    );

    const patchRes = await Promise.resolve(
      api.request(`/projects/${created.id}/subagents/patch-name-model`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Worker B", model: "gpt-5.2" }),
      })
    );
    expect(patchRes.status).toBe(200);
    const payload = await patchRes.json();
    expect(payload.name).toBe("Worker B");
    expect(payload.model).toBe("gpt-5.2");

    const config = JSON.parse(
      await fs.readFile(path.join(sessionDir, "config.json"), "utf8")
    ) as { name?: string; model?: string };
    expect(config.name).toBe("Worker B");
    expect(config.model).toBe("gpt-5.2");
  });

  it("uses patched model on resume when model is omitted", async () => {
    const createRes = await Promise.resolve(
      api.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Resume Patched Model" }),
      })
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    const sessionDir = path.join(
      projectsRoot,
      created.path,
      "sessions",
      "resume-model"
    );
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, "config.json"),
      JSON.stringify(
        { cli: "claude", model: "sonnet", runMode: "none" },
        null,
        2
      )
    );
    await fs.writeFile(
      path.join(sessionDir, "state.json"),
      JSON.stringify(
        {
          session_id: "s-existing",
          run_mode: "none",
          worktree_path: path.join(projectsRoot, created.path),
        },
        null,
        2
      )
    );

    const patchRes = await Promise.resolve(
      api.request(`/projects/${created.id}/subagents/resume-model`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "opus" }),
      })
    );
    expect(patchRes.status).toBe(200);

    const binDir = path.join(tmpDir, "bin-resume-model-patch");
    await fs.mkdir(binDir, { recursive: true });
    const claudePath = path.join(binDir, "claude");
    await fs.writeFile(
      claudePath,
      [
        "#!/bin/sh",
        'echo "$@"',
        'echo \'{"type":"system","session_id":"s2"}\'',
      ].join("\n"),
      { mode: 0o755 }
    );
    const prevPath = process.env.PATH;
    process.env.PATH = `${binDir}:${prevPath ?? ""}`;

    const resumeRes = await Promise.resolve(
      api.request(`/projects/${created.id}/subagents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: "resume-model",
          cli: "claude",
          prompt: "follow up",
          mode: "none",
          resume: true,
        }),
      })
    );
    expect(resumeRes.status).toBe(201);

    const logsPath = path.join(sessionDir, "logs.jsonl");
    const start = Date.now();
    while (Date.now() - start < 2000) {
      const logs = await fs.readFile(logsPath, "utf8");
      if (logs.includes("--model opus")) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const logs = await fs.readFile(logsPath, "utf8");
    expect(logs).toContain("--model opus");
    expect(logs).toContain("-r s-existing");

    process.env.PATH = prevPath;
  });

  it("allows explicit field overrides on /projects/:id/start", async () => {
    const createRes = await Promise.resolve(
      api.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Template Lock Allow" }),
      })
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    const binDir = path.join(tmpDir, "bin-template-lock-allow");
    await fs.mkdir(binDir, { recursive: true });
    const codexPath = path.join(binDir, "codex");
    const script = [
      "#!/bin/sh",
      'echo \'{"type":"thread.started","thread_id":"s-template-lock-allow"}\'',
      'echo \'{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}\'',
    ].join("\n");
    await fs.writeFile(codexPath, script, { mode: 0o755 });
    const prevPath = process.env.PATH;
    process.env.PATH = `${binDir}:${prevPath ?? ""}`;

    const startRes = await Promise.resolve(
      api.request(`/projects/${created.id}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runAgent: "cli:codex",
          promptRole: "legacy",
          runMode: "none",
          model: "gpt-5.3-codex",
          slug: "reviewer-legacy",
        }),
      })
    );
    expect(startRes.status).toBe(200);

    const sessionDir = path.join(
      projectsRoot,
      created.path,
      "sessions",
      "reviewer-legacy"
    );
    const config = JSON.parse(
      await fs.readFile(path.join(sessionDir, "config.json"), "utf8")
    );
    expect(config.runMode).toBe("none");

    process.env.PATH = prevPath;
  });

  it("applies reviewer template mode none and injects worker workspace paths", async () => {
    const createRes = await Promise.resolve(
      api.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Reviewer Prompt Workspaces" }),
      })
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    const repoDir = await createRepoCopy("repo-reviewer-workspaces");

    const patchRes = await Promise.resolve(
      api.request(`/projects/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: repoDir }),
      })
    );
    expect(patchRes.status).toBe(200);

    const binDir = path.join(tmpDir, "bin-reviewer-workspaces");
    await fs.mkdir(binDir, { recursive: true });
    const codexPath = path.join(binDir, "codex");
    const script = [
      "#!/bin/sh",
      'echo \'{"type":"thread.started","thread_id":"s-reviewer-workspaces"}\'',
      'echo \'{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}\'',
    ].join("\n");
    await fs.writeFile(codexPath, script, { mode: 0o755 });
    const prevPath = process.env.PATH;
    process.env.PATH = `${binDir}:${prevPath ?? ""}`;

    const workerSpawnRes = await Promise.resolve(
      api.request(`/projects/${created.id}/subagents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: "worker-alpha",
          cli: "codex",
          prompt: "worker",
          mode: "worktree",
        }),
      })
    );
    expect(workerSpawnRes.status).toBe(201);

    const workerState = JSON.parse(
      await fs.readFile(
        path.join(
          projectsRoot,
          created.path,
          "sessions",
          "worker-alpha",
          "state.json"
        ),
        "utf8"
      )
    );
    expect(typeof workerState.worktree_path).toBe("string");

    const reviewerStartRes = await Promise.resolve(
      api.request(`/projects/${created.id}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runAgent: "cli:codex",
          model: "gpt-5.3-codex",
          promptRole: "reviewer",
          runMode: "none",
          slug: "reviewer-check",
        }),
      })
    );
    expect(reviewerStartRes.status).toBe(200);

    const reviewerDir = path.join(
      projectsRoot,
      created.path,
      "sessions",
      "reviewer-check"
    );
    const reviewerConfig = JSON.parse(
      await fs.readFile(path.join(reviewerDir, "config.json"), "utf8")
    );
    expect(reviewerConfig.runMode).toBe("none");

    const logs = await fs.readFile(
      path.join(reviewerDir, "logs.jsonl"),
      "utf8"
    );
    expect(logs).toContain("## Active Worker Workspaces");
    expect(logs).toContain(workerState.worktree_path);
    expect(logs).not.toContain("No active worker workspaces found.");

    process.env.PATH = prevPath;
  });

  it("spawns subagent via API and writes logs", async () => {
    const createRes = await Promise.resolve(
      api.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Subagent Spawn" }),
      })
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    const repoDir = await createRepoCopy("repo-spawn");

    const patchRes = await Promise.resolve(
      api.request(`/projects/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: repoDir }),
      })
    );
    expect(patchRes.status).toBe(200);

    const binDir = path.join(tmpDir, "bin");
    await fs.mkdir(binDir, { recursive: true });
    const codexPath = path.join(binDir, "codex");
    const script = [
      "#!/bin/sh",
      'echo \'{"type":"thread.started","thread_id":"s1"}\'',
      'echo "$@"',
      'echo \'{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}\'',
    ].join("\n");
    await fs.writeFile(codexPath, script, { mode: 0o755 });
    const prevPath = process.env.PATH;
    process.env.PATH = `${binDir}:${prevPath ?? ""}`;

    const spawnRes = await Promise.resolve(
      api.request(`/projects/${created.id}/subagents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: "alpha",
          cli: "codex",
          name: "Coordinator",
          prompt: "hi",
          model: "gpt-5.3-codex-spark",
          reasoningEffort: "medium",
          mode: "main-run",
        }),
      })
    );
    expect(spawnRes.status).toBe(201);

    const sessionDir = path.join(
      projectsRoot,
      created.path,
      "sessions",
      "alpha"
    );
    const historyPath = path.join(sessionDir, "history.jsonl");
    const logsPath = path.join(sessionDir, "logs.jsonl");

    const start = Date.now();
    while (Date.now() - start < 2000) {
      try {
        const history = await fs.readFile(historyPath, "utf8");
        if (history.includes('"worker.finished"')) break;
      } catch {
        // wait
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const logs = await fs.readFile(logsPath, "utf8");
    expect(logs).toContain("thread.started");
    expect(logs).toContain("Let's tackle the following project:");
    expect(logs).toContain("-m gpt-5.3-codex-spark");
    expect(logs).toContain("-c reasoning_effort=medium");

    const state = JSON.parse(
      await fs.readFile(path.join(sessionDir, "state.json"), "utf8")
    );
    expect(state.session_id).toBe("s1");
    expect(state.worktree_path).toContain(
      path.join(".workspaces", created.id, "_space")
    );

    const config = JSON.parse(
      await fs.readFile(path.join(sessionDir, "config.json"), "utf8")
    );
    expect(config.name).toBe("Coordinator");
    expect(config.cli).toBe("codex");
    expect(config.model).toBe("gpt-5.3-codex-spark");
    expect(config.reasoningEffort).toBe("medium");
    expect(config.runMode).toBe("main-run");
    expect(config.baseBranch).toBe("main");
    expect(typeof config.created).toBe("string");

    const spaceRes = await Promise.resolve(
      api.request(`/projects/${created.id}/space`)
    );
    expect(spaceRes.status).toBe(200);
    const space = await spaceRes.json();
    expect(space.projectId).toBe(created.id);
    expect(space.branch).toBe(`space/${created.id}`);

    const integrateRes = await Promise.resolve(
      api.request(`/projects/${created.id}/space/integrate`, {
        method: "POST",
      })
    );
    expect(integrateRes.status).toBe(200);

    process.env.PATH = prevPath;
  });

  it("spawns pi subagent and records JSON mode output", async () => {
    const createRes = await Promise.resolve(
      api.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Pi Spawn" }),
      })
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    const repoDir = await createRepoCopy("repo-pi");

    const patchRes = await Promise.resolve(
      api.request(`/projects/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: repoDir }),
      })
    );
    expect(patchRes.status).toBe(200);

    const binDir = path.join(tmpDir, "bin-pi");
    await fs.mkdir(binDir, { recursive: true });
    const piPath = path.join(binDir, "pi");
    const script = [
      "#!/bin/sh",
      'ARGS="$*"',
      'echo "$ARGS" | grep -F -- "--mode json" >/dev/null 2>&1 || { echo "missing --mode json" >&2; exit 1; }',
      'echo "$ARGS" | grep -F -- "--session" >/dev/null 2>&1 || { echo "missing --session" >&2; exit 1; }',
      'echo "$ARGS" | grep -F -- "--model qwen3-max-2026-01-23" >/dev/null 2>&1 || { echo "missing --model" >&2; exit 1; }',
      'echo "$ARGS" | grep -F -- "--thinking high" >/dev/null 2>&1 || { echo "missing --thinking" >&2; exit 1; }',
      `echo '{"type":"session","id":"pi-s1","timestamp":"2026-02-01T00:00:00.000Z","cwd":"$PWD"}'`,
      `echo '{"type":"tool_execution_start","toolCallId":"t1","toolName":"bash","args":{"command":"echo hi"}}'`,
      `echo '{"type":"tool_execution_end","toolCallId":"t1","toolName":"bash","result":"ok","isError":false}'`,
      `echo '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"pi ok"}]}}'`,
    ].join("\n");
    await fs.writeFile(piPath, script, { mode: 0o755 });
    const prevPath = process.env.PATH;
    process.env.PATH = `${binDir}:${prevPath ?? ""}`;

    const spawnRes = await Promise.resolve(
      api.request(`/projects/${created.id}/subagents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: "pi-run",
          cli: "pi",
          prompt: "hi",
          model: "qwen3-max-2026-01-23",
          thinking: "high",
          mode: "main-run",
        }),
      })
    );
    expect(spawnRes.status).toBe(201);

    const sessionDir = path.join(
      projectsRoot,
      created.path,
      "sessions",
      "pi-run"
    );
    const historyPath = path.join(sessionDir, "history.jsonl");
    const start = Date.now();
    while (Date.now() - start < 2000) {
      try {
        const history = await fs.readFile(historyPath, "utf8");
        if (history.includes('"worker.finished"')) break;
      } catch {
        // wait
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const historyRaw = await fs.readFile(historyPath, "utf8");
    const finished = historyRaw
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line))
      .reverse()
      .find((line) => line.type === "worker.finished");
    expect(finished?.data?.outcome).toBe("replied");

    const stateRaw = await fs.readFile(
      path.join(sessionDir, "state.json"),
      "utf8"
    );
    const state = JSON.parse(stateRaw) as {
      session_id?: string;
      session_file?: string;
    };
    expect(state.session_id).toBe("pi-s1");
    expect(typeof state.session_file).toBe("string");
    expect(state.session_file?.endsWith("pi-session.jsonl")).toBe(true);

    process.env.PATH = prevPath;
  });

  it("resumes conflicted worker from Space entry", async () => {
    const createRes = await Promise.resolve(
      api.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Space Conflict Fixer" }),
      })
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    const repoDir = await createRepoCopy("repo-conflict-fixer");

    const patchRes = await Promise.resolve(
      api.request(`/projects/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: repoDir }),
      })
    );
    expect(patchRes.status).toBe(200);

    const binDir = path.join(tmpDir, "bin-conflict-fixer");
    await fs.mkdir(binDir, { recursive: true });
    const codexPath = path.join(binDir, "codex");
    await fs.writeFile(
      codexPath,
      [
        "#!/bin/sh",
        'echo \'{"type":"thread.started","thread_id":"s1"}\'',
        'echo "$@"',
      ].join("\n"),
      { mode: 0o755 }
    );
    const prevPath = process.env.PATH;
    process.env.PATH = `${binDir}:${prevPath ?? ""}`;

    const seedSpaceRes = await Promise.resolve(
      api.request(`/projects/${created.id}/subagents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: "seed-space",
          cli: "codex",
          prompt: "seed",
          mode: "main-run",
        }),
      })
    );
    expect(seedSpaceRes.status).toBe(201);
    const seedWorkerRes = await Promise.resolve(
      api.request(`/projects/${created.id}/subagents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: "alpha",
          cli: "codex",
          prompt: "seed worker",
          mode: "worktree",
        }),
      })
    );
    expect(seedWorkerRes.status).toBe(201);

    const projectDir = path.join(projectsRoot, created.path);
    const workerStatePath = path.join(
      projectDir,
      "sessions",
      "alpha",
      "state.json"
    );
    const workerStateWaitStart = Date.now();
    while (Date.now() - workerStateWaitStart < 5000) {
      try {
        const state = JSON.parse(
          await fs.readFile(workerStatePath, "utf8")
        ) as { session_id?: string };
        if (state.session_id === "s1") break;
      } catch {
        // wait
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const spacePath = path.join(projectDir, "space.json");
    const rawSpace = JSON.parse(await fs.readFile(spacePath, "utf8")) as {
      worktreePath: string;
      branch: string;
      baseBranch: string;
      integrationBlocked: boolean;
      queue: Array<Record<string, unknown>>;
    };
    rawSpace.integrationBlocked = true;
    rawSpace.queue.push({
      id: "conflict-1",
      workerSlug: "alpha",
      runMode: "worktree",
      worktreePath: path.join(projectsRoot, ".workspaces", created.id, "alpha"),
      startSha: "a",
      endSha: "b",
      shas: ["abc123"],
      status: "conflict",
      createdAt: new Date().toISOString(),
      error: "git cherry-pick failed",
    });
    await fs.writeFile(spacePath, JSON.stringify(rawSpace, null, 2), "utf8");

    const logsPath = path.join(projectDir, "sessions", "alpha", "logs.jsonl");
    const resumeOffset = (await fs.stat(logsPath)).size;
    const fixRes = await Promise.resolve(
      api.request(`/projects/${created.id}/space/conflicts/conflict-1/fix`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
    );
    expect(fixRes.status).toBe(201);
    const fixBody = await fixRes.json();
    expect(fixBody.slug).toBe("alpha");
    expect(fixBody.entryId).toBe("conflict-1");
    const logWaitStart = Date.now();
    while (Date.now() - logWaitStart < 2000) {
      const logs = await fs.readFile(logsPath, "utf8");
      if (
        logs
          .slice(resumeOffset)
          .includes(
            "Your previous delivery caused a conflict when Space tried to cherry-pick it."
          )
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const resumeLogs = (await fs.readFile(logsPath, "utf8")).slice(
      resumeOffset
    );
    expect(resumeLogs).toContain(
      "Your previous delivery caused a conflict when Space tried to cherry-pick it."
    );
    expect(resumeLogs).not.toContain("Let's tackle the following project:");

    const workerConfig = JSON.parse(
      await fs.readFile(
        path.join(projectDir, "sessions", "alpha", "config.json"),
        "utf8"
      )
    ) as { runMode?: string; baseBranch?: string; replaces?: string[] };
    expect(workerConfig.runMode).toBe("worktree");
    expect(workerConfig.baseBranch).toBe("main");
    expect(workerConfig.replaces).toEqual(["conflict-1"]);
    await expect(
      fs.stat(path.join(projectDir, "sessions", "fix-alpha"))
    ).rejects.toThrow();

    process.env.PATH = prevPath;
  }, 15000);

  it("rejects legacy CLI values on subagent spawn", async () => {
    const createRes = await Promise.resolve(
      api.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Legacy CLI Spawn Reject" }),
      })
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    const spawnRes = await Promise.resolve(
      api.request(`/projects/${created.id}/subagents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: "legacy",
          cli: "droid",
          prompt: "hi",
          mode: "main-run",
        }),
      })
    );
    expect(spawnRes.status).toBe(400);
    const payload = await spawnRes.json();
    expect(payload.error).toContain("Unsupported CLI");
    expect(payload.error).toContain("claude, codex, pi");
  });

  it("rejects invalid model/effort combos on subagent spawn", async () => {
    const createRes = await Promise.resolve(
      api.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Invalid Model Spawn Reject" }),
      })
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    const badModel = await Promise.resolve(
      api.request(`/projects/${created.id}/subagents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: "bad-model",
          cli: "codex",
          prompt: "hi",
          model: "haiku",
        }),
      })
    );
    expect(badModel.status).toBe(400);
    const badModelPayload = await badModel.json();
    expect(badModelPayload.error).toContain("Invalid codex model");

    const badThinking = await Promise.resolve(
      api.request(`/projects/${created.id}/subagents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: "bad-thinking",
          cli: "codex",
          prompt: "hi",
          thinking: "high",
        }),
      })
    );
    expect(badThinking.status).toBe(400);
    const badThinkingPayload = await badThinking.json();
    expect(badThinkingPayload.error).toContain("thinking is only valid for pi");
  });

  it("rejects legacy CLI values on project start", async () => {
    const createRes = await Promise.resolve(
      api.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Legacy CLI Start Reject" }),
      })
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    const startRes = await Promise.resolve(
      api.request(`/projects/${created.id}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runAgent: "cli:gemini" }),
      })
    );
    expect(startRes.status).toBe(400);
    const payload = await startRes.json();
    expect(payload.error).toContain("Unsupported CLI");
    expect(payload.error).toContain("claude, codex, pi");
  });

  it("interrupts a running subagent", async () => {
    const createRes = await Promise.resolve(
      api.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Subagent Interrupt" }),
      })
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    const repoDir = await createRepoCopy("repo-interrupt");

    const patchRes = await Promise.resolve(
      api.request(`/projects/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: repoDir }),
      })
    );
    expect(patchRes.status).toBe(200);

    const binDir = path.join(tmpDir, "bin-interrupt");
    await fs.mkdir(binDir, { recursive: true });
    const codexPath = path.join(binDir, "codex");
    const script = [
      "#!/bin/sh",
      'echo \'{"type":"thread.started","thread_id":"s2"}\'',
      "sleep 5",
    ].join("\n");
    await fs.writeFile(codexPath, script, { mode: 0o755 });
    const prevPath = process.env.PATH;
    process.env.PATH = `${binDir}:${prevPath ?? ""}`;

    const spawnRes = await Promise.resolve(
      api.request(`/projects/${created.id}/subagents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: "beta",
          cli: "codex",
          prompt: "hi",
          mode: "main-run",
        }),
      })
    );
    expect(spawnRes.status).toBe(201);

    const interruptRes = await Promise.resolve(
      api.request(`/projects/${created.id}/subagents/beta/interrupt`, {
        method: "POST",
      })
    );
    expect(interruptRes.status).toBe(200);

    const sessionDir = path.join(
      projectsRoot,
      created.path,
      "sessions",
      "beta"
    );
    const historyPath = path.join(sessionDir, "history.jsonl");
    const start = Date.now();
    while (Date.now() - start < 2000) {
      try {
        const history = await fs.readFile(historyPath, "utf8");
        if (history.includes('"worker.interrupt"')) break;
      } catch {
        // wait
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const history = await fs.readFile(historyPath, "utf8");
    expect(history).toContain('"worker.interrupt"');
    const state = JSON.parse(
      await fs.readFile(path.join(sessionDir, "state.json"), "utf8")
    ) as { interrupt_requested_at?: string };
    expect(typeof state.interrupt_requested_at).toBe("string");
    expect((state.interrupt_requested_at ?? "").length).toBeGreaterThan(0);

    process.env.PATH = prevPath;
  });

  it("resumes when slug exists and resume is true", async () => {
    const createRes = await Promise.resolve(
      api.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Subagent Resume" }),
      })
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    const repoDir = await createRepoCopy("repo-resume");

    const patchRes = await Promise.resolve(
      api.request(`/projects/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: repoDir }),
      })
    );
    expect(patchRes.status).toBe(200);

    const binDir = path.join(tmpDir, "bin-resume");
    await fs.mkdir(binDir, { recursive: true });
    const codexPath = path.join(binDir, "codex");
    const script = [
      "#!/bin/sh",
      'echo \'{"type":"thread.started","thread_id":"s1"}\'',
      'echo "$@"',
    ].join("\n");
    await fs.writeFile(codexPath, script, { mode: 0o755 });
    const prevPath = process.env.PATH;
    process.env.PATH = `${binDir}:${prevPath ?? ""}`;

    const spawnRes = await Promise.resolve(
      api.request(`/projects/${created.id}/subagents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: "gamma",
          cli: "codex",
          prompt: "hi",
          mode: "main-run",
        }),
      })
    );
    expect(spawnRes.status).toBe(201);

    const sessionDir = path.join(
      projectsRoot,
      created.path,
      "sessions",
      "gamma"
    );
    const logsPath = path.join(sessionDir, "logs.jsonl");
    const statePath = path.join(sessionDir, "state.json");
    const waitStart = Date.now();
    while (Date.now() - waitStart < 5000) {
      try {
        const state = JSON.parse(await fs.readFile(statePath, "utf8"));
        if (state.session_id === "s1") break;
      } catch {
        // wait
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const resumeState = JSON.parse(await fs.readFile(statePath, "utf8"));
    expect(resumeState.session_id).toBe("s1");

    const resumeOffset = (await fs.stat(logsPath)).size;
    const spawnRes2 = await Promise.resolve(
      api.request(`/projects/${created.id}/subagents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: "gamma",
          cli: "codex",
          prompt: "follow up",
          mode: "main-run",
          resume: true,
        }),
      })
    );
    expect(spawnRes2.status).toBe(201);

    const start = Date.now();
    while (Date.now() - start < 5000) {
      const logs = await fs.readFile(logsPath, "utf8");
      if (logs.slice(resumeOffset).includes("resume s1")) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const resumeLogs = (await fs.readFile(logsPath, "utf8")).slice(
      resumeOffset
    );
    expect(resumeLogs).toContain("resume s1");
    expect(resumeLogs).not.toContain("Let's tackle the following project:");

    process.env.PATH = prevPath;
  });

  it("reuses saved claude model on resume when model is omitted", async () => {
    const createRes = await Promise.resolve(
      api.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Subagent Claude Resume Model" }),
      })
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    const repoDir = await createRepoCopy("repo-claude-resume");

    const patchRes = await Promise.resolve(
      api.request(`/projects/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: repoDir }),
      })
    );
    expect(patchRes.status).toBe(200);

    const binDir = path.join(tmpDir, "bin-claude-resume");
    await fs.mkdir(binDir, { recursive: true });
    const claudePath = path.join(binDir, "claude");
    const script = [
      "#!/bin/sh",
      'echo \'{"type":"system","session_id":"claude-s1"}\'',
      'echo "$@"',
    ].join("\n");
    await fs.writeFile(claudePath, script, { mode: 0o755 });
    const prevPath = process.env.PATH;
    process.env.PATH = `${binDir}:${prevPath ?? ""}`;

    const spawnRes = await Promise.resolve(
      api.request(`/projects/${created.id}/subagents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: "delta",
          cli: "claude",
          prompt: "hi",
          mode: "main-run",
          model: "opus",
        }),
      })
    );
    expect(spawnRes.status).toBe(201);

    const sessionDir = path.join(
      projectsRoot,
      created.path,
      "sessions",
      "delta"
    );
    const statePath = path.join(sessionDir, "state.json");
    const waitStart = Date.now();
    while (Date.now() - waitStart < 5000) {
      try {
        const state = JSON.parse(await fs.readFile(statePath, "utf8"));
        if (state.session_id === "claude-s1") break;
      } catch {
        // wait
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const resumeState = JSON.parse(await fs.readFile(statePath, "utf8"));
    expect(resumeState.session_id).toBe("claude-s1");

    const logsPath = path.join(sessionDir, "logs.jsonl");
    const resumeOffset = (await fs.stat(logsPath)).size;
    const resumeRes = await Promise.resolve(
      api.request(`/projects/${created.id}/subagents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: "delta",
          cli: "claude",
          prompt: "follow up",
          mode: "main-run",
          resume: true,
        }),
      })
    );
    expect(resumeRes.status).toBe(201);

    const start = Date.now();
    while (Date.now() - start < 2000) {
      const logs = await fs.readFile(logsPath, "utf8");
      if (logs.slice(resumeOffset).includes("-r claude-s1")) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const resumeLogs = (await fs.readFile(logsPath, "utf8")).slice(
      resumeOffset
    );
    expect(resumeLogs).toContain("-r claude-s1");
    expect(resumeLogs).toContain("--model opus");
    expect(resumeLogs).not.toContain("--model sonnet");
    expect(resumeLogs).not.toContain("Let's tackle the following project:");

    process.env.PATH = prevPath;
  }, 15000);

  it("reuses saved pi session file on resume", async () => {
    const createRes = await Promise.resolve(
      api.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Subagent Pi Resume Session" }),
      })
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    const repoDir = await createRepoCopy("repo-pi-resume");

    const patchRes = await Promise.resolve(
      api.request(`/projects/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: repoDir }),
      })
    );
    expect(patchRes.status).toBe(200);

    const binDir = path.join(tmpDir, "bin-pi-resume");
    await fs.mkdir(binDir, { recursive: true });
    const piPath = path.join(binDir, "pi");
    const script = [
      "#!/bin/sh",
      'echo "$@"',
      `echo '{"type":"session","id":"pi-resume-s1","timestamp":"2026-02-01T00:00:00.000Z","cwd":"$PWD"}'`,
      `echo '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}'`,
    ].join("\n");
    await fs.writeFile(piPath, script, { mode: 0o755 });
    const prevPath = process.env.PATH;
    process.env.PATH = `${binDir}:${prevPath ?? ""}`;

    const spawnRes = await Promise.resolve(
      api.request(`/projects/${created.id}/subagents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: "pi-resume",
          cli: "pi",
          prompt: "seed",
          mode: "main-run",
        }),
      })
    );
    expect(spawnRes.status).toBe(201);

    const sessionDir = path.join(
      projectsRoot,
      created.path,
      "sessions",
      "pi-resume"
    );
    const statePath = path.join(sessionDir, "state.json");
    const waitStart = Date.now();
    while (Date.now() - waitStart < 5000) {
      try {
        const state = JSON.parse(await fs.readFile(statePath, "utf8")) as {
          session_id?: string;
        };
        if (state.session_id === "pi-resume-s1") break;
      } catch {
        // wait
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as {
      session_id?: string;
      session_file?: string;
    };
    expect(state.session_id).toBe("pi-resume-s1");
    expect(typeof state.session_file).toBe("string");
    expect(state.session_file?.endsWith("pi-session.jsonl")).toBe(true);

    const logsPath = path.join(sessionDir, "logs.jsonl");
    const resumeOffset = (await fs.stat(logsPath)).size;
    const resumeRes = await Promise.resolve(
      api.request(`/projects/${created.id}/subagents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: "pi-resume",
          cli: "pi",
          prompt: "follow up",
          mode: "main-run",
          resume: true,
        }),
      })
    );
    expect(resumeRes.status).toBe(201);

    const start = Date.now();
    while (Date.now() - start < 2000) {
      const logs = await fs.readFile(logsPath, "utf8");
      const slice = logs.slice(resumeOffset);
      if (slice.includes("--session") && slice.includes("pi-session.jsonl")) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const resumeLogs = (await fs.readFile(logsPath, "utf8")).slice(
      resumeOffset
    );
    expect(resumeLogs).toContain("--session");
    expect(resumeLogs).toContain("pi-session.jsonl");
    expect(resumeLogs).not.toContain("Let's tackle the following project:");

    process.env.PATH = prevPath;
  }, 15000);

  it("returns 400 when resume prompt exceeds configured byte limit", async () => {
    const createRes = await Promise.resolve(
      api.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Resume Limit" }),
      })
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    const repoDir = await createRepoCopy("repo-resume-limit");

    const patchRes = await Promise.resolve(
      api.request(`/projects/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: repoDir }),
      })
    );
    expect(patchRes.status).toBe(200);

    const prevResumeLimit = process.env.YOPLAI_SUBAGENT_RESUME_MAX_PROMPT_BYTES;
    process.env.YOPLAI_SUBAGENT_RESUME_MAX_PROMPT_BYTES = "64";
    let resumeRes: Response;
    try {
      resumeRes = await Promise.resolve(
        api.request(`/projects/${created.id}/subagents`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            slug: "resume-limit",
            cli: "codex",
            prompt: "x".repeat(200),
            mode: "main-run",
            resume: true,
          }),
        })
      );
    } finally {
      if (prevResumeLimit === undefined) {
        delete process.env.YOPLAI_SUBAGENT_RESUME_MAX_PROMPT_BYTES;
      } else {
        process.env.YOPLAI_SUBAGENT_RESUME_MAX_PROMPT_BYTES = prevResumeLimit;
      }
    }
    expect(resumeRes.status).toBe(400);
    const payload = await resumeRes.json();
    expect(payload.error).toContain("Prompt too large for resume:");
    expect(payload.error).toContain("> 64 bytes");
  }, 15000);

  it("returns 400 when spawn prompt exceeds configured byte limit", async () => {
    const createRes = await Promise.resolve(
      api.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Spawn Limit" }),
      })
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    const repoDir = await createRepoCopy("repo-spawn-limit");

    const patchRes = await Promise.resolve(
      api.request(`/projects/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: repoDir }),
      })
    );
    expect(patchRes.status).toBe(200);

    const prevLimit = process.env.YOPLAI_SUBAGENT_MAX_PROMPT_BYTES;
    process.env.YOPLAI_SUBAGENT_MAX_PROMPT_BYTES = "64";
    let spawnRes: Response;
    try {
      spawnRes = await Promise.resolve(
        api.request(`/projects/${created.id}/subagents`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            slug: "spawn-limit",
            cli: "codex",
            prompt: "x".repeat(200),
            mode: "main-run",
          }),
        })
      );
    } finally {
      if (prevLimit === undefined) {
        delete process.env.YOPLAI_SUBAGENT_MAX_PROMPT_BYTES;
      } else {
        process.env.YOPLAI_SUBAGENT_MAX_PROMPT_BYTES = prevLimit;
      }
    }
    expect(spawnRes.status).toBe(400);
    const payload = await spawnRes.json();
    expect(payload.error).toContain("Prompt too large for start/spawn:");
    expect(payload.error).toContain("> 64 bytes");
  }, 15000);

  it("creates worktree when mode is worktree", async () => {
    const createRes = await Promise.resolve(
      api.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Subagent Worktree" }),
      })
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    const repoDir = await createRepoCopy("repo-worktree");

    const patchRes = await Promise.resolve(
      api.request(`/projects/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: repoDir }),
      })
    );
    expect(patchRes.status).toBe(200);

    const binDir = path.join(tmpDir, "bin-worktree");
    await fs.mkdir(binDir, { recursive: true });
    const codexPath = path.join(binDir, "codex");
    const script = [
      "#!/bin/sh",
      'echo \'{"type":"thread.started","thread_id":"s1"}\'',
    ].join("\n");
    await fs.writeFile(codexPath, script, { mode: 0o755 });
    const prevPath = process.env.PATH;
    process.env.PATH = `${binDir}:${prevPath ?? ""}`;

    const spawnRes = await Promise.resolve(
      api.request(`/projects/${created.id}/subagents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: "delta",
          cli: "codex",
          prompt: "hi",
          mode: "worktree",
          baseBranch: "main",
        }),
      })
    );
    expect(spawnRes.status).toBe(201);

    const workDir = path.join(projectsRoot, ".workspaces", created.id, "delta");
    const gitPath = path.join(workDir, ".git");
    const start = Date.now();
    while (Date.now() - start < 2000) {
      try {
        await fs.stat(gitPath);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    await expect(fs.stat(gitPath)).resolves.toBeDefined();

    const listRes = await execFileAsync("git", [
      "-C",
      repoDir,
      "worktree",
      "list",
      "--porcelain",
    ]);
    // Resolve symlinks (macOS /var -> /private/var)
    const realWorkDir = await fs.realpath(workDir);
    expect(listRes.stdout).toContain(`worktree ${realWorkDir}`);

    process.env.PATH = prevPath;
  }, 15000);

  it("resolves repo from area fallback when frontmatter repo is missing", async () => {
    const createRes = await Promise.resolve(
      api.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Subagent Area Repo Fallback" }),
      })
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    const repoDir = await createRepoCopy("repo-area-fallback");

    const createAreaRes = await Promise.resolve(
      api.request("/areas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "qa",
          title: "QA",
          color: "#123456",
          repo: repoDir,
        }),
      })
    );
    expect(createAreaRes.status).toBe(201);

    const patchRes = await Promise.resolve(
      api.request(`/projects/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ area: "qa" }),
      })
    );
    expect(patchRes.status).toBe(200);

    const projectReadmePath = path.join(
      projectsRoot,
      created.path,
      "README.md"
    );
    const readme = await fs.readFile(projectReadmePath, "utf8");
    expect(readme).not.toContain("repo:");

    const binDir = path.join(tmpDir, "bin-area-fallback");
    await fs.mkdir(binDir, { recursive: true });
    const codexPath = path.join(binDir, "codex");
    const script = [
      "#!/bin/sh",
      'echo \'{"type":"thread.started","thread_id":"s-area-fallback"}\'',
    ].join("\n");
    await fs.writeFile(codexPath, script, { mode: 0o755 });
    const prevPath = process.env.PATH;
    process.env.PATH = `${binDir}:${prevPath ?? ""}`;

    const spawnRes = await Promise.resolve(
      api.request(`/projects/${created.id}/subagents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: "area-worker",
          cli: "codex",
          prompt: "hi",
          mode: "worktree",
          baseBranch: "main",
        }),
      })
    );
    expect(spawnRes.status).toBe(201);

    const workDir = path.join(
      projectsRoot,
      ".workspaces",
      created.id,
      "area-worker"
    );
    await expect(fs.stat(path.join(workDir, ".git"))).resolves.toBeDefined();

    process.env.PATH = prevPath;
  }, 15000);

  it("creates clone when mode is clone and adds named remote", async () => {
    const createRes = await Promise.resolve(
      api.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Subagent Clone" }),
      })
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    const repoDir = await createRepoCopy("repo-clone");

    const patchRes = await Promise.resolve(
      api.request(`/projects/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: repoDir }),
      })
    );
    expect(patchRes.status).toBe(200);

    const binDir = path.join(tmpDir, "bin-clone");
    await fs.mkdir(binDir, { recursive: true });
    const codexPath = path.join(binDir, "codex");
    const script = [
      "#!/bin/sh",
      'echo \'{"type":"thread.started","thread_id":"s1"}\'',
    ].join("\n");
    await fs.writeFile(codexPath, script, { mode: 0o755 });
    const prevPath = process.env.PATH;
    process.env.PATH = `${binDir}:${prevPath ?? ""}`;

    const spawnRes = await Promise.resolve(
      api.request(`/projects/${created.id}/subagents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: "sigma",
          cli: "codex",
          prompt: "hi",
          mode: "clone",
          baseBranch: "main",
        }),
      })
    );
    expect(spawnRes.status).toBe(201);

    const cloneDir = path.join(
      projectsRoot,
      ".workspaces",
      created.id,
      "sigma"
    );
    await expect(fs.stat(path.join(cloneDir, ".git"))).resolves.toBeDefined();
    const branchRes = await execFileAsync("git", [
      "-C",
      cloneDir,
      "branch",
      "--show-current",
    ]);
    expect(branchRes.stdout.trim()).toBe(`${created.id}/sigma`);

    const remote = `agent-${String(created.id).toLowerCase()}`;
    const remoteUrl = await execFileAsync("git", [
      "-C",
      repoDir,
      "remote",
      "get-url",
      remote,
    ]);
    const realCloneDir = await fs.realpath(cloneDir);
    expect(remoteUrl.stdout.trim()).toBe(realCloneDir);

    process.env.PATH = prevPath;
  }, 15000);

  it("kills clone subagent and removes named remote", async () => {
    const createRes = await Promise.resolve(
      api.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Subagent Kill Clone" }),
      })
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    const repoDir = await createRepoCopy("repo-kill-clone");

    const patchRes = await Promise.resolve(
      api.request(`/projects/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: repoDir }),
      })
    );
    expect(patchRes.status).toBe(200);

    const workspacesRoot = path.join(projectsRoot, ".workspaces", created.id);
    await fs.mkdir(workspacesRoot, { recursive: true });
    const cloneDir = path.join(workspacesRoot, "omega");
    const branch = `${created.id}/omega`;
    await execFileAsync("git", ["clone", repoDir, cloneDir]);
    await execFileAsync("git", [
      "-C",
      cloneDir,
      "checkout",
      "-b",
      branch,
      "origin/main",
    ]);
    const remote = `agent-${String(created.id).toLowerCase()}`;
    await execFileAsync("git", [
      "-C",
      repoDir,
      "remote",
      "add",
      remote,
      cloneDir,
    ]);

    const now = new Date().toISOString();
    const state = {
      session_id: "s1",
      supervisor_pid: 0,
      started_at: now,
      last_error: "",
      cli: "codex",
      run_mode: "clone",
      worktree_path: cloneDir,
      base_branch: "main",
    };
    const sessionDir = path.join(
      projectsRoot,
      created.path,
      "sessions",
      "omega"
    );
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, "state.json"),
      JSON.stringify(state, null, 2)
    );

    const killRes = await Promise.resolve(
      api.request(`/projects/${created.id}/subagents/omega/kill`, {
        method: "POST",
      })
    );
    expect(killRes.status).toBe(200);

    await expect(fs.stat(cloneDir)).rejects.toThrow();
    const remotes = await execFileAsync("git", ["-C", repoDir, "remote"]);
    expect(remotes.stdout).not.toContain(remote);
  }, 15000);

  it("kills worktree subagent and removes branch", async () => {
    const createRes = await Promise.resolve(
      api.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Subagent Kill Worktree" }),
      })
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    const repoDir = await createRepoCopy("repo-kill-worktree");

    const patchRes = await Promise.resolve(
      api.request(`/projects/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: repoDir }),
      })
    );
    expect(patchRes.status).toBe(200);

    const workspacesRoot = path.join(projectsRoot, ".workspaces", created.id);
    await fs.mkdir(workspacesRoot, { recursive: true });
    const workspaceDir = path.join(workspacesRoot, "omega");
    const branch = `${created.id}/omega`;
    await execFileAsync("git", [
      "-C",
      repoDir,
      "worktree",
      "add",
      "-b",
      branch,
      workspaceDir,
      "main",
    ]);

    const now = new Date().toISOString();
    const state = {
      session_id: "s1",
      supervisor_pid: 0,
      started_at: now,
      last_error: "",
      cli: "codex",
      run_mode: "worktree",
      worktree_path: workspaceDir,
      base_branch: "main",
    };
    const sessionDir = path.join(
      projectsRoot,
      created.path,
      "sessions",
      "omega"
    );
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, "state.json"),
      JSON.stringify(state, null, 2)
    );

    const killRes = await Promise.resolve(
      api.request(`/projects/${created.id}/subagents/omega/kill`, {
        method: "POST",
      })
    );
    expect(killRes.status).toBe(200);

    await expect(fs.stat(workspaceDir)).rejects.toThrow();
    const branchRes = await execFileAsync("git", [
      "-C",
      repoDir,
      "branch",
      "--list",
      branch,
    ]);
    expect(branchRes.stdout.trim()).toBe("");
  }, 15000);

  it("kills main-run subagent by removing workspace", async () => {
    const createRes = await Promise.resolve(
      api.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Subagent Kill Main Run" }),
      })
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    const sessionDir = path.join(projectsRoot, created.path, "sessions", "eta");
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, "state.json"),
      JSON.stringify({ supervisor_pid: 0, run_mode: "main-run" }, null, 2)
    );

    const killRes = await Promise.resolve(
      api.request(`/projects/${created.id}/subagents/eta/kill`, {
        method: "POST",
      })
    );
    expect(killRes.status).toBe(200);
    await expect(fs.stat(sessionDir)).rejects.toThrow();
  });

  it("returns error when subagent missing on kill", async () => {
    const createRes = await Promise.resolve(
      api.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Subagent Kill Missing" }),
      })
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    const killRes = await Promise.resolve(
      api.request(`/projects/${created.id}/subagents/missing/kill`, {
        method: "POST",
      })
    );
    expect(killRes.status).toBe(404);
    const body = await killRes.json();
    expect(body.error).toBe("Subagent not found: missing");
  });

  it("SIGTERMs running subagent before cleanup", async () => {
    const createRes = await Promise.resolve(
      api.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Subagent Kill Running" }),
      })
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    const sessionDir = path.join(
      projectsRoot,
      created.path,
      "sessions",
      "theta"
    );
    await fs.mkdir(sessionDir, { recursive: true });
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore" }
    );
    expect(child.pid).toBeDefined();
    const exitPromise = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      child.on("exit", (code, signal) => resolve({ code, signal }));
    });
    await fs.writeFile(
      path.join(sessionDir, "state.json"),
      JSON.stringify(
        { supervisor_pid: child.pid, run_mode: "main-run" },
        null,
        2
      )
    );

    const killRes = await Promise.resolve(
      api.request(`/projects/${created.id}/subagents/theta/kill`, {
        method: "POST",
      })
    );
    expect(killRes.status).toBe(200);

    const exitResult = await Promise.race([
      exitPromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
    ]);
    if (exitResult === null) {
      child.kill("SIGKILL");
    }
    expect(exitResult).not.toBeNull();
  });

  it("resolves cli from common install locations", async () => {
    const createRes = await Promise.resolve(
      api.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Subagent Resolve" }),
      })
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    const repoDir = await createRepoCopy("repo-resolve");

    const patchRes = await Promise.resolve(
      api.request(`/projects/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: repoDir }),
      })
    );
    expect(patchRes.status).toBe(200);

    const claudeDir = path.join(tmpDir, ".claude", "local");
    await fs.mkdir(claudeDir, { recursive: true });
    const claudePath = path.join(claudeDir, "claude");
    const script = [
      "#!/bin/sh",
      'echo \'{"type":"thread.started","thread_id":"s1"}\'',
    ].join("\n");
    await fs.writeFile(claudePath, script, { mode: 0o755 });

    const prevPath = process.env.PATH;
    process.env.PATH = "/usr/bin:/bin";

    const spawnRes = await Promise.resolve(
      api.request(`/projects/${created.id}/subagents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: "epsilon",
          cli: "claude",
          prompt: "hi",
          mode: "main-run",
        }),
      })
    );
    expect(spawnRes.status).toBe(201);

    process.env.PATH = prevPath;
  });

  it("returns agent statuses", async () => {
    const res = await Promise.resolve(api.request("/agents/status"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.statuses["test-agent"]).toBe("idle");
  });

  it("returns activity feed", async () => {
    const res = await Promise.resolve(api.request("/activity"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.events)).toBe(true);
  });
});
