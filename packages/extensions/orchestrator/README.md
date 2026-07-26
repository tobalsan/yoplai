# @yoplai/extension-orchestrator

Symphony-aligned issue orchestrator for Yoplai. Tracker-agnostic: each project's `WORKFLOW.md` picks `tracker.kind: linear` or `tracker.kind: plane`.

## Yoplai config

Yoplai config lists project folders and supervisor limits only:

```json
{
  "extensions": {
    "orchestrator": {
      "projects": ["./projects/yoplai"],
      "projectsRoot": "~/projects",
      "concurrency": { "global": 3 }
    }
  }
}
```

Each project folder must contain uppercase `WORKFLOW.md`.
Orchestrator workers run through orchestrator-owned protocol runners configured in each project `WORKFLOW.md`; the `subagents` extension is not required for orchestrator dispatch. The separate `subagents` extension remains available for manual/generic project runs.

### `extensions.orchestrator` schema

Full schema:

```json
{
  "enabled": true,
  "projects": ["./projects/yoplai"],
  "projectsRoot": "~/projects",
  "concurrency": { "global": 3 },
  "validation": { "strict": true },
  "notifyChannel": "ops",
  "linear": { "exposeGraphqlTool": true },
  "plane": { "exposeApiTool": true },
  "webhook": {
    "enabled": true,
    "path": "/api/orchestrator/webhook",
    "secret": "$ORCHESTRATOR_WEBHOOK_SECRET"
  }
}
```

Fields:

- `enabled` optional boolean. Enables/disables extension when present in config.
- `projects` required in practice, optional in schema. Project folders containing `WORKFLOW.md`. Default `[]`.
- `projectsRoot` optional string. Root folder used by `orchestrator init-project` for newly scaffolded projects. Default `~/projects`.
- `concurrency.global` optional positive integer. Max workers across all projects. Default `3` at runtime.
- `validation.strict` optional boolean. Fail startup on invalid configured project. Default `true`.
- `notifyChannel` optional string. Notification channel for HITL/stall/startup errors.
- `linear.exposeGraphqlTool` optional boolean. Expose `orchestrator.linear_graphql` to workers. Default `true`.
- `plane.exposeApiTool` optional boolean. Expose `orchestrator.plane_api` to workers. Default `true`.
- `webhook.enabled` optional boolean. Enables the tracker webhook receiver (Linear and/or Plane).
- `webhook.path` optional string. Reserved webhook path metadata; route is mounted under `/api/orchestrator/webhook`.
- `webhook.secret` optional string. Shared HMAC secret used to verify both Linear and Plane webhook signatures.

No orchestrator repo map, default repo, worktree, poll interval, or `workspacesRoot` settings live in `yoplai.json`. Project runtime settings live in each project `WORKFLOW.md`.

## Create a tracker project + WORKFLOW.md

Bootstrap a tracker project and local orchestrator project folder:

```bash
pnpm yoplai:dev orchestrator init-project "Foo Bar"
pnpm yoplai:dev orchestrator init-project "Foo Bar" --tracker plane
```

`--tracker <linear|plane>` selects the tracker; default `linear`.

Linear (`--tracker linear`, default):

- Reads `extensions.orchestrator.projectsRoot`, defaulting to `~/projects`.
- Creates a Linear project named `Foo Bar`.
- Creates `<projectsRoot>/foo-bar`.
- Writes `WORKFLOW.md` with `tracker.project_slug` set to the created Linear project's `slugId`.
- Appends the project folder path to `extensions.orchestrator.projects` in `$YOPLAI_HOME/yoplai.json`.
- Requires `LINEAR_API_KEY` in the environment.

Plane (`--tracker plane`):

