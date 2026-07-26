import { createReadStream } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { Hono } from "hono";
import {
  AreaSchema,
  CreateProjectRequestSchema,
  ProjectCommentRequestSchema,
  ProjectsExtensionConfigSchema,
  UpdateProjectCommentRequestSchema,
  UpdateProjectRequestSchema,
  type Extension,
  type ExtensionAgentTool,
  type GatewayConfig,
} from "@yoplai/shared";
import { z } from "zod";
import {
  getRecentActivity,
  recordCommentActivity,
  recordProjectStatusActivity,
} from "./activity/index.js";
import {
  createArea,
  deleteArea,
  listAreas,
  migrateAreas,
  updateArea,
} from "./areas/index.js";
import {
  appendProjectComment,
  commitProjectChanges,
  createProject,
  deleteProject,
  deleteProjectComment,
  getProject,
  getProjectChanges,
  getProjectPullRequestTarget,
  getProjectSpace,
  getProjectSpaceCommitLog,
  getProjectSpaceContribution,
  getProjectSpaceWriteLease,
  integrateProjectSpaceQueue,
  integrateSpaceEntries,
  isValidGitRepo,
  acquireProjectSpaceWriteLease,
  isSpaceWriteLeaseEnabled,
  listArchivedProjects,
  listProjects,
  mergeSpaceIntoBase,
  parseTasks,
  parseThread,
  readSpec,
  rebaseSpaceOntoMain,
  listSlices,
  createSlice,
  getSlice,
  updateSlice,
  releaseProjectSpaceWriteLease,
  resolveAttachmentFile,
  saveAttachments,
  serializeTasks,
  skipSpaceEntries,
  updateProject,
  updateProjectComment,
  writeSpec,
  type SliceStatus,
  type SliceHillPosition,
} from "./projects/index.js";
import {
  startProjectWatcher,
  type ProjectWatcher,
} from "./projects/watcher.js";
import {
  startOrchestratorDaemon,
  type OrchestratorDaemon,
} from "./orchestrator/index.js";
import {
  archiveSubagent,
  getSubagentLogs,
  listAllSubagents,
  listProjectBranches,
  listSubagents,
  unarchiveSubagent,
  updateSubagentConfig,
} from "./subagents/index.js";
import { interruptSubagent, killSubagent } from "./subagents/runner.js";
import { getTaskboardItem, scanTaskboard } from "./taskboard/index.js";
import {
  clearProjectsContext,
  getProjectsContext,
  setProjectsContext,
} from "./context.js";
import { startProjectRun } from "./use-cases/start-project-run.js";
import { spawnProjectSubagent } from "./use-cases/spawn-project-subagent.js";
import {
  fixSpaceQueueConflict,
  fixSpaceRebaseConflict,
} from "./use-cases/fix-space-conflict.js";
import {
  archiveProjectLifecycle,
  unarchiveProjectLifecycle,
  updateProjectLifecycle,
  updateProjectWithCancelInterrupt,
} from "./use-cases/update-project-lifecycle.js";
import {
  createLeadSession,
  deleteLeadSession,
  findLeadSession,
  listLeadSessions,
  patchLeadSession,
} from "./lead-sessions/store.js";
import {
  leadTranscriptHasUserMessage,
  readLeadTranscript,
  sendLeadSessionMessage,
} from "./lead-sessions/transcript.js";
import { maybeAutoTitleLeadSession } from "./lead-sessions/auto-title.js";
export { interruptCancelledOrchestratorRuns } from "./use-cases/update-project-lifecycle.js";

const registeredApps = new WeakSet<object>();

const UpdateTaskRequestSchema = z.object({
  checked: z.boolean().optional(),
  status: z.enum(["todo", "in_progress", "done"]).optional(),
  agentId: z.union([z.string(), z.null()]).optional(),
});

const CreateTaskRequestSchema = z.object({
  title: z.string(),
  description: z.string().optional(),
  status: z.enum(["todo", "in_progress", "done"]).optional(),
});

const PutSpecRequestSchema = z.object({
  content: z.string(),
});

const CommitProjectChangesRequestSchema = z.object({
  message: z.string(),
});

const AcquireSpaceLeaseRequestSchema = z.object({
  holder: z.string(),
  ttlSeconds: z.number().int().positive().optional(),
  force: z.boolean().optional(),
});

const ReleaseSpaceLeaseRequestSchema = z.object({
  holder: z.string().optional(),
  force: z.boolean().optional(),
});

const MergeSpaceRequestSchema = z.object({
  cleanup: z.boolean().optional(),
});

const SpaceEntriesRequestSchema = z.object({
  entryIds: z.array(z.string()),
});

const UpdateSubagentRequestSchema = z.object({
  name: z.string().optional(),
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
  thinking: z.string().optional(),
});

const CreateLeadSessionRequestSchema = z.object({
  agentId: z.string(),
  sliceId: z.string().optional(),
});

const PatchLeadSessionRequestSchema = z.object({
  title: z.string().optional(),
  archived: z.boolean().optional(),
});

const SendLeadSessionMessageRequestSchema = z.object({
  content: z.string(),
  agentId: z.string().optional(),
  files: z
    .array(
      z.object({
        path: z.string(),
        mimeType: z.string(),
        filename: z.string().optional(),
        size: z.number().optional(),
      })
    )
    .optional(),
});

let watcher: ProjectWatcher | null = null;
let orchestrator: OrchestratorDaemon | null = null;

function getProjectsRuntimeConfig(config: GatewayConfig): GatewayConfig {
  const root = config.extensions?.projects?.root ?? config.projects?.root;
  if (root === undefined) return config;
  return {
    ...config,
    projects: {
      ...config.projects,
      root,
    },
  };
}

function getProjectsConfig(): GatewayConfig {
  return getProjectsRuntimeConfig(getProjectsContext().getConfig());
}

function sliceMutationErrorStatus(error: string): 400 | 404 {
  if (
    error.startsWith("Cannot create slice") ||
    error.startsWith("Cannot update slice") ||
    error.startsWith("Slice repo ")
  ) {
    return 400;
  }
  return 404;
}

function projectDirNameFromPath(projectPath: string): string {
  return path.basename(projectPath.replace(/\\/g, "/"));
}

function emitProjectFileChanged(
  projectId: string,
  projectDirName: string,
  fileName: string
): void {
  getProjectsContext().emit("file.changed", {
    type: "file_changed",
    projectId,
    file: `${projectDirName}/${fileName}`,
  });
}

