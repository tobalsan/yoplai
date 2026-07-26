import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { ClaimsRegistry, ClaudeRpcRunner, CliWorkerRunner, CodexAppServerRunner, ConcurrencyLimiter, createTrackerClient, LinearClient, OrchestratorDaemon, PiRpcRunner, RetryPolicy, WorkflowLoader, WorkflowWorkerRunner, isRelevantWebhook, orchestratorExtension, resolveProfile, resolveProjects, sanitizeIdentifier, StateStore, verifyWebhookSignature, WorkspaceLayout } from "./index.js";
import type { LinearTrackerConfig, PlaneTrackerConfig } from "./index.js";
import { runHook } from "./hooks/runner.js";
import { piThinkingForRunner, reasoningEffortForRunner, runnerForWorkflow, workflowAgentThinking } from "./worker-runner/thinking.js";
import type { WorkerRunnerHandle, WorkerRunnerStatus } from "./worker-runner/runner.js";
import { sanitizedWorkerEnv } from "./worker-runner/env.js";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const profiles = [{ name: "default", cli: "codex" as const }, { name: "claude", cli: "claude" as const }];

function mockWorkerRunner(handle: WorkerRunnerHandle = { id: "worker_1", kind: "fake" }, statuses: Array<WorkerRunnerStatus | undefined> = [undefined]) {
  const queue = [...statuses];
  const start = vi.fn(async (_input: unknown) => handle);
  const status = vi.fn(async () => queue.length > 0 ? queue.shift() : undefined);
  const abort = vi.fn(async () => undefined);
  return { runner: { start, status, abort }, start, status, abort };
}

async function writeWorkflow(root: string, extra = ""): Promise<void> {
  await fs.writeFile(
    path.join(root, "WORKFLOW.md"),
    `---
tracker:
  kind: linear
  api_key: test-key
  project_slug: proj-a
  active_states: [Ready]
  terminal_states: [Done]
agent:
  profile: default
  max_concurrent: 1
workspace:
  root: ./workspaces
${extra}---
Do {{issue.identifier}}
`
  );
}

async function writeCustomWorkflow(
  root: string,
  input: {
    apiKey?: string;
    endpoint?: string;
    projectSlug: string;
    intervalMs?: number;
  }
): Promise<void> {
  await fs.writeFile(
    path.join(root, "WORKFLOW.md"),
    `---
tracker:
  kind: linear
  api_key: ${input.apiKey ?? "test-key"}
  endpoint: ${input.endpoint ?? "https://api.linear.app/graphql"}
  project_slug: ${input.projectSlug}
  active_states: [Ready]
  terminal_states: [Done]
polling:
  interval_ms: ${input.intervalMs ?? 30000}
  jitter_ms: 0
agent:
  profile: default
  max_concurrent: 1
workspace:
  root: ./workspaces
---
Do {{issue.identifier}}
`
  );
}

async function writePlaneWorkflow(
  root: string,
  input: { workspaceSlug?: string; projectId?: string; activeStates?: string[]; terminalStates?: string[] } = {}
): Promise<void> {
  await fs.writeFile(
    path.join(root, "WORKFLOW.md"),
    `---
tracker:
  kind: plane
  api_key: plane-test-key
  workspace_slug: ${input.workspaceSlug ?? "ws-a"}
  project_id: ${input.projectId ?? "proj-plane"}
  active_states: [${(input.activeStates ?? ["Ready"]).join(", ")}]
  terminal_states: [${(input.terminalStates ?? ["Done"]).join(", ")}]
agent:
  profile: default
  runner: fake
  max_concurrent: 1
workspace:
  root: ./workspaces
---
Plane body {{issue.identifier}}
`
  );
}

async function expectWorkspacePreserved(
  root: string,
  identifier: string
): Promise<void> {
  await expect(
    fs.stat(path.join(root, "workspaces", sanitizeIdentifier(identifier)))
  ).resolves.toBeTruthy();
}

describe("orchestrator pure modules", () => {
  it("limits concurrency and issue exclusivity", () => {
    const limiter = new ConcurrencyLimiter(1);
    const first = limiter.tryReserve({ issueId: "A" });
    expect(first.ok).toBe(true);
    expect(limiter.tryReserve({ issueId: "A" })).toEqual({
      ok: false,
      reason: "issue-busy",
    });
    expect(limiter.tryReserve({ issueId: "B" })).toEqual({
      ok: false,
      reason: "cap",
    });
    if (first.ok) first.release();
    expect(limiter.tryReserve({ issueId: "B" }).ok).toBe(true);
  });

  it("sanitizes identifiers", () => {
    expect(sanitizeIdentifier("ENG-123? Bad!")).toBe("eng-123bad");
  });

  it("resolves profiles or parks", () => {
    expect(resolveProfile({ workflow: { agent: { profile: "default" } }, profilesConfig: profiles })).toMatchObject({ profile: { name: "default" } });
    expect(resolveProfile({ workflow: { agent: { runner: "pi", provider: "anthropic", model: "claude-sonnet-4-6" } }, profilesConfig: [] })).toMatchObject({ profile: { cli: "pi", provider: "anthropic", model: "claude-sonnet-4-6" } });
    expect(resolveProfile({ workflow: { agent: { provider: "anthropic", model: "claude-sonnet-4-6" } }, profilesConfig: [] })).toMatchObject({ profile: { name: "pi", cli: "pi", provider: "anthropic", model: "claude-sonnet-4-6" } });
    expect(resolveProfile({ workflow: { agent: { profile: "missing" } }, profilesConfig: profiles })).toHaveProperty("park");
  });

  it("maps workflow agent thinking to runner-specific effort fields", () => {
    const base = {
      tracker: { kind: "linear" as const, endpoint: "x", apiKey: "x", projectSlug: "proj-a", activeStates: ["Ready"], terminalStates: ["Done"], needsHuman: "Needs Human" },
      workspace: { root: "/tmp", cleanupOnTerminal: false, reuse: true },
      polling: { intervalMs: 1000, jitterMs: 0 },
      hooks: {},
      server: undefined,
      linear: undefined,
    };
    expect(piThinkingForRunner({ workflow: { ...base, agent: { runner: "pi", thinking: "high" } }, profile: { name: "pi", cli: "pi", thinking: "low" } })).toBe("high");
    expect(reasoningEffortForRunner({ workflow: { ...base, agent: { runner: "codex", reasoning_effort: "xhigh" } }, profile: { name: "codex", cli: "codex", reasoningEffort: "low" } })).toBe("xhigh");
    expect(reasoningEffortForRunner({ workflow: { ...base, agent: { runner: "claude", reasoning: "max" } }, profile: { name: "claude", cli: "claude", reasoningEffort: "medium" } })).toBe("max");
    expect(runnerForWorkflow({ workflow: { ...base, agent: { profile: "claude", thinking: "max" } }, profile: { name: "claude", cli: "claude", reasoningEffort: "medium" } })).toBe("claude");
    expect(reasoningEffortForRunner({ workflow: { ...base, agent: { profile: "claude", thinking: "max" } }, profile: { name: "claude", cli: "claude", reasoningEffort: "medium" } })).toBe("max");
    expect(reasoningEffortForRunner({ workflow: { ...base, agent: { profile: "codex" } }, profile: { name: "codex", cli: "codex", reasoningEffort: "high" } })).toBe("high");
    expect(workflowAgentThinking({ runner: "codex", reasoningEffort: "medium" })).toBe("medium");
    expect(workflowAgentThinking({ runner: "codex", thinking: "high", reasoningEffort: "low", reasoning_effort: "medium", reasoning: "xhigh" })).toBe("high");
    expect(workflowAgentThinking({ runner: "codex", reasoningEffort: "low", reasoning_effort: "medium", reasoning: "xhigh" })).toBe("low");
    expect(workflowAgentThinking({ runner: "codex", reasoning_effort: "medium", reasoning: "xhigh" })).toBe("medium");
    expect(() => reasoningEffortForRunner({ workflow: { ...base, agent: { profile: "codex", thinking: "max" } }, profile: { name: "codex", cli: "codex", reasoningEffort: "low" } })).toThrow("Invalid agent.thinking for codex: max");
    expect(() => reasoningEffortForRunner({ workflow: { ...base, agent: { profile: "claude", thinking: "off" } }, profile: { name: "claude", cli: "claude", reasoningEffort: "medium" } })).toThrow("Invalid agent.thinking for claude: off");
    expect(() => piThinkingForRunner({ workflow: { ...base, agent: { profile: "pi", thinking: "max" } }, profile: { name: "pi", cli: "pi", thinking: "low" } })).toThrow("Invalid agent.thinking for pi: max");
  });

  it("backs off independently", () => {
    let now = 0;
    const retry = new RetryPolicy(() => now);
    expect(retry.register("A", "dispatch").nextAttempt).toBe(30_000);
    now = 30_000;
    expect(retry.register("A", "dispatch").nextAttempt).toBe(90_000);
    expect(retry.nextAttempt("A", "tool_call")).toBeUndefined();
    retry.reset("A", "dispatch");
    expect(retry.nextAttempt("A", "dispatch")).toBeUndefined();
  });

  it("verifies and filters Linear webhook payloads", () => {
    const body = JSON.stringify({
      type: "Issue",
      action: "update",
      data: { id: "lin_1", state: { name: "Done" } },
    });
    const signature = crypto
      .createHmac("sha256", "secret")
      .update(body)
      .digest("hex");
    expect(verifyWebhookSignature("secret", body, signature)).toBe(true);
    expect(verifyWebhookSignature("secret", body, "bad")).toBe(false);
    expect(isRelevantWebhook(JSON.parse(body))).toBe(true);
    expect(
      isRelevantWebhook({ type: "User", action: "update", data: { id: "u1" } })
    ).toBe(false);
  });

  it("strips tracker API keys from hook environments", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-hooks-"));
    const oldLinear = process.env.LINEAR_API_KEY;
    const oldPlane = process.env.PLANE_API_KEY;
    const oldOauth = process.env.PLANE_OAUTH_TOKEN;
    const oldBot = process.env.PLANE_BOT_TOKEN;
    process.env.LINEAR_API_KEY = "linear-secret";
    process.env.PLANE_API_KEY = "plane-secret";
    process.env.PLANE_OAUTH_TOKEN = "oauth-secret";
    process.env.PLANE_BOT_TOKEN = "bot-secret";
    const events: string[] = [];
    try {
      await runHook({
        command: "node -e \"console.log([process.env.LINEAR_API_KEY,process.env.PLANE_API_KEY,process.env.PLANE_OAUTH_TOKEN,process.env.PLANE_BOT_TOKEN,process.env.EXTRA_ENV].join('|'))\"",
        phase: "before_run",
        cwd: root,
        runId: "run-1",
        env: { EXTRA_ENV: "visible" },
        store: { appendEvent: async (_runId: string, _type: string, text: string) => { events.push(text); } } as unknown as StateStore,
      });
    } finally {
      if (oldLinear === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = oldLinear;
      if (oldPlane === undefined) delete process.env.PLANE_API_KEY;
      else process.env.PLANE_API_KEY = oldPlane;
      if (oldOauth === undefined) delete process.env.PLANE_OAUTH_TOKEN;
      else process.env.PLANE_OAUTH_TOKEN = oldOauth;
      if (oldBot === undefined) delete process.env.PLANE_BOT_TOKEN;
      else process.env.PLANE_BOT_TOKEN = oldBot;
    }
    expect(events.join("").trim()).toBe("||||visible");
  });

  it("strips tracker credentials from spawned worker env while preserving other vars", () => {
    const oldLinear = process.env.LINEAR_API_KEY;
    const oldPlane = process.env.PLANE_API_KEY;
    const oldOauth = process.env.PLANE_OAUTH_TOKEN;
    const oldBot = process.env.PLANE_BOT_TOKEN;
    process.env.LINEAR_API_KEY = "linear-secret";
    process.env.PLANE_API_KEY = "plane-secret";
    process.env.PLANE_OAUTH_TOKEN = "oauth-secret";
    process.env.PLANE_BOT_TOKEN = "bot-secret";
    try {
      const env = sanitizedWorkerEnv({ YOPLAI_RUN_ID: "run-1" });
      expect(env.LINEAR_API_KEY).toBeUndefined();
      expect(env.PLANE_API_KEY).toBeUndefined();
      expect(env.PLANE_OAUTH_TOKEN).toBeUndefined();
      expect(env.PLANE_BOT_TOKEN).toBeUndefined();
      expect(env.YOPLAI_RUN_ID).toBe("run-1");
      expect(env.PATH).toBe(process.env.PATH);
    } finally {
      if (oldLinear === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = oldLinear;
      if (oldPlane === undefined) delete process.env.PLANE_API_KEY;
      else process.env.PLANE_API_KEY = oldPlane;
      if (oldOauth === undefined) delete process.env.PLANE_OAUTH_TOKEN;
      else process.env.PLANE_OAUTH_TOKEN = oldOauth;
      if (oldBot === undefined) delete process.env.PLANE_BOT_TOKEN;
      else process.env.PLANE_BOT_TOKEN = oldBot;
    }
  });
});

describe("project workflow modules", () => {
  it("resolves configured projects and requires uppercase WORKFLOW.md", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-projects-"));
    const project = path.join(home, "project-a");
    await fs.mkdir(project);
    await writeWorkflow(project);
    await expect(
      resolveProjects({ paths: ["project-a"], dataDir: home })
    ).resolves.toEqual([
      {
        id: "project-a",
        path: project,
        workflowPath: path.join(project, "WORKFLOW.md"),
      },
    ]);
    await fs.mkdir(path.join(home, "bad"));
    await expect(
      resolveProjects({ paths: ["bad"], dataDir: home })
    ).rejects.toThrow("missing WORKFLOW.md");
  });

  it("disambiguates duplicate project basenames", async () => {
    const home = await fs.mkdtemp(
      path.join(os.tmpdir(), "aih-orch-project-collision-")
    );
    const left = path.join(home, "left", "app");
    const right = path.join(home, "right", "app");
    await fs.mkdir(left, { recursive: true });
    await fs.mkdir(right, { recursive: true });
    await writeWorkflow(left);
    await writeCustomWorkflow(right, { projectSlug: "proj-b" });
    const projects = await resolveProjects({
      paths: [left, right],
      dataDir: home,
    });
    expect(projects[0]?.id).toMatch(/^app-[a-f0-9]{8}$/);
    expect(projects[1]?.id).toMatch(/^app-[a-f0-9]{8}$/);
    expect(projects[0]?.id).not.toBe(projects[1]?.id);
  });

  it("loads self-contained workflow and resolves workspace relative to project", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-workflow-"));
    await writeWorkflow(root);
    const snapshot = await new WorkflowLoader(root).resolve({
      projectPath: root,
      issue: {
        id: "1",
        identifier: "ENG-1",
        title: "Hello",
        state: "Ready",
        labels: [],
      },
    });
    expect((snapshot.config.tracker as LinearTrackerConfig).projectSlug).toBe("proj-a");
    expect(snapshot.config.workspace.root).toBe(path.join(root, "workspaces"));
    expect(snapshot.body.trim()).toBe("Do ENG-1");
  });

  it("loads Plane tracker workflow config with defaults and env fallback", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-plane-workflow-"));
    const oldKey = process.env.PLANE_API_KEY;
    process.env.PLANE_API_KEY = "plane-env-key";
    try {
      await fs.writeFile(path.join(root, "WORKFLOW.md"), `---
tracker:
  kind: plane
  workspace_slug: ws-a
  project_id: proj-a
  module_id: mod-a
  mention: Worker Agent
agent:
  runner: fake
---
Run
`);
      const snapshot = await new WorkflowLoader(root).resolve({ projectPath: root });
      expect(snapshot.config.tracker).toMatchObject<PlaneTrackerConfig>({
        kind: "plane",
        baseUrl: "https://api.plane.so",
        apiKey: "plane-env-key",
        authKind: "api_key",
        workspaceSlug: "ws-a",
        projectId: "proj-a",
        moduleId: "mod-a",
        mention: "Worker Agent",
        activeStates: ["Todo", "In Progress"],
        terminalStates: ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"],
        needsHuman: "Needs Human",
      });

      await fs.writeFile(path.join(root, "WORKFLOW.md"), "---\ntracker:\n  kind: plane\n  api_key: test\n  project_id: proj-a\n---\nRun\n");
      await expect(new WorkflowLoader(root).resolve({ projectPath: root })).rejects.toThrow("tracker.workspace_slug is required for tracker.kind: plane");
    } finally {
      if (oldKey === undefined) delete process.env.PLANE_API_KEY;
      else process.env.PLANE_API_KEY = oldKey;
    }
  });

  it("infers plane auth_kind from a literal api_key env-var reference", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-plane-auth-infer-"));
    const oldBot = process.env.PLANE_BOT_TOKEN;
    const oldOauth = process.env.PLANE_OAUTH_TOKEN;
    process.env.PLANE_BOT_TOKEN = "bot-secret";
    process.env.PLANE_OAUTH_TOKEN = "oauth-secret";
    try {
      await fs.writeFile(path.join(root, "WORKFLOW.md"), "---\ntracker:\n  kind: plane\n  api_key: $PLANE_BOT_TOKEN\n  workspace_slug: ws-a\n  project_id: proj-a\n---\nRun\n");
      await expect(new WorkflowLoader(root).resolve({ projectPath: root })).resolves.toMatchObject({ config: { tracker: { authKind: "bot_token", apiKey: "bot-secret" } } });

      await fs.writeFile(path.join(root, "WORKFLOW.md"), "---\ntracker:\n  kind: plane\n  api_key: $PLANE_OAUTH_TOKEN\n  workspace_slug: ws-a\n  project_id: proj-a\n---\nRun\n");
      await expect(new WorkflowLoader(root).resolve({ projectPath: root })).resolves.toMatchObject({ config: { tracker: { authKind: "oauth_token", apiKey: "oauth-secret" } } });
    } finally {
      if (oldBot === undefined) delete process.env.PLANE_BOT_TOKEN;
      else process.env.PLANE_BOT_TOKEN = oldBot;
      if (oldOauth === undefined) delete process.env.PLANE_OAUTH_TOKEN;
      else process.env.PLANE_OAUTH_TOKEN = oldOauth;
    }
  });

  it("throws when explicit plane auth_kind mismatches the env-resolved token source", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-plane-auth-mismatch-"));
    const oldBot = process.env.PLANE_BOT_TOKEN;
    process.env.PLANE_BOT_TOKEN = "bot-secret";
    try {
      await fs.writeFile(path.join(root, "WORKFLOW.md"), "---\ntracker:\n  kind: plane\n  auth_kind: oauth_token\n  workspace_slug: ws-a\n  project_id: proj-a\n---\nRun\n");
      await expect(new WorkflowLoader(root).resolve({ projectPath: root })).rejects.toThrow(
        'tracker.auth_kind is "oauth_token" but the resolved token came from $PLANE_BOT_TOKEN'
      );
    } finally {
      if (oldBot === undefined) delete process.env.PLANE_BOT_TOKEN;
      else process.env.PLANE_BOT_TOKEN = oldBot;
    }
  });

  it("trusts explicit plane auth_kind when api_key is also explicit", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-plane-auth-explicit-"));
    await fs.writeFile(path.join(root, "WORKFLOW.md"), "---\ntracker:\n  kind: plane\n  api_key: raw-token-abc\n  auth_kind: bot_token\n  workspace_slug: ws-a\n  project_id: proj-a\n---\nRun\n");
    await expect(new WorkflowLoader(root).resolve({ projectPath: root })).resolves.toMatchObject({
      config: { tracker: { authKind: "bot_token", apiKey: "raw-token-abc" } },
    });
  });

  it("validates orchestrator-owned runner config", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-runner-config-"));
    await fs.writeFile(path.join(root, "WORKFLOW.md"), `---
tracker:
  kind: linear
  api_key: test-key
  project_slug: proj-a
agent:
  profile: default
  runner: fake
  provider: anthropic
  model: gpt-test
  thinking: high
  max_turns: 4
  turn_timeout_ms: 1000
  stall_timeout_ms: 2000
  max_concurrent: 1
---
Run
`);
    const snapshot = await new WorkflowLoader(root).resolve({ projectPath: root });
    expect(snapshot.config.agent).toMatchObject({ runner: "fake", provider: "anthropic", model: "gpt-test", thinking: "high", max_turns: 4, turn_timeout_ms: 1000, stall_timeout_ms: 2000 });

    await fs.writeFile(path.join(root, "WORKFLOW.md"), "---\ntracker:\n  kind: linear\n  api_key: test\n  project_slug: proj-a\nagent:\n  profile: default\n  runner: cli\n---\nRun\n");
    await expect(new WorkflowLoader(root).resolve({ projectPath: root })).rejects.toThrow("agent.command must provide an executable when agent.runner is cli");

    await fs.writeFile(path.join(root, "WORKFLOW.md"), "---\ntracker:\n  kind: linear\n  api_key: test\n  project_slug: proj-a\nagent:\n  profile: default\n  runner: cli\n  command: []\n---\nRun\n");
    await expect(new WorkflowLoader(root).resolve({ projectPath: root })).rejects.toThrow("agent.command must provide an executable when agent.runner is cli");

    await fs.writeFile(path.join(root, "WORKFLOW.md"), "---\ntracker:\n  kind: linear\n  api_key: test\n  project_slug: proj-a\nagent:\n  profile: default\n  runner: cli\n  command: [\" node \", \"-v\"]\n---\nRun\n");
    await expect(new WorkflowLoader(root).resolve({ projectPath: root })).resolves.toMatchObject({ config: { agent: { command: ["node", "-v"] } } });

    await fs.writeFile(path.join(root, "WORKFLOW.md"), "---\ntracker:\n  kind: linear\n  api_key: test\n  project_slug: proj-a\nagent:\n  profile: default\n  runner: codex\n---\nRun\n");
    await expect(new WorkflowLoader(root).resolve({ projectPath: root })).resolves.toMatchObject({ config: { agent: { runner: "codex" } } });

    await fs.writeFile(path.join(root, "WORKFLOW.md"), "---\ntracker:\n  kind: linear\n  api_key: test\n  project_slug: proj-a\nagent:\n  profile: default\n  runner: codex\n  command: [\" node \", \"mock-app-server.mjs\"]\n---\nRun\n");
    await expect(new WorkflowLoader(root).resolve({ projectPath: root })).resolves.toMatchObject({ config: { agent: { runner: "codex", command: ["node", "mock-app-server.mjs"] } } });

    await fs.writeFile(path.join(root, "WORKFLOW.md"), "---\ntracker:\n  kind: linear\n  api_key: test\n  project_slug: proj-a\nagent:\n  profile: default\n  kind: pi\n  provider: anthropic\n---\nRun\n");
    await expect(new WorkflowLoader(root).resolve({ projectPath: root })).resolves.toMatchObject({ config: { agent: { runner: "pi", provider: "anthropic" } } });

    await fs.writeFile(path.join(root, "WORKFLOW.md"), "---\ntracker:\n  kind: linear\n  api_key: test\n  project_slug: proj-a\nagent:\n  profile: claude\n  kind: claude\n---\nRun\n");
    await expect(new WorkflowLoader(root).resolve({ projectPath: root })).resolves.toMatchObject({ config: { agent: { runner: "claude" } } });

    await fs.writeFile(path.join(root, "WORKFLOW.md"), "---\ntracker:\n  kind: linear\n  api_key: test\n  project_slug: proj-a\nagent:\n  runner: codex\n  reasoningEffort: xhigh\n---\nRun\n");
    await expect(new WorkflowLoader(root).resolve({ projectPath: root })).resolves.toMatchObject({ config: { agent: { runner: "codex", reasoningEffort: "xhigh" } } });

    await fs.writeFile(path.join(root, "WORKFLOW.md"), "---\ntracker:\n  kind: linear\n  api_key: test\n  project_slug: proj-a\nagent:\n  runner: pi\n  thinking: max\n---\nRun\n");
    await expect(new WorkflowLoader(root).resolve({ projectPath: root })).rejects.toThrow("Invalid agent.thinking for pi: max. Allowed: off, low, medium, high, xhigh");

    await fs.writeFile(path.join(root, "WORKFLOW.md"), "---\ntracker:\n  kind: linear\n  api_key: test\n  project_slug: proj-a\nagent:\n  runner: codex\n  reasoning: max\n---\nRun\n");
    await expect(new WorkflowLoader(root).resolve({ projectPath: root })).rejects.toThrow("Invalid agent.thinking for codex: max. Allowed: xhigh, high, medium, low");

    await fs.writeFile(path.join(root, "WORKFLOW.md"), "---\ntracker:\n  kind: linear\n  api_key: test\n  project_slug: proj-a\nagent:\n  runner: codex\n  reasoning: max\n  reasoningEffort: high\n---\nRun\n");
    await expect(new WorkflowLoader(root).resolve({ projectPath: root })).resolves.toMatchObject({ config: { agent: { runner: "codex", reasoning: "max", reasoningEffort: "high" } } });

    await fs.writeFile(path.join(root, "WORKFLOW.md"), "---\ntracker:\n  kind: linear\n  api_key: test\n  project_slug: proj-a\nagent:\n  runner: claude\n  thinking: off\n---\nRun\n");
    await expect(new WorkflowLoader(root).resolve({ projectPath: root })).rejects.toThrow("Invalid agent.thinking for claude: off. Allowed: low, medium, high, xhigh, max");

    await fs.writeFile(path.join(root, "WORKFLOW.md"), "---\ntracker:\n  kind: linear\n  api_key: test\n  project_slug: proj-a\nagent:\n  profile: default\n  runner: fake\n  max_turns: 0\n---\nRun\n");
    await expect(new WorkflowLoader(root).resolve({ projectPath: root })).rejects.toThrow("agent.max_turns must be a positive number");
  });

  it("renders only Symphony issue and attempt variables strictly", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-template-"));
    await fs.writeFile(
      path.join(root, "WORKFLOW.md"),
      "---\ntracker:\n  kind: linear\n  api_key: test\n  project_slug: proj-a\nagent:\n  profile: default\n---\n{{issue.identifier}} {{attempt}} {{issue.labels}}\n"
    );
    const issue = {
      id: "1",
      identifier: "ENG-1",
      title: "Hello",
      state: "Ready",
      labels: ["bug", "p1"],
    };
    const loader = new WorkflowLoader(root);

    await expect(
      loader.resolve({ projectPath: root, issue })
    ).resolves.toMatchObject({ body: 'ENG-1  ["bug","p1"]\n' });
    await expect(
      loader.resolve({ projectPath: root, issue, attempt: 2 })
    ).resolves.toMatchObject({ body: 'ENG-1 2 ["bug","p1"]\n' });

    await fs.writeFile(
      path.join(root, "WORKFLOW.md"),
      "---\ntracker:\n  kind: linear\n  api_key: test\n  project_slug: proj-a\n---\n{{project.id}}\n"
    );
    await expect(loader.resolve({ projectPath: root, issue })).rejects.toThrow(
      "Unknown workflow template variable: project.id"
    );
    await fs.writeFile(
      path.join(root, "WORKFLOW.md"),
      "---\ntracker:\n  kind: linear\n  api_key: test\n  project_slug: proj-a\n---\n{{issue.identifier | upper}}\n"
    );
    await expect(loader.resolve({ projectPath: root, issue })).rejects.toThrow(
      "Unknown workflow template filter: upper"
    );
  });

  it("keeps last known good workflow when reload is invalid", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-lkg-"));
    await writeWorkflow(root);
    const loader = new WorkflowLoader(root);
    const first = await loader.resolve({ projectPath: root });
    expect((first.config.tracker as LinearTrackerConfig).projectSlug).toBe("proj-a");
    await fs.writeFile(
      path.join(root, "WORKFLOW.md"),
      "---\ntracker: [bad]\n---\nbad"
    );
    const stale = await loader.resolve({
      projectPath: root,
      issue: {
        id: "1",
        identifier: "ENG-2",
        title: "Hello",
        state: "Ready",
        labels: [],
      },
      allowStale: true,
    });
    expect((stale.config.tracker as LinearTrackerConfig).projectSlug).toBe("proj-a");
    expect(stale.body.trim()).toBe("Do ENG-2");
    await expect(loader.resolve({ projectPath: root })).rejects.toThrow();
  });

  it("creates directory-only workspaces", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-ws-"));
    const layout = new WorkspaceLayout(root);
    await expect(layout.create({ identifier: "ENG-1" })).resolves.toMatchObject(
      { path: path.join(root, "eng-1"), created: true }
    );
    await expect(layout.create({ identifier: "ENG-1" })).resolves.toMatchObject(
      { created: false }
    );
    await layout.remove({ identifier: "ENG-1" });
    await expect(fs.stat(path.join(root, "eng-1"))).rejects.toThrow();
  });
});