- Requires one Plane auth env (`PLANE_BOT_TOKEN`, `PLANE_OAUTH_TOKEN`, or `PLANE_API_KEY`) and `PLANE_WORKSPACE_SLUG` in the environment. Precedence is bot token, OAuth token, then API key.
- `PLANE_BASE_URL` optional, default `https://api.plane.so`.
- `PLANE_PROJECT_ID` optional. When unset, creates a new **Plane project** named `Foo Bar` and writes `tracker.project_id` from the created project. When set, creates a **module** named `Foo Bar` inside that existing project instead, and writes both `tracker.project_id` (the given `PLANE_PROJECT_ID`) and `tracker.module_id` (the created module) — see [module vs project scoping](#module-vs-project-scoping).
- Writes `WORKFLOW.md` with `tracker.kind: plane` and the resolved `workspace_slug`/`project_id`/`module_id`; `base_url` is only written when `PLANE_BASE_URL` overrides the default.
- Appends the project folder path to `extensions.orchestrator.projects` in `$YOPLAI_HOME/yoplai.json`.

The local project folder must not already exist and a same-named project/module on the configured tracker must not already exist. Because project registration is read at gateway startup, restart the gateway after running `init-project`.

## Create WORKFLOW.md

Generate starter workflow explicitly:

```bash
pnpm yoplai:dev orchestrator init-workflow \
  --project ./projects/yoplai \
  --project-slug yoplai
```

Options:

- `--project <path>`: project folder to create/update.
- `--project-slug <slug>`: Linear project `slugId` used for polling.
- `--profile <name>`: optional orchestrator profile override. When omitted, the runner supplies protocol defaults.
- `--force`: overwrite existing `WORKFLOW.md`.

`init-workflow` only has a CLI flag for the Linear `tracker.project_slug` today; it always scaffolds a `tracker.kind: linear` block. For Plane, use `init-project --tracker plane` (below), or run `init-workflow` and then hand-edit the `tracker:` block to the Plane shape shown under [WORKFLOW.md configuration](#workflowmd-configuration).

The generator never creates a global fallback workflow. It only writes project-owned `WORKFLOW.md`.

## WORKFLOW.md configuration

Full example (Linear):

```yaml
---
tracker:
  kind: linear
  endpoint: https://api.linear.app/graphql
  api_key: $LINEAR_API_KEY
  project_slug: yoplai
  active_states: [Todo, In Progress]
  terminal_states: [Closed, Cancelled, Canceled, Duplicate, Done]
  needs_human: Needs Human
polling:
  interval_ms: 30000
  jitter_ms: 5000
workspace:
  root: ./workspaces
  cleanup_on_terminal: false
  reuse: true
agent:
  runner: pi
  model: null
  thinking: medium
  max_concurrent: 3
  max_turns: 10
  turn_timeout_ms: 3600000
  stall_timeout_ms: 300000
hooks:
  after_create: null
  before_run: null
  after_run: null
  before_remove: null
linear:
  exposeGraphqlTool: true
---
You are working on Linear issue {{issue.identifier}}.

## DO THIS FIRST

1. Fetch Linear issue {{issue.identifier}}.
2. If current state is `Todo`, move it to `In Progress`.
3. Add or update one Linear comment signaling you are working on the issue.
4. Continue only after those Linear updates succeed.

Do not perform task work before this claim step.

## Workspace Rule

Work only inside the issue workspace. If repositories are needed, clone or use them inside this workspace unless hooks prepared them already.

## Linear Workflow

Update Linear with concise progress, validation results, and final handoff. Prefer updating your initial Linear comment while no other comments follow it. If another person or agent has commented after your initial comment, post a new comment instead so the timeline stays clear.

When the work is complete and validated, move the issue to `In Review`. If you are blocked, move the issue to `Needs Human` and update the comment with the blocker, what you tried, and the decision needed.

## Code Changes and Review Flow

If, and only if, you need to make code changes:

1. Create a worktree from the `main` branch and work there.
2. Spawn a reviewer subagent to run a code review.
3. Do not commit anything until the review comes back clean.
4. Once review is clean, commit inside the worktree, create a PR using `gh`, link the PR to the Linear issue, and move the issue to `In Review`.

## Golden Rule: Clarification Over Assumption

Ask rather than assume when requirements, ownership, or risk are unclear. Involve HITL by updating the Linear comment with the question or blocker and moving the issue to `Needs Human`.
```

Full example (Plane), project-scoped:

```yaml
---
tracker:
  kind: plane
  base_url: https://api.plane.so
  workspace_slug: my-workspace
  project_id: 8f14e45f-...
  api_key: $PLANE_BOT_TOKEN # or $PLANE_OAUTH_TOKEN / $PLANE_API_KEY
  auth_kind: bot_token # bot_token | oauth_token | api_key
  mention: Worker Agent # optional bot display name; polls work items assigned to that bot
  active_states: [Todo, In Progress]
  terminal_states: [Closed, Cancelled, Canceled, Duplicate, Done]
  needs_human: Needs Human
polling:
  interval_ms: 30000
  jitter_ms: 5000
workspace:
  root: ./workspaces
agent:
  runner: pi
  model: null
  thinking: medium
  max_concurrent: 3
plane:
  exposeApiTool: true
---
You are working on Plane issue {{issue.identifier}}.

## DO THIS FIRST

1. Fetch Plane issue {{issue.identifier}}.
2. If current state is `Todo`, move it to `In Progress`.
3. Add or update one Plane comment signaling you are working on the issue.
4. Continue only after those Plane updates succeed.
```

Module-scoped Plane project (polls one module's issues instead of the whole project):

```yaml
tracker:
  kind: plane
  workspace_slug: my-workspace
  project_id: 8f14e45f-...
  module_id: 3c9a2b10-...
  api_key: $PLANE_API_KEY
```

### `tracker`

- `kind`: `linear` (default) or `plane`. Unrecognized values fail workflow load with `Unsupported tracker.kind: <kind> (supported: linear, plane)`.
- `api_key`: literal token or `$ENV_VAR`. Linear default `$LINEAR_API_KEY`. Plane may use `$PLANE_BOT_TOKEN`, `$PLANE_OAUTH_TOKEN`, or `$PLANE_API_KEY`; when omitted, Plane resolves envs in that order.
- `auth_kind`: Plane only. `bot_token` and `oauth_token` send `Authorization: Bearer <token>`; `api_key` sends `X-API-Key: <token>`. If omitted, inferred from env fallback or from `api_key: $PLANE_BOT_TOKEN` / `$PLANE_OAUTH_TOKEN`; otherwise defaults to `api_key`.
- `active_states`: states eligible for worker dispatch. Default `[Todo, In Progress]`. Same field, same defaults for both trackers.
- `terminal_states`: states that release claims and optionally clean workspaces. Default `[Closed, Cancelled, Canceled, Duplicate, Done]`. Same field, same defaults for both trackers.
- `needs_human`: exceptional park state. Default `Needs Human`. Orchestrator-owned transitions into this state are hard stops for any active worker run. Same field, same defaults for both trackers.

Linear-only fields:

- `endpoint`: Linear GraphQL endpoint. Defaults to `https://api.linear.app/graphql`.
- `project_slug`: required Linear project `slugId`. Candidate issues are filtered by this.

Plane-only fields:

- `base_url`: Plane origin, e.g. `https://api.plane.so` (Cloud) or a self-hosted origin. No trailing `/api/v1`. Defaults to `https://api.plane.so`.
- `workspace_slug`: required Plane workspace slug.
- `project_id`: required Plane project UUID.
- `module_id`: optional Plane module UUID. When set, polling/lookup scopes to that module instead of the whole project (see [module vs project scoping](#module-vs-project-scoping)).
- `mention`: optional Plane bot display name. The tracker resolves it to one workspace member via a plain `GET /members/` call (case-insensitive substring on `display_name`; zero or multiple matches fail fast). Polling then filters the unfiltered work-items (or module-issues) list client-side to items whose `assignees` include the resolved user id, and still applies `active_states`.

#### Module vs project scoping

- Without `module_id`, the tracker is scoped to the whole Plane project: `pollIssues` reads `GET .../projects/{project_id}/work-items/`, and `getIssue`/`setIssueState`/`createComment`/`export` all operate against that project.
- With `module_id` set, `pollIssues` instead reads `GET .../projects/{project_id}/modules/{module_id}/module-issues/`, and `getIssue` additionally requires the fetched issue to belong to that module (its `module`/`modules` field must match `module_id`) — issues in the same project but outside the module are treated as out of scope (same "return undefined" behavior as a cross-project Linear issue).
- The tracker scope key used for duplicate-registration checks is `workspaceSlug/projectId` for project scope, or `workspaceSlug/projectId/moduleId` for module scope, so one project and one of its modules can be registered as two separate orchestrator projects without colliding.

#### Plane known gaps

- `blocked_by` is populated from Plane's work-item relations endpoint, resolving each blocker's identifier/state (fetching the blocker individually if it wasn't in the already-polled page). Behaves the same as Linear's `{{issue.blocked_by}}`.
- `{{issue.labels}}` is always an empty array for Plane issues today — label UUID → name resolution is not implemented, since no shipped workflow prompt/logic branches on labels.
- `{{issue.priority}}` is always `null` for Plane issues — Plane's priority is a string enum while `TrackerIssue.priority` is `number | null`, so it is not mapped.

### `polling`

- `interval_ms`: base delay between project ticks. Default `30000`.
- `jitter_ms`: random +/- jitter added to interval. Default `5000`.

Each configured project has its own polling schedule.

### `workspace`

- `root`: per-issue workspace root. Default `./workspaces`.
- `cleanup_on_terminal`: remove issue workspace only for release outcomes `terminal`, `hook_failed`, and `dispatch_failed`. Default `false`.
- `reuse`: preserve/reuse existing issue workspace. Default `true`.

Path rules:

- Relative paths resolve relative to the project folder containing `WORKFLOW.md`.
- `~` expands to home.
- `$YOPLAI_HOME` and `$YOPLAI_HOME/...` are supported.
- Worker cwd is `<workspace.root>/<sanitized-issue-identifier>`.
- Core orchestrator only creates directories. It does not clone repos or create worktrees.
- Workspaces are preserved for `needs_human`, worker `completed`, worker `error`, worker `interrupted`, and `stalled` releases so operators can inspect or retry them.

### `agent`

- `runner`: orchestrator-owned protocol runner. Supported values are `pi`, `claude`, `codex`, `cli`, and `fake`. Default `pi` when no profile runner is resolved. For legacy `agent.profile`-only workflows, the matched profile `cli` still selects the runner.
- `command`: optional runner command, as an executable string or `[executable, ...args]` array. Use the array form when arguments are needed; string commands are not shell-split. `pi`, `claude`, and `codex` have built-in defaults (`codex` defaults to `codex app-server`, matching Symphony), so `command` is optional for them and only needed to point at a wrapper or custom flags. Pi and Claude custom protocol commands still receive workflow-managed model/thinking flags after the configured args. `cli` requires an explicit executable command. Leading/trailing whitespace is trimmed; an empty string or empty array falls back to the runner default.
- `profile`: optional legacy/default override. If `extensions.subagents.profiles[]` is present, matching profile values can still provide runner/model/reasoning defaults; otherwise the orchestrator synthesizes protocol-runner defaults from `runner`.
- `provider`: optional provider passed to the Pi runner (`pi --provider <provider>`). Use with `model` when Pi's default provider may not have credentials.
- `model`: optional model passed to protocol runners that support it.
- `thinking`: optional workflow-owned thinking/reasoning level. This is the preferred key and overrides profile/default thinking when present. Aliases are accepted for compatibility with existing Yoplai config: `reasoning`, `reasoningEffort`, and `reasoning_effort`. If more than one key is set, precedence is `thinking`, `reasoningEffort`, `reasoning_effort`, then `reasoning`. Allowed values are runner-specific: Pi accepts `off`, `low`, `medium`, `high`, `xhigh`; Codex accepts `low`, `medium`, `high`, `xhigh`; Claude accepts `low`, `medium`, `high`, `xhigh`, `max`.
- `max_concurrent`: per-project worker cap. Effective cap also respects `extensions.orchestrator.concurrency.global`.
- `max_active_runs`: maximum consecutive clean completions allowed while the issue remains in an active state before the orchestrator parks it. A clean completion that leaves the issue in an active state increments the counter; any other outcome (terminal, needs_human, stalled, etc.) resets it. When the counter reaches this threshold the issue is moved to `needsHuman` with a HITL notification. Default `3`. Must be a positive number when set.
- `max_turns`: workflow hint for worker prompt/runtime.
- `turn_timeout_ms`: per-turn time budget. Optional; default `3600000` (1 hour, Symphony parity). Must be a positive number. When a turn exceeds this budget the runner aborts/interrupts it and surfaces an `interrupted` status with `reason: "turn_timeout"`.
- `stall_timeout_ms`: time without observed events before parking/stall handling. Default `300000` (5 minutes, Symphony parity).
- `settings`: optional runner-specific settings. Codex reads `approvalPolicy`/`approval_policy` and `sandboxPolicy`/`sandbox_policy`; by default it starts app-server threads with `approvalPolicy: never` and full-access sandbox (`dangerFullAccess`) so orchestrator workers can load trusted project `.codex` config and run unattended. Claude reads `permissionMode`/`permission_mode` and defaults to `--permission-mode bypassPermissions` so workers run unattended; override via `agent.settings.permissionMode` in `WORKFLOW.md`.

`thinking`, `max_turns`, `turn_timeout_ms`, `stall_timeout_ms`, `max_concurrent`, and `max_active_runs` are validated when set. Invalid thinking values fail config load for explicit `runner` values and fail before runner startup when the effective runner comes from a profile.

Runner config belongs in project `WORKFLOW.md`, not in `extensions.subagents`. Yoplai profiles are runner defaults, not Symphony roles. No label-to-profile routing exists.

Thinking mapping:

- `pi`: `agent.thinking` maps to Pi `--thinking <off|low|medium|high|xhigh>` and overrides profile `thinking`.
- `codex`: `agent.thinking` maps to the app-server model effort field (`effort`, equivalent to `reasoningEffort`) and overrides profile `reasoningEffort`/`reasoning`.
- `claude`: `agent.thinking` maps to Claude Code `--effort <low|medium|high|xhigh|max>` and overrides profile `reasoningEffort`/`reasoning`. Claude Code does not use the older `--thinking` flag here.

#### Runner examples

`pi` (default) — built-in RPC, no `command` needed:

```yaml
agent:
  runner: pi
  provider: anthropic
  model: claude-sonnet-4-6
  thinking: high
  max_concurrent: 3
```

`claude` — built-in RPC, optional `model`:

```yaml
agent:
  runner: claude
  model: claude-opus-4-8
  thinking: max
  max_concurrent: 2
```

`codex` — speaks the Codex app-server JSON-RPC protocol; `command` defaults to `codex app-server`, override only for a wrapper or custom flags:

```yaml
agent:
  runner: codex
  model: gpt-5.3-codex
  thinking: high
  max_concurrent: 2
  # command: [codex, app-server]   # optional override
  # settings:
  #   approvalPolicy: never
  #   sandboxPolicy:
  #     type: dangerFullAccess
```

`cli` — generic CLI harness; `command` required:

```yaml
agent:
  runner: cli
  command: [my-agent-cli, --headless]
  max_concurrent: 1
```

`fake` — in-memory stub for tests/dry runs; no external process:

```yaml
agent:
  runner: fake
  max_turns: 4
```

### `hooks`

Hook commands run in the issue workspace.

- `after_create`: after new workspace directory is created.
- `before_run`: before worker starts. Non-zero exit aborts dispatch.
- `after_run`: after worker attempt completes or claim releases.
- `before_remove`: before workspace removal for `terminal`, `hook_failed`, and `dispatch_failed` releases when `workspace.cleanup_on_terminal` is true.

Manual run release only clears the orchestrator claim. Use interrupt or kill when the active worker should also stop; orchestrator-owned `Needs Human` parks stop the worker before the claim is released.

Hook env includes:

- `YOPLAI_PROJECT_ID`
- `YOPLAI_ISSUE_ID`
- `YOPLAI_ISSUE_IDENTIFIER`
- `YOPLAI_WORKSPACE`

`LINEAR_API_KEY`, `PLANE_API_KEY`, `PLANE_OAUTH_TOKEN`, and `PLANE_BOT_TOKEN` are intentionally not passed to hooks/workers.

### `linear`

- `exposeGraphqlTool`: enables `orchestrator.linear_graphql`. Default `true`.

Worker tool calls must include project id:

```json
{ "project": "yoplai", "query": "...", "variables": {} }
```

The tool uses that project's workflow `tracker.api_key` and `tracker.endpoint`. Calling it against a project whose `tracker.kind` is `plane` returns `{ "error": "project uses tracker.kind: plane — use orchestrator.plane_api" }` instead of making a request.

### `plane`

- `exposeApiTool`: enables `orchestrator.plane_api`. Default `true`.

`orchestrator.plane_api` executes a raw Plane REST call using the owning project's workflow auth (`base_url`, `workspace_slug`, and the correct auth header are injected — the worker never sees the token). Worker tool calls must include project id, HTTP method, and a path relative to `/api/v1/`:

```json
{
  "project": "yoplai-plane",
  "method": "GET",
  "path": "workspaces/{workspace}/projects/{project}/work-items/?per_page=100"
}
```

```json
{
  "project": "yoplai-plane",
  "method": "POST",
  "path": "workspaces/{workspace}/projects/{project}/work-items/{id}/comments/",
  "body": { "comment_html": "<p>hi</p>" }
}
```

- `path` supports placeholders `{workspace}`, `{project}`, `{module}`, which expand to the project's configured `workspace_slug`, `project_id`, and `module_id`. Using `{module}` against a project with no `module_id` configured returns `{ "error": "project has no module_id configured" }` instead of making a request.
- A leading `/` and an optional leading `api/v1/` in `path` are stripped before the request is made.
- `method` is one of `GET`, `POST`, `PATCH`, `DELETE`.
- Responses are returned as parsed JSON (`{ "status": 204 }` for empty 204 responses); list endpoints paginate via `?cursor=`.
- Calling it against a project whose `tracker.kind` is `linear` returns `{ "error": "project uses tracker.kind: linear — use orchestrator.linear_graphql" }` instead of making a request.

### Prompt body

Markdown body after frontmatter becomes worker prompt template.

Supported substitutions follow Symphony core inputs only:

- `{{issue.id}}`
- `{{issue.identifier}}`
- `{{issue.title}}`
- `{{issue.description}}`
- `{{issue.priority}}`
- `{{issue.branch_name}}`
- `{{issue.state}}`
- `{{issue.url}}`
- `{{issue.labels}}`
- `{{issue.blocked_by}}`
- `{{issue.created_at}}`
- `{{issue.updated_at}}`
- `{{attempt}}`

Rules:

- First run renders `attempt` as empty/null.
- Retries/continuations render `attempt` as the attempt number.
- Unknown variables fail workflow rendering.
- Unknown filters fail workflow rendering.
- Arrays/maps render as JSON.
- No `project`, `workspace`, `repo`, `run`, or secret variables are exposed to templates.

Repo bootstrap should prefer deterministic hooks/tooling. Prompt-driven cloning is allowed, but must stay inside the issue workspace.

## Webhook

Set `extensions.orchestrator.webhook.enabled: true` and `webhook.secret` to accept push-triggered ticks instead of relying only on polling. One route (`POST /api/orchestrator/webhook`) serves both trackers; project registration determines which tracker(s) a payload is checked against.

- Linear: send the webhook signature via the `Linear-Signature` or `X-Linear-Signature` header (Linear sends `Linear-Signature`; either name is accepted).
- Plane: send the webhook signature via the `X-Plane-Signature` header.
- Both use the same HMAC-SHA256-hex scheme over the raw request body, verified against the same configured `webhook.secret` — there is no separate Plane secret to configure.
- The route rejects the request with 401 when the signature does not verify, and with 503 when `webhook.secret` is not configured.
- On a verified payload, the orchestrator resolves the tracker kind(s) of every registered project (falling back to `linear` if none load) and only enqueues a tick if the payload looks relevant for at least one of those kinds (issue create/update/delete or a comment event); irrelevant payloads (e.g. non-issue Plane webhook events) return `{ "ok": true, "queued": false }` without ticking.

Configure each tracker's webhook to point at `/api/orchestrator/webhook` with the matching signing secret.

## Runtime model

- Tracker scope comes from `WORKFLOW.md` `tracker.project_slug` (Linear) or `tracker.workspace_slug`/`tracker.project_id`/`tracker.module_id` (Plane).
- Auth comes from `tracker.api_key`: `$LINEAR_API_KEY` for Linear; `$PLANE_BOT_TOKEN`, `$PLANE_OAUTH_TOKEN`, or `$PLANE_API_KEY` for Plane.
- Candidate issues are filtered to that tracker scope (Linear project `slugId`; Plane project, optionally narrowed to one module). Plane can further narrow polling with `tracker.mention` to work items assigned to the resolved bot user.
- Workspace directories are per issue under `workspace.root`.
- Core orchestrator does not create git clones or worktrees.
- Gateway owns orchestrator worker lifetime; workers stop with gateway.
- Orchestrator dashboard/API surfaces orchestrator `worker_id`, worker status events, and persisted worker logs/events. It does not call `/api/subagents` for dispatched work.
- Restart recovery uses tracker state + preserved workspace directories. SQLite is observability/history.

### Run log storage

Orchestrator stores run index/state in SQLite at `$YOPLAI_HOME/orchestrator/state.db`. New worker events keep only query metadata in the `events` table: `run_id`, `project_id`, event `type`, `created_at`, JSONL path, byte offset, line number, and a small payload preview. Full raw payloads append to per-run JSONL:

```text
$YOPLAI_HOME/orchestrator/runs/<encoded-run-id>/logs.jsonl
```

Each JSONL line is one raw event:

```json
{"project_id":"project","run_id":"orchestrator:project:issue:ts","type":"worker.codex.message","created_at":"...","payload":{}}
```

Inspect a live run directly:

```bash
tail -f "$YOPLAI_HOME/orchestrator/runs/<encoded-run-id>/logs.jsonl"
jq -c 'select(.type | startswith("worker.codex"))' "$YOPLAI_HOME/orchestrator/runs/<encoded-run-id>/logs.jsonl"
curl "http://localhost:4000/api/orchestrator/runs/<issue-or-run-id>/logs?project=<project-id>&since=0"
```

Databases created before JSONL storage may still have DB-only rows with full `events.payload`; the logs API reads both legacy rows and JSONL-backed rows in one cursor stream. If a per-run JSONL file is archived or deleted, run metadata remains intact and APIs fall back to the stored payload preview for those events.

Useful commands:

```bash
pnpm yoplai:dev orchestrator projects
pnpm yoplai:dev orchestrator workflow --project <project-id>
pnpm yoplai:dev orchestrator tick --project <project-id>
pnpm yoplai:dev orchestrator runs --project <project-id>
```