function emitUpdatedSliceFiles(
  projectId: string,
  projectDirName: string,
  sliceId: string,
  input: {
    status?: unknown;
    specs?: unknown;
    tasks?: unknown;
    validation?: unknown;
    thread?: unknown;
  }
): void {
  const updatedFiles = new Set<string>([
    `slices/${sliceId}/README.md`,
    "SCOPE_MAP.md",
  ]);
  if (input.specs !== undefined) updatedFiles.add(`slices/${sliceId}/SPECS.md`);
  if (input.tasks !== undefined) updatedFiles.add(`slices/${sliceId}/TASKS.md`);
  if (input.validation !== undefined) {
    updatedFiles.add(`slices/${sliceId}/VALIDATION.md`);
  }
  if (input.thread !== undefined)
    updatedFiles.add(`slices/${sliceId}/THREAD.md`);
  if (input.status === "done" || input.status === "cancelled") {
    updatedFiles.add("README.md");
  }
  for (const fileName of updatedFiles) {
    emitProjectFileChanged(projectId, projectDirName, fileName);
  }
}

function formatThreadDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function unwrapProjectToolResult<T>(
  result: { ok: true; data: T } | { ok: false; error: string }
): T {
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

function createProjectAgentTools(): ExtensionAgentTool[] {
  return [
    {
      name: "project.create",
      description: "Create a Yoplai project",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          pitch: { type: "string" },
          status: { type: "string" },
          area: { type: "string" },
        },
        required: ["title"],
      },
      async execute(args, { config }) {
        const parsed = CreateProjectRequestSchema.parse(args);
        return unwrapProjectToolResult(await createProject(config, parsed));
      },
    },
    {
      name: "project.get",
      description: "Get a Yoplai project",
      parameters: {
        type: "object",
        properties: { projectId: { type: "string" } },
        required: ["projectId"],
      },
      async execute(args, { config }) {
        const parsed = z.object({ projectId: z.string() }).parse(args);
        return unwrapProjectToolResult(
          await getProject(config, parsed.projectId)
        );
      },
    },
    {
      name: "project.update",
      description: "Update a Yoplai project",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          updates: { type: "object" },
        },
        required: ["projectId"],
      },
      async execute(args, { config }) {
        const parsed = z
          .object({
            projectId: z.string(),
            updates: UpdateProjectRequestSchema.optional(),
          })
          .passthrough()
          .parse(args);
        const { projectId, updates, ...rest } = parsed;
        const body = updates ?? UpdateProjectRequestSchema.parse(rest);
        return unwrapProjectToolResult(
          await updateProjectWithCancelInterrupt(config, projectId, body)
        );
      },
    },
    {
      name: "project.comment",
      description: "Add a comment to a Yoplai project",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          author: { type: "string" },
          message: { type: "string" },
        },
        required: ["projectId", "author", "message"],
      },
      async execute(args, { config }) {
        const parsed = z
          .object({
            projectId: z.string(),
            author: z.string(),
            message: z.string(),
          })
          .parse(args);
        const comment = ProjectCommentRequestSchema.parse(parsed);
        const data = unwrapProjectToolResult(
          await appendProjectComment(config, parsed.projectId, {
            author: comment.author,
            date: formatThreadDate(new Date()),
            body: comment.message,
          })
        );
        await recordCommentActivity({
          actor: comment.author,
          projectId: parsed.projectId,
          commentExcerpt: comment.message,
        });
        return data;
      },
    },
  ];
}

function attachmentContentType(name: string): string {
  const ext = path.extname(name).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".pdf") return "application/pdf";
  return "application/octet-stream";
}

async function clearLeadSessionState(
  agentId: string,
  sessionKey: string,
  userId?: string
): Promise<void> {
  const cleared = await getProjectsContext().clearSessionEntry(
    agentId,
    sessionKey,
    userId
  );
  if (!cleared) return;
  getProjectsContext().deleteSession(agentId, cleared.sessionId);
  await getProjectsContext().invalidateHistoryCache(
    agentId,
    cleared.sessionId,
    userId
  );
}

function isUploadedFile(
  value: unknown
): value is { name: string; arrayBuffer: () => Promise<ArrayBuffer> } {
  return (
    typeof value === "object" &&
    value !== null &&
    "arrayBuffer" in value &&
    typeof (value as { arrayBuffer?: unknown }).arrayBuffer === "function" &&
    "name" in value &&
    typeof (value as { name?: unknown }).name === "string"
  );
}

export function isProjectsComponentEnabled(config: GatewayConfig): boolean {
  const componentConfig = config.extensions?.projects;
  if (componentConfig) return componentConfig.enabled !== false;
  return config.projects !== undefined;
}

