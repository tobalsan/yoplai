import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import { expandHomePlaceholder, readEnv } from "@yoplai/shared";
import type { PlaneAuthKind, TrackerConfig, TrackerIssue, TrackerStatesConfig, WorkflowConfig, WorkflowFrontmatter, WorkflowSnapshot } from "../types.js";
import { planeAuthEnvRef, resolvePlaneEnvAuth } from "../plane/auth.js";
import { validateWorkflowThinkingForRunner } from "../worker-runner/thinking.js";

const DEFAULT_ENDPOINT = "https://api.linear.app/graphql";
const DEFAULT_PLANE_BASE_URL = "https://api.plane.so";
const DEFAULT_ACTIVE = ["Todo", "In Progress"];
const DEFAULT_TERMINAL = ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"];

function parse(content: string): { frontmatter: WorkflowFrontmatter; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };
  const parsed = yaml.load(match[1] ?? "") ?? {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("WORKFLOW.md frontmatter must be an object");
  return { frontmatter: parsed as WorkflowFrontmatter, body: match[2] ?? "" };
}

function expandEnv(value: string | undefined, fallback?: string): string {
  const raw = value ?? fallback;
  if (!raw) return "";
  if (raw.startsWith("$") && /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(raw)) return process.env[raw.slice(1)] ?? "";
  return raw;
}

function resolvePath(value: string | undefined, projectPath: string): string {
  const raw = value?.trim() || "./workspaces";
  const homeExpanded = expandHomePlaceholder(raw, readEnv("HOME") ?? projectPath);
  const expanded = homeExpanded !== raw
    ? homeExpanded
    : raw.startsWith("~")
      ? path.join(process.env.HOME ?? "", raw.slice(1))
      : raw;
  return path.resolve(path.isAbsolute(expanded) ? expanded : path.join(projectPath, expanded));
}

function stringifyTemplateValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function render(template: string, ctx: { issue?: TrackerIssue; attempt?: number | null }): string {
  return template.replace(/{{\s*([^{}|\s]+)(?:\s*\|\s*([^{}]+))?\s*}}/g, (_all, expression: string, filter: string | undefined) => {
    if (filter) throw new Error(`Unknown workflow template filter: ${filter.trim()}`);
    if (expression === "attempt") return stringifyTemplateValue(ctx.attempt ?? null);
    const [group, key, extra] = expression.split(".");
    if (extra || group !== "issue" || !key) throw new Error(`Unknown workflow template variable: ${expression}`);
    if (!ctx.issue) throw new Error(`Workflow template variable requires issue context: ${expression}`);
    if (!(key in ctx.issue)) throw new Error(`Unknown workflow template variable: ${expression}`);
    return stringifyTemplateValue((ctx.issue as Record<string, unknown>)[key]);
  });
}

function normalizeCliCommand(command: string | string[] | undefined): string | string[] | undefined {
  if (typeof command === "string") return command.trim() || undefined;
  if (Array.isArray(command)) {
    const executable = command[0];
    return typeof executable === "string" && executable.trim() ? [executable.trim(), ...command.slice(1)] : undefined;
  }
  return undefined;
}

