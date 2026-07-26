import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { expandPath, getDefaultConfigPath } from "@yoplai/shared";
import { OrchestratorApiClient } from "./client.js";
import { LinearClient } from "../linear/client.js";
import { planeAuthEnvRef, planeAuthHeaders, resolvePlaneEnvAuth } from "../plane/auth.js";

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function renderStatus(value: any): string {
  return [
    `Status: ${value.status ?? "unknown"}`,
    `Active claims: ${value.activeClaims ?? 0}`,
    `Last tick: ${value.lastTickAt ?? "never"}`,
    `Rate limit remaining: ${value.rateLimitRemaining ?? "unknown"}`,
  ].join("\n");
}

function renderRuns(value: any): string {
  const active = Array.isArray(value.active) ? value.active : [];
  const recent = Array.isArray(value.recent) ? value.recent : [];
  const lines = ["Active runs:"];
  if (active.length === 0) lines.push("  none");
  for (const item of active) lines.push(`  ${item.issueId ?? "?"} ${item.runId ?? ""}`.trimEnd());
  lines.push("Recent runs:");
  if (recent.length === 0) lines.push("  none");
  for (const item of recent) lines.push(`  ${item.issue_id ?? item.issueId ?? "?"} ${item.run_id ?? item.runId ?? ""} ${item.outcome ?? ""}`.trimEnd());
  return lines.join("\n");
}

type WorkflowTemplateInput = {
  tracker?: "linear" | "plane";
  projectSlug?: string;
  workspaceSlug?: string;
  projectId?: string;
  moduleId?: string;
  baseUrl?: string;
  authKind?: "api_key" | "oauth_token" | "bot_token";
  profile?: string;
};

function linearTrackerBlock(input: WorkflowTemplateInput): string {
  return `tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: ${input.projectSlug ?? "REPLACE_ME"}
  active_states: [Todo, In Progress]
  terminal_states: [Closed, Cancelled, Canceled, Duplicate, Done]
  needs_human: Needs Human`;
}

function planeTrackerBlock(input: WorkflowTemplateInput): string {
  const lines = ["tracker:", "  kind: plane"];
  if (input.baseUrl) lines.push(`  base_url: ${input.baseUrl}`);
  lines.push(`  workspace_slug: ${input.workspaceSlug ?? "REPLACE_ME"}`);
  lines.push(`  project_id: ${input.projectId ?? "REPLACE_ME"}`);
  if (input.moduleId) lines.push(`  module_id: ${input.moduleId}`);
  const authKind = input.authKind ?? "api_key";
  lines.push(`  api_key: ${planeAuthEnvRef(authKind)}`, `  auth_kind: ${authKind}`, "  active_states: [Todo, In Progress]", "  terminal_states: [Closed, Cancelled, Canceled, Duplicate, Done]", "  needs_human: Needs Human");
  return lines.join("\n");
}

function workflowTemplate(input: WorkflowTemplateInput): string {
  const profileLine = input.profile ? `  profile: ${input.profile}\n` : "";
  const noun = input.tracker === "plane" ? "Plane" : "Linear";
  const trackerBlock = input.tracker === "plane" ? planeTrackerBlock(input) : linearTrackerBlock(input);
  return `---
${trackerBlock}
polling:
  interval_ms: 30000
  jitter_ms: 5000
workspace:
  root: ./workspaces
  cleanup_on_terminal: false
agent:
  runner: pi
${profileLine}  model: null
  max_concurrent: 3
---
You are working on ${noun} issue {{issue.identifier}}.

## DO THIS FIRST

1. Fetch ${noun} issue {{issue.identifier}}.
2. If current state is \`Todo\`, move it to \`In Progress\`.
3. Add or update one ${noun} comment signaling you are working on the issue.
4. Continue only after those ${noun} updates succeed.

Do not perform task work before this claim step.

## Workspace Rule

Work only inside the issue workspace. If repositories are needed, clone or use them inside this workspace unless hooks prepared them already.

## ${noun} Workflow

Update ${noun} with concise progress, validation results, and final handoff. Prefer updating your initial ${noun} comment while no other comments follow it. If another person or agent has commented after your initial comment, post a new comment instead so the timeline stays clear.

When the work is complete and validated, move the issue to \`In Review\`. If you are blocked, move the issue to \`Needs Human\` and update the comment with the blocker, what you tried, and the decision needed.

## Code Changes and Review Flow

If, and only if, you need to make code changes:

1. Create a worktree from the \`main\` branch and work there.
2. Spawn a reviewer subagent to run a code review.
3. Do not commit anything until the review comes back clean.
4. Once review is clean, commit inside the worktree, create a PR using \`gh\`, link the PR to the ${noun} issue, and move the issue to \`In Review\`.

## Golden Rule: Clarification Over Assumption

Ask rather than assume when requirements, ownership, or risk are unclear. Involve HITL by updating the ${noun} comment with the question or blocker and moving the issue to \`Needs Human\`.
`;
}