export function registerProjectRoutes(app: Hono): void {
  if (registeredApps.has(app)) return;
  registeredApps.add(app);

  app.get("/areas", async (c) => {
    const config = getProjectsConfig();
    const areas = await listAreas(config);
    return c.json(areas);
  });

  app.post("/areas", async (c) => {
    const body = await c.req.json();
    const parsed = AreaSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    const config = getProjectsConfig();
    try {
      const area = await createArea(config, parsed.data);
      return c.json(area, 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message.startsWith("Area already exists") ? 409 : 400;
      return c.json({ error: message }, status);
    }
  });

  app.patch("/areas/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json();
    const parsed = AreaSchema.partial().safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    const config = getProjectsConfig();
    try {
      const area = await updateArea(config, id, parsed.data);
      return c.json(area);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message.startsWith("Area not found") ? 404 : 400;
      return c.json({ error: message }, status);
    }
  });

  app.delete("/areas/:id", async (c) => {
    const id = c.req.param("id");
    const config = getProjectsConfig();
    const deleted = await deleteArea(config, id);
    if (!deleted) {
      return c.json({ error: "Area not found" }, 404);
    }
    return c.json({ ok: true });
  });

  app.post("/areas/migrate", async (c) => {
    const config = getProjectsConfig();
    const result = await migrateAreas(config);
    return c.json(result);
  });

  app.post("/projects/:id/start", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const config = getProjectsConfig();
    const result = await startProjectRun(config, id, body);
    if (!result.ok) {
      return c.json({ error: result.error }, result.status);
    }
    return c.json(result.data);
  });

  app.get("/config/spawn-options", (c) => {
    const agents = getProjectsContext()
      .getAgents()
      .map((a) => ({ id: a.id, name: a.name }));
    const subagentTemplates = getProjectsContext().getSubagentTemplates();
    return c.json({ agents, subagentTemplates });
  });

  app.get("/projects", async (c) => {
    const config = getProjectsConfig();
    const area = c.req.query("area");
    const result = await listProjects(config, { area });
    if (!result.ok) {
      return c.json({ error: result.error }, 400);
    }
    return c.json(result.data);
  });

  app.get("/projects/archived", async (c) => {
    const config = getProjectsConfig();
    const result = await listArchivedProjects(config);
    if (!result.ok) {
      return c.json({ error: result.error }, 400);
    }
    return c.json(result.data);
  });

  app.post("/projects/validate-repo", async (c) => {
    const body = await c.req.json();
    const parsed = z.object({ repo: z.string() }).safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    return c.json({ valid: await isValidGitRepo(parsed.data.repo) });
  });

  app.post("/projects", async (c) => {
    const body = await c.req.json();
    const parsed = CreateProjectRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }

    const config = getProjectsConfig();
    const result = await createProject(config, parsed.data);
    if (!result.ok) {
      return c.json({ error: result.error }, 400);
    }
    emitProjectFileChanged(result.data.id, result.data.path, "README.md");
    emitProjectFileChanged(result.data.id, result.data.path, "PITCH.md");
    return c.json(result.data, 201);
  });

  app.get("/projects/:id", async (c) => {
    const id = c.req.param("id");
    const config = getProjectsConfig();
    const result = await getProject(config, id);
    if (!result.ok) {
      return c.json({ error: result.error }, 404);
    }
    return c.json(result.data);
  });

  // ── Slice endpoints ────────────────────────────────────────────────────────

  app.get("/projects/:id/slices", async (c) => {
    const id = c.req.param("id");
    const config = getProjectsConfig();
    const project = await getProject(config, id);
    if (!project.ok) {
      return c.json({ error: project.error }, 404);
    }
    const slices = await listSlices(project.data.absolutePath);
    return c.json({ slices });
  });

  app.post("/projects/:id/slices", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title) {
      return c.json({ error: "title is required" }, 400);
    }
    const config = getProjectsConfig();
    const project = await getProject(config, id);
    if (!project.ok) {
      return c.json({ error: project.error }, 404);
    }
    try {
      const slice = await createSlice(project.data.absolutePath, {
        projectId: id,
        title,
        status:
          typeof body.status === "string"
            ? (body.status as SliceStatus)
            : "todo",
        repo: typeof body.repo === "string" ? body.repo : undefined,
        hillPosition:
          typeof body.hill_position === "string"
            ? (body.hill_position as SliceHillPosition)
            : "figuring",
        readme: typeof body.readme === "string" ? body.readme : undefined,
        specs: typeof body.specs === "string" ? body.specs : undefined,
        tasks: typeof body.tasks === "string" ? body.tasks : undefined,
        validation:
          typeof body.validation === "string" ? body.validation : undefined,
        thread: typeof body.thread === "string" ? body.thread : undefined,
      });
      emitUpdatedSliceFiles(
        id,
        projectDirNameFromPath(project.data.path),
        slice.id,
        body
      );
      return c.json(slice, 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "not found";
      return c.json({ error: msg }, sliceMutationErrorStatus(msg));
    }
  });

  app.get("/projects/:id/slices/:sliceId", async (c) => {
    const id = c.req.param("id");
    const sliceId = c.req.param("sliceId");
    const config = getProjectsConfig();
    const project = await getProject(config, id);
    if (!project.ok) {
      return c.json({ error: project.error }, 404);
    }
    try {
      const slice = await getSlice(project.data.absolutePath, sliceId);
      return c.json(slice);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "not found";
      return c.json({ error: msg }, 404);
    }
  });

  app.patch("/projects/:id/slices/:sliceId", async (c) => {
    const id = c.req.param("id");
    const sliceId = c.req.param("sliceId");
    const body = await c.req.json().catch(() => ({}));
    const config = getProjectsConfig();
    const project = await getProject(config, id);
    if (!project.ok) {
      return c.json({ error: project.error }, 404);
    }
    try {
      const slice = await updateSlice(project.data.absolutePath, sliceId, {
        title: typeof body.title === "string" ? body.title : undefined,
        status:
          typeof body.status === "string"
            ? (body.status as SliceStatus)
            : undefined,
        hillPosition:
          typeof body.hill_position === "string"
            ? (body.hill_position as SliceHillPosition)
            : undefined,
        readme: typeof body.readme === "string" ? body.readme : undefined,
        specs: typeof body.specs === "string" ? body.specs : undefined,
        tasks: typeof body.tasks === "string" ? body.tasks : undefined,
        validation:
          typeof body.validation === "string" ? body.validation : undefined,
        thread: typeof body.thread === "string" ? body.thread : undefined,
        frontmatter:
          typeof body.repo === "string" ? { repo: body.repo } : undefined,
      });
      emitUpdatedSliceFiles(
        id,
        projectDirNameFromPath(project.data.path),
        sliceId,
        body
      );
      return c.json(slice);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "not found";
      return c.json({ error: msg }, sliceMutationErrorStatus(msg));
    }
  });

  app.post("/projects/:id/slices/:sliceId/comments", async (c) => {
    const id = c.req.param("id");
    const sliceId = c.req.param("sliceId");
    const body = await c.req.json().catch(() => ({}));
    const parsed = ProjectCommentRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    const config = getProjectsConfig();
    const project = await getProject(config, id);
    if (!project.ok) {
      return c.json({ error: project.error }, 404);
    }
    try {
      const existing = await getSlice(project.data.absolutePath, sliceId);
      const date = formatThreadDate(new Date());
      const separator = existing.docs.thread.trim().length > 0 ? "\n\n" : "";
      const entry = `## ${date}\n[author:${parsed.data.author}]\n[date:${date}]\n\n${parsed.data.message.trim()}`;
      const thread = `${existing.docs.thread.trimEnd()}${separator}${entry}\n`;
      const updated = await updateSlice(project.data.absolutePath, sliceId, {
        thread,
      });
      emitUpdatedSliceFiles(
        id,
        projectDirNameFromPath(project.data.path),
        sliceId,
        {
          thread,
        }
      );
      await recordCommentActivity({
        actor: parsed.data.author,
        projectId: id,
        commentExcerpt: parsed.data.message,
      });
      const last = parseThread(updated.docs.thread).at(-1);
      return c.json(
        last ?? { author: parsed.data.author, date, body: parsed.data.message },
        201
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "not found";
      return c.json({ error: msg }, 404);
    }
  });

  app.get("/projects/:id/spec", async (c) => {
    const id = c.req.param("id");
    const config = getProjectsConfig();
    const project = await getProject(config, id);
    if (!project.ok) {
      return c.json({ error: project.error }, 404);
    }
    const content = await readSpec(config, id);
    return c.json({ content });
  });

  app.put("/projects/:id/spec", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json();
    const parsed = PutSpecRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    const config = getProjectsConfig();
    const project = await getProject(config, id);
    if (!project.ok) {
      return c.json({ error: project.error }, 404);
    }
    await writeSpec(config, id, parsed.data.content);
    return c.json({ ok: true });
  });

  app.get("/projects/:id/tasks", async (c) => {
    const id = c.req.param("id");
    const config = getProjectsConfig();
    const project = await getProject(config, id);
    if (!project.ok) {
      return c.json({ error: project.error }, 404);
    }
    const specs = await readSpec(config, id);
    const tasks = parseTasks(specs);
    const done = tasks.filter((task) => task.checked).length;
    return c.json({
      tasks,
      progress: { done, total: tasks.length },
    });
  });

  app.post("/projects/:id/tasks", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json();
    const parsed = CreateTaskRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    const config = getProjectsConfig();
    const project = await getProject(config, id);
    if (!project.ok) {
      return c.json({ error: project.error }, 404);
    }

    const specs = await readSpec(config, id);
    const tasks = parseTasks(specs);
    const status = parsed.data.status ?? "todo";
    const checked = status === "done";
    tasks.push({
      title: parsed.data.title,
      description: parsed.data.description,
      status,
      checked,
      order: tasks.length,
    });
    const nextSpecs = serializeTasks(tasks, specs);
    await writeSpec(config, id, nextSpecs);
    return c.json({ task: tasks[tasks.length - 1] }, 201);
  });

  app.patch("/projects/:id/tasks/:order", async (c) => {
    const id = c.req.param("id");
    const order = Number(c.req.param("order"));
    if (!Number.isInteger(order) || order < 0) {
      return c.json({ error: "Invalid task order" }, 400);
    }
    const body = await c.req.json();
    const parsed = UpdateTaskRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    const config = getProjectsConfig();
    const project = await getProject(config, id);
    if (!project.ok) {
      return c.json({ error: project.error }, 404);
    }

    const specs = await readSpec(config, id);
    const tasks = parseTasks(specs);
    const task = tasks[order];
    if (!task) {
      return c.json({ error: "Task not found" }, 404);
    }

    let checked = parsed.data.checked ?? task.checked;
    let status = parsed.data.status ?? task.status;
    if (parsed.data.checked !== undefined && parsed.data.status === undefined) {
      status = parsed.data.checked ? "done" : "todo";
    }
    if (parsed.data.status !== undefined && parsed.data.checked === undefined) {
      checked = parsed.data.status === "done";
    }

    const agentId =
      parsed.data.agentId === undefined
        ? task.agentId
        : parsed.data.agentId === null
          ? undefined
          : parsed.data.agentId;

    tasks[order] = {
      ...task,
      checked,
      status,
      agentId,
      order,
    };
    const nextSpecs = serializeTasks(tasks, specs);
    await writeSpec(config, id, nextSpecs);
    emitProjectFileChanged(
      id,
      projectDirNameFromPath(project.data.path),
      "SPECS.md"
    );
    return c.json({ task: tasks[order] });
  });

  app.delete("/projects/:id/tasks/:order", async (c) => {
    const id = c.req.param("id");
    const order = Number(c.req.param("order"));
    if (!Number.isInteger(order) || order < 0) {
      return c.json({ error: "Invalid task order" }, 400);
    }
    const config = getProjectsConfig();
    const project = await getProject(config, id);
    if (!project.ok) {
      return c.json({ error: project.error }, 404);
    }

    const specs = await readSpec(config, id);
    const tasks = parseTasks(specs);
    if (!tasks[order]) {
      return c.json({ error: "Task not found" }, 404);
    }
    tasks.splice(order, 1);
    const nextSpecs = serializeTasks(tasks, specs);
    await writeSpec(config, id, nextSpecs);
    return c.json({ ok: true });
  });

  app.patch("/projects/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json();
    const config = getProjectsConfig();
    const result = await updateProjectLifecycle(config, id, body);
    if (!result.ok) {
      return c.json({ error: result.error }, result.status);
    }
    if (result.files && result.projectDirName) {
      for (const fileName of result.files) {
        emitProjectFileChanged(
          id,
          projectDirNameFromPath(result.projectDirName),
          fileName
        );
      }
    }
    return c.json(result.data);
  });

  app.delete("/projects/:id", async (c) => {
    const id = c.req.param("id");
    const config = getProjectsConfig();
    const result = await deleteProject(config, id);
    if (!result.ok) {
      const status = result.error.startsWith("Trash already contains")
        ? 409
        : 404;
      return c.json({ error: result.error }, status);
    }
    return c.json(result.data);
  });

  app.post("/projects/:id/archive", async (c) => {
    const id = c.req.param("id");
    const config = getProjectsConfig();
    const result = await archiveProjectLifecycle(config, id);
    if (!result.ok) {
      return c.json({ error: result.error }, result.status);
    }
    return c.json(result.data);
  });

  app.post("/projects/:id/unarchive", async (c) => {
    const id = c.req.param("id");
    const config = getProjectsConfig();
    const result = await unarchiveProjectLifecycle(config, id);
    if (!result.ok) {
      return c.json({ error: result.error }, result.status);
    }
    return c.json(result.data);
  });

  app.post("/projects/:id/comments", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json();
    const parsed = ProjectCommentRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }

    const entry = {
      author: parsed.data.author,
      date: formatThreadDate(new Date()),
      body: parsed.data.message,
    };

    const config = getProjectsConfig();
    const result = await appendProjectComment(config, id, entry);
    if (!result.ok) {
      return c.json({ error: result.error }, 404);
    }
    await recordCommentActivity({
      actor: parsed.data.author,
      projectId: id,
      commentExcerpt: parsed.data.message,
    });
    return c.json(result.data, 201);
  });

  app.patch("/projects/:id/comments/:index", async (c) => {
    const id = c.req.param("id");
    const index = parseInt(c.req.param("index"), 10);
    if (Number.isNaN(index) || index < 0) {
      return c.json({ error: "Invalid comment index" }, 400);
    }

    const body = await c.req.json();
    const parsed = UpdateProjectCommentRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }

    const config = getProjectsConfig();
    const result = await updateProjectComment(
      config,
      id,
      index,
      parsed.data.body
    );
    if (!result.ok) {
      return c.json({ error: result.error }, 404);
    }
    return c.json(result.data);
  });

  app.delete("/projects/:id/comments/:index", async (c) => {
    const id = c.req.param("id");
    const index = parseInt(c.req.param("index"), 10);
    if (Number.isNaN(index) || index < 0) {
      return c.json({ error: "Invalid comment index" }, 400);
    }

    const config = getProjectsConfig();
    const result = await deleteProjectComment(config, id, index);
    if (!result.ok) {
      return c.json({ error: result.error }, 404);
    }
    return c.json(result.data);
  });

  app.post("/projects/:id/attachments", async (c) => {
    const id = c.req.param("id");

    const formData = await c.req.formData();
    const files: Array<{ name: string; data: Buffer }> = [];

    for (const [, value] of formData.entries()) {
      if (!isUploadedFile(value)) continue;
      const arrayBuffer = await value.arrayBuffer();
      files.push({
        name: value.name,
        data: Buffer.from(arrayBuffer),
      });
    }

    if (files.length === 0) {
      return c.json({ error: "No files provided" }, 400);
    }

    const config = getProjectsConfig();
    const result = await saveAttachments(config, id, files);
    if (!result.ok) {
      return c.json({ error: result.error }, 400);
    }

    return c.json(result.data);
  });

  app.get("/projects/:id/attachments/:name", async (c) => {
    const id = c.req.param("id");
    const name = c.req.param("name");

    const config = getProjectsConfig();
    const result = await resolveAttachmentFile(config, id, name);
    if (!result.ok) {
      return c.json({ error: result.error }, 404);
    }

    const type = attachmentContentType(result.data.name);
    c.header("Content-Type", type);
    return c.body(
      Readable.toWeb(
        createReadStream(result.data.path)
      ) as unknown as ReadableStream
    );
  });

  app.get("/projects/:id/subagents", async (c) => {
    const id = c.req.param("id");
    const includeArchived = c.req.query("includeArchived") === "true";
    const config = getProjectsConfig();
    const result = await listSubagents(config, id, includeArchived);
    if (!result.ok) {
      return c.json({ error: result.error }, 404);
    }
    return c.json(result.data);
  });

  app.get("/projects/:id/lead-sessions", async (c) => {
    const id = c.req.param("id");
    const archived = c.req.query("archived") === "true";
    const sliceId = c.req.query("sliceId") || undefined;
    const config = getProjectsConfig();
    const result = await listLeadSessions(config, id, { archived, sliceId });
    if (!result.ok) {
      return c.json({ error: result.error }, result.status);
    }
    return c.json(result.data);
  });

  app.post("/projects/:id/lead-sessions", async (c) => {
    const id = c.req.param("id");
    const parsed = CreateLeadSessionRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid body" },
        400
      );
    }
    const ctx = getProjectsContext();
    const agent = ctx.getAgent(parsed.data.agentId);
    if (!agent || !ctx.isAgentActive(parsed.data.agentId)) {
      return c.json({ error: "Agent not found" }, 404);
    }
    const config = getProjectsConfig();
    const result = await createLeadSession(config, id, parsed.data);
    if (!result.ok) {
      return c.json({ error: result.error }, result.status);
    }
    ctx.emit("lead_session.changed", {
      type: "lead_session_changed",
      kind: "created",
      session: result.data,
    });
    return c.json(result.data, 201);
  });

  app.patch("/lead-sessions/:id", async (c) => {
    const id = c.req.param("id");
    const parsed = PatchLeadSessionRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid body" },
        400
      );
    }
    const config = getProjectsConfig();
    const result = await patchLeadSession(config, id, parsed.data);
    if (!result.ok) {
      return c.json({ error: result.error }, result.status);
    }
    getProjectsContext().emit("lead_session.changed", {
      type: "lead_session_changed",
      kind: parsed.data.archived === true ? "archived" : "updated",
      session: result.data,
    });
    return c.json(result.data);
  });

  app.delete("/lead-sessions/:id", async (c) => {
    const id = c.req.param("id");
    const config = getProjectsConfig();
    const result = await deleteLeadSession(config, id);
    if (!result.ok) {
      return c.json({ error: result.error }, result.status);
    }
    getProjectsContext().emit("lead_session.changed", {
      type: "lead_session_changed",
      kind: "deleted",
      session: result.data,
    });
    return c.json({ ok: true, session: result.data });
  });

  app.get("/lead-sessions/:id/transcript", async (c) => {
    const id = c.req.param("id");
    const config = getProjectsConfig();
    const found = await findLeadSession(config, id);
    if (!found.ok) {
      return c.json({ error: found.error }, found.status);
    }
    return c.json(await readLeadTranscript(found.projectDir, found.session));
  });

  app.post("/lead-sessions/:id/messages", async (c) => {
    const id = c.req.param("id");
    const parsed = SendLeadSessionMessageRequestSchema.safeParse(
      await c.req.json()
    );
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid body" },
        400
      );
    }
    const content = parsed.data.content.trim();
    if (!content) return c.json({ error: "Content is required" }, 400);

    const config = getProjectsConfig();
    const found = await findLeadSession(config, id);
    if (!found.ok) {
      return c.json({ error: found.error }, found.status);
    }
    const hasUserMessage = await leadTranscriptHasUserMessage(
      found.projectDir,
      found.session
    );
    let session = found.session;
    if (parsed.data.agentId && parsed.data.agentId !== found.session.agentId) {
      if (hasUserMessage) {
        return c.json({ error: "Lead agent is locked for this session" }, 409);
      }
      const ctx = getProjectsContext();
      const agent = ctx.getAgent(parsed.data.agentId);
      if (!agent || !ctx.isAgentActive(parsed.data.agentId)) {
        return c.json({ error: "Agent not found" }, 404);
      }
      session = { ...found.session, agentId: parsed.data.agentId };
    }

    const result = await sendLeadSessionMessage({
      projectDir: found.projectDir,
      session,
      content,
      files: parsed.data.files,
    });
    getProjectsContext().emit("lead_session.changed", {
      type: "lead_session_changed",
      kind: "updated",
      session: result.session,
    });
    maybeAutoTitleLeadSession({
      config,
      projectDir: found.projectDir,
      session: result.session,
      hadUserMessageBeforeSend: hasUserMessage,
    });
    return c.json({ session: result.session, result: result.result });
  });

  app.delete("/projects/:id/lead-sessions/:agentId", async (c) => {
    const id = c.req.param("id");
    const agentId = c.req.param("agentId");
    const config = getProjectsConfig();
    const projectResult = await getProject(config, id);
    if (!projectResult.ok) {
      return c.json({ error: projectResult.error }, 404);
    }
    const project = projectResult.data;
    const frontmatter = project.frontmatter ?? {};
    const sessionKeys =
      typeof frontmatter.sessionKeys === "object" &&
      frontmatter.sessionKeys !== null
        ? { ...(frontmatter.sessionKeys as Record<string, string>) }
        : {};
    const sessionKey = sessionKeys[agentId];
    if (!sessionKey) {
      return c.json({ error: "Lead session not found" }, 404);
    }
    delete sessionKeys[agentId];
    await clearLeadSessionState(agentId, sessionKey);
    const updateResult = await updateProject(config, id, {
      sessionKeys: Object.keys(sessionKeys).length > 0 ? sessionKeys : null,
    });
    if (!updateResult.ok) {
      return c.json({ error: updateResult.error }, 400);
    }
    emitProjectFileChanged(
      id,
      projectDirNameFromPath(project.path),
      "README.md"
    );
    return c.json({ ok: true, agentId });
  });

  app.post("/projects/:id/lead-sessions/:agentId/reset", async (c) => {
    const id = c.req.param("id");
    const agentId = c.req.param("agentId");
    const config = getProjectsConfig();
    const projectResult = await getProject(config, id);
    if (!projectResult.ok) {
      return c.json({ error: projectResult.error }, 404);
    }
    const project = projectResult.data;
    const frontmatter = project.frontmatter ?? {};
    const sessionKeys =
      typeof frontmatter.sessionKeys === "object" &&
      frontmatter.sessionKeys !== null
        ? { ...(frontmatter.sessionKeys as Record<string, string>) }
        : {};
    const sessionKey = sessionKeys[agentId];
    if (!sessionKey) {
      return c.json({ error: "Lead session not found" }, 404);
    }
    await clearLeadSessionState(agentId, sessionKey);
    const nextSessionKey = `project:${id}:${agentId}`;
    sessionKeys[agentId] = nextSessionKey;
    const updateResult = await updateProject(config, id, { sessionKeys });
    if (!updateResult.ok) {
      return c.json({ error: updateResult.error }, 400);
    }
    emitProjectFileChanged(
      id,
      projectDirNameFromPath(project.path),
      "README.md"
    );
    return c.json({ ok: true, agentId, sessionKey: nextSessionKey });
  });

  app.get("/subagents", async (c) => {
    const config = getProjectsConfig();
    const includeArchived = ["1", "true"].includes(
      c.req.query("includeArchived") ?? ""
    );
    const items = await listAllSubagents(config, {
      projectId: c.req.query("projectId"),
      sliceId: c.req.query("sliceId"),
      status: c.req.query("status"),
      cwd: c.req.query("cwd"),
      includeArchived,
    });
    return c.json({ items });
  });

  app.get("/activity", async (c) => {
    const config = getProjectsConfig();
    const offsetParam = c.req.query("offset") ?? "0";
    const limitParam = c.req.query("limit") ?? "20";
    const offset = Number(offsetParam);
    const limit = Number(limitParam);
    if (
      !Number.isFinite(offset) ||
      offset < 0 ||
      !Number.isFinite(limit) ||
      limit < 1
    ) {
      return c.json({ error: "Invalid pagination params" }, 400);
    }
    const events = await getRecentActivity(config, { offset, limit });
    return c.json({ events });
  });

  app.post("/projects/:id/subagents", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json();
    const config = getProjectsConfig();
    const result = await spawnProjectSubagent(config, id, body);
    if (!result.ok) {
      return c.json({ error: result.error }, result.status);
    }
    return c.json(result.data, result.status);
  });

  app.patch("/projects/:id/subagents/:slug", async (c) => {
    const id = c.req.param("id");
    const slug = c.req.param("slug");
    const body = await c.req.json();
    const parsed = UpdateSubagentRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }

    const name =
      typeof parsed.data.name === "string" && parsed.data.name.trim()
        ? parsed.data.name.trim()
        : undefined;
    const model =
      typeof parsed.data.model === "string" && parsed.data.model.trim()
        ? parsed.data.model.trim()
        : undefined;
    const reasoningEffort =
      typeof parsed.data.reasoningEffort === "string" &&
      parsed.data.reasoningEffort.trim()
        ? parsed.data.reasoningEffort.trim()
        : undefined;
    const thinking =
      typeof parsed.data.thinking === "string" && parsed.data.thinking.trim()
        ? parsed.data.thinking.trim()
        : undefined;

    if (!name && !model && !reasoningEffort && !thinking) {
      return c.json(
        {
          error:
            "At least one of name/model/reasoningEffort/thinking is required",
        },
        400
      );
    }

    const config = getProjectsConfig();
    const result = await updateSubagentConfig(config, id, slug, {
      name,
      model,
      reasoningEffort,
      thinking,
    });
    if (!result.ok) {
      const status =
        result.error.startsWith("Project not found") ||
        result.error.startsWith("Subagent not found")
          ? 404
          : 400;
      return c.json({ error: result.error }, status);
    }
    return c.json(result.data);
  });

  app.post("/projects/:id/subagents/:slug/interrupt", async (c) => {
    const id = c.req.param("id");
    const slug = c.req.param("slug");
    const config = getProjectsConfig();
    const result = await interruptSubagent(config, id, slug);
    if (!result.ok) {
      const status = result.error.startsWith("Project not found") ? 404 : 400;
      return c.json({ error: result.error }, status);
    }
    return c.json(result.data);
  });

  app.post("/projects/:id/subagents/:slug/kill", async (c) => {
    const id = c.req.param("id");
    const slug = c.req.param("slug");
    const config = getProjectsConfig();
    const result = await killSubagent(config, id, slug);
    if (!result.ok) {
      const status =
        result.error.startsWith("Project not found") ||
        result.error.startsWith("Subagent not found")
          ? 404
          : 400;
      return c.json({ error: result.error }, status);
    }
    return c.json(result.data);
  });

  app.post("/projects/:id/subagents/:slug/archive", async (c) => {
    const id = c.req.param("id");
    const slug = c.req.param("slug");
    const config = getProjectsConfig();
    const result = await archiveSubagent(config, id, slug);
    if (!result.ok) {
      const status =
        result.error.startsWith("Project not found") ||
        result.error.startsWith("Subagent not found")
          ? 404
          : 400;
      return c.json({ error: result.error }, status);
    }
    return c.json(result.data);
  });

  app.post("/projects/:id/subagents/:slug/unarchive", async (c) => {
    const id = c.req.param("id");
    const slug = c.req.param("slug");
    const config = getProjectsConfig();
    const result = await unarchiveSubagent(config, id, slug);
    if (!result.ok) {
      const status =
        result.error.startsWith("Project not found") ||
        result.error.startsWith("Subagent not found")
          ? 404
          : 400;
      return c.json({ error: result.error }, status);
    }
    return c.json(result.data);
  });

  app.get("/projects/:id/subagents/:slug/logs", async (c) => {
    const id = c.req.param("id");
    const slug = c.req.param("slug");
    const sinceParam = c.req.query("since") ?? "0";
    const since = Number(sinceParam);
    if (!Number.isFinite(since) || since < 0) {
      return c.json({ error: "Invalid since cursor" }, 400);
    }
    const config = getProjectsConfig();
    const result = await getSubagentLogs(config, id, slug, since);
    if (!result.ok) {
      return c.json({ error: result.error }, 404);
    }
    return c.json(result.data);
  });

  app.get("/projects/:id/branches", async (c) => {
    const id = c.req.param("id");
    const config = getProjectsConfig();
    const result = await listProjectBranches(config, id);
    if (!result.ok) {
      const status = result.error === "Project repo not set" ? 400 : 404;
      return c.json({ error: result.error }, status);
    }
    return c.json(result.data);
  });

  app.get("/projects/:id/space", async (c) => {
    const id = c.req.param("id");
    const config = getProjectsConfig();
    const result = await getProjectSpace(config, id);
    if (!result.ok) {
      const status =
        result.error.startsWith("Project not found") ||
        result.error === "Project space not found"
          ? 404
          : result.error === "Project repo not set"
            ? 400
            : 500;
      return c.json({ error: result.error }, status);
    }
    return c.json(result.data);
  });

  app.get("/projects/:id/space/commits", async (c) => {
    const id = c.req.param("id");
    const limitParam = c.req.query("limit");
    const limit = limitParam ? Number(limitParam) : 20;
    const config = getProjectsConfig();
    try {
      const commits = await getProjectSpaceCommitLog(config, id, limit);
      return c.json({ commits });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      const status =
        message.startsWith("Project not found") ||
        message === "Project space not found"
          ? 404
          : message === "Project repo not set"
            ? 400
            : 500;
      return c.json({ error: message }, status);
    }
  });

  app.get("/projects/:id/space/contributions/:entryId", async (c) => {
    const id = c.req.param("id");
    const entryId = c.req.param("entryId");
    const config = getProjectsConfig();
    try {
      const contribution = await getProjectSpaceContribution(
        config,
        id,
        entryId
      );
      return c.json(contribution);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      const status =
        message.startsWith("Project not found") ||
        message === "Project space not found" ||
        message === "Space integration entry not found"
          ? 404
          : message === "Project repo not set"
            ? 400
            : 500;
      return c.json({ error: message }, status);
    }
  });

  app.post("/projects/:id/space/integrate", async (c) => {
    const id = c.req.param("id");
    const config = getProjectsConfig();
    try {
      const result = await integrateProjectSpaceQueue(config, id, {
        resume: true,
      });
      return c.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      const status =
        message.startsWith("Project not found") ||
        message === "Project space not found"
          ? 404
          : message === "Project repo not set" ||
              message === "Not a git repository"
            ? 400
            : 500;
      return c.json({ error: message }, status);
    }
  });

  app.post("/projects/:id/space/entries/skip", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const parsed = SpaceEntriesRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    const config = getProjectsConfig();
    try {
      const result = await skipSpaceEntries(config, id, parsed.data.entryIds);
      return c.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      const status =
        message.startsWith("Project not found") ||
        message === "Project space not found"
          ? 404
          : message === "Project repo not set"
            ? 400
            : 500;
      return c.json({ error: message }, status);
    }
  });

  app.post("/projects/:id/space/entries/integrate", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const parsed = SpaceEntriesRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    const config = getProjectsConfig();
    try {
      const result = await integrateSpaceEntries(
        config,
        id,
        parsed.data.entryIds
      );
      return c.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      const status =
        message.startsWith("Project not found") ||
        message === "Project space not found"
          ? 404
          : message === "Project repo not set" ||
              message === "Not a git repository"
            ? 400
            : 500;
      return c.json({ error: message }, status);
    }
  });

  app.post("/projects/:id/space/rebase", async (c) => {
    const id = c.req.param("id");
    const config = getProjectsConfig();
    try {
      const space = await rebaseSpaceOntoMain(config, id);
      return c.json(space);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      const status =
        message.startsWith("Project not found") ||
        message === "Project space not found"
          ? 404
          : message === "Project repo not set" ||
              message === "Not a git repository"
            ? 400
            : 500;
      return c.json({ error: message }, status);
    }
  });

  app.post("/projects/:id/space/merge", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const parsed = MergeSpaceRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    const config = getProjectsConfig();
    try {
      const merge = await mergeSpaceIntoBase(config, id, {
        cleanup: parsed.data.cleanup ?? true,
      });
      const updated = await updateProject(config, id, { status: "done" });
      if (!updated.ok) {
        throw new Error(updated.error);
      }
      await recordProjectStatusActivity({ projectId: id, status: "done" });
      emitProjectFileChanged(id, updated.data.path, "README.md");
      return c.json({ merge, project: updated.data });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      const status =
        message.startsWith("Project not found") ||
        message === "Project space not found"
          ? 404
          : message.startsWith("Space queue has unresolved entries") ||
              message.startsWith("Space merge failed")
            ? 409
            : message === "Project repo not set" ||
                message === "Not a git repository"
              ? 400
              : 500;
      return c.json({ error: message }, status);
    }
  });

  app.post("/projects/:id/space/rebase/fix", async (c) => {
    const id = c.req.param("id");
    const config = getProjectsConfig();
    const result = await fixSpaceRebaseConflict(config, id);
    if (!result.ok) {
      return c.json({ error: result.error }, result.status);
    }
    return c.json(result.data, result.status);
  });

  app.post("/projects/:id/space/conflicts/:entryId/fix", async (c) => {
    const id = c.req.param("id");
    const entryId = c.req.param("entryId");
    const config = getProjectsConfig();
    const result = await fixSpaceQueueConflict(config, id, entryId);
    if (!result.ok) {
      return c.json({ error: result.error }, result.status);
    }
    return c.json(result.data, result.status);
  });

  app.get("/projects/:id/space/lease", async (c) => {
    const id = c.req.param("id");
    if (!isSpaceWriteLeaseEnabled()) {
      return c.json({ enabled: false, lease: null });
    }
    const config = getProjectsConfig();
    const lease = await getProjectSpaceWriteLease(config, id);
    if (!lease.ok) {
      const status = lease.error.startsWith("Project not found") ? 404 : 400;
      return c.json({ error: lease.error }, status);
    }
    return c.json({ enabled: true, lease: lease.data });
  });

  app.post("/projects/:id/space/lease", async (c) => {
    const id = c.req.param("id");
    if (!isSpaceWriteLeaseEnabled()) {
      return c.json({ error: "Space write lease is disabled" }, 404);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = AcquireSpaceLeaseRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    const config = getProjectsConfig();
    const lease = await acquireProjectSpaceWriteLease(config, id, parsed.data);
    if (!lease.ok) {
      const status = lease.error.startsWith("Project not found")
        ? 404
        : lease.error.includes("held by")
          ? 409
          : 400;
      return c.json({ error: lease.error }, status);
    }
    return c.json({ enabled: true, lease: lease.data });
  });

  app.delete("/projects/:id/space/lease", async (c) => {
    const id = c.req.param("id");
    if (!isSpaceWriteLeaseEnabled()) {
      return c.json({ enabled: false, lease: null });
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = ReleaseSpaceLeaseRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    const config = getProjectsConfig();
    const released = await releaseProjectSpaceWriteLease(
      config,
      id,
      parsed.data
    );
    if (!released.ok) {
      const status = released.error.startsWith("Project not found")
        ? 404
        : released.error.includes("held by")
          ? 409
          : 400;
      return c.json({ error: released.error }, status);
    }
    return c.json({ enabled: true, lease: null });
  });

  app.get("/projects/:id/changes", async (c) => {
    const id = c.req.param("id");
    const config = getProjectsConfig();
    try {
      const result = await getProjectChanges(config, id);
      return c.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      const status =
        message === "Project repo not set" || message === "Not a git repository"
          ? 400
          : message.startsWith("Project not found")
            ? 404
            : 500;
      return c.json({ error: message }, status);
    }
  });

  app.get("/projects/:id/pr-target", async (c) => {
    const id = c.req.param("id");
    const config = getProjectsConfig();
    try {
      const target = await getProjectPullRequestTarget(config, id);
      return c.json(target);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      const status =
        message === "Project repo not set" || message === "Not a git repository"
          ? 400
          : message.startsWith("Project not found")
            ? 404
            : 500;
      return c.json({ error: message }, status);
    }
  });

  app.post("/projects/:id/commit", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const parsed = CommitProjectChangesRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }

    const config = getProjectsConfig();
    try {
      const result = await commitProjectChanges(
        config,
        id,
        parsed.data.message
      );
      if (!result.ok) {
        const status =
          result.error === "Project repo not set" ||
          result.error === "Not a git repository" ||
          result.error === "Nothing to commit"
            ? 400
            : result.error.startsWith("Project not found")
              ? 404
              : 500;
        return c.json({ error: result.error }, status);
      }
      return c.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      const status =
        message === "Project repo not set" || message === "Not a git repository"
          ? 400
          : message.startsWith("Project not found")
            ? 404
            : 500;
      return c.json({ error: message }, status);
    }
  });

  app.get("/taskboard", async (c) => {
    const config = getProjectsConfig();
    const result = await scanTaskboard(config.taskboard);
    if (!result.ok) {
      return c.json({ error: result.error }, 400);
    }
    return c.json(result.data);
  });

  app.get("/taskboard/:type/:id", async (c) => {
    const type = c.req.param("type");
    const id = c.req.param("id");
    const companion = c.req.query("companion");

    if (type !== "todo" && type !== "project") {
      return c.json(
        { error: "Invalid type. Must be 'todo' or 'project'" },
        400
      );
    }

    const config = getProjectsConfig();
    const result = await getTaskboardItem(
      config.taskboard,
      type,
      id,
      companion
    );
    if (!result.ok) {
      return c.json({ error: result.error }, 404);
    }
    return c.json(result.data);
  });
}

