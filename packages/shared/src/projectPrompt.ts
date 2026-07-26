export function normalizeProjectStatus(raw?: string): string {
  const normalized = raw?.trim().toLowerCase().replace(/\s+/g, "_") || "triage";
  if (normalized === "maybe" || normalized === "not_now") return "triage";
  if (["todo", "in_progress", "review"].includes(normalized)) return "active";
  return normalized;
}

export function buildProjectSummary(
  title: string,
  status: string,
  path: string,
  content: string
): string {
  return [
    "Let's tackle the following project:",
    "",
    title,
    status,
    "## Project Documentation",
    `Path: ${path}`,
    "(Read-only context: README, SPECS.md, docs. Do NOT implement code here.)",
    content,
  ]
    .join("\n")
    .trimEnd();
}

export function buildStartPrompt(summary: string): string {
  return summary;
}

export type PromptRole = "coordinator" | "worker" | "reviewer" | "legacy";

export type WorkerWorkspaceRef = {
  name: string;
  cli?: string;
  path: string;
};

export type RolePromptInput = {
  role: PromptRole;
  title: string;
  status: string;
  path: string;
  projectId?: string;
  repo?: string;
  customPrompt?: string;
  runAgentLabel?: string;
  specsPath?: string;
  content?: string;
  projectFiles?: readonly string[];
  workerWorkspaces?: WorkerWorkspaceRef[];
  subagentTypes?: Array<{
    name: string;
    description?: string;
    cli: string;
    model: string;
    reasoning: string;
    type: string;
    runMode: string;
  }>;
  includeDefaultPrompt?: boolean;
  includeRoleInstructions?: boolean;
  includePostRun?: boolean;
};

export function renderTemplate(
  template: string,
  vars: Record<string, string>
): string {
  let output = template;
  for (const [key, value] of Object.entries(vars)) {
    output = output.split(`{{${key}}}`).join(value);
  }
  return output;
}

export function buildProjectStartPrompt(input: {
  title: string;
  status: string;
  path: string;
  content: string;
  specsPath: string;
  repo?: string;
  customPrompt?: string;
  runAgentLabel?: string;
  includeDefaultPrompt?: boolean;
  includeRoleInstructions?: boolean;
  includePostRun?: boolean;
}): string {
  const normalized = normalizeProjectStatus(input.status);
  const custom = input.customPrompt?.trim();
  const includeDefault = input.includeDefaultPrompt !== false;
  const includeRole = input.includeRoleInstructions !== false;
  const includePostRun = input.includePostRun !== false;
  let prompt = "";
  if (normalized === "shaping") {
    prompt = custom || `/drill-specs ${input.specsPath}`;
  } else if (includeDefault) {
    prompt = buildStartPrompt(
      buildProjectSummary(input.title, input.status, input.path, input.content)
    );
  }
  if (normalized !== "shaping" && custom) {
    prompt = prompt ? `${prompt}\n\n${custom}` : custom;
  }
  const repo = input.repo?.trim();
  if (repo) {
    const repoBlock = `## Implementation Repository\nPath: ${repo}\n(This is your working directory. Implement all code changes here.)`;
    prompt = prompt ? `${prompt}\n\n${repoBlock}` : repoBlock;
  }
  if (includeRole) {
    const roleBlock = [
      "## Your Role",
      "Implement the requested project work end-to-end.",
      "- Keep changes aligned with task status and acceptance criteria in SPECS.md.",
      "- Preserve consistency across related project markdown docs when needed.",
    ].join("\n");
    prompt = prompt ? `${prompt}\n\n${roleBlock}` : roleBlock;
  }
  if (includePostRun) {
    const cliUsed = input.runAgentLabel?.trim() || "{cli_used}";
    const postRun = `## IMPORTANT: MUST DO AFTER IMPLEMENTATION\n\n- Run the test suite after changes\n- Run linter/formatter (if any)\n- Fix any failure/error before committing\n- Once everything is green, perform atomic commit(s)\n- Add a project comment using \`yoplai projects comment <project_id> --message "<your summary>" --author <your name>\`. Write a clear summary of what you did — use paragraphs, newlines, and bullet points as appropriate for readability (don't force everything into bullets). Use \\n for newlines in the message string.\n- Move the project to review status using \`yoplai projects move <project_id> review --agent ${cliUsed}\``;
    prompt = prompt ? `${prompt}\n\n${postRun}` : postRun;
  }
  return prompt.trim();
}

