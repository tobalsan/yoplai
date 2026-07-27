import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  GatewayConfig,
  CreateProjectRequest,
  UpdateProjectRequest,
  UploadedAttachment,
  ProjectStatus,
} from "@yoplai/shared";
import { getProjectsContext } from "../context.js";
import { listAreas } from "../areas/store.js";
import { dirExists } from "../util/fs.js";
import { getProjectsRoot } from "../util/paths.js";
import {
  listSlices,
  normalizeRepoValue,
  updateSlice,
  type SliceRecord,
} from "./slices.js";
import { emitProjectPitchFallbackHint } from "./fallback-hints.js";
import * as documentStore from "./document-store.js";

function getProjectsStatePath(): string {
  return path.join(getProjectsContext().getDataDir(), "projects.json");
}
const THREAD_FILE = documentStore.THREAD_FILE;
const ARCHIVE_DIR = documentStore.ARCHIVE_DIR;
const DONE_DIR = documentStore.DONE_DIR;
const TRASH_DIR = documentStore.TRASH_DIR;
const DONE_STATUSES = documentStore.DONE_STATUSES;

export type ProjectListItem = {
  id: string;
  title: string;
  path: string;
  absolutePath: string;
  repoValid: boolean;
  frontmatter: Record<string, unknown>;
};

export type ProjectDetail = {
  id: string;
  title: string;
  path: string;
  absolutePath: string;
  repoValid: boolean;
  frontmatter: Record<string, unknown>;
  docs: Record<string, string>;
  thread: ProjectThreadEntry[];
};

export type ProjectListResult =
  | { ok: true; data: ProjectListItem[] }
  | { ok: false; error: string };

export type ProjectItemResult =
  | { ok: true; data: ProjectDetail }
  | { ok: false; error: string };

export type DeleteProjectResult =
  | { ok: true; data: { id: string; path: string; trashedPath: string } }
  | { ok: false; error: string };

export type ArchiveProjectResult =
  | { ok: true; data: { id: string; path: string; archivedPath: string } }
  | { ok: false; error: string };

export type UnarchiveProjectResult =
  | { ok: true; data: { id: string; path: string } }
  | { ok: false; error: string };

export type ProjectThreadEntry = documentStore.ProjectThreadEntry;

async function isValidGitRepo(repoPath?: string): Promise<boolean> {
  return documentStore.isValidGitRepo(repoPath);
}

export { isValidGitRepo };

async function assertCanClearProjectRepo(projectDir: string): Promise<void> {
  documentStore.assertCanClearProjectRepo(await listSlices(projectDir));
}

async function fileExists(filePath: string): Promise<boolean> {
  return documentStore.fileExists(filePath);
}

async function ensureDir(dirPath: string): Promise<void> {
  await documentStore.ensureDir(dirPath);
}

async function migrateTrashRoot(root: string): Promise<void> {
  await documentStore.migrateTrashRoot(root);
}

function slugifyTitle(title: string): string {
  return documentStore.slugifyTitle(title);
}

type ProjectsState = { lastId: number };

const projectIdAllocationQueues = new Map<string, Promise<void>>();

async function readProjectsState(): Promise<ProjectsState> {
  try {
    const raw = await fs.readFile(getProjectsStatePath(), "utf8");
    const json = JSON.parse(raw) as ProjectsState;
    return { lastId: typeof json.lastId === "number" ? json.lastId : 0 };
  } catch {
    return { lastId: 0 };
  }
}

async function writeProjectsState(state: ProjectsState): Promise<void> {
  await ensureDir(getProjectsContext().getDataDir());
  await documentStore.writeFileAtomic(
    getProjectsStatePath(),
    JSON.stringify(state, null, 2)
  );
}

async function findMaxProjectIdOnDisk(root: string): Promise<number> {
  const roots = [
    root,
    path.join(root, DONE_DIR),
    path.join(root, ARCHIVE_DIR),
    path.join(root, TRASH_DIR),
  ];
  let max = 0;
  for (const scanRoot of roots) {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(scanRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const match = /^PRO-(\d+)(?:_|$)/.exec(entry.name);
      if (match) max = Math.max(max, Number.parseInt(match[1], 10));
    }
  }
  return max;
}

