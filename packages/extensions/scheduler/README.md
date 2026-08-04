# Scheduler Extension

Yoplai scheduler stores jobs per agent and fires them with cron expressions.

## Enable / disable

Add `extensions.scheduler` to `yoplai.json` to load scheduler routes and CLI support:

```json
{
  "extensions": {
    "scheduler": { "enabled": true }
  }
}
```

`enabled: false` is a runtime kill switch only. The extension still loads, and
HTTP API / `yoplai scheduler` commands still read and write per-agent
`cron/jobs.json` files. Timers do not start and jobs do not fire. Extension
shutdown prevents an already-pending tick from re-arming the timer.

## Storage

Each agent owns its jobs:

```text
<workspace>/cron/jobs.json
<workspace>/cron/output/<job_id>/YYYY-MM-DD_HH-mm-ss.md
```

Disk shape omits `agentId`; it is implied by the workspace:

```json
{
  "version": 1,
  "jobs": [
    {
      "id": "morning-digest",
      "name": "Morning digest",
      "enabled": true,
      "schedule": {
        "cron": "0 8 * * *",
        "tz": "Europe/Paris",
        "startAt": "2026-05-19T07:00:00.000Z"
      },
      "model": { "provider": "anthropic", "model": "claude-sonnet-4" },
      "payload": { "message": "Summarize overnight events." },
      "timeoutMs": 1800000,
      "createdAt": "2026-05-19T07:00:00.000Z"
    }
  ]
}
```

`model` is optional. When present, both `provider` and `model` are required and the scheduled run uses that model instead of the agent default. Jobs without `model` keep using the agent default.

`timeoutMs` is an optional top-level job field: the per-run timeout in milliseconds for that job. Falls back to `extensions.scheduler.jobTimeoutMs`, then the 30-minute built-in default.

Malformed `cron/jobs.json` logs one warning and is treated as empty for that
agent. In-process writes for one agent are serialized and atomically renamed,
so concurrent API/tool/run-state updates cannot overwrite newer job snapshots.
Gateway hot reload also refreshes manual file edits.

## Job shapes: agent, script-only, gated

There is no `kind` field. A job's `payload` shape decides what fires. All three shapes can be created by writing/editing `cron/jobs.json` directly, through `POST`/`PATCH` on the HTTP API, or via the `scheduler.create_job`/`scheduler.update_job` agent tools — all three validate through the same `SchedulePayloadSchema`. The `yoplai scheduler` CLI has not been extended for `script`/`noAgent`/`quietOutput` yet; it still only creates plain agent jobs.

| Shape | Payload | What runs |
| --- | --- | --- |
| Agent job (default, unchanged) | `message` only | `runAgent` with `message` as the prompt |
| Script-only | `script` + `noAgent: true` | The script runs as a subprocess; the **exit code** decides `ok`/`error`. `runAgent` is never called. `message` is rejected on this shape. |
| Gated agent job | `script` + `message` (no `noAgent`) | The script runs first as a $0 gate; its final stdout line decides whether `runAgent` fires at all. |

`script` is a path relative to the agent's workspace directory (never absolute, never containing a `..` segment — see Containment below).

### 1. Agent job (today's behavior)

```json
{
  "id": "morning-digest",
  "name": "Morning digest",
  "enabled": true,
  "schedule": { "cron": "0 8 * * *", "tz": "Europe/Paris" },
  "payload": { "message": "Summarize overnight events." }
}
```

### 2. Script-only (`noAgent: true`)

Use this for deterministic recurring work where the script itself *is* the job — token rotation, watchdogs, health checks. No tokens spent, no agent loop; success is decided mechanically from the exit code, so a failing script can never be misreported as a success.

```json
{
  "id": "rotate-token",
  "name": "Rotate API token",
  "enabled": true,
  "schedule": { "cron": "0 */6 * * *", "tz": "UTC" },
  "payload": {
    "script": "scripts/rotate-token.sh",
    "noAgent": true,
    "quietOutput": true
  },
  "timeoutMs": 60000
}
```

`quietOutput: true` skips writing an output file for uneventful runs (see below) — appropriate for a job that fires often and rarely has anything worth keeping.

### 3. Gated (`script` + `message`, wakeAgent gate)

Use this for a cheap, frequent check that should only spend tokens when something actually changed — file-change gates, threshold alerts, new-rows pollers.