describe("orchestrator routes", () => {
  it("redacts workflow tracker secrets", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-route-"));
    const project = path.join(home, "project");
    await fs.mkdir(project);
    await writeCustomWorkflow(project, {
      apiKey: "secret-key",
      projectSlug: "proj-a",
    });
    const context = {
      getDataDir: () => home,
      getConfig: () => ({
        gateway: { port: 4001 },
        extensions: {
          subagents: { profiles },
          orchestrator: { projects: [project] },
        },
      }),
      emit: vi.fn(),
    } as any;
    const app = new Hono();
    try {
      await orchestratorExtension.start?.(context);
      orchestratorExtension.registerRoutes(app);
      const response = await app.request(
        "/orchestrator/workflow?project=project"
      );
      const data = await response.json();
      expect(data.frontmatter.tracker.api_key).toBe("[redacted]");
      expect(data.config.tracker.apiKey).toBe("[redacted]");
      expect(JSON.stringify(data)).not.toContain("secret-key");
    } finally {
      await orchestratorExtension.stop?.();
    }
  });

  it("marks killed runs as finished", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-kill-"));
    const project = path.join(home, "project");
    await fs.mkdir(project);
    await writeWorkflow(project);
    const context = {
      getDataDir: () => home,
      getConfig: () => ({
        gateway: { port: 4001 },
        extensions: {
          subagents: { profiles },
          orchestrator: { projects: [project] },
        },
      }),
      emit: vi.fn(),
    } as any;
    const app = new Hono();
    try {
      await orchestratorExtension.start?.(context);
      orchestratorExtension.registerRoutes(app);
      const state = new StateStore(path.join(home, "orchestrator", "state.db"));
      state.bootstrap();
      state.insertRun({
        runId: "r-kill",
        projectId: "project",
        issueId: "lin_1",
        identifier: "ENG-1",
        workspace: path.join(project, "workspaces", "eng-1"),
        profileJson: "{}",
        workflowPath: path.join(project, "WORKFLOW.md"),
        workflowSha: "abc",
        pid: null,
        startedAt: new Date().toISOString(),
      });
      state.claim("lin_1", "r-kill", "project");
      const response = await app.request(
        "/orchestrator/runs/ENG-1/kill?project=project",
        { method: "POST" }
      );
      expect(response.status).toBe(200);
      expect(state.listOpenRuns("project")).toHaveLength(0);
      expect(state.listRecent(1, "project")[0]).toMatchObject({
        outcome: "killed",
        process_alive: 0,
      });
      expect(context.emit).toHaveBeenCalledWith(
        "orchestrator.run.finished",
        expect.objectContaining({
          issueId: "lin_1",
          projectId: "project",
          runId: "r-kill",
          outcome: "killed",
        })
      );
      state.close();
    } finally {
      await orchestratorExtension.stop?.();
    }
  });

  it("serves orchestrator worker logs from persisted events", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-logs-"));
    const project = path.join(home, "project");
    await fs.mkdir(project);
    await writeWorkflow(project);
    const context = { getDataDir: () => home, getConfig: () => ({ gateway: { port: 4001 }, extensions: { orchestrator: { projects: [project] } } }), emit: vi.fn() } as any;
    const app = new Hono();
    try {
      await orchestratorExtension.start?.(context);
      orchestratorExtension.registerRoutes(app);
      const state = new StateStore(path.join(home, "orchestrator", "state.db"));
      state.bootstrap();
      state.insertRun({ runId: "r-log", projectId: "project", issueId: "lin_1", identifier: "ENG-1", workspace: path.join(project, "workspaces", "eng-1"), profileJson: "{}", workflowPath: path.join(project, "WORKFLOW.md"), workflowSha: "abc", pid: null, startedAt: new Date().toISOString() });
      state.setWorkerId("r-log", "worker-log");
      state.appendEvent("r-log", "worker.started", { id: "worker-log", kind: "claude" }, "project");
      state.appendEvent("r-log", "worker.claude.message", { text: "hello from worker" }, "project");
      state.appendEvent("r-log", "worker.codex.message", { item: { type: "agentMessage", text: "\u001b[31mhello from codex\u001b[0m [2mclean" } }, "project");
      state.appendEvent("r-log", "worker.pi.message", { assistantMessageEvent: { type: "text_delta", text: "partial pi" } }, "project");
      state.appendEvent("r-log", "worker.pi.message", { type: "turn_end", message: { role: "assistant", content: "hello from pi" } }, "project");

      const response = await app.request("/orchestrator/runs/ENG-1/logs?project=project&since=0");
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.cursor).toBe(5);
      expect(body.events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "assistant", rawType: "worker.claude.message", text: "hello from worker", payload: { text: "hello from worker" } }),
        expect.objectContaining({ type: "assistant", rawType: "worker.codex.message", text: "hello from codex clean" }),
        expect.objectContaining({ type: "assistant", rawType: "worker.pi.message", text: "" }),
        expect.objectContaining({ type: "assistant", rawType: "worker.pi.message", text: "hello from pi" }),
      ]));
      state.close();
    } finally {
      await orchestratorExtension.stop?.();
    }
  });

  it("lists active worker ids and statuses from orchestrator state", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-active-"));
    const project = path.join(home, "project");
    await fs.mkdir(project);
    await writeWorkflow(project);
    const context = { getDataDir: () => home, getConfig: () => ({ gateway: { port: 4001 }, extensions: { orchestrator: { projects: [project] } } }), emit: vi.fn() } as any;
    const app = new Hono();
    try {
      await orchestratorExtension.start?.(context);
      orchestratorExtension.registerRoutes(app);
      const state = new StateStore(path.join(home, "orchestrator", "state.db"));
      state.bootstrap();
      state.insertRun({ runId: "r-active", projectId: "project", issueId: "lin_1", identifier: "ENG-1", workspace: path.join(project, "workspaces", "eng-1"), profileJson: "{}", workflowPath: path.join(project, "WORKFLOW.md"), workflowSha: "abc", pid: null, startedAt: new Date().toISOString() });
      state.setWorkerId("r-active", "worker-active");
      state.appendEvent("r-active", "worker.started", { id: "worker-active", kind: "claude" }, "project");
      state.appendEvent("r-active", "worker.status", { id: "worker-active", kind: "claude", status: "running" }, "project");

      const response = await app.request("/orchestrator/runs?project=project");
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.active).toEqual([expect.objectContaining({ runId: "r-active", worker_id: "worker-active", worker_status: "running", worker_kind: "claude" })]);
      state.close();
    } finally {
      await orchestratorExtension.stop?.();
    }
  });

  it("queues a webhook tick for a plane payload when all projects are plane-scoped", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-webhook-plane-"));
    const project = path.join(home, "project");
    await fs.mkdir(project);
    await writePlaneWorkflow(project);
    const context = {
      getDataDir: () => home,
      getConfig: () => ({
        gateway: { port: 4001 },
        extensions: {
          subagents: { profiles },
          orchestrator: { projects: [project], webhook: { enabled: true, secret: "whsec" } },
        },
      }),
      emit: vi.fn(),
    } as any;
    const app = new Hono();
    const enqueueTickSpy = vi.spyOn(OrchestratorDaemon.prototype, "enqueueTick").mockImplementation(() => {});
    try {
      await orchestratorExtension.start?.(context);
      orchestratorExtension.registerRoutes(app);
      const body = JSON.stringify({ event: "issue", action: "updated", data: { id: "wi_1", state: "In Progress" } });
      const signature = crypto.createHmac("sha256", "whsec").update(body).digest("hex");
      const response = await app.request("/orchestrator/webhook", {
        method: "POST",
        headers: { "x-plane-signature": signature },
        body,
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true, queued: true });
      expect(enqueueTickSpy).toHaveBeenCalled();
    } finally {
      enqueueTickSpy.mockRestore();
      await orchestratorExtension.stop?.();
    }
  });

  it("queues a webhook tick for a plane payload when projects mix linear and plane", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-webhook-mixed-"));
    const linearProject = path.join(home, "linear-project");
    const planeProject = path.join(home, "plane-project");
    await fs.mkdir(linearProject);
    await fs.mkdir(planeProject);
    await writeWorkflow(linearProject);
    await writePlaneWorkflow(planeProject);
    const context = {
      getDataDir: () => home,
      getConfig: () => ({
        gateway: { port: 4001 },
        extensions: {
          subagents: { profiles },
          orchestrator: { projects: [linearProject, planeProject], webhook: { enabled: true, secret: "whsec" } },
        },
      }),
      emit: vi.fn(),
    } as any;
    const app = new Hono();
    const enqueueTickSpy = vi.spyOn(OrchestratorDaemon.prototype, "enqueueTick").mockImplementation(() => {});
    try {
      await orchestratorExtension.start?.(context);
      orchestratorExtension.registerRoutes(app);
      const body = JSON.stringify({ event: "issue", action: "updated", data: { id: "wi_1", state: "In Progress" } });
      const signature = crypto.createHmac("sha256", "whsec").update(body).digest("hex");
      const response = await app.request("/orchestrator/webhook", {
        method: "POST",
        headers: { "x-plane-signature": signature },
        body,
      });
      await expect(response.json()).resolves.toEqual({ ok: true, queued: true });
      expect(enqueueTickSpy).toHaveBeenCalled();
    } finally {
      enqueueTickSpy.mockRestore();
      await orchestratorExtension.stop?.();
    }
  });

  it("fails open and still queues a plane payload when tracker kind cannot be determined", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-webhook-unknown-"));
    const context = {
      getDataDir: () => home,
      getConfig: () => ({
        gateway: { port: 4001 },
        extensions: {
          subagents: { profiles },
          orchestrator: { projects: [], webhook: { enabled: true, secret: "whsec" } },
        },
      }),
      emit: vi.fn(),
    } as any;
    const app = new Hono();
    try {
      await orchestratorExtension.start?.(context);
      orchestratorExtension.registerRoutes(app);
      const body = JSON.stringify({ event: "issue", action: "updated", data: { id: "wi_1", state: "In Progress" } });
      const signature = crypto.createHmac("sha256", "whsec").update(body).digest("hex");
      const response = await app.request("/orchestrator/webhook", {
        method: "POST",
        headers: { "x-plane-signature": signature },
        body,
      });
      await expect(response.json()).resolves.toEqual({ ok: true, queued: true });
    } finally {
      await orchestratorExtension.stop?.();
    }
  });
});