async function allocateProjectId(root: string): Promise<string> {
  const statePath = getProjectsStatePath();
  const previous =
    projectIdAllocationQueues.get(statePath) ?? Promise.resolve();
  const allocation = previous.then(async () => {
    const state = await readProjectsState();
    const maxOnDisk = await findMaxProjectIdOnDisk(root);
    const next = Math.max(state.lastId, maxOnDisk) + 1;
    await writeProjectsState({ lastId: next });
    return `PRO-${next}`;
  });
  projectIdAllocationQueues.set(
    statePath,
    allocation.then(
      () => undefined,
      () => undefined
    )
  );
  return allocation;
}

function formatMarkdown(
  frontmatter: Record<string, unknown>,
  content: string
): string {
  return documentStore.formatMarkdown(frontmatter, content);
}

function formatThreadFrontmatter(projectId: string): string {
  return documentStore.formatThreadFrontmatter(projectId);
}

function formatThreadEntry(entry: ProjectThreadEntry): string {
  return documentStore.formatThreadEntry(entry);
}

function parseThreadSections(raw: string): string[] {
  return documentStore.parseThreadSections(raw);
}

function parseThreadEntry(section: string): ProjectThreadEntry | null {
  return documentStore.parseThreadEntry(section);
}

async function readMarkdownIfExists(filePath: string): Promise<{
  frontmatter: Record<string, unknown>;
  content: string;
  title: string;
} | null> {
  return documentStore.readMarkdownIfExists(filePath);
}

export async function findProjectDir(
  root: string,
  id: string
): Promise<string | null> {
  return documentStore.findProjectDir(root, id);
}

function projectRelativePath(
  root: string,
  baseRoot: string,
  dirName: string
): string {
  return documentStore.projectRelativePath(root, baseRoot, dirName);
}

export async function findProjectLocation(
  root: string,
  id: string,
  options?: { includeDone?: boolean; includeArchived?: boolean }
): Promise<documentStore.ProjectLocation | null> {
  return documentStore.findProjectLocation(root, id, options);
}

function toStringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function validateProjectStatus(status: unknown): string | null {
  return documentStore.validateProjectStatus(status);
}

async function cascadeProjectCancellation(projectDir: string): Promise<void> {
  const slices = await listSlices(projectDir);
  await Promise.all(
    slices
      .filter(
        (slice) =>
          slice.frontmatter.status !== "done" &&
          slice.frontmatter.status !== "cancelled"
      )
      .map((slice) =>
        updateSlice(projectDir, slice.id, {
          status: "cancelled",
        })
      )
  );
}

function shouldAutoMarkProjectDone(
  status: string | null,
  slices: SliceRecord[]
): boolean {
  return documentStore.shouldAutoMarkProjectDone(status, slices);
}

async function getAreaRepoMap(
  config: GatewayConfig
): Promise<Map<string, string>> {
  const areas = await listAreas(config);
  const map = new Map<string, string>();
  for (const area of areas) {
    if (!area.repo) continue;
    map.set(area.id, area.repo);
  }
  return map;
}

function resolveProjectRepo(
  frontmatter: Record<string, unknown>,
  areaRepoMap: Map<string, string>
): string | undefined {
  const projectRepo = toStringField(frontmatter.repo);
  if (projectRepo) return projectRepo;
  const areaId = toStringField(frontmatter.area);
  if (!areaId) return undefined;
  return areaRepoMap.get(areaId);
}

function isShapingStatus(status: string | null | undefined): boolean {
  return status === "shaping" || status?.startsWith("shaping:") === true;
}

function hasProjectRepo(frontmatter: Record<string, unknown>): boolean {
  return toStringField(frontmatter.repo)?.trim().length ? true : false;
}

