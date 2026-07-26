import * as fs from "node:fs/promises";
import * as path from "node:path";
import yaml from "js-yaml";
import { AreaSchema, type Area, type GatewayConfig } from "@yoplai/shared";
import { parseMarkdownFile } from "../taskboard/parser.js";
import { getProjectsRoot } from "../util/paths.js";

const AREAS_DIR = ".areas";

type DefaultArea = Required<
  Pick<Area, "id" | "title" | "color" | "repo" | "order">
>;

const DEFAULT_AREAS: DefaultArea[] = [
  {
    id: "yoplai",
    title: "Yoplai",
    color: "#3b8ecc",
    repo: "~/code/yoplai",
    order: 1,
  },
  {
    id: "ranksource",
    title: "Ranksource",
    color: "#cc6b3b",
    repo: "~/code/ranksource",
    order: 2,
  },
  {
    id: "cloudifai",
    title: "Cloudifai",
    color: "#8a3bcc",
    repo: "~/code/cloudifai",
    order: 3,
  },
];

function getAreasPath(config: GatewayConfig): string {
  return path.join(getProjectsRoot(config), AREAS_DIR);
}

function getAreaFilePath(config: GatewayConfig, id: string): string {
  return path.join(getAreasPath(config), `${id}.yaml`);
}

function formatFrontmatterValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return JSON.stringify(value ?? "");
}

function formatFrontmatter(frontmatter: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === undefined) continue;
    lines.push(`${key}: ${formatFrontmatterValue(value)}`);
  }
  return `---\n${lines.join("\n")}\n---\n`;
}

function formatMarkdown(
  frontmatter: Record<string, unknown>,
  content: string
): string {
  return `${formatFrontmatter(frontmatter)}${content}`;
}

function inferAreaFromProjectDir(dirName: string): string | null {
  const match = dirName.match(/^PRO-\d+_(yoplai|ranksource|cloudifai)_/i);
  return match?.[1]?.toLowerCase() ?? null;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

export async function listAreas(config: GatewayConfig): Promise<Area[]> {
  const areasPath = getAreasPath(config);
  let entries: string[] = [];
  try {
    entries = await fs.readdir(areasPath);
  } catch {
    return [];
  }

  const areas: Area[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".yaml")) continue;
    const filePath = path.join(areasPath, entry);
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = yaml.load(raw) as unknown;
    areas.push(AreaSchema.parse(parsed));
  }

  return areas.sort((a, b) => {
    const orderA = a.order ?? Number.MAX_SAFE_INTEGER;
    const orderB = b.order ?? Number.MAX_SAFE_INTEGER;
    if (orderA !== orderB) return orderA - orderB;
    return a.id.localeCompare(b.id);
  });
}

export async function getArea(
  config: GatewayConfig,
  id: string
): Promise<Area | null> {
  const filePath = getAreaFilePath(config, id);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = yaml.load(raw) as unknown;
    return AreaSchema.parse(parsed);
  } catch {
    return null;
  }
}

export async function createArea(
  config: GatewayConfig,
  input: unknown
): Promise<Area> {
  const area = AreaSchema.parse(input);
  const areasPath = getAreasPath(config);
  const filePath = getAreaFilePath(config, area.id);
  await fs.mkdir(areasPath, { recursive: true });
  if (await fileExists(filePath)) {
    throw new Error(`Area already exists: ${area.id}`);
  }
  await fs.writeFile(filePath, yaml.dump(area, { lineWidth: -1 }), "utf8");
  return area;
}

export async function updateArea(
  config: GatewayConfig,
  id: string,
  patch: Partial<Area>
): Promise<Area> {
  const current = await getArea(config, id);
  if (!current) {
    throw new Error(`Area not found: ${id}`);
  }
  const next = AreaSchema.parse({ ...current, ...patch, id });
  await fs.writeFile(
    getAreaFilePath(config, id),
    yaml.dump(next, { lineWidth: -1 }),
    "utf8"
  );
  return next;
}

export async function deleteArea(
  config: GatewayConfig,
  id: string
): Promise<boolean> {
  try {
    await fs.unlink(getAreaFilePath(config, id));
    return true;
  } catch {
    return false;
  }
}

export async function migrateAreas(config: GatewayConfig): Promise<{
  seededAreas: string[];
  updatedProjects: string[];
  skippedProjects: string[];
}> {
  const areasPath = getAreasPath(config);
  await fs.mkdir(areasPath, { recursive: true });

  const seededAreas: string[] = [];
  for (const area of DEFAULT_AREAS) {
    const filePath = getAreaFilePath(config, area.id);
    if (await fileExists(filePath)) continue;
    await fs.writeFile(filePath, yaml.dump(area, { lineWidth: -1 }), "utf8");
    seededAreas.push(area.id);
  }

  const root = getProjectsRoot(config);
  let entries: Array<{ name: string; isDirectory: () => boolean }> = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return { seededAreas, updatedProjects: [], skippedProjects: [] };
  }

  const updatedProjects: string[] = [];
  const skippedProjects: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;
    const areaId = inferAreaFromProjectDir(entry.name);
    if (!areaId) continue;

    const readmePath = path.join(root, entry.name, "README.md");
    if (!(await fileExists(readmePath))) {
      skippedProjects.push(entry.name);
      continue;
    }

    const parsed = await parseMarkdownFile(readmePath);
    if (
      typeof parsed.frontmatter.area === "string" &&
      parsed.frontmatter.area.trim()
    ) {
      skippedProjects.push(entry.name);
      continue;
    }

    const frontmatter = { ...parsed.frontmatter, area: areaId };
    await fs.writeFile(
      readmePath,
      formatMarkdown(frontmatter, parsed.content),
      "utf8"
    );
    updatedProjects.push(entry.name);
  }

  return { seededAreas, updatedProjects, skippedProjects };
}