async function initWorkflow(projectPath: string, opts: WorkflowTemplateInput & { force?: boolean } = {}): Promise<string> {
  const workflowPath = path.join(path.resolve(projectPath), "WORKFLOW.md");
  await fs.mkdir(path.dirname(workflowPath), { recursive: true });
  if (!opts.force) {
    await fs.access(workflowPath).then(() => { throw new Error(`WORKFLOW.md already exists: ${workflowPath}`); }).catch((error) => {
      if (error instanceof Error && error.message.startsWith("WORKFLOW.md already exists")) throw error;
    });
  }
  await fs.writeFile(workflowPath, workflowTemplate(opts), "utf8");
  return workflowPath;
}

function safeProjectName(name: string): string {
  const safe = name
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!safe) throw new Error("Project name must contain at least one letter or number");
  return safe;
}

async function pathExists(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(() => true).catch(() => false);
}

type ConfigFile = {
  extensions?: {
    orchestrator?: {
      projectsRoot?: string;
      projects?: string[];
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

type LinearProjectBootstrapClient = Pick<LinearClient, "createProject" | "deleteProject" | "findProjectByName" | "inferProjectTeamIds">;

export type TrackerBootstrap = {
  findExisting(name: string): Promise<{ id: string; label: string } | undefined>;
  provision(name: string): Promise<{ id: string; label: string; workflowTracker: Record<string, unknown> }>;
  rollback(id: string): Promise<void>;
};

function linearBootstrap(client: LinearProjectBootstrapClient): TrackerBootstrap {
  return {
    async findExisting(name) {
      const duplicate = await client.findProjectByName(name);
      return duplicate ? { id: duplicate.id, label: `${duplicate.name} (${duplicate.slugId})` } : undefined;
    },
    async provision(name) {
      const teamIds = await client.inferProjectTeamIds();
      const project = await client.createProject({ name, teamIds });
      return { id: project.id, label: `Linear project ${project.name} (${project.slugId})`, workflowTracker: { kind: "linear", project_slug: project.slugId } };
    },
    rollback: (id) => client.deleteProject(id),
  };
}

type PlaneBootstrapEnv = { apiKey: string; authKind: "api_key" | "oauth_token" | "bot_token"; workspaceSlug: string; baseUrl: string; projectId?: string };

function planeEnv(): PlaneBootstrapEnv {
  const auth = resolvePlaneEnvAuth();
  if (!auth) throw new Error("Missing Plane auth for project creation (set PLANE_BOT_TOKEN, PLANE_OAUTH_TOKEN, or PLANE_API_KEY)");
  const workspaceSlug = process.env.PLANE_WORKSPACE_SLUG?.trim();
  if (!workspaceSlug) throw new Error("Missing PLANE_WORKSPACE_SLUG for Plane project creation");
  const baseUrl = (process.env.PLANE_BASE_URL?.trim() || "https://api.plane.so").replace(/\/+$/, "");
  return { apiKey: auth.token, authKind: auth.kind, workspaceSlug, baseUrl, projectId: process.env.PLANE_PROJECT_ID?.trim() || undefined };
}

async function planeRequest(env: PlaneBootstrapEnv, method: string, path: string, body?: unknown): Promise<any> {
  const response = await fetch(`${env.baseUrl}/api/v1/workspaces/${env.workspaceSlug}${path}`, {
    method,
    headers: { "content-type": "application/json", ...planeAuthHeaders({ kind: env.authKind, token: env.apiKey }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 204) return undefined;
  const text = await response.text();
  if (!response.ok) throw new Error(`Plane ${method} ${path} failed: ${response.status} ${text}`);
  return text ? JSON.parse(text) : undefined;
}

function planeIdentifier(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const raw = words.length > 1 ? words.map((word) => word[0]).join("") : name;
  const identifier = raw.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 12);
  if (!identifier) throw new Error(`Cannot derive a Plane project identifier from name: ${name}`);
  return identifier;
}

function planeBootstrap(env: PlaneBootstrapEnv): TrackerBootstrap {
  const moduleMode = Boolean(env.projectId);
  const baseTracker: Record<string, unknown> = { kind: "plane", workspace_slug: env.workspaceSlug };
  if (env.baseUrl !== "https://api.plane.so") baseTracker.base_url = env.baseUrl;
  baseTracker.api_key = planeAuthEnvRef(env.authKind);
  baseTracker.auth_kind = env.authKind;
  return {
    async findExisting(name) {
      const listPath = moduleMode ? `/projects/${env.projectId}/modules/` : `/projects/`;
      const page = await planeRequest(env, "GET", `${listPath}?per_page=100`);
      const rows: any[] = page?.results ?? [];
      const duplicate = rows.find((row) => row.name === name);
      if (!duplicate) return undefined;
      return { id: duplicate.id, label: moduleMode ? `${duplicate.name} (module)` : `${duplicate.name} (${duplicate.identifier})` };
    },
    async provision(name) {
      if (moduleMode) {
        const created = await planeRequest(env, "POST", `/projects/${env.projectId}/modules/`, { name });
        return { id: created.id, label: `Plane module ${created.name}`, workflowTracker: { ...baseTracker, project_id: env.projectId, module_id: created.id } };
      }
      const created = await planeRequest(env, "POST", `/projects/`, { name, identifier: planeIdentifier(name) });
      return { id: created.id, label: `Plane project ${created.name} (${created.identifier})`, workflowTracker: { ...baseTracker, project_id: created.id } };
    },
    async rollback(id) {
      await planeRequest(env, "DELETE", moduleMode ? `/projects/${env.projectId}/modules/${id}/` : `/projects/${id}/`);
    },
  };
}

async function createBootstrap(tracker: string, opts: { linearClient?: LinearProjectBootstrapClient }): Promise<TrackerBootstrap> {
  if (tracker === "plane") return planeBootstrap(planeEnv());
  if (tracker !== "linear") throw new Error(`Unsupported --tracker: ${tracker} (supported: linear, plane)`);
  const apiKey = process.env.LINEAR_API_KEY?.trim();
  if (!apiKey && !opts.linearClient) throw new Error("Missing LINEAR_API_KEY for Linear project creation");
  return linearBootstrap(opts.linearClient ?? new LinearClient(apiKey!));
}

async function readConfigFile(configPath = getDefaultConfigPath()): Promise<{ path: string; config: ConfigFile }> {
  try {
    return { path: configPath, config: JSON.parse(await fs.readFile(configPath, "utf8")) as ConfigFile };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: configPath, config: {} };
    throw error;
  }
}

function resolveProjectsRoot(config: ConfigFile): string {
  const root = config.extensions?.orchestrator?.projectsRoot?.trim() || "~/projects";
  return expandPath(root);
}

function projectRegistrationList(config: ConfigFile): { orchestrator: NonNullable<NonNullable<ConfigFile["extensions"]>["orchestrator"]>; projects: string[] } {
  config.extensions ??= {};
  config.extensions.orchestrator ??= {};
  const orchestrator = config.extensions.orchestrator;
  const projects = orchestrator.projects ?? [];
  if (!Array.isArray(projects)) throw new Error("extensions.orchestrator.projects must be an array before init-project can register a project");
  return { orchestrator, projects };
}

async function registerProject(configPath: string, config: ConfigFile, projectPath: string): Promise<void> {
  const { orchestrator, projects } = projectRegistrationList(config);
  if (!projects.includes(projectPath)) projects.push(projectPath);
  orchestrator.projects = projects;
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function initProject(
  title: string,
  opts: { profile?: string; tracker?: string; linearClient?: LinearProjectBootstrapClient; bootstrap?: TrackerBootstrap; configPath?: string } = {}
): Promise<{ projectPath: string; workflowPath: string; project: { id: string; label: string }; configPath: string }> {
  const projectName = title.trim();
  const tracker = (opts.tracker ?? "linear").trim();
  const trackerNoun = tracker === "plane" ? "Plane" : "Linear";
  const { path: configPath, config } = await readConfigFile(opts.configPath);
  const projectsRoot = resolveProjectsRoot(config);
  const projectPath = path.join(projectsRoot, safeProjectName(projectName));
  projectRegistrationList(config);
  if (await pathExists(projectPath)) throw new Error(`Project folder already exists: ${projectPath}`);
  await fs.mkdir(projectsRoot, { recursive: true });

  const bootstrap = opts.bootstrap ?? (await createBootstrap(tracker, opts));

  const duplicate = await bootstrap.findExisting(projectName);
  if (duplicate) throw new Error(`${trackerNoun} project already exists: ${duplicate.label}`);

  await fs.mkdir(projectPath, { recursive: false });
  let provisioned: { id: string; label: string; workflowTracker: Record<string, unknown> } | undefined;
  try {
    provisioned = await bootstrap.provision(projectName);
    const wt = provisioned.workflowTracker;
    const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
    const workflowPath = await initWorkflow(projectPath, {
      tracker: wt.kind === "plane" ? "plane" : "linear",
      projectSlug: str(wt.project_slug),
      workspaceSlug: str(wt.workspace_slug),
      projectId: str(wt.project_id),
      moduleId: str(wt.module_id),
      baseUrl: str(wt.base_url),
      authKind: wt.auth_kind === "bot_token" || wt.auth_kind === "oauth_token" ? wt.auth_kind : "api_key",
      profile: opts.profile,
    });
    await registerProject(configPath, config, projectPath);
    return { projectPath, workflowPath, project: { id: provisioned.id, label: provisioned.label }, configPath };
  } catch (error) {
    const rollbackErrors: string[] = [];
    if (provisioned) {
      await bootstrap.rollback(provisioned.id).catch((rollbackError) => {
        rollbackErrors.push(`${trackerNoun} rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      });
    }
    await fs.rm(projectPath, { recursive: true, force: true }).catch((rollbackError) => {
      rollbackErrors.push(`local rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
    });
    if (rollbackErrors.length > 0) throw new Error(`${error instanceof Error ? error.message : String(error)} (${rollbackErrors.join("; ")})`);
    throw error;
  }
}

async function pipeResponse(response: Response): Promise<void> {
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(body || `Request failed: ${response.status}`);
  }
  if (!response.body) {
    process.stdout.write(await response.text());
    return;
  }
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    process.stdout.write(Buffer.from(value));
  }
}

export function registerOrchestratorCommands(command: Command, client?: OrchestratorApiClient): void {
  const api = () => client ?? new OrchestratorApiClient();
  command
    .command("status")
    .description("Show orchestrator daemon status")
    .action(async () => console.log(renderStatus(await api().health())));

  command
    .command("projects")
    .description("List orchestrator projects")
    .action(async () => printJson(await api().projects()));

  command
    .command("init-workflow")
    .description("Create a project WORKFLOW.md template")
    .requiredOption("--project <path>", "project folder")
    .option("--project-slug <slug>", "Linear project slugId")
    .option("--profile <name>", "optional orchestrator profile")
    .option("--force", "overwrite existing WORKFLOW.md")
    .action(async (opts) => console.log(`Created ${await initWorkflow(opts.project, { projectSlug: opts.projectSlug, profile: opts.profile, force: opts.force })}`));

  command
    .command("init-project <name>")
    .description("Create a tracker project, local project folder, and WORKFLOW.md")
    .option("--profile <name>", "optional orchestrator profile")
    .option("--tracker <kind>", "tracker kind (linear or plane)", "linear")
    .action(async (name, opts) => {
      const result = await initProject(name, { profile: opts.profile, tracker: opts.tracker });
      console.log([
        `Created ${result.project.label}`,
        `Created ${result.projectPath}`,
        `Created ${result.workflowPath}`,
        `Updated ${result.configPath}`,
        "Restart the gateway for the project registration to take effect.",
      ].join(os.EOL));
    });

  command
    .command("runs")
    .description("List orchestrator runs")
    .option("--project <id>", "filter by project id")
    .option("--issue <id>", "filter by issue id")
    .option("--limit <n>", "limit recent rows", (value) => Number(value))
    .option("--json", "print raw JSON")
    .action(async (opts) => {
      const data = await api().runs(opts.limit, opts.issue, opts.project);
      if (opts.json) {
        printJson(data);
      } else {
        console.log(renderRuns(data));
      }
    });

  command
    .command("events <runId>")
    .description("Show run events")
    .option("--project <id>", "filter by project id")
    .action(async (runId, opts) => printJson(await api().events(runId, opts.project)));

  command
    .command("workflow")
    .description("Print resolved workflow")
    .option("--project <id>", "project id")
    .action(async (opts) => printJson(await api().workflow(opts.project)));

  for (const verb of ["claim", "release", "interrupt", "kill"] as const) {
    command
      .command(`${verb} <issueId>`)
      .description(`${verb} issue/run`)
      .option("--project <id>", "project id")
      .action(async (issueId, opts) => printJson(await api()[verb](issueId, opts.project)));
  }

  command
    .command("logs <id>")
    .description("Stream run logs")
    .option("--project <id>", "project id")
    .option("--since <n>", "start offset", (value) => Number(value))
    .option("--follow", "follow logs")
    .action(async (id, opts) => pipeResponse(await api().logs(id, opts.since, opts.follow, opts.project)));

  command
    .command("export")
    .description("Export Linear issues to markdown")
    .option("--project <id>", "project id")
    .option("--out <dir>", "output directory")
    .action(async (opts) => printJson(await api().export(opts.project, opts.out)));

  command
    .command("tick")
    .description("Force one orchestrator poll tick")
    .option("--project <id>", "project id")
    .action(async (opts) => printJson(await api().tick(opts.project)));
}

export { OrchestratorApiClient } from "./client.js";
export { initProject, initWorkflow, safeProjectName, workflowTemplate, planeBootstrap, planeEnv, planeIdentifier };
export type { PlaneBootstrapEnv };
