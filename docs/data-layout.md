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
| `agents/<id>/dreams/`        | Dream journals/state/staged sessions            |
| `history/*.jsonl`            | Canonical single-user chat transcripts          |
| `sessions/*.jsonl`           | Pi SDK runtime resume state                     |
| `sessions.json`              | Logical session key mappings                    |
| `sessions/subagents/runs/`   | Project-agnostic subagent records/logs          |
| `media/`                     | Managed inbound/outbound files                  |
| `oauth/`                     | Encrypted per-agent extension OAuth connections |
| `webhook-secrets.json`       | Webhook URL secrets                             |
| `auth.db`                    | Multi-user Better Auth SQLite database          |
| `projects.json`              | Project numeric ID counter                      |

## Canonical history vs runtime sessions

`history/*.jsonl` is normalized transcript used by API, web UI, tracing, compaction, channel context, and media blocks. `sessions/*.jsonl` is Pi SDK-owned resume/session state, not product history. Gateway may backfill/fallback from Pi files for legacy or actively streaming sessions.

Multi-user mode puts user-scoped maps/history under `sessions/users/<userId>/`. Enabling it does not migrate existing single-user history.

## Project data

Project root defaults/configures separately through `extensions.projects.root`. Each project stores Markdown/frontmatter documents, slices, threads, generated scope map, lead-session records/transcripts, Space state, and workspace metadata. See [Projects](projects.md).

Board content may use `$YOPLAI_HOME` or `extensions.board.contentRoot`.

## Permissions and backups

Treat these as secrets: `.env`, agent `.env`, `auth.json`, `oauth/`, `webhook-secrets.json`, `auth.db`, bot tokens, conversation history. OAuth token persistence requires encryption key and connection files are mode-restricted, but backup still sensitive.

Back up config, agent workspaces, canonical history, project/board roots, and databases. Decide whether large media/output/runtime session data needs retention. For consistent snapshots, stop gateway or use storage-aware snapshot methods.

## Repo-local development data

`pnpm init-dev-config` creates `./.yoplai` for repository fixtures only. Export `YOPLAI_HOME="$PWD/.yoplai"` to use it; default resolver otherwise uses `~/.yoplai`.