describe("orchestrator agent tools", () => {
  it("requires project and uses that project tracker auth", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-tool-"));
    const one = path.join(home, "one");
    const two = path.join(home, "two");
    await fs.mkdir(one);
    await fs.mkdir(two);
    await writeCustomWorkflow(one, {
      apiKey: "key-one",
      endpoint: "https://linear-one.test/graphql",
      projectSlug: "proj-a",
    });
    await writeCustomWorkflow(two, {
      apiKey: "key-two",
      endpoint: "https://linear-two.test/graphql",
      projectSlug: "proj-b",
    });
    const calls: Array<{ url: string; auth: string | null }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({
          url: String(url),
          auth: new Headers(init?.headers).get("authorization"),
        });
        return new Response(JSON.stringify({ data: { ok: true } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
    ) as any;
    const context = {
      getDataDir: () => home,
      getConfig: () => ({
        extensions: {
          subagents: { profiles },
          orchestrator: { projects: [one, two] },
        },
      }),
      emit: vi.fn(),
    } as any;
    try {
      await orchestratorExtension.start?.(context);
      const tools = await Promise.resolve(
        orchestratorExtension.getAgentTools?.(context) ?? []
      );
      const tool = tools[0]!;
      await expect(
        tool.execute({ query: "query" }, {} as any)
      ).resolves.toHaveProperty("error");
      await expect(
        tool.execute({ project: "two", query: "query" }, {} as any)
      ).resolves.toEqual({ ok: true });
      expect(calls).toEqual([
        { url: "https://linear-two.test/graphql", auth: "key-two" },
      ]);
    } finally {
      await orchestratorExtension.stop?.();
      globalThis.fetch = originalFetch;
    }
  });
});

describe("orchestrator Linear client", () => {
  it("polls by Linear project slug", async () => {
    const calls: Array<{ query: string; variables: Record<string, unknown> }> =
      [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as {
        query: string;
        variables: Record<string, unknown>;
      };
      calls.push(body);
      return new Response(
        JSON.stringify({
          data: {
            issues: {
              nodes: [
                {
                  id: "lin_2",
                  identifier: "ENG-2",
                  title: "Blocked",
                  description: null,
                  url: "https://linear.test/ENG-2",
                  state: { name: "Ready" },
                  labels: { nodes: [] },
                  inverseRelations: {
                    nodes: [
                      {
                        type: "blocks",
                        issue: {
                          id: "lin_1",
                          identifier: "ENG-1",
                          state: { name: "Ready" },
                        },
                      },
                      {
                        type: "related",
                        issue: {
                          id: "lin_3",
                          identifier: "ENG-3",
                          state: { name: "Ready" },
                        },
                      },
                    ],
                  },
                  project: { name: "Project A", slugId: "proj-a" },
                  parent: null,
                },
              ],
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;
    const client = new LinearClient("test", { fetchImpl });
    const issues = await client.pollIssues({
      projectSlug: "proj-a",
      activeStates: ["Ready"],
    });
    expect(calls[0]?.query).toContain("slugId");
    expect(calls[0]?.query).toContain("inverseRelations");
    expect(calls[0]?.variables).toEqual({
      projectSlug: "proj-a",
      states: ["Ready"],
    });
    expect(issues[0]?.blocked_by).toEqual([
      { id: "lin_1", identifier: "ENG-1", state: "Ready" },
    ]);
  });

  it("waits on exhausted bucket and retries one 429 after reset", async () => {
    let now = 1_000;
    const sleeps: number[] = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { ok: true } }), {
          headers: {
            "x-ratelimit-requests-remaining": "0",
            "x-ratelimit-requests-reset": "3",
          },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ errors: [{ message: "rate" }] }), {
          status: 429,
          headers: {
            "x-ratelimit-requests-remaining": "0",
            "x-ratelimit-requests-reset": "5",
          },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { ok: true } }), {
          headers: { "x-ratelimit-requests-remaining": "9" },
        })
      );
    const client = new LinearClient("key", {
      fetchImpl,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });
    await expect(client.graphql("query")).resolves.toEqual({ ok: true });
    await expect(client.graphql("query")).resolves.toEqual({ ok: true });
    expect(sleeps).toEqual([3_000, 2_000]);
    expect(client.rateLimitRemaining).toBe(9);
  });
});

async function writeMockCodexAppServer(dir: string): Promise<string> {
  const script = path.join(dir, "mock-codex-app-server.mjs");
  await fs.writeFile(script, `
import fs from "node:fs";
import readline from "node:readline";

const mode = process.env.MOCK_CODEX_MODE ?? "complete";
const logPath = process.env.MOCK_CODEX_LOG;
const rl = readline.createInterface({ input: process.stdin });

function write(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
}

function log(message) {
  if (logPath) fs.appendFileSync(logPath, JSON.stringify(message) + "\\n");
}

rl.on("line", (line) => {
  const message = JSON.parse(line);
  log(message);
  if (mode === "silent") return;
  if (message.id === "approval_1" && !message.method) {
    write({ method: "serverRequest/resolved", params: { threadId: "thr_mock", requestId: "approval_1" } });
    write({ method: "item/completed", params: { item: { id: "tool_approval", type: "commandExecution", command: ["git", "status"], cwd: process.cwd(), status: "declined" } } });
    write({ method: "turn/completed", params: { turn: { id: "turn_mock", status: "completed" } } });
  } else if (message.method === "initialize") {
    write({ id: message.id, result: {} });
  } else if (message.method === "initialized") {
  } else if (message.method === "thread/start") {
    write({ method: "thread/started", params: { thread: { id: "thr_mock", sessionId: "thr_mock" } } });
    write({ id: message.id, result: { thread: { id: "thr_mock", sessionId: "thr_mock" } } });
  } else if (message.method === "turn/start") {
    write({ method: "turn/started", params: { turn: { id: "turn_mock", status: "inProgress", items: [] } } });
    write({ id: message.id, result: { turn: { id: "turn_mock", status: "inProgress" } } });
    write({ method: "item/started", params: { item: { id: "msg_1", type: "agentMessage", text: "", phase: "commentary" } } });
    write({ method: "item/agentMessage/delta", params: { itemId: "msg_1", delta: "Working" } });
    write({ method: "item/completed", params: { item: { id: "tool_1", type: "commandExecution", command: ["pnpm", "test"], cwd: process.cwd(), status: "completed", exitCode: 0 } } });
    write({ method: "item/completed", params: { item: { id: "change_1", type: "fileChange", changes: [{ path: "src/index.ts", kind: "modify", diff: "@@" }], status: "completed" } } });
    write({ method: "turn/diff/updated", params: { threadId: "thr_mock", turnId: "turn_mock", diff: "@@" } });
    write({ method: "thread/tokenUsage/updated", params: { threadId: "thr_mock", usage: { totalTokens: 42 } } });
    if (mode === "fail") {
      write({ method: "error", params: { error: { message: "rate limited", codexErrorInfo: { type: "UsageLimitExceeded", httpStatusCode: 429 } } } });
      write({ method: "turn/completed", params: { turn: { id: "turn_mock", status: "failed", error: { message: "rate limited" } } } });
    } else if (mode === "approval") {
      write({ id: "approval_1", method: "item/commandExecution/requestApproval", params: { itemId: "tool_approval", threadId: "thr_mock", turnId: "turn_mock", availableDecisions: ["cancel"] } });
    } else if (mode === "complete") {
      write({ method: "turn/completed", params: { turn: { id: "turn_mock", status: "completed" } } });
    }
  } else if (message.method === "turn/steer") {
    write({ id: message.id, result: {} });
  } else if (message.method === "turn/interrupt") {
    if (mode !== "wedged") {
      write({ id: message.id, result: {} });
      write({ method: "turn/completed", params: { turn: { id: "turn_mock", status: "interrupted" } } });
    }
  }
});
`);
  return script;
}

function codexRunnerInput(root: string, command: string[], extra: Partial<Parameters<CodexAppServerRunner["start"]>[0]> = {}): Parameters<CodexAppServerRunner["start"]>[0] {
  return {
    runId: "r-codex",
    project: { id: "project", path: root, workflowPath: path.join(root, "WORKFLOW.md") },
    issue: { id: "lin_1", identifier: "ENG-1", title: "Codex", state: "Ready", labels: [] },
    workspace: root,
    prompt: "Initial rendered workflow instructions",
    label: "ENG-1",
    profile: { name: "default", cli: "codex", model: "gpt-5" },
    workflow: {
      tracker: { kind: "linear", endpoint: "x", apiKey: "x", projectSlug: "proj-a", activeStates: ["Ready"], terminalStates: ["Done"], needsHuman: "Needs Human" },
      workspace: { root, cleanupOnTerminal: false, reuse: true },
      polling: { intervalMs: 1000, jitterMs: 0 },
      agent: { runner: "codex", command, model: "gpt-5-mini" },
      hooks: {},
      server: undefined,
      linear: undefined,
    },
    ...extra,
  };
}

describe("Codex app-server worker runner", () => {
  it("validates profile-derived Codex thinking before spawning app-server", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-codex-invalid-thinking-"));
    const script = await writeMockCodexAppServer(root);
    const logPath = path.join(root, "rpc.log");
    process.env.MOCK_CODEX_MODE = "complete";
    process.env.MOCK_CODEX_LOG = logPath;
    const runner = new CodexAppServerRunner();
    try {
      await expect(runner.start(codexRunnerInput(root, [process.execPath, script], {
        profile: { name: "codex", cli: "codex", model: "gpt-5", reasoningEffort: "low" },
        workflow: {
          ...codexRunnerInput(root, [process.execPath, script]).workflow,
          agent: { profile: "codex", command: [process.execPath, script], model: "gpt-5-mini", thinking: "max" },
        },
      }))).rejects.toThrow("Invalid agent.thinking for codex: max");
      await expect(fs.stat(logPath)).rejects.toThrow();
    } finally {
      delete process.env.MOCK_CODEX_MODE;
      delete process.env.MOCK_CODEX_LOG;
    }
  });

  it("times out a non-responsive Codex app-server request and removes the session", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-codex-silent-"));
    const script = await writeMockCodexAppServer(root);
    const events: Array<{ type: string; payload: unknown }> = [];
    process.env.MOCK_CODEX_MODE = "silent";
    const runner = new CodexAppServerRunner({ requestTimeoutMs: 20, idleCleanupMs: 20, terminalRetentionMs: 20 });
    try {
      await expect(runner.start(codexRunnerInput(root, [process.execPath, script], {
        emitEvent: (type, payload) => events.push({ type, payload }),
      }))).rejects.toThrow("Codex app-server request timed out: initialize");
      expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(["worker.codex.request.timeout", "worker.codex.session.removed"]));
    } finally {
      delete process.env.MOCK_CODEX_MODE;
      await runner.shutdown();
    }
  });

  it("starts a mocked app-server session and maps messages, tools, tokens, and completion events", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-codex-complete-"));
    const script = await writeMockCodexAppServer(root);
    const logPath = path.join(root, "rpc.log");
    const events: Array<{ type: string; payload: unknown }> = [];
    process.env.MOCK_CODEX_MODE = "complete";
    process.env.MOCK_CODEX_LOG = logPath;
    const runner = new CodexAppServerRunner({ idleCleanupMs: 20, terminalRetentionMs: 50 });
    try {
      const handle = await runner.start(codexRunnerInput(root, [process.execPath, script], {
        profile: { name: "default", cli: "codex", model: "gpt-5", reasoningEffort: "low" },
        workflow: {
          ...codexRunnerInput(root, [process.execPath, script]).workflow,
          agent: { runner: "codex", command: [process.execPath, script], model: "gpt-5-mini", thinking: "high" },
        },
        emitEvent: (type, payload) => events.push({ type, payload }),
      }));

      await vi.waitFor(async () => expect(await runner.status(handle)).toMatchObject({ status: "done" }));
      expect(handle).toMatchObject({ kind: "codex", raw: { threadId: "thr_mock", turnId: "turn_mock" } });
      expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
        "worker.codex.initialized",
        "worker.codex.thread.started",
        "worker.codex.message",
        "worker.codex.tool",
        "worker.codex.tokens",
        "worker.codex.turn.completed",
      ]));
      const sent = (await fs.readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { method: string; params?: any });
      expect(sent.find((message) => message.method === "thread/start")?.params).toMatchObject({ model: "gpt-5-mini", cwd: root, approvalPolicy: "never", sandbox: "danger-full-access", serviceName: "yoplai-orchestrator" });
      expect(sent.find((message) => message.method === "turn/start")?.params).toMatchObject({ cwd: root, model: "gpt-5-mini", approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" }, effort: "high", input: [{ type: "text", text: "Initial rendered workflow instructions" }] });
    } finally {
      delete process.env.MOCK_CODEX_MODE;
      delete process.env.MOCK_CODEX_LOG;
    }
  });

  it("reuses a live Codex thread for continuation guidance", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-codex-continue-"));
    const script = await writeMockCodexAppServer(root);
    const logPath = path.join(root, "rpc.log");
    process.env.MOCK_CODEX_MODE = "hold";
    process.env.MOCK_CODEX_LOG = logPath;
    const runner = new CodexAppServerRunner();
    try {
      const first = await runner.start(codexRunnerInput(root, [process.execPath, script]));
      const second = await runner.start(codexRunnerInput(root, [process.execPath, script], { prompt: "This full prompt must not be resent" }));

      expect(second.id).toBe(first.id);
      const sent = (await fs.readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { method: string; params?: any });
      const starts = sent.filter((message) => message.method === "turn/start");
      const steer = sent.find((message) => message.method === "turn/steer");
      expect(starts).toHaveLength(1);
      expect(steer?.params.expectedTurnId).toBe("turn_mock");
      expect(steer?.params.input[0].text).toContain("Continue the active orchestrator work for ENG-1");
      expect(steer?.params.input[0].text).not.toContain("This full prompt must not be resent");
      await runner.abort(first);
    } finally {
      delete process.env.MOCK_CODEX_MODE;
      delete process.env.MOCK_CODEX_LOG;
    }
  });

  it("reuses a completed but live Codex thread before idle cleanup and later cleans it up", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-codex-idle-"));
    const script = await writeMockCodexAppServer(root);
    const logPath = path.join(root, "rpc.log");
    const events: Array<{ type: string; payload: unknown }> = [];
    process.env.MOCK_CODEX_MODE = "complete";
    process.env.MOCK_CODEX_LOG = logPath;
    const runner = new CodexAppServerRunner({ idleCleanupMs: 200, terminalRetentionMs: 40 });
    try {
      const first = await runner.start(codexRunnerInput(root, [process.execPath, script], {
        emitEvent: (type, payload) => events.push({ type, payload }),
      }));
      await vi.waitFor(async () => expect(await runner.status(first)).toMatchObject({ status: "done" }));
      const second = await runner.start(codexRunnerInput(root, [process.execPath, script], { prompt: "Do not resend this full prompt" }));
      expect(second.id).toBe(first.id);
      const sent = (await fs.readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { method?: string; params?: any });
      const starts = sent.filter((message) => message.method === "turn/start");
      expect(starts).toHaveLength(2);
      expect(starts[1]?.params.input[0].text).toContain("Continue the active orchestrator work for ENG-1");
      expect(starts[1]?.params.input[0].text).not.toContain("Do not resend this full prompt");
      await vi.waitFor(() => expect(events.map((event) => event.type)).toContain("worker.codex.session.removed"), { timeout: 1000 });
    } finally {
      delete process.env.MOCK_CODEX_MODE;
      delete process.env.MOCK_CODEX_LOG;
    }
  });

  it("does not let retained old Codex sessions remove newer sessions with the same key", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-codex-retention-replace-"));
    const script = await writeMockCodexAppServer(root);
    const events: Array<{ type: string; payload: unknown }> = [];
    process.env.MOCK_CODEX_MODE = "complete";
    const runner = new CodexAppServerRunner({ idleCleanupMs: 10, terminalRetentionMs: 40 });
    try {
      const first = await runner.start(codexRunnerInput(root, [process.execPath, script], {
        emitEvent: (type, payload) => events.push({ type, payload }),
      }));
      await vi.waitFor(async () => expect(await runner.status(first)).toMatchObject({ status: "done" }));
      await vi.waitFor(() => expect(events.map((event) => event.type)).toContain("worker.codex.process.exit"), { timeout: 1000 });

      process.env.MOCK_CODEX_MODE = "hold";
      const second = await runner.start(codexRunnerInput(root, [process.execPath, script]));
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(await runner.status(second)).toMatchObject({ status: "running" });
      await runner.abort(second);
    } finally {
      delete process.env.MOCK_CODEX_MODE;
      await runner.shutdown();
    }
  });

  it("responds to server-initiated approval requests", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-codex-approval-"));
    const script = await writeMockCodexAppServer(root);
    const logPath = path.join(root, "rpc.log");
    const events: Array<{ type: string; payload: unknown }> = [];
    process.env.MOCK_CODEX_MODE = "approval";
    process.env.MOCK_CODEX_LOG = logPath;
    const runner = new CodexAppServerRunner({ idleCleanupMs: 20, terminalRetentionMs: 50 });
    try {
      const handle = await runner.start(codexRunnerInput(root, [process.execPath, script], {
        emitEvent: (type, payload) => events.push({ type, payload }),
      }));
      await vi.waitFor(async () => expect(await runner.status(handle)).toMatchObject({ status: "done" }));
      expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(["worker.codex.server_request", "worker.codex.tool"]));
      const sent = (await fs.readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { id?: string; result?: unknown });
      expect(sent.some((message) => message.id === "approval_1" && message.result === "cancel")).toBe(true);
    } finally {
      delete process.env.MOCK_CODEX_MODE;
      delete process.env.MOCK_CODEX_LOG;
    }
  });

  it("maps failed turns and protocol-native aborts", async () => {
    const failRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-codex-fail-"));
    const failScript = await writeMockCodexAppServer(failRoot);
    process.env.MOCK_CODEX_MODE = "fail";
    const failEvents: Array<{ type: string; payload: unknown }> = [];
    const failed = new CodexAppServerRunner();
    try {
      const failedHandle = await failed.start(codexRunnerInput(failRoot, [process.execPath, failScript], {
        emitEvent: (type, payload) => failEvents.push({ type, payload }),
      }));
      await vi.waitFor(async () => expect(await failed.status(failedHandle)).toMatchObject({ status: "error" }));
      expect(failEvents.map((event) => event.type)).toContain("worker.codex.rate_limit");
    } finally {
      delete process.env.MOCK_CODEX_MODE;
    }

    const abortRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-codex-abort-"));
    const abortScript = await writeMockCodexAppServer(abortRoot);
    const logPath = path.join(abortRoot, "rpc.log");
    process.env.MOCK_CODEX_MODE = "hold";
    process.env.MOCK_CODEX_LOG = logPath;
    const aborting = new CodexAppServerRunner();
    try {
      const abortHandle = await aborting.start(codexRunnerInput(abortRoot, [process.execPath, abortScript]));
      await aborting.abort(abortHandle);
      await vi.waitFor(async () => expect(await aborting.status(abortHandle)).toMatchObject({ status: "interrupted" }));
      const sent = (await fs.readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { method: string });
      expect(sent.some((message) => message.method === "turn/interrupt")).toBe(true);
    } finally {
      delete process.env.MOCK_CODEX_MODE;
      delete process.env.MOCK_CODEX_LOG;
    }
  });

  it("falls back to process cleanup when protocol interrupt does not respond", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-codex-wedged-"));
    const script = await writeMockCodexAppServer(root);
    const events: Array<{ type: string; payload: unknown }> = [];
    process.env.MOCK_CODEX_MODE = "wedged";
    const runner = new CodexAppServerRunner({ interruptTimeoutMs: 20 });
    try {
      const handle = await runner.start(codexRunnerInput(root, [process.execPath, script], {
        emitEvent: (type, payload) => events.push({ type, payload }),
      }));
      await runner.abort(handle);
      expect(await runner.status(handle)).toMatchObject({ status: "interrupted" });
      expect(events.map((event) => event.type)).toContain("worker.codex.interrupt.timeout");
    } finally {
      delete process.env.MOCK_CODEX_MODE;
    }
  });

  it("shuts down retained completed sessions immediately", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-codex-shutdown-"));
    const script = await writeMockCodexAppServer(root);
    const events: Array<{ type: string; payload: unknown }> = [];
    process.env.MOCK_CODEX_MODE = "complete";
    const runner = new CodexAppServerRunner({ idleCleanupMs: 10_000, terminalRetentionMs: 10_000 });
    try {
      const handle = await runner.start(codexRunnerInput(root, [process.execPath, script], {
        emitEvent: (type, payload) => events.push({ type, payload }),
      }));
      await vi.waitFor(async () => expect(await runner.status(handle)).toMatchObject({ status: "done" }));
      await runner.shutdown();
      expect(events.map((event) => event.type)).toContain("worker.codex.session.removed");
      expect(await runner.status(handle)).toBeUndefined();
    } finally {
      delete process.env.MOCK_CODEX_MODE;
    }
  });

  it("aborts a turn that exceeds turn_timeout_ms and emits a turn.timeout event", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-codex-turn-timeout-"));
    const script = await writeMockCodexAppServer(root);
    const events: Array<{ type: string; payload: unknown }> = [];
    process.env.MOCK_CODEX_MODE = "stall";
    const runner = new CodexAppServerRunner({ interruptTimeoutMs: 100, idleCleanupMs: 100 });
    try {
      const handle = await runner.start(codexRunnerInput(root, [process.execPath, script], {
        emitEvent: (type, payload) => events.push({ type, payload }),
        workflow: {
          ...codexRunnerInput(root, [process.execPath, script]).workflow,
          agent: { runner: "codex", command: [process.execPath, script], turn_timeout_ms: 50 },
        },
      }));
      await vi.waitFor(async () => expect(await runner.status(handle)).toMatchObject({ status: "interrupted", raw: expect.objectContaining({ reason: "turn_timeout" }) }), { timeout: 3_000 });
      expect(events.map((event) => event.type)).toContain("worker.codex.turn.timeout");
    } finally {
      delete process.env.MOCK_CODEX_MODE;
      await runner.shutdown();
    }
  });
});