function buildConfig(frontmatter: WorkflowFrontmatter, projectPath: string): WorkflowConfig {
  const tracker = frontmatter.tracker ?? {};
  const legacyStates = tracker.states ?? {};
  const kind = tracker.kind ?? "linear";
  if (kind !== "linear" && kind !== "plane") throw new Error(`Unsupported tracker.kind: ${kind} (supported: linear, plane)`);
  const states: TrackerStatesConfig = {
    activeStates: tracker.active_states ?? legacyStates.active ?? DEFAULT_ACTIVE,
    terminalStates: tracker.terminal_states ?? legacyStates.terminal ?? DEFAULT_TERMINAL,
    needsHuman: tracker.needs_human ?? legacyStates.needs_human ?? "Needs Human",
    inProgressTarget: legacyStates.in_progress_target,
  };
  let trackerConfig: TrackerConfig;
  if (kind === "linear") {
    const apiKey = expandEnv(tracker.api_key, "$LINEAR_API_KEY");
    if (!apiKey) throw new Error("tracker.api_key is required");
    if (!tracker.project_slug) throw new Error("tracker.project_slug is required");
    trackerConfig = {
      kind,
      endpoint: expandEnv(tracker.endpoint, DEFAULT_ENDPOINT) || DEFAULT_ENDPOINT,
      apiKey,
      projectSlug: tracker.project_slug,
      ...states,
    };
  } else {
    const explicitAuthKind = tracker.auth_kind;
    if (explicitAuthKind && explicitAuthKind !== "api_key" && explicitAuthKind !== "oauth_token" && explicitAuthKind !== "bot_token") throw new Error(`Unsupported tracker.auth_kind: ${explicitAuthKind} (supported: api_key, oauth_token, bot_token)`);
    const envAuth = tracker.api_key ? undefined : resolvePlaneEnvAuth();
    const apiKey = tracker.api_key ? expandEnv(tracker.api_key, "$PLANE_API_KEY") : envAuth?.token;
    const inferredAuthKind: PlaneAuthKind = tracker.api_key === "$PLANE_BOT_TOKEN" ? "bot_token" : tracker.api_key === "$PLANE_OAUTH_TOKEN" ? "oauth_token" : envAuth?.kind ?? "api_key";
    if (explicitAuthKind && !tracker.api_key && envAuth && explicitAuthKind !== envAuth.kind) {
      throw new Error(`tracker.auth_kind is "${explicitAuthKind}" but the resolved token came from ${planeAuthEnvRef(envAuth.kind)}. Set tracker.auth_kind: ${envAuth.kind}, or set tracker.api_key explicitly.`);
    }
    const authKind: PlaneAuthKind = explicitAuthKind ?? inferredAuthKind;
    if (!apiKey) throw new Error("tracker.api_key is required (set PLANE_BOT_TOKEN, PLANE_OAUTH_TOKEN, or PLANE_API_KEY)");
    if (!tracker.workspace_slug) throw new Error("tracker.workspace_slug is required for tracker.kind: plane");
    if (!tracker.project_id) throw new Error("tracker.project_id is required for tracker.kind: plane");
    const baseUrl = (expandEnv(tracker.base_url ?? tracker.endpoint, DEFAULT_PLANE_BASE_URL) || DEFAULT_PLANE_BASE_URL).replace(/\/+$/, "");
    trackerConfig = {
      kind,
      baseUrl,
      apiKey,
      authKind,
      workspaceSlug: tracker.workspace_slug,
      projectId: tracker.project_id,
      ...(tracker.module_id ? { moduleId: tracker.module_id } : {}),
      ...(tracker.mention ? { mention: tracker.mention } : {}),
      ...states,
    };
  }
  const agent = frontmatter.agent ?? {};
  const runner = agent.runner ?? agent.kind;
  if (runner && runner !== "fake" && runner !== "cli" && runner !== "codex" && runner !== "pi" && runner !== "claude") throw new Error(`Unsupported agent.runner: ${runner}`);
  const cliCommand = normalizeCliCommand(agent.command);
  if (runner === "cli" && !cliCommand) throw new Error(`agent.command must provide an executable when agent.runner is ${runner}`);
  if (runner) validateWorkflowThinkingForRunner(runner, agent);
  for (const [key, value] of Object.entries({
    "agent.max_turns": agent.max_turns,
    "agent.turn_timeout_ms": agent.turn_timeout_ms,
    "agent.stall_timeout_ms": agent.stall_timeout_ms,
    "agent.max_concurrent": agent.max_concurrent,
    "agent.max_active_runs": agent.max_active_runs,
  })) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) throw new Error(`${key} must be a positive number`);
  }
  return {
    tracker: trackerConfig,
    workspace: {
      root: resolvePath(frontmatter.workspace?.root, projectPath),
      cleanupOnTerminal: frontmatter.workspace?.cleanup_on_terminal ?? false,
      reuse: frontmatter.workspace?.reuse ?? true,
    },
    polling: {
      intervalMs: frontmatter.polling?.interval_ms ?? 30_000,
      jitterMs: frontmatter.polling?.jitter_ms ?? 5_000,
    },
    agent: { ...agent, ...(runner ? { runner } : {}), command: runner === "cli" || runner === "codex" || runner === "pi" || runner === "claude" || !runner ? cliCommand : agent.command },
    hooks: frontmatter.hooks ?? {},
    server: frontmatter.server,
    linear: frontmatter.linear,
  };
}

export class WorkflowLoader {
  private readonly cache = new Map<string, WorkflowSnapshot>();

  constructor(private readonly home: string) {}

  async loadProjectWorkflow(input: { projectPath: string; issue?: TrackerIssue; attempt?: number | null; allowStale?: boolean }): Promise<WorkflowSnapshot> {
    const workflowPath = path.join(input.projectPath, "WORKFLOW.md");
    try {
      const parsed = parse(await fs.readFile(workflowPath, "utf8"));
      const body = input.issue ? render(parsed.body, { issue: input.issue, attempt: input.attempt }) : parsed.body;
      const config = buildConfig(parsed.frontmatter, input.projectPath);
      const sha = crypto.createHash("sha256").update(JSON.stringify(parsed.frontmatter)).update(body).digest("hex");
      const snapshot = { path: workflowPath, projectPath: input.projectPath, sha, frontmatter: parsed.frontmatter, config, body };
      if (!input.issue) this.cache.set(input.projectPath, snapshot);
      return snapshot;
    } catch (error) {
      const cached = this.cache.get(input.projectPath);
      if (!input.allowStale || !cached) throw error;
      return { ...cached, body: input.issue ? render(cached.body, { issue: input.issue, attempt: input.attempt }) : cached.body };
    }
  }

  async resolve(input: { projectPath?: string; issue?: TrackerIssue; attempt?: number | null; allowStale?: boolean } = {}): Promise<WorkflowSnapshot> {
    if (!input.projectPath) throw new Error("projectPath required");
    return this.loadProjectWorkflow({ projectPath: input.projectPath, issue: input.issue, attempt: input.attempt, allowStale: input.allowStale });
  }

  watch(projectPath: string, onChange: (event: { path: string; ok: boolean; error?: string }) => void): { close: () => void } {
    const file = path.join(projectPath, "WORKFLOW.md");
    const handle = () => {
      void this.loadProjectWorkflow({ projectPath })
        .then(() => onChange({ path: file, ok: true }))
        .catch((error) => onChange({ path: file, ok: false, error: error instanceof Error ? error.message : String(error) }));
    };
    try {
      const watcher = fsSync.watch(file, { persistent: false }, handle);
      return { close: () => watcher.close() };
    } catch {
      const watcher = fsSync.watch(projectPath, { persistent: false }, (_event, name) => {
        if (name?.toString() === "WORKFLOW.md") handle();
      });
      return { close: () => watcher.close() };
    }
  }
}
