# Data layout

`YOPLAI_HOME` defaults to `~/.yoplai`. Keep runtime data outside repository and protect backups.

| Path                         | Purpose                                         |
| ---------------------------- | ----------------------------------------------- |
| `yoplai.json`                | Required v3 instance config                     |
| `.env`                       | Instance environment aliases/secrets            |
| `auth.json`                  | Pi OAuth/API credentials                        |
| `models.json`                | Optional custom provider definitions            |
| `agents/<id>/agent.yaml`     | Agent configuration                             |
| `agents/<id>/.env`           | Agent-local extension secret aliases            |
| `agents/<id>/cron/jobs.json` | Scheduler jobs                                  |
| `agents/<id>/cron/output/`   | Scheduler/heartbeat run output                  |
| `agents/<id>/durable/agent.sqlite` | Pi Durable transcript, Main identity map, submissions and review decisions |
| `durable-mode.json` | Single-user Durable mode preference, `{ enabled: boolean, updatedAt?: string }`. The ISO timestamp is optional for older files. Multi-user preferences have the same shape at `sessions/users/<userId>/durable-mode.json`. |
| `agents/<id>/dreams/`        | Dream journals/state/staged sessions            |
| `history/*.jsonl`            | Canonical single-user chat transcripts          |
| `sessions/*.jsonl`           | Pi SDK runtime resume state                     |
| `sessions.json`              | Logical session key mappings                    |
| `sessions/subagents/runs/`   | Project-agnostic subagent records/logs          |
| `media/`                     | Managed inbound/outbound files                  |
| `oauth/`                     | Encrypted per-agent extension OAuth connections |
| `webhook-secrets.json`       | Webhook URL secrets                             |
| `auth.db`                    | Multi-user Better Auth SQLite database          |
| `rooms.sqlite`               | Gateway-wide chat room membership, agent registrations, and message log (SQLite WAL) |
| `audit.db`                   | Gateway settings audit, created on first change; secret values redacted |
| `projects.json`              | Project numeric ID counter                      |
| `threadit/<agentId>/delivering/` | Threadit reply-in-flight markers, one file per board message |

## Canonical history vs runtime sessions

`history/*.jsonl` is normalized transcript used by API, web UI, tracing, compaction, channel context, and media blocks. `sessions/*.jsonl` is Pi SDK-owned resume/session state, not product history. Gateway may backfill/fallback from Pi files for legacy or actively streaming sessions.

Multi-user mode puts user-scoped maps/history under `sessions/users/<userId>/`. Enabling it does not migrate existing single-user history.

## Durable web Main

On first Durable use the gateway opens one harness and SQLite store for the
agent. The gateway owns writes to that store and closes it on shutdown.
Each account maps to a permanent Main in a session-scoped document. Single-user
mode uses the fixed key `main:local`. Main creation and its mapping commit
together, before the separately committed input. Durable web history is
projected directly from the store. Include it in stopped-gateway snapshots with
the rest of the agent's data.

## Chat rooms

The gateway opens `rooms.sqlite` on startup or room use. A room uses its owner's chat
project ID. Project files, notes, and instructions stay in the owner's
`chat-projects/<id>/` directory. The sequenced log stores each event's author
kind (`user`, `agent`, or `digest`), mentioned agent IDs, optional author agent
ID, and optional answer reference. Existing messages migrate as user rows
with an empty mention list. Active agent registrations record the room's
sequence at join and a generation that advances when the agent rejoins.
Existing registrations migrate at generation 1 with the room's current sequence.
Treat the database and its SQLite WAL sidecars as private conversation data.

Each agent's Durable store maps `room:<roomId>` to a room conversation. Its
conversation document stores the membership generation, delivered room sequence
and examined-answer cursor. The delivered sequence commits with the model input
or passive context that covers it. Answer publication uses an idempotent room
log key so recovery can replay an interrupted publication.

## Project data

Project root defaults/configures separately through `extensions.projects.root`. Each project stores Markdown/frontmatter documents, slices, threads, generated scope map, Space state, and workspace metadata. See [Projects](projects.md).

Board content may use `$YOPLAI_HOME` or `extensions.board.contentRoot`.

## Permissions and backups

Treat these as secrets: `.env`, agent `.env`, `auth.json`, `oauth/`, `webhook-secrets.json`, `auth.db`, bot tokens, conversation history. OAuth token persistence requires encryption key and connection files are mode-restricted, but backup still sensitive.

Back up config, agent workspaces, canonical history, project/board roots, and databases. Decide whether large media/output/runtime session data needs retention. For consistent snapshots, stop gateway or use storage-aware snapshot methods.

## Repo-local development data

`pnpm init-dev-config` creates `./.yoplai` for repository fixtures only. Export `YOPLAI_HOME="$PWD/.yoplai"` to use it; default resolver otherwise uses `~/.yoplai`.