async function writeMockPiRpcServer(dir: string): Promise<string> {
  const script = path.join(dir, "mock-pi-rpc.mjs");
  await fs.writeFile(script, `
import fs from "node:fs";

const mode = process.env.MOCK_PI_MODE ?? "complete";
const logPath = process.env.MOCK_PI_LOG;
let buffer = "";

function write(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function log(message) {
  if (logPath) fs.appendFileSync(logPath, JSON.stringify(message) + "\\n");
}

function handle(message) {
  log(message);
  if (mode === "silent") return;
  if (message.type === "prompt") {
    if (mode === "reject") {
      write({ id: message.id, type: "response", command: "prompt", success: false, error: { message: "prompt rejected" } });
      return;
    }
    write({ id: message.id, type: "response", command: "prompt", success: true });
    write({ type: "agent_start" });
    write({ type: "turn_start" });
    write({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Working" }, message: { role: "assistant" } });
    write({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "Reasoning" }, message: { role: "assistant" } });
    write({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", toolCall: { id: "tc_1", name: "bash" } }, message: { role: "assistant" } });
    write({ type: "tool_execution_start", toolCallId: "tc_1", toolName: "bash", args: { command: "pnpm test" } });
    write({ type: "tool_execution_update", toolCallId: "tc_1", toolName: "bash", partialResult: { content: [{ type: "text", text: "ok" }] } });
    write({ type: "tool_execution_end", toolCallId: "tc_1", toolName: "bash", result: { content: [{ type: "text", text: "ok" }] }, isError: false });
    write({ type: "queue_update", pendingMessageCount: 0 });
    if (mode === "fail") {
      write({ type: "extension_error", error: { message: "extension failed" } });
      write({ type: "message_update", assistantMessageEvent: { type: "error", reason: "error" }, message: { role: "assistant" } });
    } else if (mode === "failend") {
      write({ type: "extension_error", error: { message: "extension failed" } });
      write({ type: "agent_end", messages: [{ role: "assistant", content: "failed" }] });
    } else if (mode === "abortend") {
      write({ type: "message_update", assistantMessageEvent: { type: "error", reason: "aborted" }, message: { role: "assistant" } });
      write({ type: "agent_end", messages: [{ role: "assistant", content: "aborted" }] });
    } else if (mode === "complete") {
      write({ type: "turn_end", message: { role: "assistant", content: "done" }, toolResults: [] });
      write({ type: "agent_end", messages: [{ role: "assistant", content: "done" }] });
    }
  } else if (message.type === "follow_up") {
    if (mode === "nofollow") return;
    write({ id: message.id, type: "response", command: "follow_up", success: true });
    write({ type: "queue_update", pendingMessageCount: 1 });
  } else if (message.type === "get_state") {
    write({ id: message.id, type: "response", command: "get_state", success: true, data: { sessionId: "pi_session", sessionFile: process.cwd() + "/.yoplai/pi-sessions/pi_session.jsonl", isStreaming: mode !== "complete", pendingMessageCount: 0 } });
  } else if (message.type === "abort") {
    if (mode !== "wedged") {
      write({ id: message.id, type: "response", command: "abort", success: true });
      write({ type: "message_update", assistantMessageEvent: { type: "error", reason: "aborted" }, message: { role: "assistant" } });
    }
  }
}

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  for (;;) {
    const index = buffer.indexOf("\\n");
    if (index === -1) return;
    const line = buffer.slice(0, index).replace(/\\r$/, "");
    buffer = buffer.slice(index + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
`);
  return script;
}

function piRunnerInput(root: string, command: string[], extra: Partial<Parameters<PiRpcRunner["start"]>[0]> = {}): Parameters<PiRpcRunner["start"]>[0] {
  return {
    runId: "r-pi",
    project: { id: "project", path: root, workflowPath: path.join(root, "WORKFLOW.md") },
    issue: { id: "lin_1", identifier: "ENG-1", title: "Pi", state: "Ready", labels: [] },
    workspace: root,
    prompt: "Initial rendered workflow instructions",
    label: "ENG-1",
    profile: { name: "default", cli: "codex", model: "gpt-5" },
    workflow: {
      tracker: { kind: "linear", endpoint: "x", apiKey: "x", projectSlug: "proj-a", activeStates: ["Ready"], terminalStates: ["Done"], needsHuman: "Needs Human" },
      workspace: { root, cleanupOnTerminal: false, reuse: true },
      polling: { intervalMs: 1000, jitterMs: 0 },
      agent: { runner: "pi", command, model: "gpt-5-mini" },
      hooks: {},
      server: undefined,
      linear: undefined,
    },
    ...extra,
  };
}

describe("Workflow worker runner", () => {
  it("uses a resolved profile runner when workflow runner is omitted", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-worker-profile-codex-"));
    const script = await writeMockCodexAppServer(root);
    const logPath = path.join(root, "rpc.log");
    process.env.MOCK_CODEX_MODE = "complete";
    process.env.MOCK_CODEX_LOG = logPath;
    const runner = new WorkflowWorkerRunner();
    try {
      const input = codexRunnerInput(root, [process.execPath, script], {
        profile: { name: "codex-profile", cli: "codex", model: "gpt-5", reasoningEffort: "high" },
        workflow: {
          ...codexRunnerInput(root, []).workflow,
          agent: { profile: "codex-profile", command: [process.execPath, script], model: "gpt-5-mini" },
        },
      });
      const handle = await runner.start(input);
      expect(handle.kind).toBe("codex");
      const sent = (await fs.readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { method: string; params?: any });
      expect(sent.find((message) => message.method === "turn/start")?.params).toMatchObject({ model: "gpt-5-mini", effort: "high" });
    } finally {
      delete process.env.MOCK_CODEX_MODE;
      delete process.env.MOCK_CODEX_LOG;
      await runner.shutdown();
    }
  });

  it("defaults omitted workflow runner to Pi", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-worker-default-pi-"));
    const script = await writeMockPiRpcServer(root);
    const events: Array<{ type: string; payload: unknown }> = [];
    process.env.MOCK_PI_MODE = "complete";
    const runner = new WorkflowWorkerRunner();
    try {
      const input = piRunnerInput(root, [process.execPath, script], {
        profile: { name: "pi", cli: "pi", model: "gpt-5-mini" },
        emitEvent: (type, payload) => events.push({ type, payload }),
        workflow: {
          ...piRunnerInput(root, []).workflow,
          agent: { command: [process.execPath, script], model: "gpt-5-mini" },
        },
      });
      const handle = await runner.start(input);
      expect(handle.kind).toBe("pi");
      const started = events.find((event) => event.type === "worker.pi.started")?.payload as { command?: string[] } | undefined;
      expect(started?.command).toEqual(expect.arrayContaining([process.execPath, script, "--model", "gpt-5-mini"]));
    } finally {
      delete process.env.MOCK_PI_MODE;
      await runner.shutdown();
    }
  });
});

