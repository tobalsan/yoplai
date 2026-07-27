/**
 * Stateless activity feed aggregator for the board extension.
 *
 * Sources (per §15.5 of kanban-slice-refactor spec):
 *   - Project README.md frontmatter: updated_at + status
 *   - Slice README.md frontmatter: updated_at + status
 *   - Subagent sessions/<slug>/state.json: started_at, finished_at, outcome
 *   - Project THREAD.md and slice THREAD.md: timestamped comments
 *
 * Aggregates on each request, cached briefly (5 s TTL).
 * Cap: 100 entries per request.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { splitFrontmatter } from "./frontmatter.js";

export type BoardActivityItemType =
  | "project_status"
  | "slice_status"
  | "run_start"
  | "run_complete"
  | "thread_comment";

export type BoardActivityColor = "green" | "purple" | "blue" | "yellow";

export type BoardActivityItem = {
  /** Stable deterministic id for deduplication. */
  id: string;
  type: BoardActivityItemType;
  projectId: string;
  sliceId?: string;
  /** Subagent session slug (for run_start / run_complete). */
  runSlug?: string;
  /** Primary display text (what / who). */
  actor: string;
  /** Secondary display text (action description). */
  action: string;
  /** ISO 8601 timestamp. */
  timestamp: string;
  color: BoardActivityColor;
};

// ── THREAD.md parser ────────────────────────────────────────────────

type ThreadEntry = { author: string; date: string; body: string };

function parseThreadSections(raw: string): string[] {
  const fmMatch = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  const without = fmMatch ? raw.slice(fmMatch[0].length) : raw;
  return without
    .split(/\r?\n---\r?\n---\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseThreadEntry(section: string): ThreadEntry | null {
  const lines = section.split(/\r?\n/);
  let author = "";
  let date = "";
  let cursor = 0;
  for (; cursor < lines.length; cursor++) {
    const line = (lines[cursor] ?? "").trim();
    if (!line) continue;
    const authorMatch = line.match(/^\[author:(.+)\]$/);
    if (authorMatch) {
      author = (authorMatch[1] ?? "").trim();
      continue;
    }
    const dateMatch = line.match(/^\[date:(.+)\]$/);
    if (dateMatch) {
      date = (dateMatch[1] ?? "").trim();
      continue;
    }
    break;
  }
  const body = lines.slice(cursor).join("\n").trim();
  if (!author && !date && !body) return null;
  return { author, date, body };
}

async function readThreadEntries(threadPath: string): Promise<ThreadEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(threadPath, "utf-8");
  } catch {
    return [];
  }
  return parseThreadSections(raw)
    .map(parseThreadEntry)
    .filter((e): e is ThreadEntry => e !== null);
}

// ── Subagent state.json reader ──────────────────────────────────────

type RunState = {
  supervisor_pid?: number;
  started_at?: string;
  outcome?: string;
  finished_at?: string;
  cli?: string;
  slice_id?: string;
};

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function validIso(ts: unknown): string | null {
  if (typeof ts !== "string" || !ts) return null;
  const d = new Date(ts);
  return Number.isFinite(d.getTime()) ? ts : null;
}