async function listProjectItemsFromRoot(
  scanRoot: string,
  pathPrefix: string,
  areaRepoMap: Map<string, string>,
  areaFilter?: string
): Promise<ProjectListItem[]> {
  if (!(await dirExists(scanRoot))) return [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(scanRoot, { withFileTypes: true });
  } catch (error) {
    // scanRoot can vanish between the dirExists check above and this readdir
    // (e.g. a test tears down its temp dir while a background scan is still
    // in flight). A scan root that disappeared mid-scan is genuinely empty.
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  }
  const projects: ProjectListItem[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirName = entry.name;
    if (dirName.startsWith(".")) continue;
    const dirPath = path.join(scanRoot, dirName);
    try {
      const dirEntries = await fs.readdir(dirPath, { withFileTypes: true });
      const mdFiles = dirEntries
        .filter(
          (e) => e.isFile() && e.name.endsWith(".md") && e.name !== THREAD_FILE
        )
        .map((e) => e.name);
      if (mdFiles.length === 0) continue;

      // Priority: README.md frontmatter > SPECS.md frontmatter > first .md file
      let frontmatter: Record<string, unknown> = {};
      let title = dirName;
      const specsFile = mdFiles.find((f) => f.toUpperCase() === "SPECS.MD");
      const readmeFile = mdFiles.find((f) => f.toUpperCase() === "README.MD");
      const primaryFile = readmeFile ?? specsFile ?? mdFiles[0];
      if (primaryFile) {
        const parsed = await readMarkdownIfExists(
          path.join(dirPath, primaryFile)
        );
        if (parsed) {
          frontmatter = parsed.frontmatter;
          title = parsed.title;
        }
      }

      const id = toStringField(frontmatter.id) ?? dirName.split("_")[0];
      const resolvedTitle = toStringField(frontmatter.title) ?? title;
      try {
        const normalizedStatus = validateProjectStatus(frontmatter.status);
        if (normalizedStatus) frontmatter.status = normalizedStatus;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        projects.push({
          id,
          title: resolvedTitle,
          path: pathPrefix ? path.join(pathPrefix, dirName) : dirName,
          absolutePath: dirPath,
          repoValid: false,
          frontmatter: {
            ...frontmatter,
            id,
            title: resolvedTitle,
            statusValidationError: message,
          },
        });
        continue;
      }
      const resolvedRepo = resolveProjectRepo(frontmatter, areaRepoMap);
      const repoValid = await isValidGitRepo(resolvedRepo);
      const resolvedFrontmatter: Record<string, unknown> = {
        ...frontmatter,
        id,
        title: resolvedTitle,
      };
      if (resolvedRepo) {
        resolvedFrontmatter.repo = resolvedRepo;
      }
      if (areaFilter) {
        const projectArea = toStringField(resolvedFrontmatter.area);
        if (projectArea !== areaFilter) continue;
      }
      projects.push({
        id,
        title: resolvedTitle,
        path: pathPrefix ? path.join(pathPrefix, dirName) : dirName,
        absolutePath: dirPath,
        repoValid,
        frontmatter: resolvedFrontmatter,
      });
    } catch {
      // Skip unreadable project folder
    }
  }
  return projects;
}

export async function listProjects(
  config: GatewayConfig,
  options?: { area?: string }
): Promise<ProjectListResult> {
  const root = getProjectsRoot(config);
  if (!(await dirExists(root))) {
    return { ok: true, data: [] };
  }
  await migrateTrashRoot(root);
  const areaRepoMap = await getAreaRepoMap(config);
  const areaFilter = options?.area?.trim();
  const projects = [
    ...(await listProjectItemsFromRoot(root, "", areaRepoMap, areaFilter)),
    ...(await listProjectItemsFromRoot(
      path.join(root, DONE_DIR),
      DONE_DIR,
      areaRepoMap,
      areaFilter
    )),
  ];

  return { ok: true, data: projects };
}

export async function listArchivedProjects(
  config: GatewayConfig
): Promise<ProjectListResult> {
  const root = getProjectsRoot(config);
  const archiveRoot = path.join(root, ARCHIVE_DIR);
  if (!(await dirExists(archiveRoot))) {
    return { ok: true, data: [] };
  }
  const areaRepoMap = await getAreaRepoMap(config);
  const projects = await listProjectItemsFromRoot(
    archiveRoot,
    ARCHIVE_DIR,
    areaRepoMap
  );

  return { ok: true, data: projects };
}

