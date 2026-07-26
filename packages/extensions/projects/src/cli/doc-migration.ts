import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { GatewayConfig } from "@yoplai/shared";
import { getDefaultConfigPath } from "@yoplai/shared";
import { parseMarkdownFile } from "../taskboard/parser.js";
import { getProjectsRoot } from "../util/paths.js";

const PROJECT_ID_PATTERN = /^PRO-\d+$/;
const SLICE_ID_PATTERN = /^PRO-\d+-S\d+$/;
const ARCHIVE_DIR = ".archive";
const DONE_DIR = ".done";

type ProjectLocation = { id: string; dirPath: string };
type MigrationResult = {
  id: string;
  sourcePath: string;
  targetPath: string;
  message: string;
};

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.stat(targetPath);
    return true;
  } catch {
    return false;
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

function getProjectsConfigPath(): string {
  return getDefaultConfigPath();
}

async function loadGatewayConfig(): Promise<GatewayConfig> {
  try {
    const raw = await fs.readFile(getProjectsConfigPath(), "utf8");
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

async function getProjectsRootDir(): Promise<string> {
  const config = await loadGatewayConfig();
  return getProjectsRoot(config);
}

async function listProjectLocations(): Promise<ProjectLocation[]> {
  const root = await getProjectsRootDir();
  const roots = [root, path.join(root, ARCHIVE_DIR), path.join(root, DONE_DIR)];
  const found = new Map<string, ProjectLocation>();

  for (const base of roots) {
    if (!(await pathExists(base))) continue;
    const entries = await fs.readdir(base, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const match = entry.name.match(/^(PRO-\d+)/);
      if (!match) continue;
      const id = match[1];
      if (!PROJECT_ID_PATTERN.test(id)) continue;
      if (!found.has(id)) {
        found.set(id, { id, dirPath: path.join(base, entry.name) });
      }
    }
  }

  return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
}

async function findProjectLocation(
  projectId: string
): Promise<ProjectLocation | null> {
  const normalized = projectId.trim().toUpperCase();
  if (!PROJECT_ID_PATTERN.test(normalized)) {
    throw new Error(`Invalid projectId: ${projectId}`);
  }
  const projects = await listProjectLocations();
  return projects.find((project) => project.id === normalized) ?? null;
}

async function copyReadmeBody(
  id: string,
  dirPath: string,
  targetFile: "PITCH.md" | "SPECS.md",
  force: boolean
): Promise<MigrationResult> {
  const sourcePath = path.join(dirPath, "README.md");
  const targetPath = path.join(dirPath, targetFile);
  if (!(await pathExists(sourcePath))) {
    throw new Error(`README.md not found for ${id}`);
  }
  if (!force && (await pathExists(targetPath))) {
    throw new Error(
      `${targetFile} already exists for ${id}. Use --force to overwrite.`
    );
  }

  const parsed = await parseMarkdownFile(sourcePath);
  await writeFileAtomic(targetPath, parsed.content);
  return {
    id,
    sourcePath,
    targetPath,
    message: `${targetFile} written from README.md for ${id}.`,
  };
}

export async function migrateProjectPitchFromReadme(
  projectId: string,
  opts: { force?: boolean } = {}
): Promise<MigrationResult> {
  const normalized = projectId.trim().toUpperCase();
  const project = await findProjectLocation(normalized);
  if (!project) throw new Error(`Project not found: ${normalized}`);
  return copyReadmeBody(
    project.id,
    project.dirPath,
    "PITCH.md",
    opts.force === true
  );
}

export async function migrateSliceSpecsFromReadme(
  sliceId: string,
  opts: { force?: boolean } = {}
): Promise<MigrationResult> {
  const normalized = sliceId.trim().toUpperCase();
  if (!SLICE_ID_PATTERN.test(normalized)) {
    throw new Error(`Invalid sliceId: ${sliceId}`);
  }

  const projects = await listProjectLocations();
  for (const project of projects) {
    const sliceDir = path.join(project.dirPath, "slices", normalized);
    if (await pathExists(sliceDir)) {
      return copyReadmeBody(
        normalized,
        sliceDir,
        "SPECS.md",
        opts.force === true
      );
    }
  }

  throw new Error(`Slice not found: ${normalized}`);
}
