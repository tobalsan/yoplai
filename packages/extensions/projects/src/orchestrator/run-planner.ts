import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  expandPath,
  resolveHomeDir,
  type GatewayConfig,
  type SubagentRuntimeProfile,
} from "@yoplai/shared";
import { normalizeRunMode, resolveProfile } from "../profiles/resolver.js";
import { ensureProjectIntegrationBranch } from "../projects/branches.js";
import type { ProjectListItem } from "../projects/store.js";
import type { SubagentListItem } from "../subagents/index.js";
import type { SpawnSubagentInput } from "../subagents/runner.js";
import { getProjectsWorktreeRoot } from "../util/paths.js";
import type { OrchestratorConfig } from "./config.js";
import {
  MERGER_SLICE_STATUS,
  REVIEWER_SLICE_STATUS,
  WORKER_SLICE_STATUS,
  isWorkerRun,
  sourceOf,
} from "./dispatch-policy.js";
import type {
  OrchestratorDispatcherDeps,
  SliceDispatchItem,
} from "./dispatcher.js";
import { OrchestratorPromptFactory } from "./prompt-factory.js";

export function runStartedAt(run: SubagentListItem): number {
  const parsed = Date.parse(run.startedAt ?? run.lastActive ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function slugForSlice(sliceId: string, now: Date, index: number): string {
  const stamp = now.getTime().toString(36);
  const suffix = index > 0 ? `-${index + 1}` : "";
  return `${sliceId.toLowerCase()}-${stamp}${suffix}`;
}

export function slugForShapingStatus(
  statusKey: string,
  projectId: string,
  now: Date,
  index: number
): string {
  const stage = statusKey.split(":")[1] ?? "shaping";
  const stamp = now.getTime().toString(36);
  const suffix = index > 0 ? `-${index + 1}` : "";
  return `${projectId.toLowerCase()}-${stage}-${stamp}${suffix}`;
}

export function slugForStatus(
  statusKey: string,
  sliceId: string,
  now: Date,
  index: number
): string {
  if (statusKey !== MERGER_SLICE_STATUS) {
    return slugForSlice(sliceId, now, index);
  }
  const stamp = now.getTime().toString(36);
  const suffix = index > 0 ? `-${index + 1}` : "";
  return `${sliceId.toLowerCase()}-merger-${stamp}${suffix}`;
}

export function fallbackCwdsForProject(
  config: GatewayConfig,
  project: ProjectListItem
): string[] {
  const candidates = new Set<string>();
  const repo = project.frontmatter.repo;
  if (typeof repo === "string" && repo.trim()) {
    candidates.add(expandPath(repo.trim()).replace(/\/$/, ""));
  }
  candidates.add(path.join(getProjectsWorktreeRoot(config), project.id));
  candidates.add(project.absolutePath);
  return [...candidates];
}

export function workerWorkspaceRuns(
  config: GatewayConfig,
  orchestratorConfig: OrchestratorConfig,
  runs: SubagentListItem[],
  sliceId?: string
): SubagentListItem[] {
  return runs
    .filter(
      (run) =>
        sourceOf(run) === "orchestrator" &&
        isWorkerRun(config, orchestratorConfig, run) &&
        Boolean(run.worktreePath) &&
        (sliceId === undefined || run.sliceId === sliceId)
    )
    .sort((a, b) => runStartedAt(b) - runStartedAt(a));
}

export async function recentWorkerWorkspaces(
  config: GatewayConfig,
  orchestratorConfig: OrchestratorConfig,
  runs: SubagentListItem[],
  sliceId?: string
): Promise<Array<{ name: string; cli?: string; path: string }>> {
  const existing: SubagentListItem[] = [];
  for (const run of workerWorkspaceRuns(
    config,
    orchestratorConfig,
    runs,
    sliceId
  )) {
    if (run.worktreePath && (await pathExists(run.worktreePath))) {
      existing.push(run);
    }
  }
  return existing.slice(0, 1).map((run) => ({
    name: run.name ?? run.slug,
    cli: run.cli,
    path: run.worktreePath ?? "",
  }));
}

export function recentWorkerBranch(
  config: GatewayConfig,
  orchestratorConfig: OrchestratorConfig,
  runs: SubagentListItem[],
  projectId: string,
  sliceId: string
): string | undefined {
  const latest = runs
    .filter(
      (run) =>
        sourceOf(run) === "orchestrator" &&
        isWorkerRun(config, orchestratorConfig, run) &&
        Boolean(run.slug) &&
        run.sliceId === sliceId
    )
    .sort((a, b) => runStartedAt(b) - runStartedAt(a))[0];
  return latest ? `${projectId}/${latest.slug}` : undefined;
}

export function hasLiveWorkerRun(
  config: GatewayConfig,
  orchestratorConfig: OrchestratorConfig,
  runs: SubagentListItem[],
  sliceId: string
): boolean {
  return runs.some(
    (run) =>
      sourceOf(run) === "orchestrator" &&
      run.status === "running" &&
      isWorkerRun(config, orchestratorConfig, run) &&
      run.sliceId === sliceId
  );
}

async function readPromptTemplate(profileName: string): Promise<string | undefined> {
  const filePath = path.join(resolveHomeDir(), "prompts", `${profileName}.md`);
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

async function markdownFilesBlock(root: string): Promise<string> {
  const entries: string[] = [];
  async function walk(dir: string): Promise<void> {
    let items;
    try {
      items = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (item.name.startsWith(".")) continue;
      const itemPath = path.join(dir, item.name);
      if (item.isDirectory()) await walk(itemPath);
      else if (item.name.endsWith(".md")) entries.push(`- ${itemPath}`);
    }
  }
  await walk(root);
  return entries.length > 0 ? entries.join("\n") : "No Markdown files found.";
}

async function recentThreadBlock(projectDir: string): Promise<string> {
  try {
    const raw = await fs.readFile(path.join(projectDir, "THREAD.md"), "utf8");
    const lines = raw.trim().split(/\r?\n/);
    return lines.slice(-80).join("\n") || "No comments yet.";
  } catch {
    return "No comments yet.";
  }
}

export class OrchestratorRunPlanner {
  constructor(
    private readonly config: GatewayConfig,
    private readonly orchestratorConfig: OrchestratorConfig,
    private readonly deps: Pick<
      OrchestratorDispatcherDeps,
      "ensureProjectIntegrationBranch"
    > = {},
    private readonly promptFactory = new OrchestratorPromptFactory()
  ) {}

  resolveProfile(name: string): SubagentRuntimeProfile | undefined {
    return resolveProfile(this.config, name);
  }

  slugForStatus(statusKey: string, sliceId: string, now: Date, index: number) {
    return slugForStatus(statusKey, sliceId, now, index);
  }

  slugForShapingStatus(
    statusKey: string,
    projectId: string,
    now: Date,
    index: number
  ) {
    return slugForShapingStatus(statusKey, projectId, now, index);
  }

  async buildSpawnInput(
    statusKey: string,
    item: SliceDispatchItem,
    profile: SubagentRuntimeProfile,
    slug: string,
    runs: SubagentListItem[]
  ): Promise<SpawnSubagentInput | undefined> {
    if (statusKey === WORKER_SLICE_STATUS) {
      return this.buildWorkerSpawnInput(item, profile, slug);
    }
    if (statusKey === REVIEWER_SLICE_STATUS) {
      const workerWorkspaces = await recentWorkerWorkspaces(
        this.config,
        this.orchestratorConfig,
        runs,
        item.slice.id
      );
      if (workerWorkspaces.length === 0) return undefined;
      return this.buildReviewerSpawnInput(
        item,
        profile,
        slug,
        workerWorkspaces
      );
    }
    if (statusKey === MERGER_SLICE_STATUS) {
      return this.buildMergerSpawnInput(item, profile, slug, runs);
    }
    return undefined;
  }

  async buildShaperSpawnInput(
    project: ProjectListItem,
    statusKey: string,
    nextStatus: string | undefined,
    profile: SubagentRuntimeProfile,
    slug: string
  ): Promise<SpawnSubagentInput> {
    const promptTemplate = await readPromptTemplate(profile.name);
    return {
      projectId: project.id,
      slug,
      cli: profile.cli,
      name: profile.name,
      prompt: this.promptFactory.buildShaperPrompt(
        {
          projectId: project.id,
          projectTitle: project.title,
          projectDirPath: project.absolutePath,
          status: statusKey,
          nextStatus,
          profileName: profile.name,
          projectDocs: await markdownFilesBlock(project.absolutePath),
          sliceDocs: await markdownFilesBlock(path.join(project.absolutePath, "slices")),
          recentThread: await recentThreadBlock(project.absolutePath),
        },
        promptTemplate
      ),
      model: profile.model,
      reasoningEffort: profile.reasoningEffort ?? profile.reasoning,
      mode: normalizeRunMode(profile.runMode),
      source: "orchestrator",
    };
  }

  async buildWorkerSpawnInput(
    item: SliceDispatchItem,
    profile: SubagentRuntimeProfile,
    slug: string
  ): Promise<SpawnSubagentInput> {
    const { slice, project } = item;
    const repo =
      typeof project.frontmatter.repo === "string"
        ? project.frontmatter.repo.trim()
        : "";
    if (!repo) {
      throw new Error("Project repo is required for Worker dispatch");
    }
    const baseBranch = await (
      this.deps.ensureProjectIntegrationBranch ?? ensureProjectIntegrationBranch
    )(expandPath(repo), project.id);
    return {
      projectId: project.id,
      sliceId: slice.id,
      slug,
      cli: profile.cli,
      name: profile.name,
      prompt: this.promptFactory.buildWorkerPrompt({
        sliceId: slice.id,
        sliceTitle: slice.frontmatter.title,
        projectDirPath: project.absolutePath,
        sliceDirPath: slice.dirPath,
      }),
      model: profile.model,
      reasoningEffort: profile.reasoningEffort ?? profile.reasoning,
      mode: normalizeRunMode(profile.runMode),
      baseBranch,
      source: "orchestrator",
    };
  }

  buildReviewerSpawnInput(
    item: SliceDispatchItem,
    profile: SubagentRuntimeProfile,
    slug: string,
    workerWorkspaces: Array<{ name: string; cli?: string; path: string }>
  ): SpawnSubagentInput {
    const { slice, project } = item;
    return {
      projectId: project.id,
      sliceId: slice.id,
      slug,
      cli: profile.cli,
      name: profile.name,
      prompt: this.promptFactory.buildReviewerPrompt({
        sliceId: slice.id,
        sliceTitle: slice.frontmatter.title,
        projectDirPath: project.absolutePath,
        sliceDirPath: slice.dirPath,
        workerWorkspaces,
      }),
      model: profile.model,
      reasoningEffort: profile.reasoningEffort ?? profile.reasoning,
      mode: normalizeRunMode(profile.runMode),
      source: "orchestrator",
    };
  }

  async buildMergerSpawnInput(
    item: SliceDispatchItem,
    profile: SubagentRuntimeProfile,
    slug: string,
    runs: SubagentListItem[]
  ): Promise<SpawnSubagentInput> {
    const { slice, project } = item;
    const repo =
      typeof project.frontmatter.repo === "string"
        ? project.frontmatter.repo.trim()
        : "";
    if (!repo) {
      throw new Error("Project repo is required for Merger dispatch");
    }

    const baseBranch = await (
      this.deps.ensureProjectIntegrationBranch ?? ensureProjectIntegrationBranch
    )(expandPath(repo), project.id);
    const workerBranch = recentWorkerBranch(
      this.config,
      this.orchestratorConfig,
      runs,
      project.id,
      slice.id
    );

    return {
      projectId: project.id,
      sliceId: slice.id,
      slug,
      cli: profile.cli,
      name: profile.name,
      prompt: this.promptFactory.buildMergerPrompt({
        sliceId: slice.id,
        sliceTitle: slice.frontmatter.title,
        projectDirPath: project.absolutePath,
        sliceDirPath: slice.dirPath,
        baseBranch,
        workerBranch,
      }),
      model: profile.model,
      reasoningEffort: profile.reasoningEffort ?? profile.reasoning,
      mode: normalizeRunMode(profile.runMode),
      baseBranch,
      source: "orchestrator",
    };
  }
}
