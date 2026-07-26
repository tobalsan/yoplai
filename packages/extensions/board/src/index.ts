import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import {
  expandPath,
  type Extension,
  type ExtensionContext,
  type SubagentRun,
} from "@yoplai/shared";
import {
  getCachedSpace,
  archiveProject,
  getProject,
  interruptSubagent as interruptProjectSubagent,
  listAllSubagents,
  listSlices,
  startSpaceCacheWatcher,
  unarchiveProject,
  updateProject,
} from "@yoplai/extension-projects";
import {
  getLiveSubagentRunsByCwd,
  listSubagentRuns,
  getSubagentRun,
  interruptSubagentRun,
} from "@yoplai/extension-subagents";
import {
  invalidateProjectCache,
  mapToLifecycleStatus,
  MOVEABLE_LIFECYCLE_STATUSES,
  readSliceProgress,
  resetProjectCaches,
  scanProjectLifecycleMetadata,
  scanProjects,
  validateLifecycleTransition,
} from "./projects.js";
import {
  scanAreaSummaries,
  toggleAreaHidden,
  updateLoopEntry,
} from "./areas.js";
import {
  aggregateActivity,
  MAX_ACTIVITY_ITEMS,
  resetActivityCache,
} from "./activity.js";
// ── Config ──────────────────────────────────────────────────────────

const BoardExtensionConfigSchema = z.object({
  /** Custom board user-content path (defaults to $YOPLAI_HOME) */
  contentRoot: z.string().optional(),
  /** If true, board claims the home route (/) */
  home: z.boolean().default(true),
});

let extensionContext: ExtensionContext | null = null;
let boardRoot: string | null = null;
let unsubscribeFileChanged: (() => void) | null = null;
let stopSpaceCacheWatcher: (() => void) | null = null;
let unsubscribeSubagentChanged: (() => void) | null = null;

function getContext(): ExtensionContext {
  if (!extensionContext) throw new Error("Board extension not started");
  return extensionContext;
}

function getBoardRoot(): string {
  if (!boardRoot) throw new Error("Board root not initialized");
  return boardRoot;
}

function getScratchpadPath(): string {
  return path.join(getBoardRoot(), "SCRATCHPAD.md");
}

function readScratchpad(): { content: string; updatedAt: string } {
  const filePath = getScratchpadPath();
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, "", "utf-8");
  }
  const content = fs.readFileSync(filePath, "utf-8");
  const stat = fs.statSync(filePath);
  return { content, updatedAt: stat.mtime.toISOString() };
}

function writeScratchpad(content: string): { updatedAt: string } {
  const filePath = getScratchpadPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, content, "utf-8");
  fs.renameSync(tmpPath, filePath);
  const stat = fs.statSync(filePath);
  return { updatedAt: stat.mtime.toISOString() };
}

function splitLines(content: string): {
  lines: string[];
  trailingNewline: boolean;
} {
  if (!content) return { lines: [], trailingNewline: false };
  const trailingNewline = content.endsWith("\n");
  const normalized = trailingNewline ? content.slice(0, -1) : content;
  return {
    lines: normalized ? normalized.split(/\r?\n/) : [],
    trailingNewline,
  };
}

function joinLines(lines: string[], trailingNewline: boolean): string {
  const content = lines.join("\n");
  return trailingNewline && content ? `${content}\n` : content;
}

function assertFresh(
  currentUpdatedAt: string,
  expectedUpdatedAt: string | undefined
): void {
  if (expectedUpdatedAt && expectedUpdatedAt !== currentUpdatedAt) {
    throw new Error(
      `Scratchpad changed since read: expected ${expectedUpdatedAt}, got ${currentUpdatedAt}`
    );
  }
}

function readScratchpadLines(startLine?: number, endLine?: number) {
  const scratchpad = readScratchpad();
  const { lines } = splitLines(scratchpad.content);
  if (lines.length === 0) {
    if (startLine !== undefined && startLine !== 1) {
      throw new Error("startLine must be 1 for an empty scratchpad");
    }
    if (endLine !== undefined && endLine !== 0) {
      throw new Error("endLine must be 0 for an empty scratchpad");
    }
    return { updatedAt: scratchpad.updatedAt, lineCount: 0, lines: [] };
  }
  const start = startLine ?? 1;
  const end = endLine ?? lines.length;
  if (!Number.isInteger(start) || start < 1) {
    throw new Error("startLine must be a positive integer");
  }
  if (!Number.isInteger(end) || end < start) {
    throw new Error("endLine must be greater than or equal to startLine");
  }
  if (end > lines.length) {
    throw new Error(`endLine ${end} exceeds line count ${lines.length}`);
  }
  return {
    updatedAt: scratchpad.updatedAt,
    lineCount: lines.length,
    lines: lines.slice(start - 1, end).map((text, index) => ({
      line: start + index,
      text,
    })),
  };
}