```json
{
  "id": "watch-inbox",
  "name": "Watch inbox for new attachments",
  "enabled": true,
  "schedule": { "cron": "*/5 * * * *", "tz": "UTC" },
  "payload": {
    "script": "scripts/inbox-gate.sh",
    "message": "New attachments arrived. Triage them.",
    "quietOutput": true
  },
  "timeoutMs": 30000
}
```

## The wakeAgent gate

On a gated job (`script` + `message`) the scheduler runs the script first and parses its **final stdout line** (last non-empty trimmed line) as JSON:

| Final stdout line | Result |
| --- | --- |
| `{"wakeAgent": false}` | **Silent tick** — no `runAgent` call, no tokens spent. Recorded as an `ok` run with the `ok (silent tick)` status. |
| `{"wakeAgent": true, "context": {...}}` | Agent runs with `message` as the prompt, with the serialized `context` object appended. |
| `wakeAgent` key omitted, final line isn't valid JSON, or there's no stdout at all | **Defaults to `true`** — the agent runs with `message` unchanged. |

Non-zero exit or a timed-out script is always recorded as `error` (exit code + stderr) and the agent is **never invoked** — a watchdog that fails cannot fail silently into a false "ok".

`noAgent: true` jobs ignore the wakeAgent line entirely; only the exit code matters.

When the gate wakes the agent, the prompt sent to `runAgent` is:

```
<message>

Gate context:
<serialized context JSON>
```

