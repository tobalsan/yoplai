/**
 * yoplai projects migrate-to-slices
 *
 * Idempotent command that walks the configured projects root and converts
 * legacy project layouts to the post-refactor slice model.
 *
 * Status mapping (spec §10.1):
 *   not_now        → project: shaping,   NO slice
 *   maybe          → project: shaping,   NO slice
 *   shaping        → project: shaping,   slice: todo
 *   todo           → project: active,    slice: todo
 *   in_progress    → project: active,    slice: in_progress
 *   review         → project: active,    slice: review
 *   ready_to_merge → project: active,    slice: ready_to_merge
 *   done           → project: done,      slice: done
 *   cancelled      → project: cancelled, slice: cancelled
 *   archived       → unchanged (skip)
 *
 * Idempotent: projects with existing slices/ subtree are skipped.
 * Gateway must NOT be running when this command is invoked.
 */

import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import type { GatewayConfig } from "@yoplai/shared";
import { getDefaultConfigPath } from "@yoplai/shared";
import { splitFrontmatter } from "../util/frontmatter.js";
import { getProjectsRoot } from "../util/paths.js";
import { regenerateScopeMap } from "../projects/slices.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type LegacyStatus =
  | "not_now"
  | "maybe"
  | "shaping"
  | "todo"
  | "in_progress"
  | "review"
  | "ready_to_merge"
  | "done"
  | "cancelled"
  | "archived";

export type SliceStatus =
  | "todo"
  | "in_progress"
  | "review"
  | "ready_to_merge"
  | "done"
  | "cancelled";

export type MigratedProjectStatus =
  | "shaping"
  | "active"
  | "done"
  | "cancelled"
  | "archived";

type StatusMapping = {
  projectStatus: MigratedProjectStatus;
  sliceStatus: SliceStatus | null; // null = no slice created
};

export type MigrateProjectResult = {
  id: string;
  dirPath: string;
  outcome: "skipped" | "migrated" | "no-slice";
  legacyStatus: string;
  projectStatus: string;
  sliceId?: string;
  sliceStatus?: string;
};

// ─── Status mapping ───────────────────────────────────────────────────────────

const STATUS_MAP: Record<string, StatusMapping> = {
  not_now: { projectStatus: "shaping", sliceStatus: null },
  maybe: { projectStatus: "shaping", sliceStatus: null },
  shaping: { projectStatus: "shaping", sliceStatus: "todo" },
  todo: { projectStatus: "active", sliceStatus: "todo" },
  in_progress: { projectStatus: "active", sliceStatus: "in_progress" },
  review: { projectStatus: "active", sliceStatus: "review" },
  ready_to_merge: { projectStatus: "active", sliceStatus: "ready_to_merge" },
  done: { projectStatus: "done", sliceStatus: "done" },
  cancelled: { projectStatus: "cancelled", sliceStatus: "cancelled" },
};

// ─── Gateway detection ────────────────────────────────────────────────────────

/**
 * Check if anything is listening on the given host:port.
 * Resolves true if connected, false otherwise.
 */
function isPortReachable(
  host: string,
  port: number,
  timeoutMs = 1000
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.on("connect", () => finish(true));
    socket.on("timeout", () => finish(false));
    socket.on("error", () => finish(false));
    socket.connect(port, host);
  });
}

export async function isGatewayRunning(
  config: GatewayConfig
): Promise<boolean> {
  const port = config.gateway?.port ?? 4000;
  const host = config.gateway?.host ?? "127.0.0.1";
  return isPortReachable(host, port);
}

// ─── Filesystem helpers ───────────────────────────────────────────────────────

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeFileAtomic(
  filePath: string,
  content: string
): Promise<void> {
  const dir = path.dirname(filePath);
  const name = path.basename(filePath);
  const tmpPath = path.join(dir, `.${name}.${process.pid}.${Date.now()}.tmp`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(tmpPath, content, "utf8");
  await fs.rename(tmpPath, filePath);
}

function formatFrontmatterValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return JSON.stringify(value);
}

function serializeFrontmatter(fm: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(fm)) {
    if (value === undefined) continue;
    lines.push(`${key}: ${formatFrontmatterValue(value)}`);
  }
  return `---\n${lines.join("\n")}\n---\n`;
}

