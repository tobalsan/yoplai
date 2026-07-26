import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Command } from "commander";
import type { GatewayConfig } from "@yoplai/shared";
import { getDefaultConfigPath } from "@yoplai/shared";
import {
  createSlice,
  getSlice,
  listSlices,
  updateSlice,
  type SliceRecord,
  type SliceStatus,
} from "../projects/slices.js";
import {
  recordSliceBlockedActivity,
  recordSliceUnblockedActivity,
} from "../activity/index.js";
import { parseMarkdownFile } from "../taskboard/parser.js";
import { getProjectsRoot } from "../util/paths.js";
import { migrateSliceSpecsFromReadme } from "./doc-migration.js";

const PROJECT_ID_PATTERN = /^PRO-\d+$/;
const ARCHIVE_DIR = ".archive";
const DONE_DIR = ".done";

type ProjectLocation = { id: string; dirPath: string };
type SliceListItem = {
  id: string;
  projectId: string;
  title: string;
  status: string;
  hillPosition: string;
  updatedAt: string;
};

type LocatedSlice = { project: ProjectLocation; slice: SliceRecord };
type ReadStdin = () => Promise<string>;

const MERGER_CONFLICT_PREFIX_RE =
  /^Merge conflict\s+(?:—|-)\s+needs human:\s*/i;

function fail(err: unknown): never {
  if (err instanceof Error) console.error(err.message);
  else console.error("Request failed");
  process.exit(1);
}

function summarizeCommentBody(body: string): string {
  return (
    body
      .trim()
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .join(", ") || "Merge conflict needs human."
  );
}

function mergerConflictSummary(body: string): string | undefined {
  const trimmed = body.trim();
  const firstLineEnd = trimmed.indexOf("\n");
  const firstLine =
    firstLineEnd === -1 ? trimmed : trimmed.slice(0, firstLineEnd);
  const match = firstLine.match(MERGER_CONFLICT_PREFIX_RE);
  if (!match) return undefined;
  const inlineSummary = firstLine.slice(match[0].length).trim();
  const remainingSummary =
    firstLineEnd === -1 ? "" : trimmed.slice(firstLineEnd + 1).trim();
  const summary = [inlineSummary, remainingSummary]
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(", ");
  return summary || "Merge conflict needs human.";
}

function sliceCommentFrontmatter(
  existing: unknown,
  author: string,
  body: string,
  at: string
): Record<string, unknown> {
  if (author !== "Merger") return {};
  if (
    existing &&
    typeof existing === "object" &&
    !Array.isArray(existing) &&
    (existing as { source?: unknown }).source === "merger_outcome"
  ) {
    return {};
  }
  const summary = mergerConflictSummary(body);
  return summary
    ? { merger_conflict: { summary, at, source: "merger_comment" } }
    : {};
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

async function readMarkdownArg(
  value: string,
  readStdinFn: ReadStdin
): Promise<string> {
  if (value === "-") return readStdinFn();
  if (value.startsWith("@")) return fs.readFile(value.slice(1), "utf8");
  return value;
}

export async function resolveAddSliceSpecs(
  positionalSpecs: string | undefined,
  flagSpecs: string | undefined,
  readStdinFn: ReadStdin = readStdin
): Promise<string | undefined> {
  if (positionalSpecs !== undefined && flagSpecs !== undefined) {
    throw new Error("Use either positional <specs> or --specs, not both.");
  }
  const value = flagSpecs !== undefined ? flagSpecs : positionalSpecs;
  if (value === undefined) return undefined;
  return readMarkdownArg(value, readStdinFn);
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.stat(targetPath);
    return true;
  } catch {
    return false;
  }
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

async function listSlicesForProject(
  project: ProjectLocation
): Promise<SliceListItem[]> {
  const slicesDir = path.join(project.dirPath, "slices");
  if (!(await pathExists(slicesDir))) return [];
  const entries = await fs.readdir(slicesDir, { withFileTypes: true });
  const out: SliceListItem[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const readmePath = path.join(slicesDir, entry.name, "README.md");
    if (!(await pathExists(readmePath))) continue;
    const parsed = await parseMarkdownFile(readmePath);
    const fm = parsed.frontmatter ?? {};
    out.push({
      id: String(fm.id ?? entry.name),
      projectId: String(fm.project_id ?? project.id),
      title: String(fm.title ?? ""),
      status: String(fm.status ?? ""),
      hillPosition: String(fm.hill_position ?? ""),
      updatedAt: String(fm.updated_at ?? ""),
    });
  }

  return out;
}

async function findSliceAcrossProjects(
  sliceId: string
): Promise<{ project: ProjectLocation; slice: SliceRecord } | null> {
  const projects = await listProjectLocations();
  for (const project of projects) {
    try {
      const slice = await getSlice(project.dirPath, sliceId);
      return { project, slice };
    } catch {
      // ignore
    }
  }
  return null;
}

function parseSliceIdList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim().toUpperCase())
        .filter(Boolean)
    ),
  ];
}