function normalizeDocFilename(name: string): string {
  return name.toLowerCase().endsWith(".md") ? name : `${name}.md`;
}

function sortProjectFiles(files: readonly string[]): string[] {
  return [...new Set(files)]
    .map((file) => file.trim())
    .filter((file) => file.length > 0)
    .sort((a, b) => {
      if (a.toUpperCase() === "README.MD") return -1;
      if (b.toUpperCase() === "README.MD") return 1;
      return a.localeCompare(b);
    });
}

function listProjectFileLinks(path: string, files: readonly string[]): string {
  const basePath = path.replace(/\/$/, "");
  const normalized = sortProjectFiles(files).map(normalizeDocFilename);
  return normalized
    .map((file) => `- [${file}](${basePath}/${file})`)
    .join("\n");
}

function buildProjectFilesBlock(input: {
  title: string;
  status: string;
  path: string;
  projectFiles: readonly string[];
  repo?: string;
  includeRepo?: boolean;
}): string {
  const lines = [
    "Let's tackle the following project:",
    "",
    `Project: ${input.title}`,
    `Status: ${input.status || "unknown"}`,
    "",
    "## Project Files",
    listProjectFileLinks(input.path, input.projectFiles),
  ];
  if (input.includeRepo && input.repo?.trim()) {
    lines.push(
      "",
      "## Implementation Repository",
      `Path: ${input.repo.trim()}`,
      "(Implement code changes here.)"
    );
  }
  lines.push(
    "",
    "Use project files as source context. Keep changes scoped to requested work."
  );
  return lines.join("\n").trimEnd();
}

function postRunCommitBlock(): string {
  return [
    "- Run relevant tests after changes.",
    "- Run linter/formatter (if any).",
    "- Fix failures before finishing.",
    "- Once checks pass, commit the implementation before reporting completion.",
  ].join("\n");
}

function postRunProjectCommentBlock(projectId: string): string {
  return `- Add a project comment: \`yoplai projects comment ${projectId} --message "<your summary>" --author <your name>\``;
}

function postRunUpdateCoordinatorDocsBlock(specsPath: string): string {
  return [
    `- Update task statuses primarily in ${specsPath}.`,
    "- Also update any other relevant project markdown files when context changes.",
  ].join("\n");
}

function postRunUpdateSpecsPrimaryBlock(specsPath: string): string {
  return [
    `- Update task statuses and acceptance criteria notes in ${specsPath}.`,
    `- Record blockers and follow-up items in ${specsPath}.`,
  ].join("\n");
}

function reviewerWorkspaceBlock(workspaces: WorkerWorkspaceRef[]): string {
  if (workspaces.length === 0) {
    return "## Active Worker Workspaces\nNo active worker workspaces found.";
  }
  const lines = workspaces.map(
    (item) => `- ${item.name} (${item.cli || "agent"}): ${item.path}`
  );
  return ["## Active Worker Workspaces", ...lines].join("\n");
}

function runProjectId(input: RolePromptInput): string {
  return input.projectId?.trim() || "<project_id>";
}

function joinPromptParts(parts: Array<string | undefined | null>): string {
  return parts
    .map((part) => (part || "").trim())
    .filter((part) => part.length > 0)
    .join("\n\n")
    .trimEnd();
}

function roleDefaultPrompt(
  input: RolePromptInput,
  includeRepo: boolean
): string {
  const files =
    input.projectFiles && input.projectFiles.length > 0
      ? input.projectFiles
      : ["README.md", "THREAD.md"];
  return buildProjectFilesBlock({
    title: input.title,
    status: input.status,
    path: input.path,
    projectFiles: files,
    repo: input.repo,
    includeRepo,
  });
}

