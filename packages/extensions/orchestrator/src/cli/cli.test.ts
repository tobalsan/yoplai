import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { OrchestratorApiClient } from "./client.js";
import { initProject, initWorkflow, planeBootstrap, planeIdentifier, registerOrchestratorCommands, safeProjectName } from "./index.js";
import type { PlaneBootstrapEnv, TrackerBootstrap } from "./index.js";

describe("orchestrator CLI client", () => {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

  beforeEach(() => {
    calls.length = 0;
    vi.clearAllMocks();
  });

  it("maps verbs to /api/orchestrator routes", async () => {
    const client = new OrchestratorApiClient({ apiUrl: "http://localhost:4000" }, fetchImpl);

    await client.health();
    await client.projects();
    await client.runs(20, "ENG-1", "yoplai");
    await client.workflow("yoplai");
    await client.claim("ENG-1", "yoplai");
    await client.release("ENG-1", "yoplai");
    await client.interrupt("ENG-1", "yoplai");
    await client.kill("ENG-1", "yoplai");
    await client.export("yoplai", "/tmp/snap");
    await client.tick("yoplai");

    expect(calls).toEqual([
      "http://localhost:4000/api/orchestrator/health",
      "http://localhost:4000/api/orchestrator/projects",
      "http://localhost:4000/api/orchestrator/runs?limit=20&issue=ENG-1&project=yoplai",
      "http://localhost:4000/api/orchestrator/workflow?project=yoplai",
      "http://localhost:4000/api/orchestrator/issues/ENG-1/claim?project=yoplai",
      "http://localhost:4000/api/orchestrator/runs/ENG-1/release?project=yoplai",
      "http://localhost:4000/api/orchestrator/runs/ENG-1/interrupt?project=yoplai",
      "http://localhost:4000/api/orchestrator/runs/ENG-1/kill?project=yoplai",
      "http://localhost:4000/api/orchestrator/export?project=yoplai&out=%2Ftmp%2Fsnap",
      "http://localhost:4000/api/orchestrator/tick?project=yoplai",
    ]);
  });
});