function frontmatterBlockers(slice: SliceRecord): string[] {
  const value = slice.frontmatter.blocked_by;
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

async function listAllLocatedSlices(): Promise<LocatedSlice[]> {
  const projects = await listProjectLocations();
  const nested = await Promise.all(
    projects.map(async (project) =>
      (await listSlices(project.dirPath)).map((slice) => ({ project, slice }))
    )
  );
  return nested.flat();
}

function findCyclePath(
  graph: Map<string, string[]>,
  start: string,
  target: string
): string[] | null {
  const visited = new Set<string>();

  function walk(current: string, pathSoFar: string[]): string[] | null {
    if (current === target) return pathSoFar;
    if (visited.has(current)) return null;
    visited.add(current);
    for (const next of graph.get(current) ?? []) {
      const path = walk(next, [...pathSoFar, next]);
      if (path) return path;
    }
    return null;
  }

  return walk(start, [start]);
}

function formatBlockedBy(blockers: string[]): string {
  return `blocked_by: [${blockers.join(", ")}]`;
}

function renderSliceTable(items: SliceListItem[]): string {
  const headers = ["id", "project", "title", "status", "hill", "updated"];
  const rows = items.map((item) =>
    [
      item.id,
      item.projectId,
      item.title,
      item.status,
      item.hillPosition,
      item.updatedAt,
    ].map((value) => value.replace(/\r?\n/g, "<br>").replace(/\|/g, "\\|"))
  );
  const headerRow = `| ${headers.join(" | ")} |`;
  const separator = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${row.join(" | ")} |`).join("\n");
  return [headerRow, separator, body].filter(Boolean).join("\n");
}

function renderSliceDetails(record: SliceRecord): string {
  const fm = record.frontmatter;
  const lines = [
    `id: ${fm.id}`,
    `project_id: ${fm.project_id}`,
    `title: ${fm.title}`,
    `status: ${fm.status}`,
    `hill_position: ${fm.hill_position}`,
    `created_at: ${fm.created_at}`,
    `updated_at: ${fm.updated_at}`,
    "",
    "## README",
    record.docs.readme.trim(),
    "",
    "## SPECS",
    record.docs.specs.trim(),
    "",
    "## TASKS",
    record.docs.tasks.trim(),
    "",
    "## VALIDATION",
    record.docs.validation.trim(),
    "",
    "## THREAD",
    record.docs.thread.trim(),
  ];
  return lines.join("\n");
}

export function registerSlicesCommands(program: Command): Command {
  program
    .command("add")
    .description("Create slice")
    .requiredOption("--project <id>", "Project ID")
    .option(
      "--specs <content>",
      "Specs content string, @file, or '-' for stdin"
    )
    .option("--repo <path>", "Slice repo path")
    .argument("<title>", "Slice title")
    .argument("[specs]", "Slice specs body")
    .action(async (title, specs, opts) => {
      try {
        const project = await findProjectLocation(String(opts.project));
        if (!project)
          throw new Error(
            `Project not found: ${String(opts.project).trim().toUpperCase()}`
          );
        const specsBody = await resolveAddSliceSpecs(
          specs === undefined ? undefined : String(specs),
          opts.specs === undefined ? undefined : String(opts.specs)
        );
        const created = await createSlice(project.dirPath, {
          projectId: project.id,
          title: String(title),
          status: "todo",
          repo: typeof opts.repo === "string" ? opts.repo : undefined,
          specs: specsBody,
        });
        console.log(created.id);
      } catch (err) {
        fail(err);
      }
    });

  program
    .command("list")
    .description("List slices")
    .option("--project <id>", "Project ID filter")
    .option("--status <status>", "Status filter")
    .option("-j, --json", "JSON output")
    .action(async (opts) => {
      try {
        const statusFilter =
          typeof opts.status === "string" && opts.status.trim().length > 0
            ? opts.status.trim()
            : undefined;
        const projectFilter =
          typeof opts.project === "string" && opts.project.trim().length > 0
            ? opts.project.trim().toUpperCase()
            : undefined;

        const projects = await listProjectLocations();
        const filteredProjects = projectFilter
          ? projects.filter((project) => project.id === projectFilter)
          : projects;
        if (projectFilter && filteredProjects.length === 0) {
          throw new Error(`Project not found: ${projectFilter}`);
        }

        const all = (
          await Promise.all(
            filteredProjects.map((project) => listSlicesForProject(project))
          )
        )
          .flat()
          .filter((slice) =>
            statusFilter ? slice.status === statusFilter : true
          )
          .sort((a, b) => a.id.localeCompare(b.id));

        if (opts.json) {
          console.log(JSON.stringify(all, null, 2));
          return;
        }
        console.log(renderSliceTable(all));
      } catch (err) {
        fail(err);
      }
    });

  program
    .command("specs")
    .description("Copy slice README body to SPECS.md")
    .argument("<sliceId>", "Slice ID")
    .requiredOption("--from-readme", "Copy README.md body to SPECS.md")
    .option("--force", "Overwrite existing SPECS.md")
    .action(async (sliceId, opts) => {
      try {
        const result = await migrateSliceSpecsFromReadme(String(sliceId), {
          force: opts.force === true,
        });
        console.log(result.message);
      } catch (err) {
        fail(err);
      }
    });

  program
    .command("get")
    .description("Get slice details")
    .argument("<sliceId>", "Slice ID")
    .option("-j, --json", "JSON output")
    .action(async (sliceId, opts) => {
      try {
        const found = await findSliceAcrossProjects(String(sliceId));
        if (!found) throw new Error(`Slice not found: ${String(sliceId)}`);
        if (opts.json) {
          console.log(JSON.stringify(found.slice, null, 2));
          return;
        }
        console.log(renderSliceDetails(found.slice));
      } catch (err) {
        fail(err);
      }
    });

  const VALID_STATUSES: SliceStatus[] = [
    "todo",
    "in_progress",
    "review",
    "ready_to_merge",
    "done",
    "cancelled",
  ];

  program
    .command("move")
    .description("Change slice status")
    .argument("<sliceId>", "Slice ID")
    .argument("<status>", "Target status")
    .action(async (sliceId, status) => {
      try {
        const normalizedStatus = String(status).trim() as SliceStatus;
        if (!(VALID_STATUSES as string[]).includes(normalizedStatus)) {
          throw new Error(
            `Invalid status "${normalizedStatus}". Must be one of: ${VALID_STATUSES.join(", ")}`
          );
        }
        const found = await findSliceAcrossProjects(String(sliceId));
        if (!found) throw new Error(`Slice not found: ${String(sliceId)}`);
        await updateSlice(found.project.dirPath, found.slice.id, {
          status: normalizedStatus,
        });
        console.log(`${found.slice.id} → ${normalizedStatus}`);
      } catch (err) {
        fail(err);
      }
    });

  program
    .command("rename")
    .description("Rename slice")
    .argument("<sliceId>", "Slice ID")
    .argument("<title>", "New title")
    .action(async (sliceId, title) => {
      try {
        const found = await findSliceAcrossProjects(String(sliceId));
        if (!found) throw new Error(`Slice not found: ${String(sliceId)}`);
        await updateSlice(found.project.dirPath, found.slice.id, {
          title: String(title),
        });
        console.log(
          `${found.slice.id} renamed to ${JSON.stringify(String(title))}`
        );
      } catch (err) {
        fail(err);
      }
    });

  program
    .command("block")
    .description("Block slice on prerequisite slices")
    .argument("<sliceId>", "Slice ID")
    .requiredOption("--on <blockerIds>", "Comma-separated blocker slice IDs")
    .action(async (sliceId, opts) => {
      try {
        const targetId = String(sliceId).trim().toUpperCase();
        const blockers = parseSliceIdList(String(opts.on ?? ""));
        if (blockers.length === 0)
          throw new Error("--on must include at least one blocker ID");

        const allSlices = await listAllLocatedSlices();
        const byId = new Map(allSlices.map((item) => [item.slice.id, item]));
        const found = byId.get(targetId);
        if (!found) throw new Error(`Slice not found: ${targetId}`);

        for (const blocker of blockers) {
          if (!byId.has(blocker))
            throw new Error(`Blocker slice not found: ${blocker}`);
          if (blocker === targetId)
            throw new Error(`Slice cannot block itself: ${targetId}`);
        }

        const nextBlockers = [
          ...new Set([...frontmatterBlockers(found.slice), ...blockers]),
        ];
        const graph = new Map<string, string[]>(
          allSlices.map((item) => [
            item.slice.id,
            frontmatterBlockers(item.slice),
          ])
        );
        graph.set(targetId, nextBlockers);

        for (const blocker of blockers) {
          const cyclePath = findCyclePath(graph, blocker, targetId);
          if (cyclePath) {
            throw new Error(
              `would create cycle: ${[targetId, ...cyclePath].join(" → ")}`
            );
          }
        }

        const updated = await updateSlice(found.project.dirPath, targetId, {
          frontmatter: { blocked_by: nextBlockers },
        });
        await recordSliceBlockedActivity({
          actor: "Yoplai",
          projectId: found.project.id,
          sliceId: targetId,
          blockers,
        });
        console.log(formatBlockedBy(frontmatterBlockers(updated)));
      } catch (err) {
        fail(err);
      }
    });

  program
    .command("unblock")
    .description("Remove slice blockers")
    .argument("<sliceId>", "Slice ID")
    .option("--from <blockerIds>", "Comma-separated blocker slice IDs")
    .action(async (sliceId, opts) => {
      try {
        const targetId = String(sliceId).trim().toUpperCase();
        const found = await findSliceAcrossProjects(targetId);
        if (!found) throw new Error(`Slice not found: ${targetId}`);

        const current = frontmatterBlockers(found.slice);
        const remove =
          typeof opts.from === "string"
            ? parseSliceIdList(opts.from)
            : undefined;
        if (remove) {
          const missing = remove.filter(
            (blocker) => !current.includes(blocker)
          );
          if (missing.length > 0) {
            throw new Error(
              `Blockers not found on ${targetId}: ${missing.join(", ")}`
            );
          }
        }
        const nextBlockers = remove
          ? current.filter((blocker) => !remove.includes(blocker))
          : [];
        const updated = await updateSlice(found.project.dirPath, targetId, {
          frontmatter: {
            blocked_by: nextBlockers.length > 0 ? nextBlockers : undefined,
          },
        });
        await recordSliceUnblockedActivity({
          actor: "Yoplai",
          projectId: found.project.id,
          sliceId: targetId,
          blockers: remove,
        });
        console.log(formatBlockedBy(frontmatterBlockers(updated)));
      } catch (err) {
        fail(err);
      }
    });

  program
    .command("comment")
    .description("Append timestamped comment to slice THREAD.md")
    .argument("<sliceId>", "Slice ID")
    .argument("<body>", "Comment body")
    .option("--author <author>", "Comment author")
    .action(async (sliceId, body, opts) => {
      try {
        const found = await findSliceAcrossProjects(String(sliceId));
        if (!found) throw new Error(`Slice not found: ${String(sliceId)}`);
        const now = new Date().toISOString();
        const existing = found.slice.docs.thread;
        const separator = existing.trim().length > 0 ? "\n\n" : "";
        const author =
          typeof opts.author === "string" && opts.author.trim()
            ? opts.author.trim()
            : "";
        const metadata = author ? `\n[author:${author}]\n[date:${now}]` : "";
        const entry = `## ${now}${metadata}\n\n${String(body).trim()}`;
        const newThread = `${existing.trimEnd()}${separator}${entry}\n`;
        await updateSlice(found.project.dirPath, found.slice.id, {
          thread: newThread,
          frontmatter: sliceCommentFrontmatter(
            found.slice.frontmatter.merger_conflict,
            author,
            String(body),
            now
          ),
        });
        console.log(`Comment added to ${found.slice.id}`);
      } catch (err) {
        fail(err);
      }
    });

  program
    .command("merger-conflict")
    .description("Record an irrecoverable Merger conflict for a slice")
    .argument("<sliceId>", "Slice ID")
    .argument("<summary>", "Conflict files or failing checks")
    .action(async (sliceId, summary) => {
      try {
        const found = await findSliceAcrossProjects(String(sliceId));
        if (!found) throw new Error(`Slice not found: ${String(sliceId)}`);
        const now = new Date().toISOString();
        await updateSlice(found.project.dirPath, found.slice.id, {
          frontmatter: {
            merger_conflict: {
              summary: summarizeCommentBody(String(summary)),
              at: now,
              source: "merger_outcome",
            },
          },
        });
        console.log(`Merger conflict recorded for ${found.slice.id}`);
      } catch (err) {
        fail(err);
      }
    });

  program
    .command("cancel")
    .description("Cancel slice (sugar for move <id> cancelled)")
    .argument("<sliceId>", "Slice ID")
    .action(async (sliceId) => {
      try {
        const found = await findSliceAcrossProjects(String(sliceId));
        if (!found) throw new Error(`Slice not found: ${String(sliceId)}`);
        await updateSlice(found.project.dirPath, found.slice.id, {
          status: "cancelled",
        });
        console.log(`${found.slice.id} → cancelled`);
      } catch (err) {
        fail(err);
      }
    });

  return program;
}
