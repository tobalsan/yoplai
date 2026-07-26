import * as fs from "node:fs/promises";
import * as path from "node:path";
import { expandPath } from "@yoplai/shared";
import { parseMarkdownFile } from "../taskboard/parser.js";
import { dirExists } from "../util/fs.js";

export const ARCHIVE_DIR = ".archive";
export const DONE_DIR = ".done";
export const LEGACY_TRASH_DIRS = ["Trash", "trash"];
export const META_DIR = ".meta";
export const README_FILE = "README.md";
export const SCOPE_MAP_FILE = "SCOPE_MAP.md";
export const SLICES_DIR = "slices";
export const SPECS_FILE = "SPECS.md";
export const TASKS_FILE = "TASKS.md";
export const THREAD_FILE = "THREAD.md";
export const TRASH_DIR = ".trash";
export const VALIDATION_FILE = "VALIDATION.md";

const PROJECT_ID_PATTERN = /^PRO-\d+$/;
const SLICE_ID_PATTERN = /^PRO-\d+-S\d+$/;
const SCOPE_MAP_LOCK_DIR = ".scope-map.lock";

export const DONE_STATUSES = new Set(["done", "cancelled"]);
const PROJECT_LIFECYCLE_STATUSES = new Set([
  "triage",
  "shaping",
  "active",
  "ready_to_merge",
  "done",
  "cancelled",
]);
const LEGACY_PROJECT_STATUS_MAP: Record<string, string> = {
  not_now: "triage",
  maybe: "triage",
  todo: "active",
  in_progress: "active",
  review: "active",
};

export type ProjectLocation = {
  dirName: string;
  baseRoot: string;
  path: string;
};

export type ProjectThreadEntry = {
  author: string;
  date: string;
  body: string;
};

export type SliceRepoFrontmatter = {
  project_id: string;
  repo?: string;
};

export type ScopeMapRow = {
  id: string;
  title: string;
  status: string;
  hillPosition: string;
};

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function writeFileAtomic(
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

export function formatFrontmatter(
  frontmatter: Record<string, unknown>
): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === undefined) continue;
    lines.push(`${key}: ${formatFrontmatterValue(value)}`);
  }
  return `---\n${lines.join("\n")}\n---\n`;
}

export function formatMarkdown(
  frontmatter: Record<string, unknown>,
  content: string
): string {
  return `${formatFrontmatter(frontmatter)}${content}`;
}

export async function readMarkdownIfExists(filePath: string): Promise<{
  frontmatter: Record<string, unknown>;
  content: string;
  title: string;
} | null> {
  if (!(await fileExists(filePath))) return null;
  return parseMarkdownFile(filePath);
}

export function slugifyTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || "project";
}

export async function migrateTrashRoot(root: string): Promise<void> {
  const hiddenTrash = path.join(root, TRASH_DIR);
  if (await dirExists(hiddenTrash)) return;
  for (const legacy of LEGACY_TRASH_DIRS) {
    const legacyPath = path.join(root, legacy);
    if (await dirExists(legacyPath)) {
      await fs.rename(legacyPath, hiddenTrash);
      return;
    }
  }
}

export async function findProjectDir(
  root: string,
  id: string
): Promise<string | null> {
  if (!(await dirExists(root))) return null;
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === id || entry.name.startsWith(`${id}_`)) {
      return entry.name;
    }
  }
  return null;
}

export function projectRelativePath(
  root: string,
  baseRoot: string,
  dirName: string
): string {
  const prefix = path.relative(root, baseRoot);
  return prefix ? path.join(prefix, dirName) : dirName;
}

export async function findProjectLocation(
  root: string,
  id: string,
  options?: { includeDone?: boolean; includeArchived?: boolean }
): Promise<ProjectLocation | null> {
  const activeDir = await findProjectDir(root, id);
  if (activeDir) {
    return { dirName: activeDir, baseRoot: root, path: activeDir };
  }

  if (options?.includeDone !== false) {
    const doneRoot = path.join(root, DONE_DIR);
    const doneDir = await findProjectDir(doneRoot, id);
    if (doneDir) {
      return {
        dirName: doneDir,
        baseRoot: doneRoot,
        path: path.join(DONE_DIR, doneDir),
      };
    }
  }

  if (options?.includeArchived) {
    const archiveRoot = path.join(root, ARCHIVE_DIR);
    const archivedDir = await findProjectDir(archiveRoot, id);
    if (archivedDir) {
      return {
        dirName: archivedDir,
        baseRoot: archiveRoot,
        path: path.join(ARCHIVE_DIR, archivedDir),
      };
    }
  }

  return null;
}