describe("Pi RPC worker runner", () => {
  it("starts a mocked Pi RPC session and maps messages, thinking, tools, queue, state, and completion events", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-pi-complete-"));
    const script = await writeMockPiRpcServer(root);
    const logPath = path.join(root, "rpc.log");
    const events: Array<{ type: string; payload: unknown }> = [];
    process.env.MOCK_PI_MODE = "complete";
    process.env.MOCK_PI_LOG = logPath;
    const runner = new PiRpcRunner({ idleCleanupMs: 20, terminalRetentionMs: 50 });
    try {
      const handle = await runner.start(piRunnerInput(root, [process.execPath, script], {
        emitEvent: (type, payload) => events.push({ type, payload }),
      }));

      await vi.waitFor(async () => expect(await runner.status(handle)).toMatchObject({ status: "done" }));
      expect(handle).toMatchObject({ kind: "pi", raw: { state: { sessionId: "pi_session" } } });
      expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
        "worker.pi.started",
        "worker.pi.prompt.accepted",
        "worker.pi.message",
        "worker.pi.tool",
        "worker.pi.queue",
        "worker.pi.state",
        "worker.pi.agent_end",
      ]));
      expect(events.filter((event) => event.type === "worker.pi.message")).toHaveLength(1);
      expect(events.some((event) => event.type === "worker.pi.message_update" || event.type === "worker.pi.thinking")).toBe(false);
      const sent = (await fs.readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; message?: string });
      expect(sent.find((message) => message.type === "prompt")?.message).toBe("Initial rendered workflow instructions");
      expect(sent.some((message) => message.type === "get_state")).toBe(true);
    } finally {
      delete process.env.MOCK_PI_MODE;
      delete process.env.MOCK_PI_LOG;
    }
  });

  it("passes provider and thinking to the default Pi RPC command", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-pi-provider-"));
    const binDir = path.join(root, "bin");
    await fs.mkdir(binDir);
    const script = await writeMockPiRpcServer(root);
    const shim = path.join(binDir, "pi");
    await fs.writeFile(shim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`);
    await fs.chmod(shim, 0o755);
    const events: Array<{ type: string; payload: unknown }> = [];
    const previousPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
    process.env.MOCK_PI_MODE = "complete";
    const runner = new PiRpcRunner({ idleCleanupMs: 20, terminalRetentionMs: 50 });
    try {
      await runner.start(piRunnerInput(root, [], {
        emitEvent: (type, payload) => events.push({ type, payload }),
        profile: { name: "default", cli: "pi", provider: "anthropic", model: "claude-sonnet-4-6", thinking: "low" },
        workflow: {
          ...piRunnerInput(root, []).workflow,
          agent: { runner: "pi", provider: "openrouter", model: "moonshotai/kimi-k2.5", thinking: "high" },
        },
      }));
      const started = events.find((event) => event.type === "worker.pi.started")?.payload as { command?: string[] } | undefined;
      expect(started?.command).toEqual(expect.arrayContaining(["--provider", "openrouter", "--model", "moonshotai/kimi-k2.5", "--thinking", "high"]));
    } finally {
      process.env.PATH = previousPath;
      delete process.env.MOCK_PI_MODE;
      await runner.shutdown();
    }
  });

  it("passes provider and thinking to a custom Pi RPC command", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-pi-custom-thinking-"));
    const script = await writeMockPiRpcServer(root);
    const events: Array<{ type: string; payload: unknown }> = [];
    process.env.MOCK_PI_MODE = "complete";
    const runner = new PiRpcRunner({ idleCleanupMs: 20, terminalRetentionMs: 50 });
    try {
      await runner.start(piRunnerInput(root, [process.execPath, script, "--wrapper-flag"], {
        emitEvent: (type, payload) => events.push({ type, payload }),
        profile: { name: "default", cli: "pi", provider: "anthropic", model: "claude-sonnet-4-6", thinking: "low" },
        workflow: {
          ...piRunnerInput(root, []).workflow,
          agent: { runner: "pi", command: [process.execPath, script, "--wrapper-flag"], provider: "openrouter", model: "moonshotai/kimi-k2.5", thinking: "high" },
        },
      }));
      const started = events.find((event) => event.type === "worker.pi.started")?.payload as { command?: string[] } | undefined;
      expect(started?.command).toEqual(expect.arrayContaining(["--wrapper-flag", "--provider", "openrouter", "--model", "moonshotai/kimi-k2.5", "--thinking", "high"]));
    } finally {
      delete process.env.MOCK_PI_MODE;
      await runner.shutdown();
    }
  });

  it("reuses a live Pi session and queues continuation with follow_up", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-pi-continue-"));
    const script = await writeMockPiRpcServer(root);
    const logPath = path.join(root, "rpc.log");
    process.env.MOCK_PI_MODE = "hold";
    process.env.MOCK_PI_LOG = logPath;
    const runner = new PiRpcRunner({ abortTimeoutMs: 20 });
    try {
      const first = await runner.start(piRunnerInput(root, [process.execPath, script]));
      const second = await runner.start(piRunnerInput(root, [process.execPath, script], { prompt: "This full prompt must not be resent" }));

      expect(second.id).toBe(first.id);
      const sent = (await fs.readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; message?: string });
      expect(sent.filter((message) => message.type === "prompt")).toHaveLength(1);
      const followUp = sent.find((message) => message.type === "follow_up");
      expect(followUp?.message).toContain("Continue the active orchestrator work for ENG-1");
      expect(followUp?.message).not.toContain("This full prompt must not be resent");
      await runner.abort(first);
    } finally {
      delete process.env.MOCK_PI_MODE;
      delete process.env.MOCK_PI_LOG;
    }
  });

  it("maps Pi failures and rejected commands", async () => {
    const failRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-pi-fail-"));
    const failScript = await writeMockPiRpcServer(failRoot);
    process.env.MOCK_PI_MODE = "fail";
    const failed = new PiRpcRunner();
    try {
      const failedHandle = await failed.start(piRunnerInput(failRoot, [process.execPath, failScript]));
      await vi.waitFor(async () => expect(await failed.status(failedHandle)).toMatchObject({ status: "error" }));
    } finally {
      delete process.env.MOCK_PI_MODE;
      await failed.shutdown();
    }

    const failEndRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-pi-fail-end-"));
    const failEndScript = await writeMockPiRpcServer(failEndRoot);
    process.env.MOCK_PI_MODE = "failend";
    const failedThenEnded = new PiRpcRunner();
    try {
      const handle = await failedThenEnded.start(piRunnerInput(failEndRoot, [process.execPath, failEndScript]));
      await vi.waitFor(async () => expect(await failedThenEnded.status(handle)).toMatchObject({ status: "error" }));
    } finally {
      delete process.env.MOCK_PI_MODE;
      await failedThenEnded.shutdown();
    }

    const abortEndRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-pi-abort-end-"));
    const abortEndScript = await writeMockPiRpcServer(abortEndRoot);
    process.env.MOCK_PI_MODE = "abortend";
    const abortedThenEnded = new PiRpcRunner();
    try {
      const handle = await abortedThenEnded.start(piRunnerInput(abortEndRoot, [process.execPath, abortEndScript]));
      await vi.waitFor(async () => expect(await abortedThenEnded.status(handle)).toMatchObject({ status: "interrupted" }));
    } finally {
      delete process.env.MOCK_PI_MODE;
      await abortedThenEnded.shutdown();
    }

    const rejectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-pi-reject-"));
    const rejectScript = await writeMockPiRpcServer(rejectRoot);
    process.env.MOCK_PI_MODE = "reject";
    const rejected = new PiRpcRunner();
    try {
      await expect(rejected.start(piRunnerInput(rejectRoot, [process.execPath, rejectScript]))).rejects.toThrow("prompt rejected");
    } finally {
      delete process.env.MOCK_PI_MODE;
      await rejected.shutdown();
    }
  });

  it("times out unresponsive Pi RPC startup and cleans the session", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-pi-silent-"));
    const script = await writeMockPiRpcServer(root);
    const events: Array<{ type: string; payload: unknown }> = [];
    process.env.MOCK_PI_MODE = "silent";
    const runner = new PiRpcRunner({ requestTimeoutMs: 200 });
    try {
      await expect(runner.start(piRunnerInput(root, [process.execPath, script], {
        emitEvent: (type, payload) => events.push({ type, payload }),
      }))).rejects.toThrow("Pi RPC prompt timed out");
      expect(events.map((event) => event.type)).toContain("worker.pi.session.removed");
    } finally {
      delete process.env.MOCK_PI_MODE;
      await runner.shutdown();
    }
  });

  it("times out unresponsive Pi continuation and removes the live session", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-pi-nofollow-"));
    const script = await writeMockPiRpcServer(root);
    const events: Array<{ type: string; payload: unknown }> = [];
    process.env.MOCK_PI_MODE = "nofollow";
    const runner = new PiRpcRunner({ requestTimeoutMs: 1_000 });
    try {
      await runner.start(piRunnerInput(root, [process.execPath, script], {
        emitEvent: (type, payload) => events.push({ type, payload }),
      }));
      await expect(runner.start(piRunnerInput(root, [process.execPath, script], {
        prompt: "Do not resend this full prompt",
        emitEvent: (type, payload) => events.push({ type, payload }),
      }))).rejects.toThrow("Pi RPC follow_up timed out");
      expect(events.map((event) => event.type)).toContain("worker.pi.session.removed");
    } finally {
      delete process.env.MOCK_PI_MODE;
      await runner.shutdown();
    }
  });

  it("aborts a turn that exceeds turn_timeout_ms and emits a turn.timeout event", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-pi-turn-timeout-"));
    const script = await writeMockPiRpcServer(root);
    const events: Array<{ type: string; payload: unknown }> = [];
    process.env.MOCK_PI_MODE = "stall";
    const runner = new PiRpcRunner({ abortTimeoutMs: 100, idleCleanupMs: 100 });
    try {
      const handle = await runner.start(piRunnerInput(root, [process.execPath, script], {
        emitEvent: (type, payload) => events.push({ type, payload }),
        workflow: {
          ...piRunnerInput(root, [process.execPath, script]).workflow,
          agent: { runner: "pi", command: [process.execPath, script], turn_timeout_ms: 50 },
        },
      }));
      await vi.waitFor(async () => expect(await runner.status(handle)).toMatchObject({ status: "interrupted", raw: expect.objectContaining({ reason: "turn_timeout" }) }), { timeout: 3_000 });
      expect(events.map((event) => event.type)).toContain("worker.pi.turn.timeout");
    } finally {
      delete process.env.MOCK_PI_MODE;
      await runner.shutdown();
    }
  });

  it("uses protocol abort and falls back to process cleanup when abort does not respond", async () => {
    const abortRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-pi-abort-"));
    const abortScript = await writeMockPiRpcServer(abortRoot);
    const abortLog = path.join(abortRoot, "rpc.log");
    process.env.MOCK_PI_MODE = "hold";
    process.env.MOCK_PI_LOG = abortLog;
    const aborting = new PiRpcRunner();
    try {
      const abortHandle = await aborting.start(piRunnerInput(abortRoot, [process.execPath, abortScript]));
      await aborting.abort(abortHandle);
      await vi.waitFor(async () => expect(await aborting.status(abortHandle)).toMatchObject({ status: "interrupted" }));
      const sent = (await fs.readFile(abortLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string });
      expect(sent.some((message) => message.type === "abort")).toBe(true);
    } finally {
      delete process.env.MOCK_PI_MODE;
      delete process.env.MOCK_PI_LOG;
    }

    const wedgedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-pi-wedged-"));
    const wedgedScript = await writeMockPiRpcServer(wedgedRoot);
    const events: Array<{ type: string; payload: unknown }> = [];
    process.env.MOCK_PI_MODE = "wedged";
    const wedged = new PiRpcRunner({ abortTimeoutMs: 20 });
    try {
      const handle = await wedged.start(piRunnerInput(wedgedRoot, [process.execPath, wedgedScript], {
        emitEvent: (type, payload) => events.push({ type, payload }),
      }));
      await wedged.abort(handle);
      expect(await wedged.status(handle)).toMatchObject({ status: "interrupted" });
      expect(events.map((event) => event.type)).toContain("worker.pi.abort.timeout");
    } finally {
      delete process.env.MOCK_PI_MODE;
      await wedged.shutdown();
    }
  });
});

async function writeMockClaudeRpcShim(dir: string): Promise<string> {
  const script = path.join(dir, "mock-claude-rpc-shim.mjs");
  await fs.writeFile(script, `
import fs from "node:fs";

const mode = process.env.MOCK_CLAUDE_MODE ?? "complete";
const logPath = process.env.MOCK_CLAUDE_LOG;
let buffer = "";

function write(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function log(message) {
  if (logPath) fs.appendFileSync(logPath, JSON.stringify(message) + "\\n");
}

function handle(message) {
  log(message);
  if (mode === "silent") return;
  if (message.type === "prompt") {
    if (mode === "reject") {
      write({ id: message.id, type: "response", command: "prompt", success: false, error: { message: "prompt rejected" } });
      return;
    }
    write({ id: message.id, type: "response", command: "prompt", success: true });
    write({ type: "session_start", session_id: "claude_session" });
    write({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Working" }, { type: "tool_use", id: "embedded_tool", name: "Read", input: { file_path: "package.json" } }] } });
    write({ type: "message_delta", delta: { type: "thinking_delta", text: "Reasoning" } });
    write({ type: "tool_use", id: "tool_1", name: "Bash", input: { command: "pnpm test" } });
    write({ type: "tool_result", tool_use_id: "tool_1", content: "ok", is_error: false });
    write({ type: "queue_update", pendingMessageCount: 0 });
    if (mode === "fail") {
      write({ type: "error", error: { message: "shim failed" } });
    } else if (mode === "resultfail") {
      write({ type: "result", subtype: "error", error: "failed" });
    } else if (mode === "complete") {
      write({ type: "result", subtype: "success", result: "done" });
    }
  } else if (message.type === "follow_up") {
    if (mode === "nofollow") return;
    write({ id: message.id, type: "response", command: "follow_up", success: true });
    write({ type: "queue_update", pendingMessageCount: 1 });
  } else if (message.type === "get_state") {
    write({ id: message.id, type: "response", command: "get_state", success: true, data: { sessionId: "claude_session", sessionFile: process.cwd() + "/.yoplai/claude-sessions/claude_session.jsonl", isStreaming: mode !== "complete", pendingMessageCount: 0 } });
  } else if (message.type === "abort") {
    if (mode !== "wedged") {
      write({ id: message.id, type: "response", command: "abort", success: true });
      write({ type: "error", error: { message: "aborted", reason: "aborted" } });
    }
  }
}

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  for (;;) {
    const index = buffer.indexOf("\\n");
    if (index === -1) return;
    const line = buffer.slice(0, index).replace(/\\r$/, "");
    buffer = buffer.slice(index + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
`);
  return script;
}

async function writeMockClaudeCli(dir: string): Promise<string> {
  const script = path.join(dir, "claude");
  await fs.writeFile(script, `#!/usr/bin/env node
import fs from "node:fs";

const logPath = process.env.MOCK_CLAUDE_CLI_LOG;
if (logPath) fs.appendFileSync(logPath, JSON.stringify(process.argv.slice(2)) + "\\n");
const delay = Number(process.env.MOCK_CLAUDE_CLI_DELAY_MS ?? "0");
if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
process.stdout.write(JSON.stringify({ type: "system", session_id: "shim_session" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Working" }] } }) + "\\n");
if (process.env.MOCK_CLAUDE_CLI_FAIL === "1") {
  process.stdout.write(JSON.stringify({ type: "result", subtype: "error", error: "failed" }) + "\\n");
} else {
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: "done" }) + "\\n");
}
`);
  await fs.chmod(script, 0o755);
  return script;
}

function claudeRunnerInput(root: string, command: string[], extra: Partial<Parameters<ClaudeRpcRunner["start"]>[0]> = {}): Parameters<ClaudeRpcRunner["start"]>[0] {
  return {
    runId: "r-claude",
    project: { id: "project", path: root, workflowPath: path.join(root, "WORKFLOW.md") },
    issue: { id: "lin_1", identifier: "ENG-1", title: "Claude", state: "Ready", labels: [] },
    workspace: root,
    prompt: "Initial rendered workflow instructions",
    label: "ENG-1",
    profile: { name: "claude", cli: "claude", model: "claude-sonnet-4" },
    workflow: {
      tracker: { kind: "linear", endpoint: "x", apiKey: "x", projectSlug: "proj-a", activeStates: ["Ready"], terminalStates: ["Done"], needsHuman: "Needs Human" },
      workspace: { root, cleanupOnTerminal: false, reuse: true },
      polling: { intervalMs: 1000, jitterMs: 0 },
      agent: { runner: "claude", command: command.length > 0 ? command : undefined, model: "claude-sonnet-4" },
      hooks: {},
      server: undefined,
      linear: undefined,
    },
    ...extra,
  };
}

describe("Claude RPC worker runner", () => {
  it("uses the in-package Claude shim by default and queues active follow-up work", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-claude-default-shim-"));
    await writeMockClaudeCli(root);
    const logPath = path.join(root, "claude-cli.log");
    const originalPath = process.env.PATH;
    process.env.PATH = `${root}${path.delimiter}${originalPath ?? ""}`;
    process.env.MOCK_CLAUDE_CLI_LOG = logPath;
    process.env.MOCK_CLAUDE_CLI_DELAY_MS = "200";
    process.env.MOCK_CLAUDE_QUEUE_DELAY_MS = "200";
    const runner = new ClaudeRpcRunner({ idleCleanupMs: 50, terminalRetentionMs: 1_000 });
    try {
      const first = await runner.start(claudeRunnerInput(root, [], {
        profile: { name: "claude", cli: "claude", model: "claude-sonnet-4", reasoningEffort: "low" },
        workflow: {
          ...claudeRunnerInput(root, []).workflow,
          agent: { runner: "claude", model: "claude-sonnet-4", thinking: "max" },
        },
      }));
      const second = await runner.start(claudeRunnerInput(root, [], { prompt: "Do not resend this full prompt" }));

      expect(second.id).toBe(first.id);
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(await runner.status(first)).toMatchObject({ status: "running" });
      await vi.waitFor(async () => expect(await runner.status(first)).toMatchObject({ status: "done" }), { timeout: 3_000 });
      const invocations = (await fs.readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
      expect(invocations).toHaveLength(2);
      expect(invocations[0]?.join(" ")).toContain("Initial rendered workflow instructions");
      expect(invocations[0]).toEqual(expect.arrayContaining(["--effort", "max"]));
      expect(invocations[0]).toEqual(expect.arrayContaining(["--permission-mode", "bypassPermissions"]));
      expect(invocations[1]?.join(" ")).toContain("Continue the active orchestrator work for ENG-1");
      expect(invocations[1]?.join(" ")).not.toContain("Do not resend this full prompt");
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      delete process.env.MOCK_CLAUDE_CLI_LOG;
      delete process.env.MOCK_CLAUDE_CLI_DELAY_MS;
      delete process.env.MOCK_CLAUDE_QUEUE_DELAY_MS;
      await runner.shutdown();
    }
  });

  it("passes effort to a custom Claude RPC command", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-claude-custom-effort-"));
    await writeMockClaudeCli(root);
    const logPath = path.join(root, "claude-cli.log");
    const shim = fileURLToPath(new URL("./worker-runner/claude-rpc-shim.ts", import.meta.url));
    const command = [
      process.execPath,
      "--import",
      require.resolve("tsx"),
      shim,
      "--name",
      "custom",
      "--session-dir",
      path.join(root, ".yoplai", "claude-sessions"),
      "--claude-cli",
      "claude",
      "--wrapper-flag",
    ];
    const originalPath = process.env.PATH;
    process.env.PATH = `${root}${path.delimiter}${originalPath ?? ""}`;
    process.env.MOCK_CLAUDE_CLI_LOG = logPath;
    const runner = new ClaudeRpcRunner({ idleCleanupMs: 20, terminalRetentionMs: 50 });
    const events: Array<{ type: string; payload: unknown }> = [];
    try {
      const handle = await runner.start(claudeRunnerInput(root, command, {
        emitEvent: (type, payload) => events.push({ type, payload }),
        profile: { name: "claude", cli: "claude", model: "claude-sonnet-4", reasoningEffort: "low" },
        workflow: {
          ...claudeRunnerInput(root, []).workflow,
          agent: { runner: "claude", command, model: "claude-sonnet-4", thinking: "max" },
        },
      }));
      const started = events.find((event) => event.type === "worker.claude.started")?.payload as { command?: string[] } | undefined;
      expect(started?.command).toEqual(expect.arrayContaining(["--wrapper-flag", "--effort", "max"]));
      await vi.waitFor(async () => expect(await runner.status(handle)).toMatchObject({ status: "done" }));
      const invocations = (await fs.readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
      expect(invocations[0]).toEqual(expect.arrayContaining(["--effort", "max"]));
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      delete process.env.MOCK_CLAUDE_CLI_LOG;
      await runner.shutdown();
    }
  });

  it("does not run queued Claude follow-up work after a failed default shim run", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-claude-default-shim-fail-"));
    await writeMockClaudeCli(root);
    const logPath = path.join(root, "claude-cli.log");
    const originalPath = process.env.PATH;
    process.env.PATH = `${root}${path.delimiter}${originalPath ?? ""}`;
    process.env.MOCK_CLAUDE_CLI_LOG = logPath;
    process.env.MOCK_CLAUDE_CLI_DELAY_MS = "200";
    process.env.MOCK_CLAUDE_CLI_FAIL = "1";
    const runner = new ClaudeRpcRunner({ idleCleanupMs: 50, terminalRetentionMs: 1_000 });
    try {
      const first = await runner.start(claudeRunnerInput(root, []));
      const second = await runner.start(claudeRunnerInput(root, [], { prompt: "Queued follow-up must not run" }));

      expect(second.id).toBe(first.id);
      await vi.waitFor(async () => expect(await runner.status(first)).toMatchObject({ status: "error" }));
      await new Promise((resolve) => setTimeout(resolve, 250));
      const invocations = (await fs.readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
      expect(invocations).toHaveLength(1);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      delete process.env.MOCK_CLAUDE_CLI_LOG;
      delete process.env.MOCK_CLAUDE_CLI_DELAY_MS;
      delete process.env.MOCK_CLAUDE_CLI_FAIL;
      await runner.shutdown();
    }
  });

  it("starts a mocked Claude shim and maps messages, thinking, tools, queue, state, and result events", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-claude-complete-"));
    const script = await writeMockClaudeRpcShim(root);
    const logPath = path.join(root, "rpc.log");
    const events: Array<{ type: string; payload: unknown }> = [];
    process.env.MOCK_CLAUDE_MODE = "complete";
    process.env.MOCK_CLAUDE_LOG = logPath;
    const runner = new ClaudeRpcRunner({ idleCleanupMs: 20, terminalRetentionMs: 50 });
    try {
      const handle = await runner.start(claudeRunnerInput(root, [process.execPath, script], {
        emitEvent: (type, payload) => events.push({ type, payload }),
      }));

      await vi.waitFor(async () => expect(await runner.status(handle)).toMatchObject({ status: "done" }));
      expect(handle).toMatchObject({ kind: "claude", raw: { state: { sessionId: "claude_session" } } });
      expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
        "worker.claude.started",
        "worker.claude.prompt.accepted",
        "worker.claude.message",
        "worker.claude.thinking",
        "worker.claude.tool",
        "worker.claude.queue",
        "worker.claude.state",
        "worker.claude.result",
      ]));
      expect(events.some((event) => event.type === "worker.claude.tool" && (event.payload as { item?: { type?: string } }).item?.type === "tool_use")).toBe(true);
      const sent = (await fs.readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; message?: string });
      expect(sent.find((message) => message.type === "prompt")?.message).toBe("Initial rendered workflow instructions");
      expect(sent.some((message) => message.type === "get_state")).toBe(true);
    } finally {
      delete process.env.MOCK_CLAUDE_MODE;
      delete process.env.MOCK_CLAUDE_LOG;
      await runner.shutdown();
    }
  });

  it("reuses a live Claude shim session and queues continuation with follow_up", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-claude-continue-"));
    const script = await writeMockClaudeRpcShim(root);
    const logPath = path.join(root, "rpc.log");
    process.env.MOCK_CLAUDE_MODE = "hold";
    process.env.MOCK_CLAUDE_LOG = logPath;
    const runner = new ClaudeRpcRunner({ abortTimeoutMs: 20 });
    try {
      const first = await runner.start(claudeRunnerInput(root, [process.execPath, script]));
      const second = await runner.start(claudeRunnerInput(root, [process.execPath, script], { prompt: "This full prompt must not be resent" }));

      expect(second.id).toBe(first.id);
      const sent = (await fs.readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; message?: string });
      expect(sent.filter((message) => message.type === "prompt")).toHaveLength(1);
      const followUp = sent.find((message) => message.type === "follow_up");
      expect(followUp?.message).toContain("Continue the active orchestrator work for ENG-1");
      expect(followUp?.message).not.toContain("This full prompt must not be resent");
      await runner.abort(first);
    } finally {
      delete process.env.MOCK_CLAUDE_MODE;
      delete process.env.MOCK_CLAUDE_LOG;
      await runner.shutdown();
    }
  });

  it("surfaces Claude shim failures and rejected commands", async () => {
    const failRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-claude-fail-"));
    const failScript = await writeMockClaudeRpcShim(failRoot);
    process.env.MOCK_CLAUDE_MODE = "fail";
    const failed = new ClaudeRpcRunner();
    try {
      const failedHandle = await failed.start(claudeRunnerInput(failRoot, [process.execPath, failScript]));
      await vi.waitFor(async () => expect(await failed.status(failedHandle)).toMatchObject({ status: "error" }));
      expect(failedHandle.kind).toBe("claude");
    } finally {
      delete process.env.MOCK_CLAUDE_MODE;
      await failed.shutdown();
    }

    const resultFailRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-claude-result-fail-"));
    const resultFailScript = await writeMockClaudeRpcShim(resultFailRoot);
    process.env.MOCK_CLAUDE_MODE = "resultfail";
    const resultFailed = new ClaudeRpcRunner();
    try {
      const handle = await resultFailed.start(claudeRunnerInput(resultFailRoot, [process.execPath, resultFailScript]));
      await vi.waitFor(async () => expect(await resultFailed.status(handle)).toMatchObject({ status: "error" }));
    } finally {
      delete process.env.MOCK_CLAUDE_MODE;
      await resultFailed.shutdown();
    }

    const rejectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-claude-reject-"));
    const rejectScript = await writeMockClaudeRpcShim(rejectRoot);
    process.env.MOCK_CLAUDE_MODE = "reject";
    const rejected = new ClaudeRpcRunner();
    try {
      const handle = await rejected.start(claudeRunnerInput(rejectRoot, [process.execPath, rejectScript]));
      await expect(rejected.status(handle)).resolves.toMatchObject({ status: "error", raw: { message: "prompt rejected" } });
    } finally {
      delete process.env.MOCK_CLAUDE_MODE;
      await rejected.shutdown();
    }
  });

  it("times out unresponsive Claude shim startup and removes the session", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-claude-silent-"));
    const script = await writeMockClaudeRpcShim(root);
    const events: Array<{ type: string; payload: unknown }> = [];
    process.env.MOCK_CLAUDE_MODE = "silent";
    const runner = new ClaudeRpcRunner({ requestTimeoutMs: 200 });
    try {
      const handle = await runner.start(claudeRunnerInput(root, [process.execPath, script], {
        emitEvent: (type, payload) => events.push({ type, payload }),
      }));
      await expect(runner.status(handle)).resolves.toMatchObject({ status: "error", raw: { message: "Claude RPC prompt timed out" } });
      expect(events.map((event) => event.type)).toContain("worker.claude.start.error");
    } finally {
      delete process.env.MOCK_CLAUDE_MODE;
      await runner.shutdown();
    }
  });

  it("aborts a turn that exceeds turn_timeout_ms and emits a turn.timeout event", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-claude-turn-timeout-"));
    const script = await writeMockClaudeRpcShim(root);
    const events: Array<{ type: string; payload: unknown }> = [];
    process.env.MOCK_CLAUDE_MODE = "stall";
    const runner = new ClaudeRpcRunner({ abortTimeoutMs: 100, idleCleanupMs: 100 });
    try {
      const handle = await runner.start(claudeRunnerInput(root, [process.execPath, script], {
        emitEvent: (type, payload) => events.push({ type, payload }),
        workflow: {
          ...claudeRunnerInput(root, [process.execPath, script]).workflow,
          agent: { runner: "claude", command: [process.execPath, script], turn_timeout_ms: 50 },
        },
      }));
      await vi.waitFor(async () => expect(await runner.status(handle)).toMatchObject({ status: "interrupted", raw: expect.objectContaining({ reason: "turn_timeout" }) }), { timeout: 3_000 });
      expect(events.map((event) => event.type)).toContain("worker.claude.turn.timeout");
    } finally {
      delete process.env.MOCK_CLAUDE_MODE;
      await runner.shutdown();
    }
  });

  it("uses protocol abort and falls back to process cleanup when abort does not respond", async () => {
    const abortRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-claude-abort-"));
    const abortScript = await writeMockClaudeRpcShim(abortRoot);
    const abortLog = path.join(abortRoot, "rpc.log");
    process.env.MOCK_CLAUDE_MODE = "hold";
    process.env.MOCK_CLAUDE_LOG = abortLog;
    const aborting = new ClaudeRpcRunner();
    try {
      const abortHandle = await aborting.start(claudeRunnerInput(abortRoot, [process.execPath, abortScript]));
      await aborting.abort(abortHandle);
      await vi.waitFor(async () => expect(await aborting.status(abortHandle)).toMatchObject({ status: "interrupted" }));
      const sent = (await fs.readFile(abortLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string });
      expect(sent.some((message) => message.type === "abort")).toBe(true);
    } finally {
      delete process.env.MOCK_CLAUDE_MODE;
      delete process.env.MOCK_CLAUDE_LOG;
      await aborting.shutdown();
    }

    const wedgedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-claude-wedged-"));
    const wedgedScript = await writeMockClaudeRpcShim(wedgedRoot);
    const events: Array<{ type: string; payload: unknown }> = [];
    process.env.MOCK_CLAUDE_MODE = "wedged";
    const wedged = new ClaudeRpcRunner({ abortTimeoutMs: 20 });
    try {
      const handle = await wedged.start(claudeRunnerInput(wedgedRoot, [process.execPath, wedgedScript], {
        emitEvent: (type, payload) => events.push({ type, payload }),
      }));
      await wedged.abort(handle);
      expect(await wedged.status(handle)).toMatchObject({ status: "interrupted" });
      expect(events.map((event) => event.type)).toContain("worker.claude.abort.timeout");
    } finally {
      delete process.env.MOCK_CLAUDE_MODE;
      await wedged.shutdown();
    }
  });

  it("emits user_prompt, tool, and tool_output events when Claude CLI nests tool blocks", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-claude-tool-events-"));
    const binDir = path.join(root, "bin");
    await fs.mkdir(binDir);
    const cliScript = path.join(binDir, "claude");
    await fs.writeFile(cliScript, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: "system", session_id: "shim_session" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } }] } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: [{ type: "text", text: "file.txt" }] }] } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: "done" }) + "\\n");
`);
    await fs.chmod(cliScript, 0o755);
    const events: Array<{ type: string; payload: unknown }> = [];
    const previousPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
    const runner = new ClaudeRpcRunner({ idleCleanupMs: 50, terminalRetentionMs: 200 });
    try {
      const handle = await runner.start(claudeRunnerInput(root, [], {
        emitEvent: (type, payload) => events.push({ type, payload }),
      }));
      await vi.waitFor(async () => expect(await runner.status(handle)).toMatchObject({ status: "done" }), { timeout: 5000 });

      const userPromptEvent = events.find((e) => e.type === "worker.claude.user_prompt");
      expect(userPromptEvent?.payload).toMatchObject({ message: "Initial rendered workflow instructions" });

      const toolEvent = events.find((e) => e.type === "worker.claude.tool");
      expect((toolEvent?.payload as { item?: { name?: string } } | undefined)?.item?.name).toBe("Bash");

      const toolOutputEvent = events.find((e) => e.type === "worker.claude.tool_output");
      expect((toolOutputEvent?.payload as { item?: { aggregated_output?: string } } | undefined)?.item?.aggregated_output).toContain("file.txt");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await runner.shutdown();
    }
  });

  it("does not let a stale retention timer evict a newer session occupying the same key", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-claude-retention-replace-"));
    const script = await writeMockClaudeRpcShim(root);
    const events: Array<{ type: string; payload: unknown }> = [];
    process.env.MOCK_CLAUDE_MODE = "complete";
    const runner = new ClaudeRpcRunner({ idleCleanupMs: 10, terminalRetentionMs: 40 });
    try {
      const first = await runner.start(claudeRunnerInput(root, [process.execPath, script], {
        emitEvent: (type, payload) => events.push({ type, payload }),
      }));
      await vi.waitFor(async () => expect(await runner.status(first)).toMatchObject({ status: "done" }));
      await vi.waitFor(() => expect(events.map((e) => e.type)).toContain("worker.claude.process.exit"), { timeout: 1000 });

      process.env.MOCK_CLAUDE_MODE = "hold";
      const second = await runner.start(claudeRunnerInput(root, [process.execPath, script]));
      // Wait long enough for the old session's retention timer (40 ms) to fire
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(await runner.status(second)).toMatchObject({ status: "running" });
      await runner.abort(second);
    } finally {
      delete process.env.MOCK_CLAUDE_MODE;
      await runner.shutdown();
    }
  });
});

describe("orchestrator daemon", () => {
  it("records CLI runner spawn failures as worker errors", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-cli-error-"));
    const runner = new CliWorkerRunner();
    const handle = await runner.start({
      runId: "r-cli-error",
      project: { id: "project", path: root, workflowPath: path.join(root, "WORKFLOW.md") },
      issue: { id: "lin_1", identifier: "ENG-1", title: "CLI", state: "Ready", labels: [] },
      workspace: root,
      prompt: "Run",
      label: "ENG-1",
      profile: { name: "default", cli: "codex" },
      workflow: {
        tracker: { kind: "linear", endpoint: "x", apiKey: "x", projectSlug: "proj-a", activeStates: ["Ready"], terminalStates: ["Done"], needsHuman: "Needs Human" },
        workspace: { root, cleanupOnTerminal: false, reuse: true },
        polling: { intervalMs: 1000, jitterMs: 0 },
        agent: { runner: "cli", command: "__yoplai_missing_command__" },
        hooks: {},
        server: undefined,
        linear: undefined,
      },
    });

    await vi.waitFor(async () => expect(await runner.status(handle)).toMatchObject({ status: "error" }));
  });

  it("spawns CLI workers without leaking tracker credentials into their env", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-cli-env-"));
    const script = path.join(root, "dump-env.mjs");
    await fs.writeFile(script, `import fs from "node:fs"; fs.writeFileSync("env.json", JSON.stringify(process.env));`);
    const oldLinear = process.env.LINEAR_API_KEY;
    const oldPlane = process.env.PLANE_API_KEY;
    process.env.LINEAR_API_KEY = "linear-secret";
    process.env.PLANE_API_KEY = "plane-secret";
    const runner = new CliWorkerRunner();
    try {
      const handle = await runner.start({
        runId: "r-env",
        project: { id: "project", path: root, workflowPath: path.join(root, "WORKFLOW.md") },
        issue: { id: "lin_1", identifier: "ENG-1", title: "Env", state: "Ready", labels: [] },
        workspace: root,
        prompt: "Run",
        label: "ENG-1",
        profile: { name: "default", cli: "codex" },
        workflow: {
          tracker: { kind: "linear", endpoint: "x", apiKey: "x", projectSlug: "proj-a", activeStates: ["Ready"], terminalStates: ["Done"], needsHuman: "Needs Human" },
          workspace: { root, cleanupOnTerminal: false, reuse: true },
          polling: { intervalMs: 1000, jitterMs: 0 },
          agent: { runner: "cli", command: [process.execPath, script] },
          hooks: {},
          server: undefined,
          linear: undefined,
        },
      });
      await vi.waitFor(async () => expect(await runner.status(handle)).toMatchObject({ status: "done" }));
      const dumped = JSON.parse(await fs.readFile(path.join(root, "env.json"), "utf8"));
      expect(dumped.LINEAR_API_KEY).toBeUndefined();
      expect(dumped.PLANE_API_KEY).toBeUndefined();
      expect(dumped.PLANE_OAUTH_TOKEN).toBeUndefined();
      expect(dumped.PLANE_BOT_TOKEN).toBeUndefined();
      expect(dumped.YOPLAI_RUN_ID).toBe("r-env");
    } finally {
      if (oldLinear === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = oldLinear;
      if (oldPlane === undefined) delete process.env.PLANE_API_KEY;
      else process.env.PLANE_API_KEY = oldPlane;
    }
  });

  it("skips issues with pending blockers", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-blocked-"));
    await writeWorkflow(root);
    const store = new StateStore(path.join(root, "state.db"));
    store.bootstrap();
    const claims = new ClaimsRegistry();
    const client = {
      pollIssues: vi.fn(async () => [
        {
          id: "lin_2",
          identifier: "ENG-2",
          title: "Blocked",
          description: "Body",
          state: "Ready",
          labels: [],
          projectSlug: "proj-a",
          blocked_by: [{ id: "lin_1", identifier: "ENG-1", state: "Ready" }],
        },
      ]),
      createComment: vi.fn(),
      setIssueState: vi.fn(),
    } as any;
    const ctx = { getDataDir: () => path.dirname(root), getConfig: () => ({ extensions: { subagents: { profiles }, orchestrator: { projects: [root] } } }), emit: vi.fn() } as any;
    const worker = mockWorkerRunner();
    const daemon = new OrchestratorDaemon({ ctx, store, claims, getConfig: () => ({ projects: [root] }), workerRunner: worker.runner, createTrackerClient: () => client });

    await daemon.start();
    await expect(daemon.tick()).resolves.toMatchObject({
      dispatched: 0,
      skipped: 1,
    });

    expect(worker.start).not.toHaveBeenCalled();
    expect(claims.list()).toHaveLength(0);
    expect(ctx.emit).toHaveBeenCalledWith(
      "orchestrator.run.event",
      expect.objectContaining({
        type: "dispatch.skipped",
        reason: "blocked_by_pending",
        issueId: "lin_2",
        pendingBlockerIds: ["ENG-1"],
      })
    );
    await daemon.stop();
    store.close();
  });

  it("dispatches issues when all blockers are terminal", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "aih-orch-unblocked-")
    );
    await writeWorkflow(root);
    const store = new StateStore(path.join(root, "state.db"));
    store.bootstrap();
    const claims = new ClaimsRegistry();
    const client = {
      pollIssues: vi.fn(async () => [
        {
          id: "lin_2",
          identifier: "ENG-2",
          title: "Ready",
          description: "Body",
          state: "Ready",
          labels: [],
          projectSlug: "proj-a",
          blocked_by: [{ id: "lin_1", identifier: "ENG-1", state: "Done" }],
        },
      ]),
      createComment: vi.fn(),
      setIssueState: vi.fn(),
    } as any;
    const ctx = { getDataDir: () => path.dirname(root), getConfig: () => ({ extensions: { subagents: { profiles }, orchestrator: { projects: [root] } } }), emit: vi.fn() } as any;
    const worker = mockWorkerRunner();
    const daemon = new OrchestratorDaemon({ ctx, store, claims, getConfig: () => ({ projects: [root] }), workerRunner: worker.runner, createTrackerClient: () => client });

    await daemon.start();
    await expect(daemon.tick()).resolves.toMatchObject({
      dispatched: 1,
      skipped: 0,
    });

    expect(worker.start).toHaveBeenCalledOnce();
    expect(claims.list()).toHaveLength(1);
    await daemon.stop();
    store.close();
  });

  it("builds a Plane-worded worker prompt through the real tracker client factory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-plane-dispatch-"));
    await writePlaneWorkflow(root);
    const store = new StateStore(path.join(root, "state.db"));
    store.bootstrap();
    const claims = new ClaimsRegistry();
    const jsonResponse = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/relations/")) return jsonResponse({ blocked_by: [] });
      if (u.includes("/states/")) return jsonResponse({ results: [{ id: "state-ready", name: "Ready" }] });
      if (u.includes("/work-items/") && u.includes("per_page")) {
        return jsonResponse({ results: [{ id: "wi_1", sequence_id: 1, name: "Plane Issue", description_stripped: "Body", state: "state-ready" }] });
      }
      if (u.endsWith("/proj-plane/")) return jsonResponse({ id: "proj-plane", identifier: "PLN", name: "Plane Project" });
      return jsonResponse({});
    }) as unknown as typeof fetch;
    const ctx = { getDataDir: () => path.dirname(root), getConfig: () => ({ extensions: { subagents: { profiles }, orchestrator: { projects: [root] } } }), emit: vi.fn() } as any;
    const worker = mockWorkerRunner();
    const daemon = new OrchestratorDaemon({
      ctx,
      store,
      claims,
      getConfig: () => ({ projects: [root] }),
      workerRunner: worker.runner,
      createTrackerClient: ({ config: trackerConfig }) => createTrackerClient(trackerConfig, { fetchImpl }),
    });

    await daemon.start();
    await expect(daemon.tick()).resolves.toMatchObject({ dispatched: 1, skipped: 0 });

    expect(worker.start).toHaveBeenCalledOnce();
    const prompt = (worker.start.mock.calls[0]?.[0] as { prompt: string }).prompt;
    expect(prompt).toContain("Plane API tool calls must pass project");
    expect(prompt).toContain("## Plane work item");
    expect(prompt).not.toContain("Linear GraphQL tool calls");
    expect(prompt).not.toContain("## Linear issue");
    await daemon.stop();
    store.close();
  });

  it("dispatches through fake worker runner without starting an external runtime", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-fake-runner-"));
    await fs.writeFile(path.join(root, "WORKFLOW.md"), `---
tracker:
  kind: linear
  api_key: test-key
  project_slug: proj-a
  active_states: [Ready]
  terminal_states: [Done]
agent:
  profile: default
  runner: fake
  max_concurrent: 1
workspace:
  root: ./workspaces
---
Do {{issue.identifier}}
`);
    const store = new StateStore(path.join(root, "state.db"));
    store.bootstrap();
    const claims = new ClaimsRegistry();
    const client = {
      pollIssues: vi.fn(async () => [{ id: "lin_1", identifier: "ENG-1", title: "Fake", description: "Body", state: "Ready", labels: [], projectSlug: "proj-a" }]),
      createComment: vi.fn(),
      setIssueState: vi.fn(),
    } as any;
    const ctx = { getDataDir: () => path.dirname(root), getConfig: () => ({ extensions: { subagents: { profiles }, orchestrator: { projects: [root] } } }), emit: vi.fn() } as any;
    const daemon = new OrchestratorDaemon({ ctx, store, claims, getConfig: () => ({ projects: [root] }), createTrackerClient: () => client });

    await daemon.start();
    await expect(daemon.tick()).resolves.toMatchObject({ dispatched: 1, skipped: 0 });
    expect(store.listRecent(1)[0]).toMatchObject({ worker_id: expect.stringContaining("fake:") });
    await expect(daemon.tick()).resolves.toMatchObject({ dispatched: 0 });
    expect(claims.list()).toHaveLength(0);
    expect(store.listRecent(1)[0]).toMatchObject({ outcome: "completed" });
    const runId = String((store.listRecent(1)[0] as any).run_id);
    expect(store.listEvents(runId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "worker.started" }),
      expect.objectContaining({ type: "worker.status" }),
    ]));
    await daemon.stop();
    store.close();
  });

  it("dispatches without the subagents extension configured", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-no-subagents-"));
    await fs.writeFile(path.join(root, "WORKFLOW.md"), `---
tracker:
  kind: linear
  api_key: test-key
  project_slug: proj-a
  active_states: [Ready]
  terminal_states: [Done]
agent:
  runner: claude
workspace:
  root: ./workspaces
---
Do {{issue.identifier}}
`);
    const store = new StateStore(path.join(root, "state.db"));
    store.bootstrap();
    const claims = new ClaimsRegistry();
    const client = {
      pollIssues: vi.fn(async () => [{ id: "lin_1", identifier: "ENG-1", title: "No Subagents", description: "Body", state: "Ready", labels: [], projectSlug: "proj-a" }]),
      createComment: vi.fn(),
      setIssueState: vi.fn(),
    } as any;
    const ctx = { getDataDir: () => path.dirname(root), getConfig: () => ({ extensions: { orchestrator: { projects: [root] } } }), emit: vi.fn() } as any;
    const worker = mockWorkerRunner({ id: "claude:owned", kind: "claude" });
    const daemon = new OrchestratorDaemon({ ctx, store, claims, getConfig: () => ({ projects: [root] }), workerRunner: worker.runner, createTrackerClient: () => client });

    await daemon.start();
    await expect(daemon.tick()).resolves.toMatchObject({ dispatched: 1, skipped: 0 });

    expect(worker.start).toHaveBeenCalledWith(expect.objectContaining({ profile: expect.objectContaining({ name: "claude", cli: "claude" }) }));
    expect(store.listRecent(1)[0]).toMatchObject({ worker_id: "claude:owned" });
    await daemon.stop();
    store.close();
  });

  it("interrupts worker handles by orchestrator run id", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-interrupt-runid-"));
    await writeWorkflow(root);
    const store = new StateStore(path.join(root, "state.db"));
    store.bootstrap();
    const claims = new ClaimsRegistry();
    const client = { pollIssues: vi.fn(async () => [{ id: "lin_1", identifier: "ENG-1", title: "Run", description: "Body", state: "Ready", labels: [], projectSlug: "proj-a" }]), createComment: vi.fn(), setIssueState: vi.fn() } as any;
    const ctx = { getDataDir: () => path.dirname(root), getConfig: () => ({ extensions: { subagents: { profiles }, orchestrator: { projects: [root] } } }), emit: vi.fn() } as any;
    const abort = vi.fn(async () => undefined);
    const daemon = new OrchestratorDaemon({
      ctx,
      store,
      claims,
      getConfig: () => ({ projects: [root] }),
      createTrackerClient: () => client,
      workerRunner: {
        start: vi.fn(async () => ({ id: "cli:test:123", kind: "cli" as const, pid: 123 })),
        status: vi.fn(async () => undefined),
        abort,
      },
    });

    await daemon.start();
    await daemon.tick();
    const runId = String((store.listRecent(1)[0] as any).run_id);
    await daemon.interruptWorker(runId, path.basename(root));

    expect(abort).toHaveBeenCalledWith(expect.objectContaining({ id: "cli:test:123", kind: "cli" }));
    await daemon.stop();
    store.close();
  });

  it("persists CLI worker pid for restart cleanup", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-cli-pid-"));
    await fs.writeFile(path.join(root, "WORKFLOW.md"), `---
tracker:
  kind: linear
  api_key: test-key
  project_slug: proj-a
  active_states: [Ready]
  terminal_states: [Done]
agent:
  profile: default
  runner: cli
  command: ["${process.execPath}", "-e", "setTimeout(()=>{}, 10000)"]
  max_concurrent: 1
workspace:
  root: ./workspaces
---
Do {{issue.identifier}}
`);
    const store = new StateStore(path.join(root, "state.db"));
    store.bootstrap();
    const claims = new ClaimsRegistry();
    const client = { pollIssues: vi.fn(async () => [{ id: "lin_1", identifier: "ENG-1", title: "CLI", description: "Body", state: "Ready", labels: [], projectSlug: "proj-a" }]), createComment: vi.fn(), setIssueState: vi.fn() } as any;
    const ctx = { getDataDir: () => path.dirname(root), getConfig: () => ({ extensions: { subagents: { profiles }, orchestrator: { projects: [root] } } }), emit: vi.fn() } as any;
    const daemon = new OrchestratorDaemon({ ctx, store, claims, getConfig: () => ({ projects: [root] }), createTrackerClient: () => client });

    await daemon.start();
    await daemon.tick();
    const row = store.listRecent(1)[0] as Record<string, unknown>;
    expect(row.worker_id).toEqual(expect.stringContaining("cli:"));
    expect(row.pid).toEqual(expect.any(Number));
    await daemon.stop();
    store.close();
  });

  it("ticks configured project, dispatches in issue workspace, and releases terminal", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-daemon-"));
    await writeWorkflow(root, "  cleanup_on_terminal: true\n");
    const store = new StateStore(path.join(root, "state.db"));
    store.bootstrap();
    const claims = new ClaimsRegistry();
    let state = "Ready";
    const client = {
      rateLimitRemaining: 7,
      pollIssues: vi.fn(async () => [
        {
          id: "lin_1",
          identifier: "ENG-1",
          title: "Test",
          description: "Body",
          state,
          labels: [],
          projectSlug: "proj-a",
        },
      ]),
      createComment: vi.fn(),
      setIssueState: vi.fn(),
    } as any;
    const ctx = { getDataDir: () => path.dirname(root), getConfig: () => ({ extensions: { subagents: { profiles }, orchestrator: { projects: [root] } } }), emit: vi.fn() } as any;
    const worker = mockWorkerRunner({ id: "worker_1", kind: "fake" });
    const daemon = new OrchestratorDaemon({ ctx, store, claims, getConfig: () => ({ projects: [root] }), workerRunner: worker.runner, createTrackerClient: () => client });

    await daemon.start();
    await daemon.tick();
    expect(daemon.rateLimitRemaining).toBe(7);
    expect(claims.list()).toHaveLength(1);
    expect(worker.start).toHaveBeenCalledWith(expect.objectContaining({ workspace: path.join(root, "workspaces", "eng-1"), prompt: expect.stringContaining(`Linear GraphQL tool calls must pass project: ${path.basename(root)}`), profile: expect.objectContaining({ name: "default" }) }));
    expect(store.listRecent(5)).toHaveLength(1);

    state = "Done";
    await daemon.tick();
    expect(claims.list()).toHaveLength(0);
    expect(worker.abort).toHaveBeenCalledWith(expect.objectContaining({ id: "worker_1" }));
    expect(store.listRecent(1)[0]).toMatchObject({ project_id: path.basename(root), outcome: "terminal" });
    await daemon.stop();
    store.close();
  });

  it("releases claim when worker reaches terminal status", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-complete-"));
    await writeWorkflow(root, "  cleanup_on_terminal: true\n");
    const store = new StateStore(path.join(root, "state.db"));
    store.bootstrap();
    const claims = new ClaimsRegistry();
    const client = { pollIssues: vi.fn(async () => [{ id: "lin_1", identifier: "ENG-1", title: "Test", description: "Body", state: "Ready", labels: [], projectSlug: "proj-a" }]), createComment: vi.fn(), setIssueState: vi.fn() } as any;
    const ctx = { getDataDir: () => path.dirname(root), getConfig: () => ({ extensions: { subagents: { profiles }, orchestrator: { projects: [root] } } }), emit: vi.fn() } as any;
    const worker = mockWorkerRunner({ id: "worker_done", kind: "fake" }, [{ status: "done", exitCode: 0 }]);
    const daemon = new OrchestratorDaemon({ ctx, store, claims, getConfig: () => ({ projects: [root] }), workerRunner: worker.runner, createTrackerClient: () => client });
    await daemon.start();
    await daemon.tick();
    expect(claims.list()).toHaveLength(1);
    await daemon.tick();
    expect(claims.list()).toHaveLength(0);
    expect(store.listRecent(1)[0]).toMatchObject({
      outcome: "completed",
      process_alive: 0,
    });
    await expectWorkspacePreserved(root, "ENG-1");
    await daemon.stop();
    store.close();
  });

  it("manual release finishes the orchestrator run without aborting worker", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-release-"));
    await writeWorkflow(root);
    const store = new StateStore(path.join(root, "state.db"));
    store.bootstrap();
    const claims = new ClaimsRegistry();
    const client = { pollIssues: vi.fn(async () => [{ id: "lin_1", identifier: "ENG-1", title: "Release", description: "Body", state: "Ready", labels: [], projectSlug: "proj-a" }]), createComment: vi.fn(), setIssueState: vi.fn() } as any;
    const ctx = { getDataDir: () => path.dirname(root), getConfig: () => ({ extensions: { orchestrator: { projects: [root] } } }), emit: vi.fn() } as any;
    const worker = mockWorkerRunner({ id: "worker_release", kind: "fake" });
    const daemon = new OrchestratorDaemon({ ctx, store, claims, getConfig: () => ({ projects: [root] }), workerRunner: worker.runner, createTrackerClient: () => client });

    await daemon.start();
    await daemon.tick();
    expect(claims.list()).toHaveLength(1);
    await daemon.releaseRun(path.basename(root), "lin_1", "released");

    expect(worker.abort).not.toHaveBeenCalled();
    expect(claims.list()).toHaveLength(0);
    expect(store.listRecent(1)[0]).toMatchObject({ outcome: "released", process_alive: 0, worker_id: "worker_release" });
    await daemon.stop();
    store.close();
  });

  it("parks issue when worker exits with error", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-error-"));
    await writeWorkflow(root, "  cleanup_on_terminal: true\n");
    const store = new StateStore(path.join(root, "state.db"));
    store.bootstrap();
    const claims = new ClaimsRegistry();
    const client = { pollIssues: vi.fn(async () => [{ id: "lin_1", identifier: "ENG-1", title: "Test", description: "Body", state: "Ready", labels: [], projectSlug: "proj-a" }]), createComment: vi.fn(async () => undefined), setIssueState: vi.fn(async () => undefined) } as any;
    const ctx = { getDataDir: () => path.dirname(root), getConfig: () => ({ extensions: { subagents: { profiles }, orchestrator: { projects: [root] } } }), emit: vi.fn() } as any;
    const worker = mockWorkerRunner({ id: "worker_error", kind: "fake" }, [{ status: "error", exitCode: 1 }]);
    const daemon = new OrchestratorDaemon({ ctx, store, claims, getConfig: () => ({ projects: [root] }), workerRunner: worker.runner, createTrackerClient: () => client });
    await daemon.start();
    await daemon.tick();
    await daemon.tick();
    expect(client.createComment).toHaveBeenCalledWith("lin_1", "Orchestrator parked issue: worker exited with error (exit 1)");
    expect(client.setIssueState).toHaveBeenCalledWith("lin_1", "Needs Human");
    expect(worker.abort).toHaveBeenCalledWith(expect.objectContaining({ id: "worker_error" }));
    expect(claims.list()).toHaveLength(0);
    expect(store.listRecent(1)[0]).toMatchObject({ outcome: "error", process_alive: 0, worker_id: "worker_error" });
    await daemon.stop();
    store.close();
  });

  it("stops active worker when claimed issue is observed in Needs Human", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-hitl-"));
    await writeWorkflow(root, "  cleanup_on_terminal: true\n");
    const store = new StateStore(path.join(root, "state.db"));
    store.bootstrap();
    const claims = new ClaimsRegistry();
    let state = "Ready";
    const client = { pollIssues: vi.fn(async () => [{ id: "lin_1", identifier: "ENG-1", title: "Test", description: "Body", state, labels: [], projectSlug: "proj-a" }]), createComment: vi.fn(), setIssueState: vi.fn() } as any;
    const ctx = { getDataDir: () => path.dirname(root), getConfig: () => ({ extensions: { subagents: { profiles }, orchestrator: { projects: [root] } } }), emit: vi.fn() } as any;
    const worker = mockWorkerRunner({ id: "worker_needs_human", kind: "fake" });
    const daemon = new OrchestratorDaemon({ ctx, store, claims, getConfig: () => ({ projects: [root] }), workerRunner: worker.runner, createTrackerClient: () => client });
    await daemon.start();
    await daemon.tick();

    state = "Needs Human";
    await daemon.tick();

    expect(worker.abort).toHaveBeenCalledWith(expect.objectContaining({ id: "worker_needs_human" }));
    expect(claims.list()).toHaveLength(0);
    expect(store.listRecent(1)[0]).toMatchObject({ outcome: "needs_human", process_alive: 0, worker_id: "worker_needs_human" });
    await daemon.stop();
    store.close();
  });

  it("retries same issue with unique label and attempt", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-retry-"));
    await writeWorkflow(root);
    await fs.appendFile(
      path.join(root, "WORKFLOW.md"),
      "Attempt {{attempt}}\n"
    );
    const store = new StateStore(path.join(root, "state.db"));
    store.bootstrap();
    store.insertRun({
      runId: "old",
      projectId: path.basename(root),
      issueId: "lin_1",
      identifier: "ENG-1",
      workspace: path.join(root, "workspaces", "eng-1"),
      profileJson: "{}",
      workflowPath: path.join(root, "WORKFLOW.md"),
      workflowSha: "abc",
      pid: null,
      startedAt: new Date().toISOString(),
    });
    store.finishRun("old", "interrupted_gateway_restart");
    const claims = new ClaimsRegistry();
    const client = { pollIssues: vi.fn(async () => [{ id: "lin_1", identifier: "ENG-1", title: "Test", description: "Body", state: "Ready", labels: [], projectSlug: "proj-a" }]), createComment: vi.fn(), setIssueState: vi.fn() } as any;
    const ctx = { getDataDir: () => path.dirname(root), getConfig: () => ({ extensions: { subagents: { profiles }, orchestrator: { projects: [root] } } }), emit: vi.fn() } as any;
    const worker = mockWorkerRunner({ id: "worker_retry", kind: "fake" });
    const daemon = new OrchestratorDaemon({ ctx, store, claims, getConfig: () => ({ projects: [root] }), workerRunner: worker.runner, createTrackerClient: () => client });
    await daemon.start();
    await daemon.tick();
    const calls = worker.start.mock.calls as Array<[Record<string, unknown>]>;
    expect(calls).toHaveLength(1);
    const input = calls[0]![0];
    expect(input.label).toMatch(/^ENG-1-\d+$/);
    expect(input.prompt).toEqual(expect.stringContaining("Attempt 2"));
    await daemon.stop();
    store.close();
  });

  it("manual claim runs project-scoped dispatch", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-claim-"));
    await writeWorkflow(root);
    const store = new StateStore(path.join(root, "state.db"));
    store.bootstrap();
    const claims = new ClaimsRegistry();
    const issue = { id: "lin_1", identifier: "ENG-1", title: "Manual", description: "Body", state: "Ready", labels: [], projectSlug: "proj-a" };
    const client = { getIssue: vi.fn(async () => issue), pollIssues: vi.fn(), createComment: vi.fn(), setIssueState: vi.fn() } as any;
    const ctx = { getDataDir: () => path.dirname(root), getConfig: () => ({ extensions: { subagents: { profiles }, orchestrator: { projects: [root] } } }), emit: vi.fn() } as any;
    const worker = mockWorkerRunner({ id: "worker_manual", kind: "fake" });
    const daemon = new OrchestratorDaemon({ ctx, store, claims, getConfig: () => ({ projects: [root] }), workerRunner: worker.runner, createTrackerClient: () => client });
    await daemon.start();
    await expect(daemon.claimNow("ENG-1")).resolves.toEqual({ ok: true });
    expect(client.getIssue).toHaveBeenCalledWith("ENG-1");
    expect(worker.start).toHaveBeenCalledWith(expect.objectContaining({ workspace: path.join(root, "workspaces", "eng-1") }));
    await expect(daemon.claimNow("ENG-1")).resolves.toMatchObject({ ok: false, status: 409 });
    await daemon.stop();
    store.close();
  });

  it("honors per-project polling cadence", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-polling-"));
    const fast = path.join(home, "fast");
    const slow = path.join(home, "slow");
    await fs.mkdir(fast);
    await fs.mkdir(slow);
    await writeWorkflow(
      fast,
      "polling:\n  interval_ms: 1000\n  jitter_ms: 0\n"
    );
    await writeCustomWorkflow(slow, {
      projectSlug: "proj-b",
      intervalMs: 5000,
    });
    const store = new StateStore(path.join(home, "state.db"));
    store.bootstrap();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const ctx = { getDataDir: () => home, getConfig: () => ({ extensions: { subagents: { profiles }, orchestrator: { projects: [fast, slow] } } }), emit: vi.fn() } as any;
    const daemon = new OrchestratorDaemon({ ctx, store, claims: new ClaimsRegistry(), getConfig: () => ({ projects: [fast, slow] }), createTrackerClient: () => ({ pollIssues: vi.fn(async () => []) } as any) });
    try {
      await daemon.start();
      const delays = setTimeoutSpy.mock.calls.map((call) => call[1]);
      expect(delays).toContain(1000);
      expect(delays).toContain(5000);
    } finally {
      setTimeoutSpy.mockRestore();
      await daemon.stop();
      store.close();
    }
  });

  it("marks open runs interrupted on startup instead of reattaching", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-recovery-"));
    await writeWorkflow(root);
    const store = new StateStore(path.join(root, "state.db"));
    store.bootstrap();
    store.insertRun({ runId: "r1", projectId: path.basename(root), issueId: "lin_1", identifier: "ENG-1", workspace: path.join(root, "workspaces", "eng-1"), profileJson: "{}", workflowPath: path.join(root, "WORKFLOW.md"), workflowSha: "abc", pid: 1, startedAt: new Date().toISOString() });
    const ctx = { getDataDir: () => path.dirname(root), getConfig: () => ({ extensions: { subagents: { profiles }, orchestrator: { projects: [root] } } }), emit: vi.fn() } as any;
    store.setWorkerId("r1", "sub_stale");
    const daemon = new OrchestratorDaemon({ ctx, store, claims: new ClaimsRegistry(), getConfig: () => ({ projects: [root] }), createTrackerClient: () => ({ pollIssues: vi.fn(async () => []) } as any) });
    await daemon.start();
    expect(store.listRecent(1)[0]).toMatchObject({ outcome: "interrupted_gateway_restart" });
    await daemon.stop();
    store.close();
  });

  it("coalesces queued ticks and batches HITL notifications", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-queue-"));
    await writeWorkflow(root);
    const store = new StateStore(path.join(root, "state.db"));
    store.bootstrap();
    let resolvePoll: (() => void) | undefined;
    const pollGate = new Promise<void>((resolve) => {
      resolvePoll = resolve;
    });
    let polls = 0;
    const client = {
      pollIssues: vi.fn(async () => {
        polls += 1;
        if (polls === 1) await pollGate;
        return [];
      }),
    } as any;
    const sent: string[] = [];
    const ctx = { getDataDir: () => path.dirname(root), getConfig: () => ({ extensions: { subagents: { profiles }, orchestrator: { projects: [root], notifyChannel: "ops" } } }), emit: vi.fn() } as any;
    const daemon = new OrchestratorDaemon({ ctx, store, claims: new ClaimsRegistry(), getConfig: () => ({ projects: [root], notifyChannel: "ops" }), createTrackerClient: () => client, notify: async (message) => { sent.push(message); } });
    await daemon.start();
    daemon.enqueueTick();
    daemon.enqueueTick();
    resolvePoll?.();
    await vi.waitFor(() => expect(polls).toBe(2));
    for (let i = 0; i < 5; i += 1) daemon.notifyRunFailed(`ENG-${i}`, "boom");
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toContain("ENG-0");
    await daemon.stop();
    store.close();
  });

  it("bootstraps project-aware sqlite state", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-db-"));
    const store = new StateStore(path.join(root, "state.db"));
    store.bootstrap();
    store.insertRun({
      runId: "r1",
      projectId: "p1",
      issueId: "i1",
      identifier: "ENG-1",
      workspace: root,
      profileJson: "{}",
      workflowPath: path.join(root, "WORKFLOW.md"),
      workflowSha: "abc",
      pid: 1,
      startedAt: new Date().toISOString(),
    });
    store.appendEvent("r1", "x", { ok: true }, "p1");
    expect(store.listRecent(1, "p1")).toHaveLength(1);
    expect(store.listEvents("r1")).toHaveLength(1);
    store.finishRun("r1", "done", 0);
    store.close();
  });

  it("stores new event payloads in per-run JSONL with sqlite metadata only", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-jsonl-"));
    const dbPath = path.join(root, "state.db");
    const store = new StateStore(dbPath);
    store.bootstrap();
    store.insertRun({ runId: "orchestrator:p1:i1:1", projectId: "p1", issueId: "i1", identifier: "ENG-1", workspace: path.join(root, "workspaces", "eng-1"), profileJson: "{}", workflowPath: path.join(root, "WORKFLOW.md"), workflowSha: "abc", pid: null, startedAt: new Date(1).toISOString() });
    store.appendEvent("orchestrator:p1:i1:1", "worker.codex.tool_output", { output: "x".repeat(6000) }, "p1");

    const db = new Database(dbPath);
    const row = db.prepare("SELECT payload, payload_preview, log_path, log_offset, log_line FROM events").get() as Record<string, unknown>;
    db.close();
    expect(row.payload).toBeNull();
    expect(row.log_path).toBe(path.join(".yoplai", "codex", "19700101T000000Z-b3JjaGVzdHJhdG9yOnAxOmkxOjE.jsonl"));
    expect(row.log_offset).toBe(0);
    expect(row.log_line).toBe(1);
    expect(String(row.payload_preview).length).toBeLessThan(5000);

    const logPath = path.join(root, String(row.log_path));
    const line = JSON.parse((await fs.readFile(logPath, "utf8")).trim()) as Record<string, unknown>;
    expect(line).toMatchObject({ project_id: "p1", run_id: "orchestrator:p1:i1:1", type: "worker.codex.tool_output" });
    expect((line.payload as { output: string }).output).toHaveLength(6000);
    const hydrated = store.listEvents("orchestrator:p1:i1:1") as Array<Record<string, unknown>>;
    expect(JSON.parse(String(hydrated[0].payload)).output).toHaveLength(6000);
    store.close();
  });

  it("handles undefined payloads and keeps encoded run log paths distinct", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-jsonl-undefined-"));
    const store = new StateStore(path.join(root, "state.db"));
    store.bootstrap();
    store.insertRun({ runId: "a:b", projectId: "p1", issueId: "i1", identifier: "ENG-1", workspace: "/", profileJson: "{}", workflowPath: path.join(root, "WORKFLOW.md"), workflowSha: "s", pid: null, startedAt: new Date(1).toISOString() });
    store.insertRun({ runId: "a_3Ab", projectId: "p1", issueId: "i2", identifier: "ENG-2", workspace: "/", profileJson: "{}", workflowPath: path.join(root, "WORKFLOW.md"), workflowSha: "s", pid: null, startedAt: new Date(2).toISOString() });
    store.appendEvent("a:b", "worker.empty", undefined, "p1");
    store.appendEvent("a_3Ab", "worker.empty", undefined, "p1");

    const first = store.listEvents("a:b") as Array<Record<string, unknown>>;
    const second = store.listEvents("a_3Ab") as Array<Record<string, unknown>>;
    expect(first).toEqual([expect.objectContaining({ payload: "null" })]);
    expect(second).toEqual([expect.objectContaining({ payload: "null" })]);

    const firstPath = String(first[0].log_path);
    const secondPath = String(second[0].log_path);
    expect(firstPath).not.toBe(secondPath);
    await expect(fs.access(path.join(root, firstPath))).resolves.toBeUndefined();
    await expect(fs.access(path.join(root, secondPath))).resolves.toBeUndefined();
    store.close();
  });

  it("reads legacy DB-only events mixed with JSONL-backed events by cursor", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-mixed-"));
    const dbPath = path.join(root, "state.db");
    const store = new StateStore(dbPath);
    store.bootstrap();
    store.insertRun({ runId: "r1", projectId: "p1", issueId: "i1", identifier: "ENG-1", workspace: "/", profileJson: "{}", workflowPath: path.join(root, "WORKFLOW.md"), workflowSha: "s", pid: null, startedAt: new Date(1).toISOString() });
    const db = new Database(dbPath);
    db.prepare("INSERT INTO events (project_id,run_id,type,payload,created_at) VALUES (?,?,?,?,?)").run("p1", "r1", "worker.started", JSON.stringify({ legacy: true }), new Date().toISOString());
    db.close();
    store.appendEvent("r1", "worker.claude.message", { text: "jsonl" }, "p1");

    expect(store.listEvents("r1", 0)).toEqual([
      expect.objectContaining({ id: 1, payload: JSON.stringify({ legacy: true }) }),
      expect.objectContaining({ id: 2, payload: JSON.stringify({ text: "jsonl" }) }),
    ]);
    expect(store.listEvents("r1", 1)).toEqual([
      expect.objectContaining({ id: 2, payload: JSON.stringify({ text: "jsonl" }) }),
    ]);
    store.close();
  });

  it("reads and deletes prior state-root JSONL rows for runs with workflow paths", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-legacy-jsonl-"));
    const project = path.join(root, "project");
    const state = path.join(root, "state");
    await fs.mkdir(path.join(state, "runs", "cjE"), { recursive: true });
    const legacyLog = path.join(state, "runs", "cjE", "logs.jsonl");
    await fs.writeFile(legacyLog, `${JSON.stringify({ payload: { text: "legacy jsonl payload" } })}\n`, "utf8");
    const store = new StateStore(path.join(state, "state.db"));
    store.bootstrap();
    store.insertRun({ runId: "r1", projectId: "p1", issueId: "i1", identifier: "ENG-1", workspace: "/", profileJson: "{}", workflowPath: path.join(project, "WORKFLOW.md"), workflowSha: "s", pid: null, startedAt: new Date(1).toISOString() });
    const db = new Database(path.join(state, "state.db"));
    db.prepare("INSERT INTO events (project_id,run_id,type,payload,created_at,log_path,log_offset,log_line,payload_preview) VALUES (?,?,?,?,?,?,?,?,?)").run("p1", "r1", "worker.message", null, new Date().toISOString(), path.join("runs", "cjE", "logs.jsonl"), 0, 1, JSON.stringify({ text: "preview" }));
    db.close();

    expect(store.listEvents("r1")).toEqual([
      expect.objectContaining({ payload: JSON.stringify({ text: "legacy jsonl payload" }) }),
    ]);
    expect(store.deleteRunLogs("r1")).toBe(true);
    await expect(fs.access(legacyLog)).rejects.toThrow();
    store.close();
  });

  it("can delete per-run JSONL while preserving preview metadata", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-delete-"));
    const store = new StateStore(path.join(root, "state.db"));
    store.bootstrap();
    store.insertRun({ runId: "r1", projectId: "p1", issueId: "i1", identifier: "ENG-1", workspace: "/", profileJson: "{}", workflowPath: path.join(root, "WORKFLOW.md"), workflowSha: "s", pid: null, startedAt: new Date(1).toISOString() });
    store.appendEvent("r1", "worker.claude.message", { text: "short preview" }, "p1");

    expect(store.deleteRunLogs("r1")).toBe(true);
    const rows = store.listEvents("r1") as Array<Record<string, unknown>>;
    expect(rows).toEqual([
      expect.objectContaining({ payload: JSON.stringify({ text: "short preview" }), payload_preview: JSON.stringify({ text: "short preview" }) }),
    ]);
    await expect(fs.access(path.join(root, ".yoplai", "codex", "19700101T000000Z-cjE.jsonl"))).rejects.toThrow();
    store.close();
  });

  it("ignores corrupted log paths outside the orchestrator state directory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-path-root-"));
    const sibling = `${root}-sibling`;
    await fs.mkdir(sibling);
    const outside = path.join(sibling, "outside.jsonl");
    await fs.writeFile(outside, `${JSON.stringify({ payload: { text: "outside" } })}\n`);
    const dbPath = path.join(root, "state.db");
    const store = new StateStore(dbPath);
    store.bootstrap();
    const db = new Database(dbPath);
    db.prepare("INSERT INTO events (project_id,run_id,type,payload,created_at,log_path,log_offset,log_line,payload_preview) VALUES (?,?,?,?,?,?,?,?,?)").run("p1", "r1", "worker.message", null, new Date().toISOString(), path.relative(root, outside), 0, 1, JSON.stringify({ text: "preview" }));
    db.close();

    expect(store.listEvents("r1")).toEqual([
      expect.objectContaining({ payload: JSON.stringify({ text: "preview" }) }),
    ]);
    expect(store.deleteRunLogs("r1")).toBe(false);
    await expect(fs.access(outside)).resolves.toBeUndefined();
    store.close();
  });

  it("countConsecutiveCompletedRuns counts streak of completed outcomes since last non-completed", () => {
    const store = new StateStore(":memory:");
    store.bootstrap();
    const t = Date.now();
    const seed = (runId: string, outcome: string, offset: number) => {
      store.insertRun({ runId, projectId: "p1", issueId: "i1", identifier: "ENG-1", workspace: "/", profileJson: "{}", workflowPath: "w", workflowSha: "s", pid: null, startedAt: new Date(t + offset).toISOString() });
      store.finishRun(runId, outcome);
    };

    expect(store.countConsecutiveCompletedRuns("i1", "p1")).toBe(0);
    seed("r1", "completed", 0);
    expect(store.countConsecutiveCompletedRuns("i1", "p1")).toBe(1);
    seed("r2", "completed", 1);
    expect(store.countConsecutiveCompletedRuns("i1", "p1")).toBe(2);
    seed("r3", "terminal", 2);
    expect(store.countConsecutiveCompletedRuns("i1", "p1")).toBe(0);
    seed("r4", "completed", 3);
    expect(store.countConsecutiveCompletedRuns("i1", "p1")).toBe(1);
    store.close();
  });

  it("parks issue after max_active_runs consecutive completed runs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-cap-park-"));
    await fs.writeFile(path.join(root, "WORKFLOW.md"), `---
tracker:
  kind: linear
  api_key: test-key
  project_slug: proj-a
  active_states: [Ready]
  terminal_states: [Done]
agent:
  profile: default
  max_active_runs: 2
  max_concurrent: 1
workspace:
  root: ./workspaces
---
Do {{issue.identifier}}
`);
    const store = new StateStore(path.join(root, "state.db"));
    store.bootstrap();
    const projectId = path.basename(root);
    const t = Date.now();
    for (let i = 0; i < 2; i++) {
      const runId = `seed-${i}`;
      store.insertRun({ runId, projectId, issueId: "lin_1", identifier: "ENG-1", workspace: "/", profileJson: "{}", workflowPath: "WORKFLOW.md", workflowSha: "s", pid: null, startedAt: new Date(t + i).toISOString() });
      store.finishRun(runId, "completed");
    }
    const claims = new ClaimsRegistry();
    const client = { pollIssues: vi.fn(async () => [{ id: "lin_1", identifier: "ENG-1", title: "Loop", state: "Ready", labels: [], projectSlug: "proj-a" }]), createComment: vi.fn(async () => undefined), setIssueState: vi.fn(async () => undefined) } as any;
    const worker = mockWorkerRunner();
    const ctx = { getDataDir: () => path.dirname(root), getConfig: () => ({ extensions: { subagents: { profiles }, orchestrator: { projects: [root] } } }), emit: vi.fn() } as any;
    const daemon = new OrchestratorDaemon({ ctx, store, claims, getConfig: () => ({ projects: [root] }), workerRunner: worker.runner, createTrackerClient: () => client });

    await daemon.start();
    await daemon.tick();

    expect(worker.start).not.toHaveBeenCalled();
    expect(client.createComment).toHaveBeenCalledWith("lin_1", expect.stringContaining("2 consecutive run"));
    expect(client.setIssueState).toHaveBeenCalledWith("lin_1", "Needs Human");
    await daemon.stop();
    store.close();
  });

  it("resets consecutive run count after a non-completed outcome so future dispatches proceed", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-cap-reset-"));
    await fs.writeFile(path.join(root, "WORKFLOW.md"), `---
tracker:
  kind: linear
  api_key: test-key
  project_slug: proj-a
  active_states: [Ready]
  terminal_states: [Done]
agent:
  profile: default
  max_active_runs: 2
  max_concurrent: 1
workspace:
  root: ./workspaces
---
Do {{issue.identifier}}
`);
    const store = new StateStore(path.join(root, "state.db"));
    store.bootstrap();
    const projectId = path.basename(root);
    const t = Date.now();
    for (let i = 0; i < 2; i++) {
      const runId = `seed-completed-${i}`;
      store.insertRun({ runId, projectId, issueId: "lin_1", identifier: "ENG-1", workspace: "/", profileJson: "{}", workflowPath: "WORKFLOW.md", workflowSha: "s", pid: null, startedAt: new Date(t + i).toISOString() });
      store.finishRun(runId, "completed");
    }
    store.insertRun({ runId: "seed-terminal", projectId, issueId: "lin_1", identifier: "ENG-1", workspace: "/", profileJson: "{}", workflowPath: "WORKFLOW.md", workflowSha: "s", pid: null, startedAt: new Date(t + 2).toISOString() });
    store.finishRun("seed-terminal", "terminal");

    const claims = new ClaimsRegistry();
    const client = { pollIssues: vi.fn(async () => [{ id: "lin_1", identifier: "ENG-1", title: "Reset", state: "Ready", labels: [], projectSlug: "proj-a" }]), createComment: vi.fn(async () => undefined), setIssueState: vi.fn(async () => undefined) } as any;
    const worker = mockWorkerRunner();
    const ctx = { getDataDir: () => path.dirname(root), getConfig: () => ({ extensions: { subagents: { profiles }, orchestrator: { projects: [root] } } }), emit: vi.fn() } as any;
    const daemon = new OrchestratorDaemon({ ctx, store, claims, getConfig: () => ({ projects: [root] }), workerRunner: worker.runner, createTrackerClient: () => client });

    await daemon.start();
    await expect(daemon.tick()).resolves.toMatchObject({ dispatched: 1 });

    expect(worker.start).toHaveBeenCalledOnce();
    expect(client.setIssueState).not.toHaveBeenCalledWith("lin_1", "Needs Human");
    await daemon.stop();
    store.close();
  });

  it("resets consecutive run count after parking for max_active_runs so reactivation can dispatch", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-cap-reactivate-"));
    await fs.writeFile(path.join(root, "WORKFLOW.md"), `---
tracker:
  kind: linear
  api_key: test-key
  project_slug: proj-a
  active_states: [Ready]
  terminal_states: [Done]
agent:
  profile: default
  max_active_runs: 2
  max_concurrent: 1
workspace:
  root: ./workspaces
---
Do {{issue.identifier}}
`);
    const store = new StateStore(path.join(root, "state.db"));
    store.bootstrap();
    const projectId = path.basename(root);
    const t = Date.now();
    for (let i = 0; i < 2; i++) {
      const runId = `seed-${i}`;
      store.insertRun({ runId, projectId, issueId: "lin_1", identifier: "ENG-1", workspace: "/", profileJson: "{}", workflowPath: "WORKFLOW.md", workflowSha: "s", pid: null, startedAt: new Date(t + i).toISOString() });
      store.finishRun(runId, "completed");
    }
    const claims = new ClaimsRegistry();
    const client = { pollIssues: vi.fn(async () => [{ id: "lin_1", identifier: "ENG-1", title: "Loop", state: "Ready", labels: [], projectSlug: "proj-a" }]), createComment: vi.fn(async () => undefined), setIssueState: vi.fn(async () => undefined) } as any;
    const worker = mockWorkerRunner();
    const ctx = { getDataDir: () => path.dirname(root), getConfig: () => ({ extensions: { subagents: { profiles }, orchestrator: { projects: [root] } } }), emit: vi.fn() } as any;
    const daemon = new OrchestratorDaemon({ ctx, store, claims, getConfig: () => ({ projects: [root] }), workerRunner: worker.runner, createTrackerClient: () => client });

    await daemon.start();
    await daemon.tick();

    expect(worker.start).not.toHaveBeenCalled();
    expect(client.setIssueState).toHaveBeenCalledWith("lin_1", "Needs Human");

    // Simulate human reactivating the issue
    client.setIssueState.mockClear();
    worker.start.mockClear();
    claims.release("lin_1", projectId);

    await expect(daemon.tick()).resolves.toMatchObject({ dispatched: 1 });

    expect(worker.start).toHaveBeenCalledOnce();
    expect(client.setIssueState).not.toHaveBeenCalledWith("lin_1", "Needs Human");
    await daemon.stop();
    store.close();
  });

  it("uses default max_active_runs of 3 and does not park below threshold", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-orch-cap-default-"));
    await writeWorkflow(root);
    const store = new StateStore(path.join(root, "state.db"));
    store.bootstrap();
    const projectId = path.basename(root);
    const t = Date.now();
    for (let i = 0; i < 2; i++) {
      const runId = `seed-${i}`;
      store.insertRun({ runId, projectId, issueId: "lin_1", identifier: "ENG-1", workspace: "/", profileJson: "{}", workflowPath: "WORKFLOW.md", workflowSha: "s", pid: null, startedAt: new Date(t + i).toISOString() });
      store.finishRun(runId, "completed");
    }
    const claims = new ClaimsRegistry();
    const client = { pollIssues: vi.fn(async () => [{ id: "lin_1", identifier: "ENG-1", title: "Default", state: "Ready", labels: [], projectSlug: "proj-a" }]), createComment: vi.fn(async () => undefined), setIssueState: vi.fn(async () => undefined) } as any;
    const worker = mockWorkerRunner();
    const ctx = { getDataDir: () => path.dirname(root), getConfig: () => ({ extensions: { subagents: { profiles }, orchestrator: { projects: [root] } } }), emit: vi.fn() } as any;
    const daemon = new OrchestratorDaemon({ ctx, store, claims, getConfig: () => ({ projects: [root] }), workerRunner: worker.runner, createTrackerClient: () => client });

    await daemon.start();
    await expect(daemon.tick()).resolves.toMatchObject({ dispatched: 1 });
    expect(worker.start).toHaveBeenCalledOnce();
    expect(client.setIssueState).not.toHaveBeenCalledWith("lin_1", "Needs Human");

    store.insertRun({ runId: "seed-5th", projectId, issueId: "lin_1", identifier: "ENG-1", workspace: "/", profileJson: "{}", workflowPath: "WORKFLOW.md", workflowSha: "s", pid: null, startedAt: new Date(t + 100).toISOString() });
    store.finishRun("seed-5th", "completed");
    worker.start.mockClear();
    claims.release("lin_1", projectId);
    await expect(daemon.tick()).resolves.toMatchObject({ dispatched: 0 });
    expect(worker.start).not.toHaveBeenCalled();
    expect(client.createComment).toHaveBeenCalledWith("lin_1", expect.stringContaining("max_active_runs=3"));
    await daemon.stop();
    store.close();
  });
});