describe("registerOrchestratorCommands", () => {
  it("registers required verbs", () => {
    const program = new Command();
    registerOrchestratorCommands(program.command("orchestrator"));

    const verbs = program.commands[0]?.commands.map((command) => command.name()).sort();
    expect(verbs).toEqual([
      "claim",
      "events",
      "export",
      "init-project",
      "init-workflow",
      "interrupt",
      "kill",
      "logs",
      "projects",
      "release",
      "runs",
      "status",
      "tick",
      "workflow",
    ]);
  });

  it("creates project workflow templates explicitly", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-cli-"));
    const project = path.join(root, "project");

    const workflowPath = await initWorkflow(project, { projectSlug: "yoplai", profile: "worker" });
    const content = await fs.readFile(workflowPath, "utf8");

    expect(workflowPath).toBe(path.join(project, "WORKFLOW.md"));
    expect(content).toContain("project_slug: yoplai");
    expect(content).toContain("api_key: $LINEAR_API_KEY");
    expect(content).toContain("runner: pi");
    expect(content).toContain("profile: worker");
    expect(content).toContain("## DO THIS FIRST");
    expect(content).toContain("Fetch Linear issue {{issue.identifier}}.");
    expect(content).toContain("Do not perform task work before this claim step.");
    expect(content).toContain("## Workspace Rule");
    expect(content).toContain("## Linear Workflow");
    expect(content).toContain("move the issue to `In Review`");
    expect(content).toContain("## Code Changes and Review Flow");
    expect(content).toContain("Create a worktree from the `main` branch");
    expect(content).toContain("Spawn a reviewer subagent");
    expect(content).toContain("## Golden Rule: Clarification Over Assumption");
    await expect(initWorkflow(project, { projectSlug: "yoplai" })).rejects.toThrow("WORKFLOW.md already exists");
  });

  it("sanitizes project names for folder creation", () => {
    expect(safeProjectName("Foo Bar")).toBe("foo-bar");
    expect(safeProjectName("  Déjà Vu / 2026!  ")).toBe("deja-vu-2026");
    expect(() => safeProjectName("!!!")).toThrow("Project name must contain at least one letter or number");
  });

  it("creates Linear project, folder, workflow, and registers config", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-project-"));
    const projectsRoot = path.join(root, "projects");
    const configPath = path.join(root, "yoplai.json");
    await fs.writeFile(configPath, JSON.stringify({ extensions: { orchestrator: { projectsRoot, projects: [] } } }), "utf8");
    const linear = {
      findProjectByName: vi.fn(async () => undefined),
      inferProjectTeamIds: vi.fn(async () => ["team-1"]),
      createProject: vi.fn(async () => ({ id: "project-1", name: "Foo Bar", slugId: "foo-bar-linear" })),
    };

    const result = await initProject("Foo Bar", { profile: "reviewer", linearClient: linear as any, configPath });
    const workflow = await fs.readFile(result.workflowPath, "utf8");
    const config = JSON.parse(await fs.readFile(configPath, "utf8"));

    expect(result.projectPath).toBe(path.join(projectsRoot, "foo-bar"));
    expect(workflow).toContain("project_slug: foo-bar-linear");
    expect(workflow).toContain("runner: pi");
    expect(workflow).toContain("profile: reviewer");
    expect(workflow).toContain("## DO THIS FIRST");
    expect(workflow).toContain("## Code Changes and Review Flow");
    expect(workflow).toContain("## Golden Rule: Clarification Over Assumption");
    expect(config.extensions.orchestrator.projects).toEqual([path.join(projectsRoot, "foo-bar")]);
    expect(linear.createProject).toHaveBeenCalledWith({ name: "Foo Bar", teamIds: ["team-1"] });
  });

  it("creates Plane project workflow from bootstrap metadata", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-plane-project-"));
    const projectsRoot = path.join(root, "projects");
    const configPath = path.join(root, "yoplai.json");
    await fs.writeFile(configPath, JSON.stringify({ extensions: { orchestrator: { projectsRoot, projects: [] } } }), "utf8");
    const bootstrap: TrackerBootstrap = {
      findExisting: vi.fn(async () => undefined),
      provision: vi.fn(async () => ({
        id: "mod-1",
        label: "Plane module Foo Bar",
        workflowTracker: { kind: "plane", workspace_slug: "ws-a", project_id: "proj-a", module_id: "mod-1", base_url: "https://plane.example" },
      })),
      rollback: vi.fn(async () => undefined),
    };

    const result = await initProject("Foo Bar", { profile: "reviewer", tracker: "plane", bootstrap, configPath });
    const workflow = await fs.readFile(result.workflowPath, "utf8");
    const config = JSON.parse(await fs.readFile(configPath, "utf8"));

    expect(workflow).toContain("kind: plane");
    expect(workflow).toContain("base_url: https://plane.example");
    expect(workflow).toContain("workspace_slug: ws-a");
    expect(workflow).toContain("project_id: proj-a");
    expect(workflow).toContain("module_id: mod-1");
    expect(workflow).toContain("api_key: $PLANE_API_KEY");
    expect(workflow).toContain("auth_kind: api_key");
    expect(workflow).toContain("Fetch Plane issue {{issue.identifier}}.");
    expect(workflow).toContain("## Plane Workflow");
    expect(config.extensions.orchestrator.projects).toEqual([path.join(projectsRoot, "foo-bar")]);
    expect(bootstrap.provision).toHaveBeenCalledWith("Foo Bar");
  });

  it("defaults projectsRoot to ~/projects", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-home-"));
    const homedir = vi.spyOn(os, "homedir").mockReturnValue(home);
    const configPath = path.join(home, ".yoplai", "yoplai.json");
    const linear = {
      findProjectByName: vi.fn(async () => undefined),
      inferProjectTeamIds: vi.fn(async () => ["team-1"]),
      createProject: vi.fn(async () => ({ id: "project-1", name: "Default Root", slugId: "default-root" })),
    };
    try {
      const result = await initProject("Default Root", { linearClient: linear as any, configPath });
      expect(result.projectPath).toBe(path.join(home, "projects", "default-root"));
    } finally {
      homedir.mockRestore();
    }
  });

  it("fails before Linear creation when the folder already exists", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-exists-"));
    const projectsRoot = path.join(root, "projects");
    const configPath = path.join(root, "yoplai.json");
    await fs.mkdir(path.join(projectsRoot, "foo-bar"), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify({ extensions: { orchestrator: { projectsRoot } } }), "utf8");
    const linear = {
      findProjectByName: vi.fn(),
      inferProjectTeamIds: vi.fn(),
      createProject: vi.fn(),
    };

    await expect(initProject("Foo Bar", { linearClient: linear as any, configPath })).rejects.toThrow("Project folder already exists");
    expect(linear.findProjectByName).not.toHaveBeenCalled();
    expect(linear.createProject).not.toHaveBeenCalled();
  });

  it("fails before local scaffolding when Linear project already exists", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-duplicate-"));
    const projectsRoot = path.join(root, "projects");
    const configPath = path.join(root, "yoplai.json");
    await fs.writeFile(configPath, JSON.stringify({ extensions: { orchestrator: { projectsRoot } } }), "utf8");
    const linear = {
      findProjectByName: vi.fn(async () => ({ id: "project-1", name: "Foo Bar", slugId: "foo-bar" })),
      inferProjectTeamIds: vi.fn(),
      createProject: vi.fn(),
    };

    await expect(initProject("Foo Bar", { linearClient: linear as any, configPath })).rejects.toThrow("Linear project already exists");
    await expect(fs.access(path.join(projectsRoot, "foo-bar"))).rejects.toThrow();
    expect(linear.createProject).not.toHaveBeenCalled();
  });

  it("rolls back Linear project and local folder when registration fails after creation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-rollback-"));
    const projectsRoot = path.join(root, "projects");
    const configPath = path.join(root, "yoplai.json");
    await fs.writeFile(configPath, JSON.stringify({ extensions: { orchestrator: { projectsRoot, projects: [] } } }), "utf8");
    await fs.chmod(configPath, 0o444);
    const linear = {
      findProjectByName: vi.fn(async () => undefined),
      inferProjectTeamIds: vi.fn(async () => ["team-1"]),
      createProject: vi.fn(async () => ({ id: "project-1", name: "Foo Bar", slugId: "foo-bar" })),
      deleteProject: vi.fn(async () => undefined),
    };
    try {
      await expect(initProject("Foo Bar", { linearClient: linear as any, configPath })).rejects.toThrow();
      expect(linear.deleteProject).toHaveBeenCalledWith("project-1");
      await expect(fs.access(path.join(projectsRoot, "foo-bar"))).rejects.toThrow();
    } finally {
      await fs.chmod(configPath, 0o644).catch(() => undefined);
    }
  });
});

