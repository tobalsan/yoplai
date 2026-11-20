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
| GET    | `/api/agents/sessions` | Sidebar session summaries (`includeArchived=1` optional) |
| GET    | `/api/agents/sessions/search?q=words` | Full-text search of the caller's interactive chats |
| GET/PUT/DELETE | `/api/agents/:id/sessions/:sessionId/share` | Read/create/revoke an owner-only chat share link (multi-user only) |
| GET    | `/api/shared-chats/:token` | Read a shared chat's persisted transcript (authenticated, multi-user only) |
| GET    | `/api/media/download/:id`  | Managed media download                 |
| WS     | `/ws`                      | Send/subscribe streaming protocol      |

Exact request/response schemas in `packages/shared` and route source are authoritative.

Session search returns `{ items: [...] }`: sidebar summaries (including avatar)
plus `match: "title" | "content"` and an optional `snippet` for content matches.
The shown label is `title || firstUserMessage || sessionId`. Each query word is
a case-insensitive substring that must occur in the label or user/assistant text,
possibly across messages. Tool calls/results, thinking and system text do not
count. Only the caller's sessions of visible agents are scanned, including chat
Project sessions, excluding archived and non-interactive sessions. Empty queries
return no items. Title matches precede content matches, each newest first by
`lastActivity`, capped at 50. Search scans canonical history without an index;
unlike sidebar polling, search requests remain in the access log.

Chat share GET returns `{ shared: boolean, token? }`; PUT is idempotent and
returns `{ shared: true, token }`; DELETE returns `{ shared: false }` and kills
the old token immediately. A later PUT creates a new token. Owner routes require
agent access and an existing session in the caller's own history (otherwise
404). Sharing is unavailable in single-user mode.

The shared-chat endpoint grants any logged-in platform user read access through
the token, without requiring agent access. It returns
`{ agentId, agentName, title, messages }` with full canonical persisted history,
including tool calls/results and compaction entries, with system `context`
removed. It returns no owner identity, active-turn snapshot or context usage.
Each request reads the latest persisted history, without paging or streaming.
Unknown/revoked tokens and deleted sessions return 404. The share store is
`$YOPLAI_HOME/chat-shares.json`; it never contributes to agent prompts.
Media download permissions are unchanged: the shared UI renders filenames only.

## Desktop setup and model access

The Yoplai Desktop app uses these routes for first-run setup. They are not a
general API. `GET /api/capabilities` reports `desktopSetup: true` only when the
request passes the desktop access checks below.

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET/PUT | `/api/desktop-setup` | Read or patch the setup state |
| GET | `/api/desktop-setup/turns/:agentId/:sessionId/:turnId` | `{ state }`: `none`, `running`, `answered` or `failed` |
| GET | `/api/model-access` | `{ external, owned, oauthProviders, apiKeyProviders, attempts }` |
| POST | `/api/model-access/oauth/:provider` | Start sign-in for `openai-codex` or `anthropic`; body `{ replace?, warningAccepted? }`. Returns `202` with the attempt, or `200` with the existing attempt and `resumed: true`. |
| GET | `/api/model-access/oauth/attempts/:handle` | Read `{ handle, provider, state, message? }` |
| POST | `/api/model-access/oauth/attempts/:handle/answer` | Submit `{ code }`; returns the attempt |
| POST | `/api/model-access/oauth/attempts/:handle/cancel` | Cancel without a body; returns the attempt |
| POST | `/api/model-access/api-key` | Body `{ provider, key, checkOnly?, replace? }`; returns `{ provider, model, ready, saved }` |
| POST | `/api/model-access/external/:source` | Body `{ enabled, warningAccepted? }` for `codex`, `claude-code`, `opencode`, `pi` |
| GET | `/api/model-access/models` | `{ models: [{ provider, model, name, source, ready, default, free }] }` |
| POST | `/api/model-access/models/check` | Body `{ provider, model }`; `{ provider, model, ready }` (`422` with `message` if not ready) |
| DELETE | `/api/model-access/:provider` | Remove the owned credential (`204`) |
| POST | `/api/agents` | Create a desktop agent (same guard as the routes above) |

Attempt `state` is `waiting-browser`, `waiting-code`, `done`, `failed`, or
`cancelled`. Model access responses do not return stored keys. Use
`checkOnly: true` to check an API key without saving it.