(the `Gate context:` block is omitted when the gate didn't include a `context` value).

### Sample gate script: a file-change gate

A gate script must print exactly one JSON line as the *last* line of stdout — everything before it is free-form and gets stored as the gate output in the run's log. This example wakes the agent only when a watched file's content hash changed since the last tick:

```bash
#!/bin/bash
# scripts/inbox-gate.sh — wakes the agent only when inbox.json changed.
set -euo pipefail

STATE_FILE=".gate-state/inbox.sha256"
WATCH_FILE="inbox.json"

mkdir -p "$(dirname "$STATE_FILE")"

if [ ! -f "$WATCH_FILE" ]; then
  echo '{"wakeAgent": false}'
  exit 0
fi

current_hash=$(shasum -a 256 "$WATCH_FILE" | cut -d' ' -f1)
previous_hash=$(cat "$STATE_FILE" 2>/dev/null || echo "")

if [ "$current_hash" = "$previous_hash" ]; then
  echo "no change"
  echo '{"wakeAgent": false}'
  exit 0
fi

echo "$current_hash" > "$STATE_FILE"
new_count=$(jq 'length' "$WATCH_FILE")

echo "inbox.json changed, $new_count entries"
echo "{\"wakeAgent\": true, \"context\": {\"newCount\": $new_count}}"
```

This runs under `bash` because of its `.sh` extension (see Interpreter policy below), so it does not need the executable bit set. Every line before the final JSON line — `"no change"`, `"inbox.json changed, N entries"` — is captured as the gate's stdout and, on a woke run, shown in the output file's `## Gate Output` section.

## Interpreter policy

No shebang guessing — the extension picks the interpreter from the file extension alone:

- `.sh` or `.bash` → spawned as `bash <script-path>`. The executable bit is not required.
- Any other extension → spawned **directly** (`<script-path>` as the command). The file **must** have the executable bit set (`chmod +x`), or the run fails immediately with `script <path> is not executable`.

`cwd` for the subprocess is always the agent's workspace directory. stdout/stderr are piped and captured; each stream is capped at 64 KiB while streaming (a `[output truncated]` marker is appended past the cap), so a chatty script can't buffer unbounded output in memory.

A script gets its own process group (POSIX `detached: true`); on timeout the scheduler kills the whole group (`SIGKILL`), so a shell script's foreground child (e.g. something it `wait`s on) is killed too — no orphaned process survives a timeout.

## Containment rules

`payload.script` must be a workspace-relative path:

- Absolute paths are rejected at schema-validation time (`payload.script must be a relative path contained in the agent root`).
- Paths containing a `..` segment are rejected at schema-validation time, same message.
- At fire time the resolved path's **realpath** is checked against the workspace directory's realpath, so a symlink inside the workspace that points outside it is also rejected (`script path escapes workspace: <script>`) — schema validation alone can't catch that, since it only sees the literal string.
- A script path that doesn't resolve to an existing file fails with `script not found: <path>`.

## Delivery (`deliver`)

A job may optionally push its result to comm-channel extensions, in addition to (never instead of) the
`cron/output/<job_id>/<ts>.md` file, which stays the default and canonical record. `deliver` is a **job-level**
field — a sibling of `payload`, not inside it — and delivery happens at the runtime level after a run resolves,
never as an LLM tool call. The agent must **not** call `*.send_message` itself for cron results; the scheduler
does it mechanically, the same way it decides success/failure from a script's exit code rather than trusting
the model to say so.

```json
{
  "id": "watch-inbox",
  "name": "Watch inbox for new attachments",
  "enabled": true,
  "schedule": { "cron": "*/5 * * * *", "tz": "UTC" },
  "payload": {
    "script": "scripts/inbox-gate.sh",
    "message": "New attachments arrived. Triage them.",
    "quietOutput": true
  },
  "deliver": [
    { "target": "slack", "channel": "C0123456789" },
    { "target": "telegram", "user": "12345" },
    { "target": "discord", "channel": "998877665544332211" }
  ],
  "timeoutMs": 30000
}
```

Each entry is `{ target, channel? | user? }` — `target` names the extension whose sink handles it (`slack`,
`telegram`, `discord`); exactly one of `channel` or `user` addresses the destination within that extension.
Empty/blank values are rejected at schema-validation time. `target`/`channel`/`user` are extension-specific
strings, not IDs the scheduler interprets itself — see each extension's own README for what its sink expects:
[discord](../discord/README.md#scheduler-delivery-sink), [slack](../slack/README.md#scheduler-delivery),
[telegram](../telegram/README.md#delivery-sink).

### What gets delivered, and when a run stays silent

| Run | Delivered text |
| --- | --- |
| Agent job | The runner's final response. |
| Script-only job | Trimmed stdout. **Empty stdout delivers nothing** — a quiet success stays quiet. |
| Gated job, silent tick | Nothing — the gate chose not to wake the agent, and that is the point. |
| Gated job, woke agent | The agent's response. |
| Any shape, run errored (non-zero exit, script timeout, or runner failure) | **Always delivered** — an error alert naming the job and the error text. A watchdog cannot fail silently. |

### Failure is a warning, not a run failure

Delivery is best-effort per target:

- A `target` with no registered sink at fire time, or a sink that throws, is recorded as a **warning** on the
  run and noted in the output file's `## Delivery` section (`<target>: warning: <message>`) — it does **not**
  flip the run's `ok`/`error` status.
- One failing target never blocks the others: every configured target is attempted independently.

Outcomes also land in runtime state as `state.lastDelivery: [{ target, ok, error? }]`, visible via
`scheduler.list_jobs`.

### Truncation

Delivered text is capped at **4000 characters** (fits Telegram's 4096-character message limit with room for
transport metadata) with a `[truncated]` marker appended when the cap is hit. Longer results are truncated,
never dropped.

### No irc sink

`packages/extensions/irc/` exposes no proactive send path — there is no `irc.send_message` agent tool or
exported send function to share, unlike discord/slack/telegram. A `deliver` entry with `"target": "irc"` has
no sink registered for it and is recorded as a delivery warning, same as any other unregistered target.

## Output files & `quietOutput`

Every run writes `<workspace>/cron/output/<job_id>/<ts>.md` by default, including `ok` and `ok (silent tick)` runs. Runtime state (`lastRunAtMs`, `lastStatus`, `lastExitCode`, `lastRunKind`, `scheduler.list_jobs`, CLI table) updates on **every** tick regardless of whether a file was written.

Opt in per-job with `payload.quietOutput: true` to skip the output file for **uneventful** runs only:

- a script-only run that exited 0 with empty (trimmed) stdout, or
- a silent tick.

Errors, woke-agent runs, and any run with non-empty output **always** write the file, even with `quietOutput: true`. `quietOutput: true` requires `payload.script` (it has no effect on a plain agent job).

### `Status:` values

The output file's `**Status:**` line (and `status_label` frontmatter key) is one of:

| Status | Meaning |
| --- | --- |
| `ok` | Plain agent job succeeded, or a script-only job exited 0. |
| `ok (silent tick)` | Gated job; the gate's final line said `wakeAgent: false`. |
| `woke agent` | Gated job; the gate woke the agent and the agent run completed. |
| `script failed (exit N)` | The script exited non-zero; `N` is the exit code (also recorded as `exit_code` in frontmatter). |
| `script failed (exit signal)` | The script was killed by a signal (not via the scheduler's own timeout). |
| `error` | Any other failure — the underlying agent run failed, or the script's own timeout fired (`script exceeded the <ms>ms timeout and was killed`). The full error text is always in the `## Error` section. |

For a woke-agent run, the file includes both the script's stdout (`## Gate Output`) and the agent's response (`## Response`). A script-only run's stdout is itself the `## Response`. `session_id` and `## Prompt` are only rendered when the run actually has one — script-only and silent-tick runs never start a session.

Each run writes hybrid frontmatter + readable markdown; a plain agent-job run looks like:

```md
---
job_id: "morning-digest"
agent_id: "devagent"
session_id: "scheduler:morning-digest:..."
run_type: cron
fired_at: 2026-05-19T07:00:00.000Z
finished_at: 2026-05-19T07:00:14.000Z
status: ok
duration_ms: 14000
status_label: "ok"
schedule: "0 8 * * * Europe/Paris"
---

# Cron Job: Morning digest

**Job ID:** morning-digest
**Run Time:** 2026-05-19 07:00:00
**Schedule:** 0 8 \* \* \* Europe/Paris
**Status:** ok

## Prompt

...

## Response

...
```

A script failure adds `exit_code` to the frontmatter and puts the error text under `## Error` instead of `## Response`; a woke-agent run adds a `## Gate Output` section before `## Response`, as described above.

## Schedule schema

Current schedule shape:

```json
{
  "cron": "0 8 * * *",
  "tz": "Europe/Paris",
  "startAt": "2026-05-19T07:00:00.000Z"
}
```

- `cron`: cron expression parsed by `cron-parser`
- `tz`: required IANA timezone
- `startAt`: optional valid ISO date anchor

Breaking change for old clients: old `interval` / `daily` schedule variants are
removed. Migration rewrites them to cron + timezone.

## HTTP API

```http
GET    /api/schedules?agent=<agent-id>
POST   /api/schedules
PATCH  /api/schedules/:agentId/:id
DELETE /api/schedules/:agentId/:id
GET    /api/schedules/:agentId/:id/tail
```

Create still takes `agentId` in the JSON body:

```bash
curl -X POST localhost:4000/api/schedules \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "devagent",
    "name": "Morning digest",
    "schedule": { "cron": "0 8 * * *", "tz": "Europe/Paris" },
    "model": { "provider": "anthropic", "model": "claude-sonnet-4" },
    "payload": { "message": "Summarize overnight events." }
  }'
```

Breaking change for old clients: update/delete/tail are agent-scoped paths.
Old non-agent-id paths (`PATCH /api/schedules/:id`, `DELETE /api/schedules/:id`)
are gone.

## CLI

```bash
yoplai scheduler add <agent-id> --cron "0 8 * * *" --tz Europe/Paris -m "..."
yoplai scheduler add <agent-id> --cron "0 8 * * *" --tz Europe/Paris -m "..." --provider anthropic --model claude-sonnet-4
yoplai scheduler list [--agent <agent-id>]
yoplai scheduler update <agent-id> <job-id> --cron "*/30 * * * *" --tz UTC
yoplai scheduler update <agent-id> <job-id> --provider openai --model gpt-5
yoplai scheduler rm <agent-id> <job-id>
yoplai scheduler tail <agent-id> <job-id>
```

CLI can edit files while scheduler runtime is disabled.

## Agent tools

When `extensions.scheduler.enabled` is not `false`, agents receive scheduler tools for their own jobs only:

- `scheduler.list_jobs`
- `scheduler.create_job`
- `scheduler.update_job`
- `scheduler.delete_job`
- `scheduler.get_latest_output`

Tools use raw cron + timezone input, generate job ids server-side, create enabled jobs by default, and support optional `sessionId`. They do not expose model overrides. `create_job`/`update_job` accept `script`, `noAgent`, and `quietOutput` alongside `message`, following the same shape rules as the payload schema (see Job shapes above), plus an optional `timeoutMs`: the per-run timeout in milliseconds (default 30 minutes; falls back to `extensions.scheduler.jobTimeoutMs`, then the 30-minute built-in). `update_job` only changes payload fields you pass; omitted fields keep their existing value.

`scheduler.get_latest_output` requires `jobId`. Call `scheduler.list_jobs` first and pass a returned `jobs[n].id`; optional `maxChars` bounds preview length from 1 to 20,000 characters (default 4,000). `Output not found` means job has not produced stored output yet.

## Hot reload

Gateway polls config, agent YAML files, and agent `cron/jobs.json` files every 5 seconds. Manual cron file edits refresh scheduler state without restart.