// Re-exports for gateway/internal consumers
export { recordCommentActivity } from "./activity/index.js";
export * from "./projects/index.js";
export { spawnProjectSubagent } from "./use-cases/spawn-project-subagent.js";
export {
  archiveSubagent,
  getSubagentLogs,
  listAllSubagents,
  listSubagents,
} from "./subagents/index.js";
export { interruptSubagent, killSubagent } from "./subagents/runner.js";
export {
  createProjectCommentHandler,
  createProjectsCommand,
  registerProjectsCommands,
  registerSlicesCommands,
} from "./cli/index.js";

const projectsExtension: Extension = {
  id: "projects",
  displayName: "Projects",
  factory: true,
  description: "Project planning, taskboard, and subagent orchestration APIs",
  dependencies: [],
  configSchema: ProjectsExtensionConfigSchema,
  routePrefixes: [
    "/api/areas",
    "/api/config",
    "/api/projects",
    "/api/lead-sessions",
    "/api/subagents",
    "/api/activity",
    "/api/taskboard",
  ],
  validateConfig(raw) {
    const result = ProjectsExtensionConfigSchema.safeParse(raw);
    return {
      valid: result.success,
      errors: result.success
        ? []
        : result.error.issues.map((issue) => issue.message),
    };
  },
  registerRoutes(app) {
    registerProjectRoutes(app);
  },
  async start(ctx) {
    setProjectsContext(ctx);
    const config = getProjectsConfig();
    watcher = startProjectWatcher(config);
    orchestrator = startOrchestratorDaemon(config);
  },
  async stop() {
    await orchestrator?.stop();
    orchestrator = null;
    await watcher?.close();
    watcher = null;
    clearProjectsContext();
  },
  capabilities() {
    return ["projects", "subagents", "areas", "activity", "taskboard"];
  },
  getAgentTools() {
    return createProjectAgentTools();
  },
};

export { projectsExtension };