function shortBody(body: string, max = 60): string {
  const s = body.trim().replace(/\s+/g, " ");
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

// ── Status → color ──────────────────────────────────────────────────

function projectStatusColor(status: string): BoardActivityColor {
  if (status === "done" || status === "active" || status === "in_progress")
    return "green";
  if (status === "review") return "purple";
  if (status === "shaping" || status === "maybe") return "yellow";
  return "blue";
}

function sliceStatusColor(status: string): BoardActivityColor {
  if (status === "done") return "green";
  if (status === "review") return "purple";
  if (status === "in_progress") return "blue";
  return "yellow";
}

// ── Per-project aggregation ─────────────────────────────────────────

const SLICE_DIR_RE = /^PRO-\d+-S\d+$/;

async function aggregateProject(
  projectDir: string,
  projectId: string
): Promise<BoardActivityItem[]> {
  const items: BoardActivityItem[] = [];
  const readmePath = path.join(projectDir, "README.md");

  // Project frontmatter
  let projectStatus = "";
  let projectUpdatedAt: string | null = null;
  try {
    const raw = await fs.readFile(readmePath, "utf-8");
    const stat = await fs.stat(readmePath);
    const { frontmatter } = splitFrontmatter(raw);
    projectStatus =
      typeof frontmatter.status === "string" ? frontmatter.status : "";
    projectUpdatedAt =
      validIso(frontmatter.updated_at) ?? stat.mtime.toISOString();
  } catch {
    // project dir unreadable — skip status item but still try slices/sessions/thread
  }

  if (projectStatus && projectUpdatedAt) {
    items.push({
      id: `project:${projectId}:status:${projectStatus}:${projectUpdatedAt}`,
      type: "project_status",
      projectId,
      actor: projectId,
      action: `→ ${projectStatus}`,
      timestamp: projectUpdatedAt,
      color: projectStatusColor(projectStatus),
    });
  }

  // Project THREAD.md
  const projectThread = await readThreadEntries(
    path.join(projectDir, "THREAD.md")
  );
  for (const entry of projectThread) {
    const ts = validIso(entry.date) ?? null;
    if (!ts) continue;
    const id = `thread:${projectId}:${ts}:${entry.author}`;
    items.push({
      id,
      type: "thread_comment",
      projectId,
      actor: entry.author || "unknown",
      action: shortBody(entry.body) || "(comment)",
      timestamp: ts,
      color: "blue",
    });
  }

  // Slices
  const slicesDir = path.join(projectDir, "slices");
  let sliceDirs: string[] = [];
  try {
    const entries = await fs.readdir(slicesDir, { withFileTypes: true });
    sliceDirs = entries
      .filter((e) => e.isDirectory() && SLICE_DIR_RE.test(e.name))
      .map((e) => e.name);
  } catch {
    // no slices dir
  }

  for (const sliceId of sliceDirs) {
    const sliceDir = path.join(slicesDir, sliceId);
    // Slice frontmatter
    const sliceReadme = path.join(sliceDir, "README.md");
    try {
      const raw = await fs.readFile(sliceReadme, "utf-8");
      const stat = await fs.stat(sliceReadme);
      const { frontmatter } = splitFrontmatter(raw);
      const sliceStatus =
        typeof frontmatter.status === "string" ? frontmatter.status : "";
      const sliceTs =
        validIso(frontmatter.updated_at) ?? stat.mtime.toISOString();
      if (sliceStatus && sliceTs) {
        items.push({
          id: `slice:${sliceId}:status:${sliceStatus}:${sliceTs}`,
          type: "slice_status",
          projectId,
          sliceId,
          actor: sliceId,
          action: `→ ${sliceStatus}`,
          timestamp: sliceTs,
          color: sliceStatusColor(sliceStatus),
        });
      }
    } catch {
      // unreadable slice
    }

    // Slice THREAD.md
    const sliceThread = await readThreadEntries(
      path.join(sliceDir, "THREAD.md")
    );
    for (const entry of sliceThread) {
      const ts = validIso(entry.date) ?? null;
      if (!ts) continue;
      const id = `thread:${sliceId}:${ts}:${entry.author}`;
      items.push({
        id,
        type: "thread_comment",
        projectId,
        sliceId,
        actor: entry.author || "unknown",
        action: shortBody(entry.body) || "(comment)",
        timestamp: ts,
        color: "blue",
      });
    }
  }

  // Subagent sessions
  const sessionsDir = path.join(projectDir, "sessions");
  let sessionSlugs: string[] = [];
  try {
    const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
    sessionSlugs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    // no sessions dir
  }

  for (const slug of sessionSlugs) {
    const sessionDir = path.join(sessionsDir, slug);
    const state = await readJson<RunState>(path.join(sessionDir, "state.json"));
    if (!state) continue;

    const startedAt = validIso(state.started_at);
    const finishedAt = validIso(state.finished_at);
    const sliceId = state.slice_id;
    const label = state.cli ? `${state.cli}/${slug}` : slug;

    if (startedAt) {
      items.push({
        id: `run:${projectId}:${slug}:start:${startedAt}`,
        type: "run_start",
        projectId,
        sliceId,
        runSlug: slug,
        actor: label,
        action: "run started",
        timestamp: startedAt,
        color: "green",
      });
    }

    if (finishedAt) {
      const isError = state.outcome !== "done" && state.outcome !== undefined;
      items.push({
        id: `run:${projectId}:${slug}:complete:${finishedAt}`,
        type: "run_complete",
        projectId,
        sliceId,
        runSlug: slug,
        actor: label,
        action: isError ? "run errored" : "run completed",
        timestamp: finishedAt,
        color: isError ? "yellow" : "green",
      });
    }
  }

  return items;
}

// ── Cache ───────────────────────────────────────────────────────────

const CACHE_TTL_MS = 5_000;

type CacheEntry = {
  items: BoardActivityItem[];
  expiresAt: number;
};

const cache = new Map<string, CacheEntry>();

export function resetActivityCache(): void {
  cache.clear();
}

// ── Public API ──────────────────────────────────────────────────────

export type AggregateActivityOptions = {
  /** Projects root directory (e.g. ~/projects). */
  projectsRoot: string;
  /** When set, aggregate only this project. Cross-project feed when absent. */
  projectId?: string;
  /** Max items to return. Capped at 100. Default 50. */
  limit?: number;
  /** Cache TTL override (ms). Default 5000. */
  cacheTtlMs?: number;
};

export const MAX_ACTIVITY_ITEMS = 100;

const PROJECT_DIR_RE = /^PRO-/;
const SKIP_DIRS = new Set([".workspaces", ".archive", ".done", ".trash"]);

export async function aggregateActivity(
  opts: AggregateActivityOptions
): Promise<BoardActivityItem[]> {
  if (opts.projectId && !isSafeProjectId(opts.projectId)) return [];

  const limit = Math.min(Math.max(opts.limit ?? 50, 1), MAX_ACTIVITY_ITEMS);
  const ttl = opts.cacheTtlMs ?? CACHE_TTL_MS;
  const cacheKey = `${opts.projectsRoot}:${opts.projectId ?? "*"}:${limit}`;

  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.items.slice(0, limit);
  }

  let projectDirs: Array<{ id: string; dir: string }> = [];

  if (opts.projectId) {
    // Single project
    const dir = await findProjectDir(opts.projectsRoot, opts.projectId);
    if (dir) projectDirs = [{ id: opts.projectId, dir }];
  } else {
    // All projects
    try {
      const entries = await fs.readdir(opts.projectsRoot, {
        withFileTypes: true,
      });
      projectDirs = entries
        .filter(
          (e) =>
            e.isDirectory() &&
            PROJECT_DIR_RE.test(e.name) &&
            !SKIP_DIRS.has(e.name)
        )
        .map((e) => ({
          id: e.name,
          dir: path.join(opts.projectsRoot, e.name),
        }));
    } catch {
      projectDirs = [];
    }
  }

  const allItems: BoardActivityItem[] = [];
  const results = await Promise.allSettled(
    projectDirs.map(({ id, dir }) => aggregateProject(dir, id))
  );
  for (const r of results) {
    if (r.status === "fulfilled") allItems.push(...r.value);
  }

  // Dedup by id
  const seen = new Set<string>();
  const deduped: BoardActivityItem[] = [];
  for (const item of allItems) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    deduped.push(item);
  }

  // Sort newest first
  deduped.sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );

  // Cap at MAX_ACTIVITY_ITEMS globally before caching
  const capped = deduped.slice(0, MAX_ACTIVITY_ITEMS);

  cache.set(cacheKey, { items: capped, expiresAt: Date.now() + ttl });

  return capped.slice(0, limit);
}

// ── Helpers ─────────────────────────────────────────────────────────

function isSafeProjectId(projectId: string): boolean {
  return (
    PROJECT_DIR_RE.test(projectId) && path.basename(projectId) === projectId
  );
}

async function findProjectDir(
  projectsRoot: string,
  projectId: string
): Promise<string | null> {
  // Exact directory match first (most common: PRO-123 dir)
  const direct = path.join(projectsRoot, projectId);
  try {
    const s = await fs.stat(direct);
    if (s.isDirectory()) return direct;
  } catch {
    // not found
  }
  // Scan for dir whose README frontmatter has matching id
  try {
    const entries = await fs.readdir(projectsRoot, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory() || !PROJECT_DIR_RE.test(e.name)) continue;
      const readmePath = path.join(projectsRoot, e.name, "README.md");
      try {
        const raw = await fs.readFile(readmePath, "utf-8");
        const { frontmatter } = splitFrontmatter(raw);
        if (frontmatter.id === projectId) {
          return path.join(projectsRoot, e.name);
        }
      } catch {
        // skip
      }
    }
  } catch {
    // skip
  }
  return null;
}