// ─── Project discovery ────────────────────────────────────────────────────────

const PROJECT_ID_PATTERN = /^PRO-\d+/;
const ARCHIVE_DIR = ".archive";
const DONE_DIR = ".done";

type ProjectLocation = { id: string; dirPath: string };

async function listProjectLocations(root: string): Promise<ProjectLocation[]> {
  const bases = [root, path.join(root, ARCHIVE_DIR), path.join(root, DONE_DIR)];
  const found = new Map<string, ProjectLocation>();

  for (const base of bases) {
    if (!(await pathExists(base))) continue;
    const entries = await fs.readdir(base, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const match = entry.name.match(/^(PRO-\d+)/);
      if (!match) continue;
      const id = match[1] as string;
      if (!PROJECT_ID_PATTERN.test(id)) continue;
      if (!found.has(id)) {
        found.set(id, { id, dirPath: path.join(base, entry.name) });
      }
    }
  }

  return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
}

// ─── Per-project migration ────────────────────────────────────────────────────

const META_DIR = ".meta";
const COUNTERS_FILE = "counters.json";
const SLICES_DIR = "slices";
const README_FILE = "README.md";
const SPECS_FILE = "SPECS.md";
const TASKS_FILE = "TASKS.md";
const VALIDATION_FILE = "VALIDATION.md";
const THREAD_FILE = "THREAD.md";

function formatSliceId(projectId: string, n: number): string {
  return `${projectId}-S${String(n).padStart(2, "0")}`;
}

async function migrateProject(
  project: ProjectLocation
): Promise<MigrateProjectResult> {
  const { id, dirPath } = project;

  // Idempotency: skip if slices/ already exists
  const slicesDir = path.join(dirPath, SLICES_DIR);
  if (await pathExists(slicesDir)) {
    return {
      id,
      dirPath,
      outcome: "skipped",
      legacyStatus: "",
      projectStatus: "",
    };
  }

  // Read project README frontmatter
  const readmePath = path.join(dirPath, README_FILE);
  if (!(await pathExists(readmePath))) {
    return {
      id,
      dirPath,
      outcome: "skipped",
      legacyStatus: "",
      projectStatus: "",
    };
  }

  const readmeRaw = await fs.readFile(readmePath, "utf8");
  const { frontmatter, content } = splitFrontmatter(readmeRaw);
  const legacyStatus = String(frontmatter.status ?? "").trim();

  // archived → unchanged, skip
  if (legacyStatus === "archived") {
    return {
      id,
      dirPath,
      outcome: "skipped",
      legacyStatus,
      projectStatus: "archived",
    };
  }

  const mapping = STATUS_MAP[legacyStatus];
  if (!mapping) {
    // Unknown status — skip
    return {
      id,
      dirPath,
      outcome: "skipped",
      legacyStatus,
      projectStatus: legacyStatus,
    };
  }

  const { projectStatus, sliceStatus } = mapping;

  // Update project README frontmatter status
  const nextFrontmatter = { ...frontmatter, status: projectStatus };
  const nextReadme = `${serializeFrontmatter(nextFrontmatter)}${content}`;
  await writeFileAtomic(readmePath, nextReadme);

  // not_now / maybe → project shaping, no slice
  if (sliceStatus === null) {
    return { id, dirPath, outcome: "no-slice", legacyStatus, projectStatus };
  }

  // Allocate PRO-XXX-S01
  const metaDir = path.join(dirPath, META_DIR);
  await fs.mkdir(metaDir, { recursive: true });
  const countersPath = path.join(metaDir, COUNTERS_FILE);
  const counters = await readJsonFile<{ lastSliceId: number }>(countersPath, {
    lastSliceId: 0,
  });
  const sliceNumber = counters.lastSliceId + 1;
  await writeFileAtomic(
    countersPath,
    JSON.stringify({ lastSliceId: sliceNumber }, null, 2)
  );

  const sliceId = formatSliceId(id, sliceNumber);
  const sliceDir = path.join(slicesDir, sliceId);
  await fs.mkdir(sliceDir, { recursive: true });

  // Move SPECS.md / TASKS.md / VALIDATION.md if present
  const projectTitle = String(frontmatter.title ?? id);
  const now = new Date().toISOString();

  const [specs, tasks, validation] = await Promise.all([
    moveOrRead(path.join(dirPath, SPECS_FILE), path.join(sliceDir, SPECS_FILE)),
    moveOrRead(path.join(dirPath, TASKS_FILE), path.join(sliceDir, TASKS_FILE)),
    moveOrRead(
      path.join(dirPath, VALIDATION_FILE),
      path.join(sliceDir, VALIDATION_FILE)
    ),
  ]);

  // Suppress unused-var warnings - files already moved, values unused
  void specs;
  void tasks;
  void validation;

  // Create slice README with frontmatter
  const sliceFrontmatter: Record<string, unknown> = {
    id: sliceId,
    project_id: id,
    title: projectTitle,
    status: sliceStatus,
    hill_position: "figuring",
    created_at: now,
    updated_at: now,
  };
  const sliceReadme = `${serializeFrontmatter(sliceFrontmatter)}## Must\n\n## Nice\n`;
  await writeFileAtomic(path.join(sliceDir, README_FILE), sliceReadme);

  // Init slice THREAD.md
  await writeFileAtomic(path.join(sliceDir, THREAD_FILE), "");

  // Regenerate SCOPE_MAP.md
  await regenerateScopeMap(dirPath, id);

  return {
    id,
    dirPath,
    outcome: "migrated",
    legacyStatus,
    projectStatus,
    sliceId,
    sliceStatus,
  };
}

