import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import os from "node:os";
import { writeTestV3Config } from "../../../../../apps/gateway/src/test-utils/v3-config.js";

let clearProjectsContextForTest: (() => void) | undefined;
let emittedEvents: unknown[] = [];

describe("slices HTTP API", () => {
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
  let createdProjectId: string;
  let sliceRepoDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-slices-api-"));
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
      emit: (_event: string, payload: unknown) => {
        emittedEvents.push(payload);
      },
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

    // Create a project to use in slice tests
    await fs.mkdir(projectsRoot, { recursive: true });
    const projectRes = await api.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Slice Test Project" }),
    });
    expect(projectRes.status).toBe(201);
    const projectId = ((await projectRes.clone().json()) as { id: string }).id;
    // S13 invariant: slices need a repo if the project has none. Update the project to set repo.
    sliceRepoDir = path.join(tmpDir, "slices-api-test-repo");
    await fs.mkdir(path.join(sliceRepoDir, ".git"), { recursive: true });
    const updateRes = await api.request(`/projects/${projectId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo: sliceRepoDir }),
    });
    expect(updateRes.status).toBe(200);
    const project = (await projectRes.json()) as { id: string };
    createdProjectId = project.id;
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

  it("GET /projects/:id/slices returns empty list initially", async () => {
    const res = await api.request(`/projects/${createdProjectId}/slices`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { slices: unknown[] };
    expect(Array.isArray(body.slices)).toBe(true);
    expect(body.slices).toHaveLength(0);
  });

  it("POST /projects/:id/slices creates a slice", async () => {
    emittedEvents = [];
    const res = await api.request(`/projects/${createdProjectId}/slices`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Auth flow" }),
    });
    expect(res.status).toBe(201);
    const slice = (await res.json()) as {
      id: string;
      frontmatter: { status: string; title: string };
    };
    expect(slice.id).toMatch(/^PRO-\d+-S\d+$/);
    expect(slice.frontmatter.title).toBe("Auth flow");
    expect(slice.frontmatter.status).toBe("todo");
    expect(emittedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "file_changed",
          projectId: createdProjectId,
          file: expect.stringMatching(new RegExp(`/${slice.id}/README\\.md$`)),
        }),
        expect.objectContaining({
          type: "file_changed",
          projectId: createdProjectId,
          file: expect.stringMatching(/\/SCOPE_MAP\.md$/),
        }),
      ])
    );
  });

  it("POST /projects/:id/slices heals stale counters instead of overwriting", async () => {
    const projectRes = await api.request("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Stale Counter Project" }),
    });
    const project = (await projectRes.json()) as { id: string };
    await api.request(`/projects/${project.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo: sliceRepoDir }),
    });
    const firstRes = await api.request(`/projects/${project.id}/slices`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Original", readme: "## Original\n" }),
    });
    const first = (await firstRes.json()) as { id: string };
    expect(first.id).toBe(`${project.id}-S01`);

    const [projectDirName] = (await fs.readdir(projectsRoot)).filter((name) =>
      name.startsWith(project.id)
    );
    const projectDir = path.join(projectsRoot, projectDirName!);
    await fs.writeFile(
      path.join(projectDir, ".meta", "counters.json"),
      JSON.stringify({ lastSliceId: 0 }, null, 2)
    );

    const secondRes = await api.request(`/projects/${project.id}/slices`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Next" }),
    });

    expect(secondRes.status).toBe(201);
    const second = (await secondRes.json()) as { id: string };
    expect(second.id).toBe(`${project.id}-S02`);
    const originalReadme = await fs.readFile(
      path.join(projectDir, "slices", first.id, "README.md"),
      "utf8"
    );
    expect(originalReadme).toContain('title: "Original"');
    expect(originalReadme).toContain("## Original");
  });

  it("GET /projects/:id/slices lists created slices", async () => {
    const res = await api.request(`/projects/${createdProjectId}/slices`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { slices: Array<{ id: string }> };
    expect(body.slices.length).toBeGreaterThanOrEqual(1);
  });

  it("GET /projects/:id/slices/:sliceId returns slice detail", async () => {
    // Create a fresh slice for this test
    const createRes = await api.request(
      `/projects/${createdProjectId}/slices`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Profile page",
          specs: "# Profile spec\nUser can view their profile.",
        }),
      }
    );
    const created = (await createRes.json()) as { id: string };

    const res = await api.request(
      `/projects/${createdProjectId}/slices/${created.id}`
    );
    expect(res.status).toBe(200);
    const slice = (await res.json()) as {
      id: string;
      docs: {
        specs: string;
        tasks: string;
        validation: string;
        thread: string;
      };
    };
    expect(slice.id).toBe(created.id);
    expect(slice.docs.specs).toContain("Profile spec");
  });

  it("PATCH /projects/:id/slices/:sliceId changes status", async () => {
    // Create a fresh slice
    const createRes = await api.request(
      `/projects/${createdProjectId}/slices`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Settings" }),
      }
    );
    const created = (await createRes.json()) as { id: string };
    emittedEvents = [];

    const patchRes = await api.request(
      `/projects/${createdProjectId}/slices/${created.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "in_progress" }),
      }
    );
    expect(patchRes.status).toBe(200);
    const updated = (await patchRes.json()) as {
      frontmatter: { status: string };
    };
    expect(updated.frontmatter.status).toBe("in_progress");
    expect(emittedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "file_changed",
          projectId: createdProjectId,
          file: expect.stringMatching(
            new RegExp(`/${created.id}/README\\.md$`)
          ),
        }),
        expect.objectContaining({
          type: "file_changed",
          projectId: createdProjectId,
          file: expect.stringMatching(/\/SCOPE_MAP\.md$/),
        }),
      ])
    );
  });

  it("PATCH /projects/:id/slices/:sliceId updates docs and preserves README frontmatter", async () => {
    const createRes = await api.request(
      `/projects/${createdProjectId}/slices`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Editable docs", readme: "## Before\n" }),
      }
    );
    const created = (await createRes.json()) as { id: string };

    const patchRes = await api.request(
      `/projects/${createdProjectId}/slices/${created.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          readme: "## After\n",
          specs: "# Specs updated\n",
          tasks: "- [x] Done\n",
          validation: "- [ ] Check\n",
          thread: "Comment\n",
        }),
      }
    );
    expect(patchRes.status).toBe(200);

    const getRes = await api.request(
      `/projects/${createdProjectId}/slices/${created.id}`
    );
    const updated = (await getRes.json()) as {
      docs: {
        readme: string;
        specs: string;
        tasks: string;
        validation: string;
        thread: string;
      };
    };
    expect(updated.docs).toMatchObject({
      readme: "## After\n",
      specs: "# Specs updated\n",
      tasks: "- [x] Done\n",
      validation: "- [ ] Check\n",
      thread: "Comment\n",
    });

    const [projectDirName] = (await fs.readdir(projectsRoot)).filter((name) =>
      name.startsWith(createdProjectId)
    );
    const readmePath = path.join(
      projectsRoot,
      projectDirName!,
      "slices",
      created.id,
      "README.md"
    );
    const rawReadme = await fs.readFile(readmePath, "utf8");
    expect(rawReadme).toContain(`id: "${created.id}"`);
    expect(rawReadme).toContain(`project_id: "${createdProjectId}"`);
    expect(rawReadme).toContain('title: "Editable docs"');
    expect(rawReadme).toContain("\n---\n## After\n");
  });

  it("POST with missing title returns 400", async () => {
    const res = await api.request(`/projects/${createdProjectId}/slices`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("GET slice with invalid id returns 404", async () => {
    const res = await api.request(
      `/projects/${createdProjectId}/slices/INVALID-ID`
    );
    expect(res.status).toBe(404);
  });

  it("GET /projects/nonexistent/slices returns 404", async () => {
    const res = await api.request("/projects/PRO-99999/slices");
    expect(res.status).toBe(404);
  });
});