function normalizeStatus(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function validateProjectStatus(status: unknown): string | null {
  const normalized = normalizeStatus(status);
  if (!normalized) return null;
  if (PROJECT_LIFECYCLE_STATUSES.has(normalized)) return normalized;
  if (/^shaping:[a-z][a-z0-9_-]*$/.test(normalized)) return normalized;
  const migrated = LEGACY_PROJECT_STATUS_MAP[normalized];
  if (migrated) return migrated;
  throw new Error(`Invalid project status: ${String(status)}`);
}

export function shouldAutoMarkProjectDone(
  status: string | null,
  slices: Array<{ frontmatter: { status?: string } }>
): boolean {
  if (status !== "active") return false;
  if (slices.length === 0) return false;
  const hasDone = slices.some((slice) => slice.frontmatter.status === "done");
  const allTerminal = slices.every(
    (slice) =>
      slice.frontmatter.status === "done" ||
      slice.frontmatter.status === "cancelled"
  );
  return hasDone && allTerminal;
}

export function formatThreadFrontmatter(projectId: string): string {
  return `---\nproject: ${projectId}\n---\n`;
}

export function formatThreadEntry(entry: ProjectThreadEntry): string {
  const body = entry.body.trim();
  return `[author:${entry.author}]\n[date:${entry.date}]\n${body}\n`;
}

export function parseThreadSections(raw: string): string[] {
  const fmMatch = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  const withoutFrontmatter = fmMatch ? raw.slice(fmMatch[0].length) : raw;
  return withoutFrontmatter
    .split(/\r?\n---\r?\n---\r?\n/)
    .map((section) => section.trim())
    .filter(Boolean);
}

export function parseThreadEntry(section: string): ProjectThreadEntry | null {
  const lines = section.split(/\r?\n/);
  let author = "";
  let date = "";
  let cursor = 0;
  for (; cursor < lines.length; cursor += 1) {
    const line = lines[cursor]?.trim();
    if (!line) continue;
    const authorMatch = line.match(/^\[author:(.+)\]$/);
    if (authorMatch) {
      author = authorMatch[1].trim();
      continue;
    }
    const dateMatch = line.match(/^\[date:(.+)\]$/);
    if (dateMatch) {
      date = dateMatch[1].trim();
      continue;
    }
    break;
  }
  const body = lines.slice(cursor).join("\n").trim();
  if (!author && !date && !body) return null;
  return { author, date, body };
}

export function parseThread(raw: string): ProjectThreadEntry[] {
  return parseThreadSections(raw)
    .map(parseThreadEntry)
    .filter((entry): entry is ProjectThreadEntry => Boolean(entry));
}

export function appendThreadEntry(
  raw: string,
  projectId: string,
  entry: ProjectThreadEntry
): string {
  const fmMatch = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  const prefix = fmMatch ? fmMatch[0] : formatThreadFrontmatter(projectId);
  const rest = fmMatch ? raw.slice(fmMatch[0].length) : raw;
  const separator = rest.trim() ? "\n---\n---\n\n" : "\n";
  return `${prefix}${rest}${separator}${formatThreadEntry(entry)}`;
}

export function updateThreadEntry(
  raw: string,
  projectId: string,
  index: number,
  body: string
): { next: string; entry: ProjectThreadEntry } {
  const fmMatch = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  const prefix = fmMatch ? fmMatch[0] : formatThreadFrontmatter(projectId);
  const sections = parseThreadSections(raw);
  if (index < 0 || index >= sections.length) {
    throw new Error("Comment not found");
  }
  const entry = parseThreadEntry(sections[index]);
  if (!entry) {
    throw new Error("Failed to parse comment");
  }
  const updatedEntry = { ...entry, body };
  sections[index] =
    `[author:${updatedEntry.author}]\n[date:${updatedEntry.date}]\n${body.trim()}`;
  return {
    next:
      prefix + sections.map((section) => `${section}\n`).join("\n---\n---\n\n"),
    entry: updatedEntry,
  };
}

export function deleteThreadEntry(
  raw: string,
  projectId: string,
  index: number
): string {
  const fmMatch = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  const prefix = fmMatch ? fmMatch[0] : formatThreadFrontmatter(projectId);
  const sections = parseThreadSections(raw);
  if (index < 0 || index >= sections.length) {
    throw new Error("Comment not found");
  }
  sections.splice(index, 1);
  return sections.length > 0
    ? prefix + sections.map((section) => `${section}\n`).join("\n---\n---\n\n")
    : prefix;
}

export async function isValidGitRepo(repoPath?: string): Promise<boolean> {
  if (!repoPath) return false;
  const expandedRepoPath = expandPath(repoPath);
  if (!(await dirExists(expandedRepoPath))) return false;
  try {
    await fs.stat(path.join(expandedRepoPath, ".git"));
    return true;
  } catch {
    return false;
  }
}

export function normalizeRepoValue(repo: unknown): string | undefined {
  if (repo === undefined) return undefined;
  if (typeof repo !== "string") {
    throw new Error("Slice repo must be an absolute path");
  }
  const trimmed = repo.trim();
  if (!trimmed) return undefined;
  return trimmed;
}

export async function assertValidSliceRepo(
  repo: unknown
): Promise<string | undefined> {
  const trimmed = normalizeRepoValue(repo);
  if (trimmed === undefined) return undefined;
  if (!path.isAbsolute(trimmed)) {
    throw new Error("Slice repo must be an absolute path");
  }
  if (!(await isValidGitRepo(trimmed))) {
    throw new Error(`Slice repo is not a git repo: ${trimmed}`);
  }
  return trimmed;
}

async function readProjectRepo(
  projectDir: string
): Promise<string | undefined> {
  const parsed = await parseMarkdownFile(
    path.join(projectDir, README_FILE)
  ).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!parsed) return undefined;
  return normalizeRepoValue(parsed.frontmatter.repo);
}

