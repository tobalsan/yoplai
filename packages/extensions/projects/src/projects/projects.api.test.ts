import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import os from "node:os";
import { writeTestV3Config } from "../../../../../apps/gateway/src/test-utils/v3-config.js";

let clearProjectsContextForTest: (() => void) | undefined;

describe("projects API", () => {
  let tmpDir: string;
  let projectsRoot: string;
  let api: {
    request: (
      input: RequestInfo,
      init?: RequestInit
    ) => Response | Promise<Response>;
  };
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-projects-"));
    projectsRoot = path.join(tmpDir, "projects");

    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpDir;
    process.env.USERPROFILE = tmpDir;

    const configDir = path.join(tmpDir, ".yoplai");
    await writeTestV3Config(configDir, {
      agents: [
        {
          id: "test-agent",
          name: "Test Agent",
          model: { provider: "anthropic", model: "claude-3-5-sonnet-20241022" },
        },
      ],
      extensions: {
        projects: { enabled: true, root: projectsRoot },
      },
    });
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
        projects: { enabled: true, root: projectsRoot },
      },
    };

    vi.resetModules();
    const { setProjectsContext, clearProjectsContext } =
      await import("../context.js");
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

    const { clearConfigCacheForTests, loadConfig } =
      await import("../../../../../apps/gateway/src/config/index.js");
    clearConfigCacheForTests();
    const { loadExtensions } =
      await import("../../../../../apps/gateway/src/extensions/registry.js");
    const mod =
      await import("../../../../../apps/gateway/src/server/api.core.js");
    api = mod.api;
    const extensions = await loadExtensions(loadConfig());
    for (const extension of extensions) {
      extension.registerRoutes(api as never);
    }
  });

  afterAll(async () => {
    clearProjectsContextForTest?.();
    clearProjectsContextForTest = undefined;

    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("creates and updates project files in temp root", async () => {
    const createRes = await Promise.resolve(
      api.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Add Project Mgmt v1",
        }),
      })
    );

    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    const createdDir = path.join(projectsRoot, created.path);
    const createdReadme = path.join(createdDir, "README.md");
    const createdPitch = path.join(createdDir, "PITCH.md");
    const createdThread = path.join(createdDir, "THREAD.md");

    await expect(fs.stat(createdDir)).resolves.toBeDefined();
    await expect(fs.stat(createdReadme)).resolves.toBeDefined();
    await expect(fs.stat(createdPitch)).resolves.toBeDefined();
    await expect(fs.stat(createdThread)).resolves.toBeDefined();

    const listRes = await Promise.resolve(api.request("/projects"));
    expect(listRes.status).toBe(200);
    const list = await listRes.json();
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(created.id);

    const getRes = await Promise.resolve(
      api.request(`/projects/${created.id}`)
    );
    expect(getRes.status).toBe(200);
    const fetched = await getRes.json();
    expect(fetched.docs.PITCH).toBe("");

    const updateRes = await Promise.resolve(
      api.request(`/projects/${created.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Project Mgmt API",
          readme: "# Project Mgmt API\n\nOverview.\n",
          specs: "# Project Mgmt API Specs\n\nUpdated content.\n",
          status: "shaping",
          repo: "/tmp/repo",
        }),
      })
    );

    expect(updateRes.status).toBe(200);
    const updated = await updateRes.json();
    const updatedDir = path.join(projectsRoot, updated.path);
    const updatedReadme = path.join(updatedDir, "README.md");
    const updatedSpecs = path.join(updatedDir, "SPECS.md");

    await expect(fs.stat(updatedDir)).resolves.toBeDefined();
    await expect(fs.stat(updatedReadme)).resolves.toBeDefined();
    await expect(fs.stat(updatedSpecs)).resolves.toBeDefined();
    await expect(fs.access(createdDir)).rejects.toBeDefined();

    const updatedContent = await fs.readFile(updatedReadme, "utf8");
    const updatedSpecsContent = await fs.readFile(updatedSpecs, "utf8");
    expect(updatedContent).toContain("# Project Mgmt API");
    expect(updatedContent).toContain('status: "shaping"');
    expect(updatedSpecsContent).toContain("# Project Mgmt API Specs");
  });

  it("rejects invalid create payloads", async () => {
    const invalidTitle = await Promise.resolve(
      api.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Solo",
        }),
      })
    );

    expect(invalidTitle.status).toBe(400);
    const invalidTitleBody = await invalidTitle.json();
    expect(invalidTitleBody.error).toContain(
      "Title must contain at least two words"
    );
  });

  it("validates repo paths without persisting a project", async () => {
    const repoDir = path.join(tmpDir, "valid-api-repo");
    await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });

    const validRes = await Promise.resolve(
      api.request("/projects/validate-repo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: repoDir }),
      })
    );
    const invalidRes = await Promise.resolve(
      api.request("/projects/validate-repo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: path.join(tmpDir, "missing") }),
      })
    );

    expect(validRes.status).toBe(200);
    await expect(validRes.json()).resolves.toEqual({ valid: true });
    expect(invalidRes.status).toBe(200);
    await expect(invalidRes.json()).resolves.toEqual({ valid: false });
  });

  it("creates project with active fields", async () => {
    const createRes = await Promise.resolve(
      api.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Metadata Project",
          pitch: "Track the active form fields.",
          status: "shaping",
        }),
      })
    );

    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.frontmatter.status).toBe("shaping");

    const readmePath = path.join(projectsRoot, created.path, "README.md");
    const pitchPath = path.join(projectsRoot, created.path, "PITCH.md");
    const readme = await fs.readFile(readmePath, "utf8");
    const pitch = await fs.readFile(pitchPath, "utf8");
    expect(readme).not.toContain("Track the active form fields.");
    expect(pitch).toContain("Track the active form fields.");
    expect(readme).toContain('status: "shaping"');
  });

  it("requires slice repo when project has no repo", async () => {
    const repoDir = path.join(tmpDir, "api-slice-repo");
    await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });
    const createRes = await Promise.resolve(
      api.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Slice Repo Required" }),
      })
    );
    expect(createRes.status).toBe(201);
    const project = await createRes.json();

    const missingRepo = await Promise.resolve(
      api.request(`/projects/${project.id}/slices`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "No repo" }),
      })
    );
    expect(missingRepo.status).toBe(400);
    expect((await missingRepo.json()).error).toContain(
      `Cannot create slice: project ${project.id} has no repo. Pass --repo <abs path>`
    );

    const withRepo = await Promise.resolve(
      api.request(`/projects/${project.id}/slices`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Own repo", repo: repoDir }),
      })
    );
    expect(withRepo.status).toBe(201);
    const slice = await withRepo.json();
    expect(slice.frontmatter.repo).toBe(repoDir);

    const clearSliceRepo = await Promise.resolve(
      api.request(`/projects/${project.id}/slices/${slice.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: "" }),
      })
    );
    expect(clearSliceRepo.status).toBe(400);
    expect((await clearSliceRepo.json()).error).toContain(
      `Cannot update slice: project ${project.id} has no repo. Pass --repo <abs path>`
    );
  });

  it("rejects clearing project repo when slices rely on it", async () => {
    const repoDir = path.join(tmpDir, "api-project-repo");
    await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });
    const createRes = await Promise.resolve(
      api.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Project Repo Clear" }),
      })
    );
    expect(createRes.status).toBe(201);
    const project = await createRes.json();

    const setRepo = await Promise.resolve(
      api.request(`/projects/${project.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: repoDir }),
      })
    );
    expect(setRepo.status).toBe(200);

    const sliceRes = await Promise.resolve(
      api.request(`/projects/${project.id}/slices`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Inherit repo" }),
      })
    );
    expect(sliceRes.status).toBe(201);
    const slice = await sliceRes.json();

    const clearRepo = await Promise.resolve(
      api.request(`/projects/${project.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: "" }),
      })
    );
    expect(clearRepo.status).toBe(400);
    expect((await clearRepo.json()).error).toBe(
      `Cannot clear project repo: slice(s) ${slice.id} rely on it (no slice-level repo set). Set their repo first, then clear the project repo.`
    );

    const readyClearRepo = await Promise.resolve(
      api.request(`/projects/${project.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "ready_to_merge", repo: "" }),
      })
    );
    expect(readyClearRepo.status).toBe(400);
    expect((await readyClearRepo.json()).error).toContain(
      "Cannot clear project repo"
    );
  });

  it("filters projects by area query parameter", async () => {
    await Promise.resolve(
      api.request("/areas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "yoplai",
          title: "Yoplai",
          color: "#3b8ecc",
          repo: "~/code/yoplai",
        }),
      })
    );

    await Promise.resolve(
      api.request("/areas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "cloudifai",
          title: "Cloudifai",
          color: "#8a3bcc",
          repo: "~/code/cloudifai",
        }),
      })
    );

    const firstCreateRes = await Promise.resolve(
      api.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Area Filter Alpha" }),
      })
    );
    const secondCreateRes = await Promise.resolve(
      api.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Area Filter Beta" }),
      })
    );
    expect(firstCreateRes.status).toBe(201);
    expect(secondCreateRes.status).toBe(201);
    const firstProject = await firstCreateRes.json();
    const secondProject = await secondCreateRes.json();

    const firstPatch = await Promise.resolve(
      api.request(`/projects/${firstProject.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ area: "yoplai" }),
      })
    );
    const secondPatch = await Promise.resolve(
      api.request(`/projects/${secondProject.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ area: "cloudifai" }),
      })
    );
    expect(firstPatch.status).toBe(200);
    expect(secondPatch.status).toBe(200);

    const filteredRes = await Promise.resolve(
      api.request("/projects?area=yoplai")
    );
    expect(filteredRes.status).toBe(200);
    const filtered = await filteredRes.json();
    expect(filtered.length).toBe(1);
    expect(filtered[0].id).toBe(firstProject.id);
    expect(filtered[0].frontmatter.area).toBe("yoplai");
  });

  it("appends thread comments via API", async () => {
    const createRes = await Promise.resolve(
      api.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Threaded Project",
        }),
      })
    );

    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    const commentRes = await Promise.resolve(
      api.request(`/projects/${created.id}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          author: "cto",
          message: "First note.",
        }),
      })
    );

    expect(commentRes.status).toBe(201);
    const threadPath = path.join(projectsRoot, created.path, "THREAD.md");
    const thread = await fs.readFile(threadPath, "utf8");
    expect(thread).toContain("[author:cto]");
    expect(thread).toContain("First note.");

    const getRes = await Promise.resolve(
      api.request(`/projects/${created.id}`)
    );
    const fetched = await getRes.json();
    expect(fetched.thread.length).toBe(1);
    expect(fetched.thread[0]?.author).toBe("cto");

    const activityRes = await Promise.resolve(api.request("/activity"));
    expect(activityRes.status).toBe(200);
    const activity = await activityRes.json();
    const commentEvent = activity.events.find(
      (event: {
        type?: string;
        projectId?: string;
        actor?: string;
        action?: string;
      }) => event.type === "project_comment" && event.projectId === created.id
    );
    expect(commentEvent?.actor).toBe("cto");
    expect(commentEvent?.action).toContain(`commented on ${created.id}:`);
    expect(commentEvent?.action).toContain("First note.");
  });

  it("updates thread comments via PATCH endpoint", async () => {
    const createRes = await Promise.resolve(
      api.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Update Comment Project",
        }),
      })
    );

    expect(createRes.status).toBe(201);
    const created = await createRes.json();

    await Promise.resolve(
      api.request(`/projects/${created.id}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ author: "alice", message: "Original message" }),
      })
    );

    const updateRes = await Promise.resolve(
      api.request(`/projects/${created.id}/comments/0`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: "Updated message" }),
      })
    );

    expect(updateRes.status).toBe(200);
    const updated = await updateRes.json();
    expect(updated.author).toBe("alice");
    expect(updated.body).toBe("Updated message");

    const getRes = await Promise.resolve(
      api.request(`/projects/${created.id}`)
    );
    const fetched = await getRes.json();
    expect(fetched.thread[0]?.body).toBe("Updated message");
  });

  it("deletes a project and moves it to trash", async () => {
    const createRes = await Promise.resolve(
      api.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Delete Me Project" }),
      })
    );

    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    const createdDir = path.join(projectsRoot, created.path);
    const trashRoot = path.join(projectsRoot, ".trash");

    await expect(fs.stat(createdDir)).resolves.toBeDefined();
    await expect(fs.stat(trashRoot)).rejects.toBeDefined();

    const deleteRes = await Promise.resolve(
      api.request(`/projects/${created.id}`, {
        method: "DELETE",
      })
    );

    expect(deleteRes.status).toBe(200);
    const deleted = await deleteRes.json();
    expect(deleted.id).toBe(created.id);
    expect(deleted.path).toBe(created.path);
    expect(deleted.trashedPath).toBe(path.join(".trash", created.path));

    const trashedDir = path.join(projectsRoot, deleted.trashedPath);
    await expect(fs.access(createdDir)).rejects.toBeDefined();
    await expect(fs.stat(trashedDir)).resolves.toBeDefined();
  });

  it("archives and unarchives a project", async () => {
    const createRes = await Promise.resolve(
      api.request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Archive API Project" }),
      })
    );

    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    const createdDir = path.join(projectsRoot, created.path);

    await expect(fs.stat(createdDir)).resolves.toBeDefined();

    const archiveRes = await Promise.resolve(
      api.request(`/projects/${created.id}/archive`, {
        method: "POST",
      })
    );

    expect(archiveRes.status).toBe(200);
    const archived = await archiveRes.json();
    const archivedDir = path.join(projectsRoot, archived.archivedPath);

    await expect(fs.access(createdDir)).rejects.toBeDefined();
    await expect(fs.stat(archivedDir)).resolves.toBeDefined();

    const unarchiveRes = await Promise.resolve(
      api.request(`/projects/${created.id}/unarchive`, {
        method: "POST",
      })
    );

    expect(unarchiveRes.status).toBe(200);
    const unarchived = await unarchiveRes.json();
    expect(unarchived.id).toBe(created.id);

    await expect(fs.access(archivedDir)).rejects.toBeDefined();
    await expect(fs.stat(createdDir)).resolves.toBeDefined();
  });
});
