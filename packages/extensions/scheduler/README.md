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

Tools use raw cron + timezone input, generate job ids server-side, create enabled jobs by default, and support optional `sessionId`. They do not expose model overrides. `create_job`/`update_job` accept an optional `timeoutMs`: the per-run timeout in milliseconds (default 30 minutes; falls back to `extensions.scheduler.jobTimeoutMs`, then the 30-minute built-in).

`scheduler.get_latest_output` requires `jobId`. Call `scheduler.list_jobs` first and pass a returned `jobs[n].id`; optional `maxChars` bounds preview length from 1 to 20,000 characters (default 4,000). `Output not found` means job has not produced stored output yet.

## Hot reload

Gateway polls config, agent YAML files, and agent `cron/jobs.json` files every 5 seconds. Manual cron file edits refresh scheduler state without restart.

## Output files

Each run writes hybrid frontmatter + readable markdown:

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
schedule: "0 8 * * * Europe/Paris"
---

# Cron Job: Morning digest

**Job ID:** morning-digest
**Run Time:** 2026-05-19 07:00:00
**Schedule:** 0 8 \* \* \* Europe/Paris

## Prompt

...

## Response

...
```
