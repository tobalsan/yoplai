import os from "node:os";
import path from "node:path";
import {
  StartProjectRunRequestSchema,
  buildRolePrompt,
  normalizeProjectStatus,
  type GatewayConfig,
  type PromptRole,
  type UpdateProjectRequest,
} from "@yoplai/shared";
import { normalizeRunModeOrClone } from "../profiles/resolver.js";
import {
  resolveCliProfileOptions,
  type NormalizedRunMode,
} from "../profiles/resolver.js";
import { getProject, updateProject } from "../projects/index.js";
import { parseMarkdownFile } from "../taskboard/parser.js";
import { listSubagents } from "../subagents/index.js";
import {
  getUnsupportedSubagentCliError,
  isSupportedSubagentCli,
  spawnSubagent,
} from "../subagents/runner.js";
import { getProjectsContext } from "../context.js";

type CliRunMode = NormalizedRunMode;

export type StartProjectRunResult =
  | { ok: true; data: { ok: true; type: "native"; sessionKey: string } }
  | {
      ok: true;
      data: { ok: true; type: "cli"; slug: string | undefined; runMode: CliRunMode | undefined };
    }
  | { ok: false; error: string; status: 400 | 404 };

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function expandHomePath(value: string): string {
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

const NATIVE_PREFIX = "yoplai:";
const LEGACY_NATIVE_PREFIX = "aihub:";
let warnedLegacyPrefix = false;

function normalizeRunAgent(
  value?: string
): { type: "native"; id: string } | { type: "cli"; id: string } | null {
  if (!value) return null;
  if (value.startsWith(NATIVE_PREFIX)) {
    return { type: "native", id: value.slice(NATIVE_PREFIX.length) };
  }
  if (value.startsWith(LEGACY_NATIVE_PREFIX)) {
    if (!warnedLegacyPrefix) {
      warnedLegacyPrefix = true;
      console.warn(
        `[projects] runAgent "${LEGACY_NATIVE_PREFIX}" prefix is deprecated; rewrite it as "${NATIVE_PREFIX}" instead.`
      );
    }
    return { type: "native", id: value.slice(LEGACY_NATIVE_PREFIX.length) };
  }
  if (value.startsWith("cli:")) return { type: "cli", id: value.slice(4) };
  return null;
}

function slugToName(slug: string): string {
  return slug
    .split("-")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .slice(0, 3)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function resolveRunName(
  prefix: string | undefined,
  slug: string | undefined,
  explicitName: string | undefined
): string | undefined {
  const requestedName = hasText(explicitName) ? explicitName.trim() : undefined;
  if (requestedName) return requestedName;
  if (!prefix) return undefined;
  if (!hasText(slug)) return prefix;

  const words = slugToName(slug)
    .split(" ")
    .filter((part) => part.length > 0);
  if (words.length === 0) return prefix;
  if (words[0].toLowerCase() === prefix.toLowerCase()) {
    words.shift();
  }
  return words.length > 0 ? `${prefix} ${words.join(" ")}` : prefix;
}

function slugifyTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export async function startProjectRun(
  config: GatewayConfig,
  projectId: string,
  body: unknown
): Promise<StartProjectRunResult> {
  const parsed = StartProjectRunRequestSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.message, status: 400 };
  }
  const startInput = { ...parsed.data };
  const userExplicitName = hasText(startInput.name)
    ? startInput.name.trim()
    : undefined;

  const subagentTemplateName = startInput.subagentTemplate;
  if (subagentTemplateName) {
    const match = getProjectsContext()
      .getSubagentTemplates()
      .find((t) => t.name.toLowerCase() === subagentTemplateName.toLowerCase());
    if (!match) {
      return {
        ok: false,
        error: `Unknown subagent template: ${subagentTemplateName}`,
        status: 400,
      };
    }
    if (!hasText(startInput.runAgent)) startInput.runAgent = `cli:${match.cli}`;
    if (!hasText(startInput.model)) startInput.model = match.model;
    if (!hasText(startInput.reasoningEffort)) {
      startInput.reasoningEffort = match.reasoning;
    }
    if (!hasText(startInput.runMode)) startInput.runMode = match.runMode;
    if (!hasText(startInput.promptRole)) {
      startInput.promptRole = match.type as PromptRole;
    }
    if (!hasText(startInput.name)) startInput.name = match.name;
  }

  const projectResult = await getProject(config, projectId);
  if (!projectResult.ok) {
    return { ok: false, error: projectResult.error, status: 404 };
  }
  const project = projectResult.data;
  const frontmatter = project.frontmatter ?? {};
  const status = typeof frontmatter.status === "string" ? frontmatter.status : "";
  const normalizedStatus = normalizeProjectStatus(status);
  const requestedRunAgentValue = hasText(startInput.runAgent)
    ? startInput.runAgent.trim()
    : "";
  const frontmatterRunAgentValue =
    typeof frontmatter.runAgent === "string" ? frontmatter.runAgent.trim() : "";
  const resolvedRunAgentValue =
    requestedRunAgentValue || frontmatterRunAgentValue || "cli:codex";
  const normalizedRunAgentValue = resolvedRunAgentValue.includes(":")
    ? resolvedRunAgentValue
    : `cli:${resolvedRunAgentValue}`;

  let runAgentSelection = normalizeRunAgent(normalizedRunAgentValue);
  if (!runAgentSelection) {
    const agents = getProjectsContext().getAgents();
    if (agents.length === 0) {
      return { ok: false, error: "No active agents available", status: 400 };
    }
    const preferred =
      normalizedStatus === "shaping"
        ? agents.find((agent) => agent.name === "Project Manager")
        : null;
    const selected = preferred ?? agents[0];
    runAgentSelection = { type: "native", id: selected.id };
  }

  let runMode: CliRunMode | undefined;
  let slug: string | undefined;
  let baseBranch: string | undefined;
  const requestedModel = hasText(startInput.model) ? startInput.model.trim() : undefined;
  const requestedReasoningEffort = hasText(startInput.reasoningEffort)
    ? startInput.reasoningEffort.trim()
    : undefined;
  const requestedThinking = hasText(startInput.thinking)
    ? startInput.thinking.trim()
    : undefined;
  const requestedRunModeValue = hasText(startInput.runMode)
    ? startInput.runMode.trim()
    : "";
  const resolvedRunMode = normalizeRunModeOrClone(
    requestedRunModeValue || "clone"
  );
  if (runAgentSelection.type === "cli") {
    runMode = resolvedRunMode;
    const requestedSlugValue = hasText(startInput.slug) ? startInput.slug.trim() : "";
    slug =
      runMode === "main-run"
        ? "main"
        : requestedSlugValue || slugifyTitle(project.title);
    baseBranch = hasText(startInput.baseBranch)
      ? startInput.baseBranch.trim()
      : "main";
  }

  let runAgentLabel: string | undefined;
  if (runAgentSelection.type === "cli") {
    const cliId = runAgentSelection.id;
    runAgentLabel =
      cliId === "codex"
        ? "Codex"
        : cliId === "claude"
          ? "Claude"
          : cliId === "pi"
            ? "Pi"
            : undefined;
  } else {
    runAgentLabel = getProjectsContext().getAgent(runAgentSelection.id)?.name;
  }

  const repo = typeof frontmatter.repo === "string" ? frontmatter.repo : "";
  const root =
    config.extensions?.projects?.root ?? config.projects?.root ?? "~/projects";
  const resolvedRoot = root.startsWith("~/")
    ? path.join(os.homedir(), root.slice(2))
    : root;
  const mainRepoPath = repo ? expandHomePath(repo) : "";
  const spaceWorktreePath = path.join(
    resolvedRoot,
    ".workspaces",
    project.id,
    "_space"
  );

  let implementationRepo = repo;
  if (runMode && (runMode === "clone" || runMode === "worktree") && slug) {
    implementationRepo = path.join(
      resolvedRoot,
      ".workspaces",
      project.id,
      slug
    );
  }
  const basePath = (project.absolutePath || project.path).replace(/\/$/, "");
  const absReadmePath = basePath.endsWith("README.md")
    ? basePath
    : `${basePath}/README.md`;
  const absSpecsPath = basePath.endsWith("SPECS.md")
    ? basePath
    : `${basePath}/SPECS.md`;
  const relBasePath = project.path.replace(/\/$/, "");
  const relReadmePath = relBasePath.endsWith("README.md")
    ? relBasePath
    : `${relBasePath}/README.md`;
  const relSpecsPath = relBasePath.endsWith("SPECS.md")
    ? relBasePath
    : `${relBasePath}/SPECS.md`;
  const readmePath =
    runAgentSelection.type === "native" ? absReadmePath : relReadmePath;
  const specsPathForRole =
    runAgentSelection.type === "native" ? absSpecsPath : relSpecsPath;
  const threadPath = path.join(basePath, "THREAD.md");
  let threadContent = "";
  try {
    const parsedThread = await parseMarkdownFile(threadPath);
    threadContent = parsedThread.content.trim();
  } catch {
    // Missing thread is fine.
  }

  const docKeys = Object.keys(project.docs ?? {}).sort((a, b) => {
    if (a === "README") return -1;
    if (b === "README") return 1;
    return a.localeCompare(b);
  });
  let fullContent = project.docs?.README ?? "";
  if (threadContent) {
    fullContent += `\n\n## THREAD\n\n${threadContent}`;
  }
  for (const key of docKeys) {
    if (key === "README") continue;
    const docContent = project.docs?.[key];
    if (docContent) {
      fullContent += `\n\n## ${key}\n\n${docContent}`;
    }
  }

  const promptRole: PromptRole = startInput.promptRole ?? "legacy";
  const specsPath = promptRole === "legacy" ? readmePath : specsPathForRole;
  const coordinatorWorkspaceContext =
    promptRole === "coordinator"
      ? [
          mainRepoPath
            ? [
                "## Main Repository",
                `Path: ${mainRepoPath}`,
                "(Use this canonical repo for planning and delegation.)",
              ].join("\n")
            : "",
          [
            "## Project Space Worktree",
            `Path: ${spaceWorktreePath}`,
            "(Integration workspace where main-run aggregates worker changes.)",
          ].join("\n"),
        ]
          .filter((part) => part.length > 0)
          .join("\n\n")
      : "";
  const mergedCustomPrompt = [
    coordinatorWorkspaceContext,
    typeof startInput.customPrompt === "string" ? startInput.customPrompt : "",
  ]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join("\n\n");
  let reviewerWorkspaces:
    | Array<{ name: string; cli?: string; path: string }>
    | undefined;
  if (promptRole === "reviewer") {
    const subagentsResult = await listSubagents(config, project.id);
    if (subagentsResult.ok) {
      reviewerWorkspaces = subagentsResult.data.items
        .filter(
          (item) =>
            item.archived !== true &&
            (item.runMode === "clone" || item.runMode === "worktree")
        )
        .map((item) => {
          const workspacePath = hasText(item.worktreePath)
            ? item.worktreePath.trim()
            : path.join(resolvedRoot, ".workspaces", project.id, item.slug);
          return {
            name: item.name?.trim() || item.slug,
            cli: item.cli,
            path: workspacePath,
          };
        });
    }
  }
  const prompt = buildRolePrompt({
    role: promptRole,
    title: project.title,
    status,
    path: basePath,
    content: fullContent,
    specsPath,
    projectFiles: ["README.md", "THREAD.md", ...docKeys.map((key) => `${key}.md`)],
    projectId: project.id,
    repo: promptRole === "coordinator" ? mainRepoPath : implementationRepo,
    customPrompt: mergedCustomPrompt || undefined,
    runAgentLabel,
    workerWorkspaces: reviewerWorkspaces,
    subagentTypes: getProjectsContext().getSubagentTemplates(),
    includeDefaultPrompt: startInput.includeDefaultPrompt,
    includeRoleInstructions: startInput.includeRoleInstructions,
    includePostRun: startInput.includePostRun,
  });

  const updates: Partial<UpdateProjectRequest> = {};
  const hasLegacyRunConfig =
    typeof frontmatter.runAgent === "string" ||
    typeof frontmatter.runMode === "string" ||
    typeof frontmatter.baseBranch === "string";

  if (runAgentSelection.type === "native") {
    const agent = getProjectsContext().getAgent(runAgentSelection.id);
    if (!agent || !getProjectsContext().isAgentActive(runAgentSelection.id)) {
      return { ok: false, error: "Agent not found", status: 404 };
    }
    const sessionKeys =
      typeof frontmatter.sessionKeys === "object" && frontmatter.sessionKeys !== null
        ? (frontmatter.sessionKeys as Record<string, string>)
        : {};
    const sessionKey = sessionKeys[agent.id] ?? `project:${project.id}:${agent.id}`;
    if (!sessionKeys[agent.id]) {
      updates.sessionKeys = { ...sessionKeys, [agent.id]: sessionKey };
    }
    if (normalizedStatus === "triage" || normalizedStatus === "shaping") {
      updates.status = "active";
    }

    getProjectsContext()
      .runAgent({ agentId: agent.id, message: prompt, sessionKey })
      .catch((err) => {
        console.error(`[projects:${project.id}] start run failed:`, err);
      });

    if (Object.keys(updates).length > 0 || hasLegacyRunConfig) {
      await updateProject(config, project.id, updates);
    }

    return { ok: true, data: { ok: true, type: "native", sessionKey } };
  }

  if (!isSupportedSubagentCli(runAgentSelection.id)) {
    return {
      ok: false,
      error: getUnsupportedSubagentCliError(runAgentSelection.id),
      status: 400,
    };
  }
  const runCli = runAgentSelection.id;
  const resolvedCliOptions = resolveCliProfileOptions(
    runCli,
    requestedModel,
    requestedReasoningEffort,
    requestedThinking
  );
  if (!resolvedCliOptions.ok) {
    return { ok: false, error: resolvedCliOptions.error, status: 400 };
  }

  const runModeValue = runMode ?? "main-run";
  const slugValue = slug ?? "main";
  if (!slug) {
    return { ok: false, error: "Slug required", status: 400 };
  }
  const baseBranchValue = baseBranch ?? "main";
  const namePrefix = hasText(startInput.name) ? startInput.name.trim() : undefined;
  const resolvedName = resolveRunName(namePrefix, slugValue, userExplicitName);

  const result = await spawnSubagent(config, {
    projectId: project.id,
    slug: slugValue,
    cli: runCli,
    name: resolvedName,
    prompt,
    model: resolvedCliOptions.data.model,
    reasoningEffort: resolvedCliOptions.data.reasoningEffort,
    thinking: resolvedCliOptions.data.thinking,
    mode: runModeValue,
    baseBranch: baseBranchValue,
  });
  if (!result.ok) {
    return { ok: false, error: result.error, status: 400 };
  }

  if (normalizedStatus === "triage" || normalizedStatus === "shaping") {
    updates.status = "active";
  }
  if (Object.keys(updates).length > 0 || hasLegacyRunConfig) {
    await updateProject(config, project.id, updates);
  }

  return { ok: true, data: { ok: true, type: "cli", slug, runMode } };
}