These routes require `YOPLAI_DESKTOP=1`, relay enabled, and multi-user mode off.
The listener, socket peer and all forwarded addresses must be loopback. `Host`
must be `127.0.0.1`, `localhost` or `[::1]` with the gateway port. `Origin`, if
present, must be an HTTP origin using one of those hosts on the UI port. `Sec-Fetch-Site` must be absent, `same-origin` or `none`.
The guard returns `403 desktop_setup_unavailable` when access is denied and
`415 json_required` for nonempty write bodies without `application/json`.
Responses use `Cache-Control: no-store`.

Setup state is saved in `$YOPLAI_HOME/desktop-setup.json`. PUT accepts a partial
`DesktopSetupStateSchema` and returns the saved state. Setting `completed: true`
requires the saved `firstChat` (`{ agentId, sessionId, turnId }`) to match an
answered turn. Changing `firstChat` clears completion. To retry a claimed,
failed greeting, submit the same agent and session with a fresh UUID in
`firstChat.turnId` and the old UUID in `retryOf`. If the failed turn is no longer
current, the gateway returns `409 retry_conflict`.

Agent creation takes `{ requestId, name, purpose?, avatar, model: { provider,
model } }`. Use a UUID for `requestId`, an integer from 1 to 10 for `avatar`, and
an eligible model from the model list. The response is `{ id, instructions }`,
where `instructions` is `model` or `template` (`201` for creation, `200` when
reusing a saved request ID).

## Extension catalog

| Method | Path | `200` response |
| ------ | ---- | -------------- |
| GET | `/api/admin/extension-catalog` | Catalog list |
| POST | `/api/admin/extension-catalog/refresh` | Catalog list after a refresh |
| POST | `/api/admin/extension-catalog/:id/install` | Catalog row after an install or update |
| DELETE | `/api/admin/extension-catalog/:id` | `{ ok: true }` |

Send no request body. Use the extension ID from the catalog row for `:id`.

The catalog list returns `{ source, fetchedAt, stale, error?, entries }`.
`source` is the catalog URL. `fetchedAt` is an ISO timestamp or `null`.
Each row includes `id`, `usedByAgents`, and `state`: `available`, `installed`,
`update`, `manual`, or `incompatible`. A row can also include `installedVersion`.
Catalog metadata includes `name`, `tagline`, `description`, `category`, `version`,
`minYoplai`, `url`, `size`, `sha256`, and optional `iconUrl` and `docsUrl`.
Local entries without a catalog match can omit catalog metadata.

If a catalog fetch fails, list and refresh return `200` with `stale: true` and
`error`. They use the last catalog copy if one exists. Without a copy, they
return only local entries and set `fetchedAt` to `null`.

| Status | Meaning |
| ------ | ------- |
| `403` | The caller is not a superadmin in multi-user mode, or the write has an untrusted `Origin`. |
| `404` | The catalog is disabled, or the extension ID is unknown. |
| `409` | The gateway is busy with another extension change, or the operation fails. |
| `502` | The install has no usable catalog. |

Errors return `{ error: "<message>" }`. If a write supplies an `Origin` header,
it must match an allowed origin.

For a linked gateway, add `/api/relay/gateways/:name` before the full route.
The relay checks the browser origin before it forwards a write. It rejects a
write with a body (`400`). The linked gateway checks the linked user's role.

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

## Settings audit

`GET /api/audit/settings` lists settings changes for admins and superadmins.
In single-user mode the local owner may read it. Other multi-user members receive
`403`. Optional query filters: `agentId`, `actorUserId`, `action`, `since`, `until`,
`limit` (default 100, maximum 500), and `cursor` (the prior response's
`nextCursor`). Dates are ISO timestamps; invalid dates, limits, or cursors return
`400`.

The response is `{ entries: [...], nextCursor: string | null }`, ordered newest
first. Entries include `id`, `createdAt`, actor user/email, impersonator ID,
action, agent, target type/ID, scope, and `changes`. Non-secret changes include
`field`, `before` and/or `after`; secret changes include only `field` and
`secret: "set" | "removed"`. Environment references in non-secret fields remain
references, never resolved environment values.

The gateway creates `$YOPLAI_HOME/audit.db` lazily on the first effective settings
change, independently of multi-user `auth.db`. Rows are retained indefinitely.
Audit write failures warn and allow the settings change to succeed. Direct edits
to agent YAML on disk are outside the audit; the audit covers extension settings,
credential removal, OAuth connections, scheduler credential modes, and admin
user/team/membership/assignment/fork changes. Extensions may append events using
optional `ctx.audit?.record(entry)`; secret fields must use markers rather than
values. Empty change arrays write no row.