function assertLineRange(
  lineCount: number,
  startLine: number,
  endLine: number
): void {
  if (!Number.isInteger(startLine) || startLine < 1) {
    throw new Error("startLine must be a positive integer");
  }
  if (!Number.isInteger(endLine) || endLine < startLine) {
    throw new Error("endLine must be greater than or equal to startLine");
  }
  if (endLine > lineCount) {
    throw new Error(`endLine ${endLine} exceeds line count ${lineCount}`);
  }
}

function editScratchpadLines(params: {
  startLine: number;
  endLine: number;
  content?: string;
  expectedContent?: string;
  expectedUpdatedAt?: string;
}) {
  const scratchpad = readScratchpad();
  assertFresh(scratchpad.updatedAt, params.expectedUpdatedAt);
  const parsed = splitLines(scratchpad.content);
  assertLineRange(parsed.lines.length, params.startLine, params.endLine);

  const currentContent = parsed.lines
    .slice(params.startLine - 1, params.endLine)
    .join("\n");
  if (
    params.expectedContent !== undefined &&
    params.expectedContent !== currentContent
  ) {
    throw new Error("Scratchpad lines did not match expectedContent");
  }

  const replacement = splitLines(params.content ?? "").lines;
  parsed.lines.splice(
    params.startLine - 1,
    params.endLine - params.startLine + 1,
    ...replacement
  );
  const result = writeScratchpad(
    joinLines(parsed.lines, parsed.trailingNewline)
  );
  return { ...result, lineCount: parsed.lines.length };
}

function insertScratchpadLines(params: {
  afterLine: number;
  content: string;
  expectedUpdatedAt?: string;
}) {
  const scratchpad = readScratchpad();
  assertFresh(scratchpad.updatedAt, params.expectedUpdatedAt);
  const parsed = splitLines(scratchpad.content);
  if (
    !Number.isInteger(params.afterLine) ||
    params.afterLine < 0 ||
    params.afterLine > parsed.lines.length
  ) {
    throw new Error(
      `afterLine must be an integer between 0 and ${parsed.lines.length}`
    );
  }
  const insertedLines = splitLines(params.content).lines;
  parsed.lines.splice(params.afterLine, 0, ...insertedLines);
  const result = writeScratchpad(
    joinLines(parsed.lines, parsed.trailingNewline)
  );
  return { ...result, lineCount: parsed.lines.length };
}

function resolveBoardRoot(ctx: ExtensionContext, rawConfig: unknown): string {
  const parsed = BoardExtensionConfigSchema.pick({ contentRoot: true }).parse(
    rawConfig
  );
  if (parsed.contentRoot) return expandPath(parsed.contentRoot);
  return ctx.getDataDir();
}

function resolveProjectRoots(ctx: ExtensionContext): {
  root: string;
  worktreesRoot: string;
} {
  const config = ctx.getConfig();
  const root = expandPath(
    config.extensions?.projects?.root ?? config.projects?.root ?? "~/projects"
  );
  const legacyProjectsConfig = config.projects as
    | ({ worktrees?: string } & typeof config.projects)
    | undefined;
  const worktreeSetting =
    config.extensions?.projects?.worktreeDir ??
    legacyProjectsConfig?.worktrees ??
    "~/.worktrees";
  const worktreesRoot =
    worktreeSetting.startsWith("/") || worktreeSetting.startsWith("~")
      ? expandPath(worktreeSetting)
      : path.join(root, worktreeSetting);
  return { root, worktreesRoot };
}

function isProjectFileChange(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const file = (payload as { file?: unknown }).file;
  return typeof file === "string" && file.endsWith(".md");
}

function emitBoardProjectChanged(projectId: string, projectPath: string): void {
  getContext().emit("file.changed", {
    type: "file_changed",
    projectId,
    file: `${projectPath}/README.md`,
  });
}

// ── Simplified project statuses ─────────────────────────────────────

