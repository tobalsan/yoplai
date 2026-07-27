# Subagents Extension

The `subagents` extension is Yoplai's project-agnostic runtime for CLI-backed
subagents. It lets any UI, extension, or lead agent start and observe external
agent processes without depending on the `projects` extension.

The extension is built in but opt-in. Add an `extensions.subagents` block (for
example `{}`) to `yoplai.json` to load it. Runtime actions go through the gateway
HTTP API, so the gateway must be running for `yoplai subagents ...` commands.

## What It Owns

- CLI process lifecycle for `codex`, `claude`, and `pi`
- Run metadata, state, progress, raw logs, and normalized log reads
- Resume, interrupt, archive, unarchive, and delete actions
- Realtime `subagent_changed` websocket broadcasts
- Parent-scoped run filtering for ChatView, Board, and other extensions

The runtime intentionally does not own repo policy. Callers choose `cwd` and
decide whether it must be a git repo, worktree, project Space checkout, or any
ordinary directory. The runtime only validates that `cwd` exists.

## Storage

Runs are stored under:

```text
$YOPLAI_HOME/sessions/subagents/runs/<runId>/
  config.json
  state.json
  progress.json
  logs.jsonl
  history.jsonl
```

Run ids are opaque and stable, for example:

```text
sar_mabc1234xyz
```

## Parent Scopes

Parents are metadata used for filtering. The runtime stores them but does not
interpret them.

Common parent strings:

```text
agent-session:<agentId>:<sessionKey>
board:<boardId>
projects:<projectId>
```

Use parents to keep each surface focused. For example, Board can show runs for
the selected chat session with `agent-session:lead:main`, or broader board work
with `board:main`.

## Profiles

Profiles live in `yoplai.json` under `extensions.subagents.profiles`.

```json
{
  "extensions": {
    "subagents": {
      "profiles": [
        {
          "name": "Worker",
          "cli": "codex",
          "model": "gpt-5.3-codex",
          "reasoningEffort": "medium",
          "labelPrefix": "worker"
        }
      ]
    }
  }
}
```

Profiles are convenience defaults. CLI and API callers can still override
`cli`, `model`, and `reasoningEffort`.

Top-level `subagents` templates also resolve as runtime profiles while project
screens migrate to the runtime extension. Those templates use `cli`:

```json
{
  "subagents": [
    {
      "name": "Worker",
      "cli": "codex",
      "model": "gpt-5.3-codex",
      "reasoning": "medium",
      "type": "worker",
      "runMode": "worktree"
    }
  ]
}
```

## CLI Examples

Start a Codex subagent in a repo:

```sh
yoplai subagents start \
  --cli codex \
  --cwd /Users/me/code/app \
  --label worker-a \
  --prompt "Implement the settings page"
```

Start with a model and reasoning effort:

```sh
yoplai subagents start \
  --cli codex \
  --cwd /Users/me/code/app \
  --label reviewer-a \
  --model gpt-5.3-codex \
  --reasoning-effort high \
  --prompt "Review the current diff"
```

Start from a profile:

```sh
yoplai subagents start \
  --profile Worker \
  --cwd /Users/me/code/app \
  --label worker-b \
  --prompt "Add tests for the billing flow"
```

Attach a run to the current lead-agent chat session:

```sh
yoplai subagents start \
  --cli claude \
  --cwd /Users/me/code/app \
  --label docs-worker \
  --parent agent-session:lead:main \
  --prompt "Draft API docs for the new endpoints"
```

List active runs:

```sh
yoplai subagents list --status running
```

List runs for a parent:

```sh
yoplai subagents list --parent board:main
```

Inspect one run:

```sh
yoplai subagents status sar_mabc1234xyz
```

Read logs from the beginning:

```sh
yoplai subagents logs sar_mabc1234xyz --since 0
```

Resume a completed or interrupted run:

```sh
yoplai subagents resume sar_mabc1234xyz \
  --prompt "Continue with the remaining failing tests"
```

Stop a running process but keep its run record:

```sh
yoplai subagents interrupt sar_mabc1234xyz
```

Hide a run from normal lists:

```sh
yoplai subagents archive sar_mabc1234xyz
```

Restore an archived run:

```sh
yoplai subagents unarchive sar_mabc1234xyz
```

Delete a run record and its files:

```sh
yoplai subagents delete sar_mabc1234xyz
```

For scripts and agents, add `--json` to receive machine-readable output:

```sh
yoplai subagents list --parent agent-session:lead:main --json
```

## HTTP API

The CLI calls the same gateway API used by web clients and extensions:

```http
GET    /api/subagents
POST   /api/subagents
GET    /api/subagents/:runId
POST   /api/subagents/:runId/resume
POST   /api/subagents/:runId/interrupt
POST   /api/subagents/:runId/archive
POST   /api/subagents/:runId/unarchive
DELETE /api/subagents/:runId
GET    /api/subagents/:runId/logs?since=0
```

Useful list filters:

```http
GET /api/subagents?status=running
GET /api/subagents?parent=agent-session:lead:main
GET /api/subagents?includeArchived=true
```

List and detail responses include `latestOutput` and `lastActiveAt`, so UIs can
render a compact overview without fetching logs for every run.

## Realtime Events

The gateway broadcasts:

```ts
type SubagentChangedEvent = {
  type: "subagent_changed";
  runId: string;
  parent?: { type: string; id: string };
  status: "starting" | "running" | "done" | "error" | "interrupted";
};
```

Clients should refetch `/api/subagents` or `/api/subagents/:runId` after this
event. Output-triggered updates are throttled.

## Operational Notes

- `resume` is rejected while a run is active.
- `interrupt` stops the process but keeps the run.
- `archive` hides the run from normal lists.
- `delete` removes the run directory.
- Labels are unique per parent.
- Raw CLI output stays in `logs.jsonl`; API logs are normalized for UI stability.