describe("planeIdentifier", () => {
  it("derives an identifier from initials for multi-word names", () => {
    expect(planeIdentifier("Foo Bar Baz")).toBe("FBB");
  });

  it("uppercases and strips symbols for single-word names", () => {
    expect(planeIdentifier("foo-bar_2026!")).toBe("FOOBAR2026");
  });

  it("throws when no letters or numbers remain", () => {
    expect(() => planeIdentifier("!!!")).toThrow("Cannot derive a Plane project identifier from name");
  });
});

describe("planeBootstrap", () => {
  const projectEnv: PlaneBootstrapEnv = {
    apiKey: "token-1",
    authKind: "api_key",
    workspaceSlug: "ws-a",
    baseUrl: "https://plane.example",
  };
  const moduleEnv: PlaneBootstrapEnv = { ...projectEnv, projectId: "proj-a" };

  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("finds an existing project by name", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [{ id: "proj-1", name: "Foo Bar", identifier: "FB" }] }), { status: 200 })
    );

    const found = await planeBootstrap(projectEnv).findExisting("Foo Bar");

    expect(found).toEqual({ id: "proj-1", label: "Foo Bar (FB)" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://plane.example/api/v1/workspaces/ws-a/projects/?per_page=100",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("provisions a project and returns workflow tracker metadata", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "proj-1", name: "Foo Bar", identifier: "FB" }), { status: 200 })
    );

    const result = await planeBootstrap(projectEnv).provision("Foo Bar");

    expect(result).toEqual({
      id: "proj-1",
      label: "Plane project Foo Bar (FB)",
      workflowTracker: {
        kind: "plane",
        workspace_slug: "ws-a",
        base_url: "https://plane.example",
        api_key: "$PLANE_API_KEY",
        auth_kind: "api_key",
        project_id: "proj-1",
      },
    });
    const [, requestInit] = fetchMock.mock.calls[0];
    expect(requestInit.method).toBe("POST");
    expect(JSON.parse(requestInit.body)).toEqual({ name: "Foo Bar", identifier: "FB" });
  });

  it("rolls back a project by id", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await planeBootstrap(projectEnv).rollback("proj-1");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://plane.example/api/v1/workspaces/ws-a/projects/proj-1/",
      expect.objectContaining({ method: "DELETE" })
    );
  });

  it("finds an existing module by name scoped to the project", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [{ id: "mod-1", name: "Foo Bar" }] }), { status: 200 })
    );

    const found = await planeBootstrap(moduleEnv).findExisting("Foo Bar");

    expect(found).toEqual({ id: "mod-1", label: "Foo Bar (module)" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://plane.example/api/v1/workspaces/ws-a/projects/proj-a/modules/?per_page=100",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("provisions a module under the configured project", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ id: "mod-1", name: "Foo Bar" }), { status: 200 }));

    const result = await planeBootstrap(moduleEnv).provision("Foo Bar");

    expect(result).toEqual({
      id: "mod-1",
      label: "Plane module Foo Bar",
      workflowTracker: {
        kind: "plane",
        workspace_slug: "ws-a",
        base_url: "https://plane.example",
        api_key: "$PLANE_API_KEY",
        auth_kind: "api_key",
        project_id: "proj-a",
        module_id: "mod-1",
      },
    });
    const [url, requestInit] = fetchMock.mock.calls[0];
    expect(url).toBe("https://plane.example/api/v1/workspaces/ws-a/projects/proj-a/modules/");
    expect(JSON.parse(requestInit.body)).toEqual({ name: "Foo Bar" });
  });

  it("rolls back a module by id scoped to the project", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await planeBootstrap(moduleEnv).rollback("mod-1");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://plane.example/api/v1/workspaces/ws-a/projects/proj-a/modules/mod-1/",
      expect.objectContaining({ method: "DELETE" })
    );
  });
});