function repoRequiredMessage(
  projectId: string,
  action: "create" | "update"
): string {
  const verb = action === "create" ? "create" : "update";
  return `Cannot ${verb} slice: project ${projectId} has no repo. Pass --repo <abs path> or set the project repo first (\`yoplai projects update ${projectId} --repo …\`).`;
}

export async function assertSliceRepoInvariant(
  projectDir: string,
  sliceFrontmatter: SliceRepoFrontmatter,
  action: "create" | "update"
): Promise<void> {
  const projectRepo = await readProjectRepo(projectDir);
  const sliceRepo = normalizeRepoValue(sliceFrontmatter.repo);
  if (!projectRepo && !sliceRepo) {
    throw new Error(repoRequiredMessage(sliceFrontmatter.project_id, action));
  }
}

export function projectRepoClearError(sliceIds: string[]): string {
  return `Cannot clear project repo: slice(s) ${sliceIds.join(", ")} rely on it (no slice-level repo set). Set their repo first, then clear the project repo.`;
}

export function assertCanClearProjectRepo(
  slices: Array<{ id: string; frontmatter: { repo?: unknown } }>
): void {
  const relyingSlices = slices
    .filter((slice) => !normalizeRepoValue(slice.frontmatter.repo))
    .map((slice) => slice.id);
  if (relyingSlices.length > 0) {
    throw new Error(projectRepoClearError(relyingSlices));
  }
}

export function assertValidProjectId(projectId: string): void {
  if (!PROJECT_ID_PATTERN.test(projectId)) {
    throw new Error(`Invalid projectId: ${projectId}`);
  }
}

export function assertValidSliceId(sliceId: string): void {
  if (!SLICE_ID_PATTERN.test(sliceId)) {
    throw new Error(`Invalid sliceId: ${sliceId}`);
  }
}

export function isSliceDirName(name: string): boolean {
  return SLICE_ID_PATTERN.test(name);
}

async function withProjectLock<T>(
  projectDir: string,
  lockDirName: string,
  task: () => Promise<T>
): Promise<T> {
  const lockPath = path.join(projectDir, META_DIR, lockDirName);
  await fs.mkdir(path.join(projectDir, META_DIR), { recursive: true });
  while (true) {
    try {
      await fs.mkdir(lockPath);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  try {
    return await task();
  } finally {
    await fs.rm(lockPath, { recursive: true, force: true });
  }
}

export function withCounterLock<T>(
  projectDir: string,
  task: () => Promise<T>
): Promise<T> {
  return withProjectLock(projectDir, ".slice-counter.lock", task);
}

function escapeCell(value: string): string {
  return value.replace(/\r?\n/g, "<br>").replace(/\|/g, "\\|");
}

export function renderScopeMap(projectId: string, rows: ScopeMapRow[]): string {
  const lines = [
    "<!-- Auto-generated by yoplai. Do not edit by hand. -->",
    `# Scope map — ${projectId}`,
    "",
    "| Slice | Title | Status | Hill |",
    "|-------|-------|--------|------|",
  ];

  for (const row of rows) {
    lines.push(
      `| ${escapeCell(row.id)} | ${escapeCell(row.title)} | ${escapeCell(row.status)} | ${escapeCell(row.hillPosition)} |`
    );
  }

  lines.push("");
  return lines.join("\n");
}

export async function regenerateScopeMap(
  projectDir: string,
  projectId: string
): Promise<void> {
  assertValidProjectId(projectId);

  await withProjectLock(projectDir, SCOPE_MAP_LOCK_DIR, async () => {
    const slicesDir = path.join(projectDir, SLICES_DIR);
    const rows: ScopeMapRow[] = [];

    try {
      const entries = await fs.readdir(slicesDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const readmePath = path.join(slicesDir, entry.name, README_FILE);
        try {
          const parsed = await parseMarkdownFile(readmePath);
          const frontmatter = parsed.frontmatter;
          const id = String(frontmatter.id ?? entry.name);
          rows.push({
            id,
            title: String(frontmatter.title ?? ""),
            status: String(frontmatter.status ?? ""),
            hillPosition: String(frontmatter.hill_position ?? ""),
          });
        } catch {
          // Ignore invalid/incomplete slice dirs.
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    rows.sort((a, b) => a.id.localeCompare(b.id));
    await writeFileAtomic(
      path.join(projectDir, SCOPE_MAP_FILE),
      renderScopeMap(projectId, rows)
    );
  });
}