export function buildCoordinatorPrompt(input: RolePromptInput): string {
  const includeDefault = input.includeDefaultPrompt !== false;
  const includeRole = input.includeRoleInstructions !== false;
  const includePostRun = input.includePostRun !== false;
  const projectId = runProjectId(input);
  const repo = input.repo?.trim();
  const repoBlock = repo
    ? [
        "## Canonical Repo Root",
        `Path: ${repo}`,
        "Treat this as the main repo root for context only.",
        "Every worker agent must run in its dedicated worktree or workspace, never directly in the main repo, unless explicitly required.",
      ].join("\n")
    : "";
  const postRun = includePostRun
    ? [
        "## IMPORTANT: MUST DO AFTER IMPLEMENTATION",
        postRunUpdateCoordinatorDocsBlock(
          input.specsPath || `${input.path}/SPECS.md`
        ),
        postRunProjectCommentBlock(projectId),
      ].join("\n")
    : "";
  const subagentTypesBlock =
    includeRole && input.subagentTypes && input.subagentTypes.length > 0
      ? [
          "## Available Subagent Types",
          "",
          "The following subagent types are configured and can be spawned via `yoplai projects start`:",
          "",
          ...input.subagentTypes.map(
            (s) =>
              `- **${s.name}** (${s.cli} / ${s.model}, reasoning: ${s.reasoning}, mode: ${s.runMode})${s.description ? `: ${s.description}` : ""}\n  → \`yoplai projects start ${projectId} --subagent ${s.name} --custom-prompt "..."\``
          ),
        ].join("\n")
      : "";
  return joinPromptParts([
    includeDefault ? roleDefaultPrompt(input, false) : "",
    repoBlock,
    includeRole
      ? [
          "## Your Role: Coordinator",
          "You manage this project's execution. You do NOT implement code yourself.",
          "You do NOT run code reviews yourself. Always dispatch a Reviewer agent for review work.",
          "- Review the spec and break it into discrete tasks if needed",
          "- Delegate implementation to worker agents",
          "- Delegate code review, verification, and test validation to reviewer agents",
          "- Track progress and keep project docs updated",
          "- Verify acceptance criteria before signaling completion",
          "- When delegating implementation, keep workers on dedicated worktrees/workspaces; do not send them to the main repo unless the task explicitly requires it.",
          "Use `yoplai projects start` with configured subagents for delegation:",
          "- Preflight first: `command -v yoplai && yoplai projects --version`",
          '- Worker: `yoplai projects start <project_id> --subagent Worker --slug worker-<task> --custom-prompt "Implement <task>; update SPECS.md status."`',
          '- Reviewer: `yoplai projects start <project_id> --subagent Reviewer --slug reviewer-<scope> --custom-prompt "Review worker workspaces; run tests; report pass/fail against acceptance criteria."`',
          '- Agent names use the subagent config name as prefix (e.g. "Worker Sage"). Use `--name "..."` to override.',
          "- Before dispatching, pick an exact subagent name from `## Available Subagent Types` below. If none are listed, inspect the Yoplai config first.",
          "- When using `--subagent`, do NOT add locked flags (`--agent`, `--model`, `--reasoning-effort`, `--thinking`, `--mode`, `--branch`, `--prompt-role`) unless also using `--allow-overrides`.",
          "- Do not merge/cherry-pick directly from coordinator/reviewer runs. Integration must go through Space queue and explicit Integrate Now.",
          "## Agent Management Rules",
          "- Monitor agents with `yoplai projects status <project-id> --slug <agent>`.",
          '- Resume agents with `yoplai projects resume <project-id> -m "..." --slug <agent>`.',
          "- Never use background tasks to monitor worker agents — background monitoring does not work. Always use a foreground sleep & poll loop using `yoplai projects status`, for example: `while true; do yoplai projects status <project-id> --slug <agent> --json; sleep 30; done`.",
          "- Never merge commits directly into `main`. Route all changes through the Space branch first.",
          '- Never act on a worker\'s changes until `yoplai projects status` shows the worker finished with status `"done"`.',
          "- Never implement fixes or run reviews yourself unless the user explicitly asks. Resume the original worker/reviewer for follow-up on an existing run; spawn a new Yoplai agent only for new work.",
          "- Never spawn direct native subagents outside Yoplai `yoplai projects` for implementation work. Direct subagents may be used only for exploration/research, and only after explicit user confirmation.",
          "- When a new worker depends on a previous worker's output, wait until the first worker's worktree has been integrated into the Space branch before dispatching the dependent worker.",
          "- As soon as you dispatch workers, move the project to `in_progress` status using `yoplai projects update <project-id> --status in_progress`.",
          "- As soon as implementation is complete and you are ready for review, move the project to `review` status using `yoplai projects update <project-id> --status review`.",
          "- If you manually integrate a worker commit into the Space branch outside the normal Space queue flow, update the project's `space.json` to mark those commits integrated.",
          "- When manually integrating, update each commit's status in `space.json` to `integrated` or `skipped` as appropriate.",
          "When writing SPECS.md, keep checklist sections parseable:",
          "- Use `## Tasks` and `## Acceptance Criteria` headings.",
          "- In `## Tasks`, each checkbox line should include a bold title and a status token (`status:todo`, `status:in_progress`, or `status:done`).",
          "- Optional `agent:<id>` token and indented task description lines are supported.",
          "- In `## Acceptance Criteria`, use checkbox lines (`- [ ] ...`).",
          "- Optional `###` subsections are supported in both sections.",
        ].join("\n")
      : "",
    subagentTypesBlock,
    postRun,
    input.customPrompt,
  ]);
}

