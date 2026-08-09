# API

Gateway exposes Hono HTTP API and `/ws` realtime broker. Enabled extensions add routes; disabled extension endpoints return `extension_disabled` behavior.

## Core

| Method | Path                       | Purpose                                |
| ------ | -------------------------- | -------------------------------------- |
| GET    | `/health`                  | Process health                         |
| GET    | `/api/capabilities`        | Enabled UI/runtime capabilities        |
| GET    | `/api/agents`              | List available agents                  |
| GET    | `/api/agents/:id/status`   | Agent run status                       |
| POST   | `/api/agents/:id/messages` | Send message and await result          |
| GET    | `/api/agents/:id/history`  | Session history (`sessionKey`, `view`) |
| GET    | `/api/media/download/:id`  | Managed media download                 |
| WS     | `/ws`                      | Send/subscribe streaming protocol      |

Exact request/response schemas in `packages/shared` and route source are authoritative.

## Extension route groups

- scheduler: `/api/schedules/*`
- projects and nested slices: `/api/projects/*`
- project-agnostic subagents: `/api/subagents/*`
- board: `/api/board/*`
- tracker orchestrator: `/api/orchestrator/*`
- host OAuth: `/api/oauth/:provider/*`
- multi-user auth/admin: `/api/auth/*`, `/api/me`, `/api/admin/*`, teams/pool routes
- webhooks: `/hooks/:agentId/:name/:secret`
- sandbox tool bridge: `/internal/tools` (per-run token required)

See owning package README for exhaustive extension endpoints, especially [projects](../packages/extensions/projects/README.md), [scheduler](../packages/extensions/scheduler/README.md), and [orchestrator](../packages/extensions/orchestrator/README.md).

## WebSocket

Clients can send run request using `agentId` plus logical `sessionKey` or explicit `sessionId`; subscribe/unsubscribe to sessions; subscribe to status/project/subagent events; receive text, thinking, tool, file, done, error, replay, and history-update events.

Use `packages/shared` stream schemas and `apps/gateway/src/server/ws-broker.ts`; do not copy protocol unions from this overview.

## Authentication

Single-user mode has no Yoplai user boundary; keep it private. Multi-user extension guards `/api/*` and `/ws` using Better Auth cookie session or bearer API key. Both resolve same request auth context and agent/team access checks.

```bash
curl -H "Authorization: Bearer $YOPLAI_TOKEN" \
  https://host.example/api/agents
```

Webhook URL secret and internal tool token are separate authentication mechanisms.

## Media

Inbound upload is capped server-side and MIME allowlisted. Gateway stores managed files beneath `$YOPLAI_HOME/media`; access is subject to auth ownership in multi-user mode. Outbound agent files are registered before download.