export async function getProject(
  config: GatewayConfig,
  id: string
): Promise<ProjectItemResult> {
  const root = getProjectsRoot(config);
  const areaRepoMap = await getAreaRepoMap(config);
  await migrateTrashRoot(root);
  const location = await findProjectLocation(root, id, {
    includeArchived: true,
  });
  if (!location) {
    return { ok: false, error: `Project not found: ${id}` };
  }
  const { dirName, baseRoot } = location;

  const dirPath = path.join(baseRoot, dirName);
  const threadPath = path.join(dirPath, THREAD_FILE);
  const threadRaw = (await fileExists(threadPath))
    ? await fs.readFile(threadPath, "utf8")
    : "";
  const thread = threadRaw
    ? (parseThreadSections(threadRaw)
        .map(parseThreadEntry)
        .filter(Boolean) as ProjectThreadEntry[])
    : [];

  // Scan for all .md files at root (non-recursive)
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const mdFiles = entries
    .filter(
      (e) => e.isFile() && e.name.endsWith(".md") && e.name !== THREAD_FILE
    )
    .map((e) => e.name);

  // Build docs map
  const docs: Record<string, string> = {};
  let frontmatter: Record<string, unknown> = {};
  let title = dirName;
  const specsFile = mdFiles.find((f) => f.toUpperCase() === "SPECS.MD");
  const readmeFile = mdFiles.find((f) => f.toUpperCase() === "README.MD");

  for (const file of mdFiles) {
    const parsed = await readMarkdownIfExists(path.join(dirPath, file));
    if (parsed) {
      const key = file.replace(/\.md$/i, "").toUpperCase();
      docs[key] = parsed.content;
      // Use README.md frontmatter if available, else SPECS.md
      if (file === readmeFile) {
        frontmatter = parsed.frontmatter;
        title = parsed.title;
      } else if (file === specsFile && !readmeFile) {
        frontmatter = parsed.frontmatter;
        title = parsed.title;
      }
    }
  }
  if (docs.PITCH === undefined && docs.README !== undefined) {
    docs.PITCH = docs.README;
    emitProjectPitchFallbackHint(toStringField(frontmatter.id) ?? id);
  }

  const resolvedTitle = toStringField(frontmatter.title) ?? title;
  const resolvedId = toStringField(frontmatter.id) ?? id;
  try {
    validateProjectStatus(frontmatter.status);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const resolvedRepo = resolveProjectRepo(frontmatter, areaRepoMap);
  const repoValid = await isValidGitRepo(resolvedRepo);
  const resolvedFrontmatter: Record<string, unknown> = {
    ...frontmatter,
    id: resolvedId,
    title: resolvedTitle,
  };
  if (resolvedRepo) {
    resolvedFrontmatter.repo = resolvedRepo;
  }

  return {
    ok: true,
    data: {
      id: resolvedId,
      title: resolvedTitle,
      path: projectRelativePath(root, baseRoot, dirName),
      absolutePath: dirPath,
      repoValid,
      frontmatter: resolvedFrontmatter,
      docs,
      thread,
    },
  };
}

export async function createProject(
  config: GatewayConfig,
  input: CreateProjectRequest
): Promise<ProjectItemResult> {
  const trimmedTitle = input.title.trim();
  const wordCount = trimmedTitle.split(/\s+/).filter(Boolean).length;
  if (wordCount < 2) {
    return { ok: false, error: "Title must contain at least two words" };
  }

  const root = getProjectsRoot(config);
  await migrateTrashRoot(root);
  await ensureDir(root);
  const id = await allocateProjectId(root);
  const slug = slugifyTitle(trimmedTitle);
  const dirName = `${id}_${slug}`;
  const dirPath = path.join(root, dirName);

  await fs.mkdir(dirPath);

  const created = new Date().toISOString();
  let requestedStatus = "triage";
  try {
    requestedStatus =
      validateProjectStatus(input.status ?? "triage") ?? "triage";
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const frontmatter: Record<string, unknown> = {
    id,
    title: trimmedTitle,
    status: requestedStatus,
    created,
  };
  if (input.area) frontmatter.area = input.area;
  if (input.repo !== undefined) {
    const repo = normalizeRepoValue(input.repo);
    if (repo !== undefined) frontmatter.repo = repo;
  }
  const pitchBody = input.pitch ?? "";
  const readmeContent = formatMarkdown(frontmatter, "");
  await fs.writeFile(path.join(dirPath, "README.md"), readmeContent, "utf8");
  await fs.writeFile(path.join(dirPath, "PITCH.md"), pitchBody, "utf8");
  await fs.writeFile(
    path.join(dirPath, THREAD_FILE),
    formatThreadFrontmatter(id),
    "utf8"
  );

  const docs: Record<string, string> = { PITCH: pitchBody };
  const repoValid = await isValidGitRepo(toStringField(frontmatter.repo));

  return {
    ok: true,
    data: {
      id,
      title: trimmedTitle,
      path: dirName,
      absolutePath: dirPath,
      repoValid,
      frontmatter,
      docs,
      thread: [],
    },
  };
}

export async function updateProject(
  config: GatewayConfig,
  id: string,
  input: UpdateProjectRequest
): Promise<ProjectItemResult> {
  const root = getProjectsRoot(config);
  await migrateTrashRoot(root);
  const location = await findProjectLocation(root, id);
  if (!location) {
    return { ok: false, error: `Project not found: ${id}` };
  }

  const { dirName, baseRoot } = location;
  const dirPath = path.join(baseRoot, dirName);
  const currentSpecsPath = path.join(dirPath, "SPECS.md");
  const currentReadmePath = path.join(dirPath, "README.md");
  const parsedSpecs = await readMarkdownIfExists(currentSpecsPath);
  const parsedReadme = await readMarkdownIfExists(currentReadmePath);
  const currentFrontmatter =
    parsedReadme?.frontmatter ?? parsedSpecs?.frontmatter ?? {};
  let currentStatus: string | null;
  try {
    currentStatus = validateProjectStatus(currentFrontmatter.status);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const currentTitle =
    toStringField(currentFrontmatter.title) ??
    parsedReadme?.title ??
    parsedSpecs?.title ??
    id;
  const nextTitle = input.title ?? currentTitle;
  const nextSlug = slugifyTitle(nextTitle);
  const nextDirName = `${id}_${nextSlug}`;
  let requestedStatus: string | null;
  try {
    requestedStatus =
      input.status !== undefined
        ? validateProjectStatus(input.status)
        : currentStatus;
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const nextStatus = requestedStatus ?? currentStatus;
  if (
    input.status !== undefined &&
    nextStatus !== currentStatus &&
    isShapingStatus(nextStatus) &&
    !hasProjectRepo(
      input.repo !== undefined
        ? { ...currentFrontmatter, repo: input.repo }
        : currentFrontmatter
    )
  ) {
    return {
      ok: false,
      error: "Cannot move project to Shaping: project repo is not set.",
    };
  }
  const nextBaseRoot =
    nextStatus && DONE_STATUSES.has(nextStatus)
      ? path.join(root, DONE_DIR)
      : input.status && baseRoot === path.join(root, DONE_DIR)
        ? root
        : baseRoot;
  let finalDirName = dirName;
  let finalBaseRoot = baseRoot;

  if (nextDirName !== dirName || nextBaseRoot !== baseRoot) {
    await ensureDir(nextBaseRoot);
    const targetPath = path.join(nextBaseRoot, nextDirName);
    if (await dirExists(targetPath)) {
      return { ok: false, error: `Project already exists: ${nextDirName}` };
    }
    await fs.rename(dirPath, targetPath);
    finalDirName = nextDirName;
    finalBaseRoot = nextBaseRoot;
  }

  const finalDirPath = path.join(finalBaseRoot, finalDirName);

  let nextFrontmatter: Record<string, unknown> = {
    ...currentFrontmatter,
    id,
    title: nextTitle,
    ...(nextStatus ? { status: nextStatus } : {}),
    ...(input.status !== undefined && nextStatus !== currentStatus
      ? { last_status_change_at: new Date().toISOString() }
      : {}),
  };

  if (input.repo !== undefined) {
    try {
      const repo = normalizeRepoValue(input.repo);
      if (repo === undefined) {
        await assertCanClearProjectRepo(finalDirPath);
        delete nextFrontmatter.repo;
      } else {
        nextFrontmatter.repo = repo;
      }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (input.area === "") delete nextFrontmatter.area;
  else if (input.area) nextFrontmatter.area = input.area;

  if (input.sessionKeys === null) delete nextFrontmatter.sessionKeys;
  else if (input.sessionKeys) nextFrontmatter.sessionKeys = input.sessionKeys;

  // Handle docs updates (new format)
  if (input.docs) {
    for (const [key, content] of Object.entries(input.docs)) {
      const fileName = `${key}.md`;
      const filePath = path.join(finalDirPath, fileName);
      // README.md gets frontmatter
      if (key === "README") {
        await fs.writeFile(
          filePath,
          formatMarkdown(nextFrontmatter, content),
          "utf8"
        );
      } else {
        await fs.writeFile(filePath, content, "utf8");
      }
    }
  }

  // Handle legacy readme/specs updates
  if (input.readme !== undefined && !input.docs?.README) {
    await fs.writeFile(
      path.join(finalDirPath, "README.md"),
      formatMarkdown(nextFrontmatter, input.readme),
      "utf8"
    );
  }
  if (input.specs !== undefined && !input.docs?.SPECS) {
    await fs.writeFile(
      path.join(finalDirPath, "SPECS.md"),
      input.specs,
      "utf8"
    );
  }

  // Ensure frontmatter update even if no docs changed
  if (!input.docs?.README && input.readme === undefined) {
    const existingReadme = parsedReadme?.content ?? "";
    await fs.writeFile(
      path.join(finalDirPath, "README.md"),
      formatMarkdown(nextFrontmatter, existingReadme),
      "utf8"
    );
  }

  const finalThreadPath = path.join(finalDirPath, THREAD_FILE);
  if (!(await fileExists(finalThreadPath))) {
    await fs.writeFile(finalThreadPath, formatThreadFrontmatter(id), "utf8");
  }

  if (nextStatus === "cancelled") {
    await cascadeProjectCancellation(finalDirPath);
  }

  const slicesAfterUpdate = await listSlices(finalDirPath);
  if (shouldAutoMarkProjectDone(nextStatus ?? null, slicesAfterUpdate)) {
    nextFrontmatter = {
      ...nextFrontmatter,
      status: "done",
    };
    const existingReadme = await readMarkdownIfExists(
      path.join(finalDirPath, "README.md")
    );
    await fs.writeFile(
      path.join(finalDirPath, "README.md"),
      formatMarkdown(nextFrontmatter, existingReadme?.content ?? ""),
      "utf8"
    );
  }

  // Re-read all docs
  const entries = await fs.readdir(finalDirPath, { withFileTypes: true });
  const mdFiles = entries
    .filter(
      (e) => e.isFile() && e.name.endsWith(".md") && e.name !== THREAD_FILE
    )
    .map((e) => e.name);

  const docs: Record<string, string> = {};
  for (const file of mdFiles) {
    const parsed = await readMarkdownIfExists(path.join(finalDirPath, file));
    if (parsed) {
      const key = file.replace(/\.md$/i, "").toUpperCase();
      docs[key] = parsed.content;
    }
  }

  const areaRepoMap = await getAreaRepoMap(config);
  const resolvedRepo = resolveProjectRepo(nextFrontmatter, areaRepoMap);
  const repoValid = await isValidGitRepo(resolvedRepo);
  const resolvedFrontmatter = { ...nextFrontmatter };
  if (resolvedRepo) {
    resolvedFrontmatter.repo = resolvedRepo;
  }

  return {
    ok: true,
    data: {
      id,
      title: nextTitle,
      path: projectRelativePath(root, finalBaseRoot, finalDirName),
      absolutePath: finalDirPath,
      repoValid,
      frontmatter: resolvedFrontmatter,
      docs,
      thread: [],
    },
  };
}

export async function deleteProject(
  config: GatewayConfig,
  id: string
): Promise<DeleteProjectResult> {
  const root = getProjectsRoot(config);
  const location = await findProjectLocation(root, id);
  if (!location) {
    return { ok: false, error: `Project not found: ${id}` };
  }

  await migrateTrashRoot(root);
  const trashRoot = path.join(root, TRASH_DIR);
  await ensureDir(trashRoot);

  const sourcePath = path.join(location.baseRoot, location.dirName);
  const targetPath = path.join(trashRoot, location.dirName);
  if (await dirExists(targetPath)) {
    return {
      ok: false,
      error: `Trash already contains project: ${location.dirName}`,
    };
  }

  await fs.rename(sourcePath, targetPath);

  return {
    ok: true,
    data: {
      id,
      path: location.path,
      trashedPath: path.join(TRASH_DIR, location.dirName),
    },
  };
}

export async function archiveProject(
  config: GatewayConfig,
  id: string
): Promise<ArchiveProjectResult> {
  const root = getProjectsRoot(config);
  const location = await findProjectLocation(root, id);
  if (!location) {
    return { ok: false, error: `Project not found: ${id}` };
  }

  const archiveRoot = path.join(root, ARCHIVE_DIR);
  await ensureDir(archiveRoot);

  const targetPath = path.join(archiveRoot, location.dirName);
  if (await dirExists(targetPath)) {
    return {
      ok: false,
      error: `Archive already contains project: ${location.dirName}`,
    };
  }

  const sourcePath = path.join(location.baseRoot, location.dirName);
  const dirName = path.basename(sourcePath);
  await fs.rename(sourcePath, targetPath);

  return {
    ok: true,
    data: { id, path: dirName, archivedPath: path.join(ARCHIVE_DIR, dirName) },
  };
}

export async function unarchiveProject(
  config: GatewayConfig,
  id: string,
  nextStatus: ProjectStatus
): Promise<UnarchiveProjectResult> {
  const root = getProjectsRoot(config);
  const archiveRoot = path.join(root, ARCHIVE_DIR);
  const dirName = await findProjectDir(archiveRoot, id);
  if (!dirName) {
    return { ok: false, error: `Project not found: ${id}` };
  }

  const sourcePath = path.join(archiveRoot, dirName);
  const targetPath = path.join(root, dirName);
  if (await dirExists(targetPath)) {
    return { ok: false, error: `Project already exists: ${dirName}` };
  }

  await fs.rename(sourcePath, targetPath);
  const updated = await updateProject(config, id, { status: nextStatus });
  if (!updated.ok) {
    return { ok: false, error: updated.error };
  }

  return { ok: true, data: { id, path: dirName } };
}

export type ProjectCommentResult =
  | { ok: true; data: ProjectThreadEntry }
  | { ok: false; error: string };

export async function appendProjectComment(
  config: GatewayConfig,
  projectId: string,
  entry: ProjectThreadEntry
): Promise<ProjectCommentResult> {
  const root = getProjectsRoot(config);
  const location = await findProjectLocation(root, projectId);
  if (!location) {
    return { ok: false, error: `Project not found: ${projectId}` };
  }

  const threadPath = path.join(
    location.baseRoot,
    location.dirName,
    THREAD_FILE
  );
  const formatted = formatThreadEntry(entry);
  if (!(await fileExists(threadPath))) {
    const initial = formatThreadFrontmatter(projectId) + formatted;
    await fs.writeFile(threadPath, initial, "utf8");
    return { ok: true, data: entry };
  }

  const raw = await fs.readFile(threadPath, "utf8");
  const next = documentStore.appendThreadEntry(raw, projectId, entry);
  await fs.writeFile(threadPath, next, "utf8");
  return { ok: true, data: entry };
}

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
]);
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

async function generateUniqueName(
  dir: string,
  baseName: string
): Promise<string> {
  const ext = path.extname(baseName);
  const nameWithoutExt = path.basename(baseName, ext);
  let candidate = baseName;
  let counter = 1;
  while (
    await fs
      .access(path.join(dir, candidate))
      .then(() => true)
      .catch(() => false)
  ) {
    candidate = `${nameWithoutExt}-${counter}${ext}`;
    counter++;
  }
  return candidate;
}

export type SaveAttachmentsResult =
  | { ok: true; data: UploadedAttachment[] }
  | { ok: false; error: string };

export async function saveAttachments(
  config: GatewayConfig,
  projectId: string,
  files: Array<{ name: string; data: Buffer }>
): Promise<SaveAttachmentsResult> {
  const root = getProjectsRoot(config);
  const location = await findProjectLocation(root, projectId);
  if (!location) {
    return { ok: false, error: `Project not found: ${projectId}` };
  }

  const attachmentsDir = path.join(
    location.baseRoot,
    location.dirName,
    "attachments"
  );
  await ensureDir(attachmentsDir);

  const results: UploadedAttachment[] = [];

  for (const file of files) {
    if (file.data.length > MAX_FILE_SIZE) {
      return { ok: false, error: `File ${file.name} exceeds 20MB limit` };
    }

    const savedName = await generateUniqueName(attachmentsDir, file.name);
    const filePath = path.join(attachmentsDir, savedName);
    await fs.writeFile(filePath, file.data);

    const ext = path.extname(savedName).toLowerCase();
    results.push({
      originalName: file.name,
      savedName,
      path: `attachments/${savedName}`,
      isImage: IMAGE_EXTENSIONS.has(ext),
    });
  }

  return { ok: true, data: results };
}

export type ResolveAttachmentResult =
  | { ok: true; data: { path: string; name: string } }
  | { ok: false; error: string };

export async function resolveAttachmentFile(
  config: GatewayConfig,
  projectId: string,
  fileName: string
): Promise<ResolveAttachmentResult> {
  const root = getProjectsRoot(config);
  const location = await findProjectLocation(root, projectId);
  if (!location) {
    return { ok: false, error: `Project not found: ${projectId}` };
  }
  if (!fileName || fileName === "." || fileName === "..") {
    return { ok: false, error: "Invalid attachment name" };
  }
  if (
    fileName !== path.basename(fileName) ||
    fileName.includes("/") ||
    fileName.includes("\\")
  ) {
    return { ok: false, error: "Invalid attachment name" };
  }

  const attachmentsDir = path.join(
    location.baseRoot,
    location.dirName,
    "attachments"
  );
  const filePath = path.join(attachmentsDir, fileName);
  if (!(await fileExists(filePath))) {
    return { ok: false, error: "Attachment not found" };
  }
  return { ok: true, data: { path: filePath, name: fileName } };
}

export async function updateProjectComment(
  config: GatewayConfig,
  projectId: string,
  index: number,
  body: string
): Promise<ProjectCommentResult> {
  const root = getProjectsRoot(config);
  const location = await findProjectLocation(root, projectId);
  if (!location) {
    return { ok: false, error: `Project not found: ${projectId}` };
  }

  const threadPath = path.join(
    location.baseRoot,
    location.dirName,
    THREAD_FILE
  );
  if (!(await fileExists(threadPath))) {
    return { ok: false, error: "Thread file not found" };
  }

  try {
    const raw = await fs.readFile(threadPath, "utf8");
    const updated = documentStore.updateThreadEntry(
      raw,
      projectId,
      index,
      body
    );
    await fs.writeFile(threadPath, updated.next, "utf8");
    return { ok: true, data: updated.entry };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export type DeleteCommentResult =
  | { ok: true; data: { index: number } }
  | { ok: false; error: string };

export async function deleteProjectComment(
  config: GatewayConfig,
  projectId: string,
  index: number
): Promise<DeleteCommentResult> {
  const root = getProjectsRoot(config);
  const location = await findProjectLocation(root, projectId);
  if (!location) {
    return { ok: false, error: `Project not found: ${projectId}` };
  }

  const threadPath = path.join(
    location.baseRoot,
    location.dirName,
    THREAD_FILE
  );
  if (!(await fileExists(threadPath))) {
    return { ok: false, error: "Thread file not found" };
  }

  let next: string;
  try {
    const raw = await fs.readFile(threadPath, "utf8");
    next = documentStore.deleteThreadEntry(raw, projectId, index);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  await fs.writeFile(threadPath, next, "utf8");

  return { ok: true, data: { index } };
}