const BOARD_STATUSES = ["intent", "current", "review", "done"] as const;

// ── Routes ──────────────────────────────────────────────────────────

const registeredApps = new WeakSet<object>();

function registerBoardRoutes(app: Hono): void {
  if (registeredApps.has(app)) return;
  registeredApps.add(app);

  // Health / info
  app.get("/board/info", (c) => {
    const config = getContext().getConfig();
    const raw = config.extensions?.board ?? {};
    const parsed = BoardExtensionConfigSchema.parse(raw);
    return c.json({
      id: "board",
      home: parsed.home,
      contentRoot: getBoardRoot(),
      root: getBoardRoot(),
      statuses: BOARD_STATUSES,
    });
  });

  // Canvas commands — agent tells the UI what to show
  // These are stored in a simple in-memory map per session
  // (Will evolve to persistent store later)
  const canvasState = new Map<
    string,
    { panel: string; props?: Record<string, unknown> }
  >();

  app.post("/board/canvas/:agentId", async (c) => {
    const agentId = c.req.param("agentId");
    const body = await c.req.json();
    const panel = typeof body.panel === "string" ? body.panel : "overview";
    const props =
      typeof body.props === "object" && body.props !== null
        ? (body.props as Record<string, unknown>)
        : undefined;

    canvasState.set(agentId, { panel, props });

    // Emit event so SSE subscribers know
    getContext().emit("canvas.updated", { agentId, panel, props });

    return c.json({ ok: true, agentId, panel, props });
  });

  app.get("/board/canvas/:agentId", (c) => {
    const agentId = c.req.param("agentId");
    const state = canvasState.get(agentId) ?? { panel: "overview" };
    return c.json(state);
  });

  app.get("/board/projects", async (c) => {
    const profile = c.req.query("profile") === "true";
    const startedAt = profile ? Date.now() : 0;
    const includeDone = c.req.query("include") === "done";
    const { root, worktreesRoot } = resolveProjectRoots(getContext());
    const config = getContext().getConfig();
    const lifecycle = await scanProjectLifecycleMetadata(root);
    const items = await scanProjects(root, includeDone, worktreesRoot, {
      getSpace: (projectId) => getCachedSpace(config, projectId),
      runsByCwd: getLiveSubagentRunsByCwd(),
      lifecycleStatuses: lifecycle.statuses,
    });
    if (profile) c.header("X-Profile-Ms", String(Date.now() - startedAt));
    return c.json({ items, lifecycleCounts: lifecycle.counts });
  });

  // ── Project lifecycle move ────────────────────────────────────────────

  app.post("/board/projects/:id/move", async (c) => {
    const projectId = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const targetStatus =
      typeof body.status === "string" ? body.status : undefined;

    if (!targetStatus) {
      return c.json(
        { error: "status is required", code: "missing_status" },
        400
      );
    }
    if (
      !MOVEABLE_LIFECYCLE_STATUSES.has(
        targetStatus as Parameters<typeof validateLifecycleTransition>[1]
      )
    ) {
      return c.json(
        {
          error: `Unknown lifecycle status: ${targetStatus}`,
          code: "unknown_status",
        },
        400
      );
    }
    const config = getContext().getConfig();

    // Fetch current project
    const result = await getProject(config, projectId);
    if (!result.ok) {
      return c.json({ error: result.error, code: "not_found" }, 404);
    }

    const currentRawStatus =
      typeof result.data.frontmatter.status === "string"
        ? result.data.frontmatter.status
        : "shaping";
    const currentLifecycle = mapToLifecycleStatus(currentRawStatus);
    const targetLifecycle = targetStatus as Parameters<
      typeof validateLifecycleTransition
    >[1];

    // For active→done, validate slice progress
    let sliceProgress: { done: number; total: number } | undefined;
    if (currentLifecycle === "active" && targetLifecycle === "done") {
      sliceProgress = await readSliceProgress(result.data.absolutePath);
      // Fallback to listSlices for accurate terminal count
      const slices = await listSlices(result.data.absolutePath);
      const total = slices.length;
      const terminalCount = slices.filter(
        (s) =>
          s.frontmatter.status === "done" ||
          s.frontmatter.status === "cancelled"
      ).length;
      const doneCount = slices.filter(
        (s) => s.frontmatter.status === "done"
      ).length;
      if (total > 0 && terminalCount < total) {
        sliceProgress = { done: terminalCount, total };
      } else if (total > 0 && doneCount === 0) {
        // All cancelled but none done — still reject
        sliceProgress = { done: 0, total };
      } else {
        sliceProgress = undefined;
      }
    }

    const validation = validateLifecycleTransition(
      currentLifecycle,
      targetLifecycle,
      sliceProgress
    );
    if (!validation.ok) {
      return c.json({ error: validation.reason, code: validation.code }, 422);
    }

    let changedProjectPath: string;
    if (targetLifecycle === "archived") {
      const archiveResult = await archiveProject(config, projectId);
      if (!archiveResult.ok) {
        return c.json(
          { error: archiveResult.error, code: "update_failed" },
          500
        );
      }
      changedProjectPath = archiveResult.data.archivedPath;
    } else if (currentLifecycle === "archived") {
      const unarchiveResult = await unarchiveProject(
        config,
        projectId,
        targetLifecycle
      );
      if (!unarchiveResult.ok) {
        return c.json(
          { error: unarchiveResult.error, code: "update_failed" },
          500
        );
      }
      changedProjectPath = unarchiveResult.data.path;
    } else {
      const updateResult = await updateProject(config, projectId, {
        status: targetStatus,
      });
      if (!updateResult.ok) {
        return c.json(
          { error: updateResult.error, code: "update_failed" },
          500
        );
      }
      changedProjectPath = updateResult.data.path;
    }

    invalidateProjectCache(undefined);
    emitBoardProjectChanged(projectId, changedProjectPath);

    return c.json({
      ok: true,
      id: projectId,
      previousStatus: currentRawStatus,
      status: targetStatus,
    });
  });

  app.get("/board/areas", async (c) => {
    const { root } = resolveProjectRoots(getContext());
    const items = await scanAreaSummaries(root);
    return c.json({ items });
  });

  app.patch("/board/areas/:areaId/hidden", async (c) => {
    const areaId = c.req.param("areaId");
    const body = await c.req.json();
    const hidden = body.hidden === true;
    const { root } = resolveProjectRoots(getContext());
    await toggleAreaHidden(root, areaId, hidden);
    return c.json({ ok: true, areaId, hidden });
  });

  app.put("/board/areas/:areaId/loop", async (c) => {
    const areaId = c.req.param("areaId");
    const body = await c.req.json();
    const date = typeof body.date === "string" ? body.date : "";
    const content = typeof body.body === "string" ? body.body : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return c.json({ error: "Invalid date format, expected YYYY-MM-DD" }, 400);
    }
    const { root } = resolveProjectRoots(getContext());
    await updateLoopEntry(root, areaId, date, content);
    return c.json({ ok: true, areaId, date });
  });

  // ── Agents (live subagent runs) ────────────────────────────────────

  function boardRuntimeOptions() {
    const ctx = getContext();
    return {
      dataDir: ctx.getDataDir(),
      emit: (event: Parameters<typeof ctx.emit>[1]) => {
        ctx.emit("subagent.changed", event);
      },
    };
  }

  function projectRunId(projectId: string, slug: string): string {
    return `${projectId}:${slug}`;
  }

  function isRuntimeCli(
    value: string | undefined
  ): value is SubagentRun["cli"] {
    return (
      value === "claude" ||
      value === "codex" ||
      value === "pi" ||
      value === "openclaw"
    );
  }

  function toBoardProjectRun(
    item: Awaited<ReturnType<typeof listAllSubagents>>[number]
  ): SubagentRun | null {
    if (item.status !== "running" || !item.projectId) return null;
    return {
      id: projectRunId(item.projectId, item.slug),
      label: item.name ?? item.slug,
      projectId: item.projectId,
      sliceId: item.sliceId,
      cli: isRuntimeCli(item.cli) ? item.cli : "codex",
      cwd: item.worktreePath ?? "",
      prompt: "",
      status: "running",
      startedAt:
        item.runStartedAt ?? item.lastActive ?? new Date(0).toISOString(),
      lastActiveAt: item.lastActive,
    };
  }

  app.get("/board/agents", async (c) => {
    const runs = await listSubagentRuns(boardRuntimeOptions(), {
      includeArchived: false,
    });
    const liveRuns = runs.filter(
      (r) => r.status === "running" || r.status === "starting"
    );
    const projectRuns = (await listAllSubagents(getContext().getConfig()))
      .map(toBoardProjectRun)
      .filter((run): run is SubagentRun => run !== null);
    return c.json({ runs: [...liveRuns, ...projectRuns] });
  });

  app.post("/board/agents/:runId/kill", async (c) => {
    const runId = c.req.param("runId");
    const existing = await getSubagentRun(boardRuntimeOptions(), runId);
    if (!existing) {
      const [projectId, slug] = runId.split(":");
      if (projectId && slug) {
        const result = await interruptProjectSubagent(
          getContext().getConfig(),
          projectId,
          slug
        );
        if (!result.ok) {
          return c.json({ error: result.error, code: "kill_failed" }, 500);
        }
        return c.json({ ok: true, runId, status: "interrupted" });
      }
      return c.json({ error: "Run not found", code: "not_found" }, 404);
    }
    if (
      existing.status === "done" ||
      existing.status === "interrupted" ||
      existing.status === "error"
    ) {
      return c.json({ ok: true, runId, status: existing.status });
    }
    try {
      const run = await interruptSubagentRun(boardRuntimeOptions(), runId);
      return c.json({ ok: true, runId, status: run.status });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message, code: "kill_failed" }, 500);
    }
  });

  // ── Activity feed ─────────────────────────────────────────────────

  app.get("/board/activity", async (c) => {
    const { root } = resolveProjectRoots(getContext());
    const projectId = c.req.query("projectId");
    const limitParam = c.req.query("limit");
    const limit = limitParam
      ? Math.min(parseInt(limitParam, 10) || 50, MAX_ACTIVITY_ITEMS)
      : 50;
    const items = await aggregateActivity({
      projectsRoot: root,
      projectId: projectId || undefined,
      limit,
    });
    return c.json({ items });
  });

  app.get("/board/scratchpad", (c) => {
    const data = readScratchpad();
    return c.json(data);
  });

  app.put("/board/scratchpad", async (c) => {
    const body = await c.req.json();
    const content = typeof body.content === "string" ? body.content : "";
    const result = writeScratchpad(content);
    getContext().emit("scratchpad.updated", {
      updatedAt: result.updatedAt,
    });
    return c.json({ ok: true, ...result });
  });
}