export function buildWorkerPrompt(input: RolePromptInput): string {
  const includeDefault = input.includeDefaultPrompt !== false;
  const includeRole = input.includeRoleInstructions !== false;
  const includePostRun = input.includePostRun !== false;
  const projectId = runProjectId(input);
  const postRun = includePostRun
    ? [
        "## IMPORTANT: MUST DO AFTER IMPLEMENTATION",
        postRunCommitBlock(),
        postRunUpdateSpecsPrimaryBlock(
          input.specsPath || `${input.path}/SPECS.md`
        ),
        postRunProjectCommentBlock(projectId),
      ].join("\n")
    : "";
  return joinPromptParts([
    includeDefault ? roleDefaultPrompt(input, true) : "",
    includeRole
      ? [
          "## Your Role: Worker",
          "Implement the assigned tasks in the repository workspace.",
          "Commit your implementation once done and checks are green.",
        ].join("\n")
      : "",
    postRun,
    input.customPrompt,
  ]);
}

export function buildReviewerPrompt(input: RolePromptInput): string {
  const includeDefault = input.includeDefaultPrompt !== false;
  const includeRole = input.includeRoleInstructions !== false;
  const includePostRun = input.includePostRun !== false;
  const projectId = runProjectId(input);
  const postRun = includePostRun
    ? [
        "## IMPORTANT: MUST DO AFTER REVIEW",
        postRunUpdateSpecsPrimaryBlock(
          input.specsPath || `${input.path}/SPECS.md`
        ),
        postRunProjectCommentBlock(projectId),
      ].join("\n")
    : "";
  return joinPromptParts([
    includeDefault ? roleDefaultPrompt(input, false) : "",
    includeRole
      ? [
          "## Your Role: Reviewer",
          "Review implementation done by worker agents.",
          "- Read code changes directly from each worker workspace path listed below",
          "- Run tests and verify spec alignment",
          "- Report findings and remaining issues clearly",
        ].join("\n")
      : "",
    reviewerWorkspaceBlock(input.workerWorkspaces ?? []),
    postRun,
    input.customPrompt,
  ]);
}

export function buildLegacyPrompt(input: RolePromptInput): string {
  return buildProjectStartPrompt({
    title: input.title,
    status: input.status,
    path: input.path,
    content: input.content || "",
    specsPath: input.specsPath || `${input.path}/README.md`,
    repo: input.repo,
    customPrompt: input.customPrompt,
    runAgentLabel: input.runAgentLabel,
    includeDefaultPrompt: input.includeDefaultPrompt,
    includeRoleInstructions: input.includeRoleInstructions,
    includePostRun: input.includePostRun,
  });
}

export function buildRolePrompt(input: RolePromptInput): string {
  switch (input.role) {
    case "coordinator":
      return buildCoordinatorPrompt(input);
    case "worker":
      return buildWorkerPrompt(input);
    case "reviewer":
      return buildReviewerPrompt(input);
    case "legacy":
    default:
      return buildLegacyPrompt(input);
  }
}