/**
 * Move a file from src to dst (if src exists), returning its content.
 * If src does not exist, writes empty string to dst and returns "".
 */
async function moveOrRead(src: string, dst: string): Promise<string> {
  try {
    const content = await fs.readFile(src, "utf8");
    await writeFileAtomic(dst, content);
    await fs.unlink(src);
    return content;
  } catch {
    await writeFileAtomic(dst, "");
    return "";
  }
}

// ─── Config loading ───────────────────────────────────────────────────────────

function getConfigPath(): string {
  return getDefaultConfigPath();
}

async function loadGatewayConfig(): Promise<GatewayConfig> {
  try {
    const raw = await fs.readFile(getConfigPath(), "utf8");
    return JSON.parse(raw) as GatewayConfig;
  } catch {
    return {
      agents: [],
      extensions: {},
      sessions: { idleMinutes: 360 },
      agentFab: false,
    };
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export type MigrateOptions = {
  /** Override YOPLAI_HOME config path */
  config?: string;
  /** Skip gateway detection (for tests) */
  skipGatewayCheck?: boolean;
};

export type MigrateResult = {
  projects: MigrateProjectResult[];
  migratedCount: number;
  skippedCount: number;
  noSliceCount: number;
};

export async function runMigration(
  opts: MigrateOptions = {}
): Promise<MigrateResult> {
  let config: GatewayConfig;
  if (opts.config) {
    try {
      const raw = await fs.readFile(opts.config, "utf8");
      config = JSON.parse(raw) as GatewayConfig;
    } catch {
      config = {
        agents: [],
        extensions: {},
        sessions: { idleMinutes: 360 },
        agentFab: false,
      };
    }
  } else {
    config = await loadGatewayConfig();
  }

  // Gateway running check
  if (!opts.skipGatewayCheck) {
    const running = await isGatewayRunning(config);
    if (running) {
      throw new Error(
        "Gateway is running. Stop the gateway before migrating:\n  yoplai gateway stop\nThen re-run: yoplai projects migrate-to-slices"
      );
    }
  }

  const root = getProjectsRoot(config);
  const projects = await listProjectLocations(root);
  const results: MigrateProjectResult[] = [];

  for (const project of projects) {
    const result = await migrateProject(project);
    results.push(result);
  }

  return {
    projects: results,
    migratedCount: results.filter((r) => r.outcome === "migrated").length,
    skippedCount: results.filter((r) => r.outcome === "skipped").length,
    noSliceCount: results.filter((r) => r.outcome === "no-slice").length,
  };
}
