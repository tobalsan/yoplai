import * as fs from "node:fs/promises";
import * as path from "node:path";
import { expandPath } from "@yoplai/shared";
import type {
  TodoItem,
  ProjectItem,
  TaskboardResponse,
  TaskboardItemResponse,
  TaskboardConfig,
} from "@yoplai/shared";
import { parseMarkdownFile } from "./parser.js";
import { dirExists } from "../util/fs.js";

const COMPANION_TYPES = ["scopes", "progress", "prompt"] as const;

/**
 * Checks if a filename is a companion file (e.g., file.scopes.md).
 */
function isCompanionFile(filename: string): boolean {
  for (const type of COMPANION_TYPES) {
    if (filename.endsWith(`.${type}.md`)) {
      return true;
    }
  }
  return false;
}

/**
 * Scans a directory for .md files (non-recursive).
 * Excludes companion files (.scopes.md, .progress.md, .prompt.md).
 */
async function scanDir(dirPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries
      .filter(
        (e) => e.isFile() && e.name.endsWith(".md") && !isCompanionFile(e.name)
      )
      .map((e) => path.join(dirPath, e.name));
  } catch {
    return [];
  }
}

/**
 * Gets available companion file types for a project file.
 */
async function getCompanions(filePath: string): Promise<string[]> {
  const baseName = path.basename(filePath, ".md");
  const dirPath = path.dirname(filePath);
  const companions: string[] = [];

  for (const type of COMPANION_TYPES) {
    const companionPath = path.join(dirPath, `${baseName}.${type}.md`);
    try {
      await fs.access(companionPath);
      companions.push(type);
    } catch {
      // File doesn't exist
    }
  }

  return companions;
}

/**
 * Extracts date from filename (format: PRO-{N}_{YYYYMMDD}_{slug}.md).
 * Returns YYYY-MM-DD format or undefined if not found.
 */
function extractDateFromFilename(filename: string): string | undefined {
  const match = filename.match(/^(?:PRO|PER)-\d+_(\d{4})(\d{2})(\d{2})_/);
  if (match) {
    return `${match[1]}-${match[2]}-${match[3]}`;
  }
  return undefined;
}

/**
 * Parses a todo file into a TodoItem.
 */
async function parseTodoFile(filePath: string): Promise<TodoItem> {
  const { frontmatter, title } = await parseMarkdownFile(filePath);
  const id = path.basename(filePath, ".md");
  const filenameDate = extractDateFromFilename(id);

  return {
    id,
    title,
    status: "todo",
    created:
      (typeof frontmatter.created === "string"
        ? frontmatter.created
        : undefined) ?? filenameDate,
    due: typeof frontmatter.due === "string" ? frontmatter.due : undefined,
    path: path.basename(filePath),
  };
}

/**
 * Parses a project file into a ProjectItem.
 */
async function parseProjectFile(
  filePath: string,
  status: "todo" | "doing"
): Promise<ProjectItem> {
  const { frontmatter, title } = await parseMarkdownFile(filePath);
  const id = path.basename(filePath, ".md");
  const companions = await getCompanions(filePath);
  const filenameDate = extractDateFromFilename(id);

  return {
    id,
    title,
    status,
    created:
      (typeof frontmatter.created === "string"
        ? frontmatter.created
        : undefined) ?? filenameDate,
    due: typeof frontmatter.due === "string" ? frontmatter.due : undefined,
    project: frontmatter.project as string | undefined,
    path: path.basename(filePath),
    companions,
  };
}

export type ScanResult =
  | { ok: true; data: TaskboardResponse }
  | { ok: false; error: string };

/**
 * Scans todos and projects directories, returns TaskboardResponse.
 */
export async function scanTaskboard(
  config: TaskboardConfig | undefined
): Promise<ScanResult> {
  if (!config?.todosPath && !config?.projectsPath) {
    return { ok: false, error: "Taskboard paths not configured in yoplai.json" };
  }

  const result: TaskboardResponse = {
    todos: { todo: [], doing: [] },
    projects: { todo: [], doing: [] },
  };

  // Scan personal todos
  if (config.todosPath) {
    const todosPath = expandPath(config.todosPath);
    if (!(await dirExists(todosPath))) {
      return { ok: false, error: `Path not found: ${config.todosPath}` };
    }

    // Root contains active items (todo), done/ is excluded
    const todoFiles = await scanDir(todosPath);
    const todos = await Promise.all(todoFiles.map(parseTodoFile));
    result.todos.todo = todos;
  }

  // Scan projects
  if (config.projectsPath) {
    const projectsPath = expandPath(config.projectsPath);
    if (!(await dirExists(projectsPath))) {
      return { ok: false, error: `Path not found: ${config.projectsPath}` };
    }

    // todo/ and doing/ subdirectories
    const todoDir = path.join(projectsPath, "todo");
    const doingDir = path.join(projectsPath, "doing");

    if (await dirExists(todoDir)) {
      const todoFiles = await scanDir(todoDir);
      const projects = await Promise.all(
        todoFiles.map((f) => parseProjectFile(f, "todo"))
      );
      result.projects.todo = projects;
    }

    if (await dirExists(doingDir)) {
      const doingFiles = await scanDir(doingDir);
      const projects = await Promise.all(
        doingFiles.map((f) => parseProjectFile(f, "doing"))
      );
      result.projects.doing = projects;
    }
  }

  return { ok: true, data: result };
}

export type ItemResult =
  | { ok: true; data: TaskboardItemResponse }
  | { ok: false; error: string };

/**
 * Fetches a specific taskboard item's full content.
 */
export async function getTaskboardItem(
  config: TaskboardConfig | undefined,
  type: "todo" | "project",
  id: string,
  companion?: string
): Promise<ItemResult> {
  if (!config?.todosPath && !config?.projectsPath) {
    return { ok: false, error: "Taskboard paths not configured in yoplai.json" };
  }

  let filePath: string | undefined;
  let companions: string[] = [];

  if (type === "todo") {
    if (!config.todosPath) {
      return { ok: false, error: "Todos path not configured" };
    }
    const todosPath = expandPath(config.todosPath);
    filePath = path.join(todosPath, `${id}.md`);
  } else {
    if (!config.projectsPath) {
      return { ok: false, error: "Projects path not configured" };
    }
    const projectsPath = expandPath(config.projectsPath);

    // Check todo/ then doing/ for the project
    const todoPath = path.join(projectsPath, "todo", `${id}.md`);
    const doingPath = path.join(projectsPath, "doing", `${id}.md`);

    try {
      await fs.access(doingPath);
      filePath = doingPath;
    } catch {
      try {
        await fs.access(todoPath);
        filePath = todoPath;
      } catch {
        return { ok: false, error: `Item not found: ${id}` };
      }
    }

    companions = await getCompanions(filePath);
  }

  // If companion requested, modify path
  if (
    companion &&
    COMPANION_TYPES.includes(companion as (typeof COMPANION_TYPES)[number])
  ) {
    const dir = path.dirname(filePath);
    const baseName = path.basename(filePath, ".md");
    filePath = path.join(dir, `${baseName}.${companion}.md`);
  }

  try {
    const { frontmatter, content, title } = await parseMarkdownFile(filePath);
    return {
      ok: true,
      data: { id, title, content, frontmatter, companions },
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, error: `Item not found: ${id}` };
    }
    throw err;
  }
}