// ── Extension definition ────────────────────────────────────────────

const boardExtension: Extension = {
  id: "board",
  displayName: "Board",
  factory: true,
  description:
    "Two-pane workspace: agent chat + reactive canvas. Simplified project tracking for solo operators.",
  dependencies: ["projects", "subagents"],
  configSchema: BoardExtensionConfigSchema,
  routePrefixes: ["/api/board"],
  validateConfig(raw) {
    const result = BoardExtensionConfigSchema.safeParse(raw);
    return {
      valid: result.success,
      errors: result.success
        ? []
        : result.error.issues.map((issue) => issue.message),
    };
  },
  registerRoutes(app) {
    registerBoardRoutes(app);
  },
  async start(ctx) {
    extensionContext = ctx;

    const config = ctx.getConfig();
    const raw = config.extensions?.board ?? {};
    boardRoot = resolveBoardRoot(ctx, raw);

    fs.mkdirSync(boardRoot, { recursive: true });
    const { root, worktreesRoot } = resolveProjectRoots(ctx);
    unsubscribeFileChanged = ctx.subscribe("file.changed", (payload) => {
      if (!isProjectFileChange(payload)) return;
      invalidateProjectCache(root);
    });
    stopSpaceCacheWatcher = startSpaceCacheWatcher(config, () => {
      invalidateProjectCache(root);
    });
    unsubscribeSubagentChanged = ctx.subscribe("subagent.changed", () => {
      invalidateProjectCache(root);
    });
    void scanProjects(root, false, worktreesRoot, {
      getSpace: (projectId) => getCachedSpace(config, projectId),
      runsByCwd: getLiveSubagentRunsByCwd(),
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger.warn("[board] failed to warm project cache:", message);
    });
    console.log(`[board] extension started (root: ${boardRoot})`);
  },
  async stop() {
    unsubscribeFileChanged?.();
    stopSpaceCacheWatcher?.();
    unsubscribeSubagentChanged?.();
    unsubscribeFileChanged = null;
    stopSpaceCacheWatcher = null;
    unsubscribeSubagentChanged = null;
    resetProjectCaches();
    resetActivityCache();
    extensionContext = null;
    boardRoot = null;
    console.log("[board] extension stopped");
  },
  getSystemPromptContributions() {
    return [
      "Board scratchpad tools:",
      "- scratchpad_read {} → Returns { content: string, updatedAt: string }. The shared scratchpad content.",
      "- scratchpad_write { content: string } → Replaces scratchpad content. Use only when intentionally rewriting the full scratchpad.",
      "- scratchpad_read_lines { startLine?, endLine? } → Returns numbered scratchpad lines.",
      "- scratchpad_insert_lines { afterLine, content, expectedUpdatedAt? } → Inserts lines after a 1-based line number, or 0 for top.",
      "- scratchpad_replace_lines { startLine, endLine, content, expectedContent?, expectedUpdatedAt? } → Replaces an inclusive line range.",
      "- scratchpad_delete_lines { startLine, endLine, expectedContent?, expectedUpdatedAt? } → Deletes an inclusive line range.",
      "Prefer line-level tools for edits to avoid clobbering concurrent scratchpad changes.",
    ].join("\n");
  },
  getAgentTools() {
    return [
      {
        name: "scratchpad.read",
        description: "Read the shared Board scratchpad.",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        execute: () => readScratchpad(),
      },
      {
        name: "scratchpad.write",
        description: "Replace the shared Board scratchpad content.",
        parameters: {
          type: "object",
          properties: {
            content: { type: "string" },
          },
          required: ["content"],
          additionalProperties: false,
        },
        execute: (args) => {
          const parsed = z.object({ content: z.string() }).parse(args);
          return writeScratchpad(parsed.content);
        },
      },
      {
        name: "scratchpad.read_lines",
        description:
          "Read numbered lines from the shared Board scratchpad. Lines are 1-based.",
        parameters: {
          type: "object",
          properties: {
            startLine: { type: "number" },
            endLine: { type: "number" },
          },
          additionalProperties: false,
        },
        execute: (args) => {
          const parsed = z
            .object({
              startLine: z.number().int().positive().optional(),
              endLine: z.number().int().nonnegative().optional(),
            })
            .parse(args);
          return readScratchpadLines(parsed.startLine, parsed.endLine);
        },
      },
      {
        name: "scratchpad.insert_lines",
        description:
          "Insert lines into the shared Board scratchpad after a 1-based line number, or 0 for the top.",
        parameters: {
          type: "object",
          properties: {
            afterLine: { type: "number" },
            content: { type: "string" },
            expectedUpdatedAt: { type: "string" },
          },
          required: ["afterLine", "content"],
          additionalProperties: false,
        },
        execute: (args) => {
          const parsed = z
            .object({
              afterLine: z.number().int().nonnegative(),
              content: z.string(),
              expectedUpdatedAt: z.string().optional(),
            })
            .parse(args);
          return insertScratchpadLines(parsed);
        },
      },
      {
        name: "scratchpad.replace_lines",
        description:
          "Replace an inclusive 1-based line range in the shared Board scratchpad.",
        parameters: {
          type: "object",
          properties: {
            startLine: { type: "number" },
            endLine: { type: "number" },
            content: { type: "string" },
            expectedContent: { type: "string" },
            expectedUpdatedAt: { type: "string" },
          },
          required: ["startLine", "endLine", "content"],
          additionalProperties: false,
        },
        execute: (args) => {
          const parsed = z
            .object({
              startLine: z.number().int().positive(),
              endLine: z.number().int().positive(),
              content: z.string(),
              expectedContent: z.string().optional(),
              expectedUpdatedAt: z.string().optional(),
            })
            .parse(args);
          return editScratchpadLines(parsed);
        },
      },
      {
        name: "scratchpad.delete_lines",
        description:
          "Delete an inclusive 1-based line range from the shared Board scratchpad.",
        parameters: {
          type: "object",
          properties: {
            startLine: { type: "number" },
            endLine: { type: "number" },
            expectedContent: { type: "string" },
            expectedUpdatedAt: { type: "string" },
          },
          required: ["startLine", "endLine"],
          additionalProperties: false,
        },
        execute: (args) => {
          const parsed = z
            .object({
              startLine: z.number().int().positive(),
              endLine: z.number().int().positive(),
              expectedContent: z.string().optional(),
              expectedUpdatedAt: z.string().optional(),
            })
            .parse(args);
          return editScratchpadLines(parsed);
        },
      },
    ];
  },
  capabilities() {
    return ["board", "canvas"];
  },
};

export { boardExtension };
