# API

Gateway exposes Hono HTTP API and `/ws` realtime broker. Enabled extensions add routes; disabled extension endpoints return `extension_disabled` behavior.

## Core

| Method | Path                       | Purpose                                |
| ------ | -------------------------- | -------------------------------------- |
| GET    | `/health`                  | Process health                         |
| GET    | `/api/ops/metrics`         | Per-agent gateway process counters     |
| GET    | `/api/admin/durable/delivery` | Durable channel queue and uncertain deliveries |
| GET    | `/api/capabilities`        | Enabled UI/runtime capabilities        |
| GET    | `/api/agents`              | List available agents                  |
| GET    | `/api/agents/:id`          | Agent detail for the caller            |
| GET    | `/api/agents/:id/status`   | Agent run status                       |
| POST   | `/api/agents/:id/messages` | Send message and await result          |
| GET    | `/api/agents/:id/history`  | Session history (`sessionKey`, `view`) |
| GET    | `/api/agents/sessions` | Sidebar session summaries (`includeArchived=1` optional) |
| GET    | `/api/agents/sessions/search?q=words` | Full-text search of the caller's interactive chats |
| GET    | `/api/agents/:id/legacy-sessions/:sessionId` | Read an older chat in Durable mode |
| POST   | `/api/agents/:id/legacy-sessions/:sessionId/continue` | Continue an older chat in a private Durable thread |
| GET/PUT/DELETE | `/api/agents/:id/sessions/:sessionId/share` | Read/create/revoke an owner-only chat share link (multi-user only) |
| GET    | `/api/shared-chats/:token` | Read a shared chat's persisted transcript (authenticated, multi-user only) |
| GET    | `/api/media/download/:id`  | Managed media download                 |
| GET/PUT | `/api/me/durable-mode`  | Read or set the caller's Durable mode   |
| GET/PUT | `/api/me/sidebar-order` | Read or set the caller's local agent order |
| GET | `/api/agents/:id/memory` | Read the caller's Durable topics, plan, and gauge |
| WS     | `/ws`                      | Send/subscribe streaming protocol      |

Exact request/response schemas in `packages/shared` and route source are authoritative.

Session search returns `{ items: [...] }`: sidebar summaries (including avatar)
plus `match: "title" | "content"` and an optional `snippet` for content matches.
Hits for local Durable agents have `legacy: true` and use the same private
file reader as `legacy_history`. A content hit has a zero-based `messageIndex`
when the same user or assistant message contains every query word. The index
uses the full transcript's timestamp order and matches the tool's `#<index>`
anchor. Title hits and terms found across messages or the label use the chat URL
without a message anchor.
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

## Ops metrics

`GET /api/ops/metrics` returns counters for the current gateway process.
Multi-user gateways require a superadmin. Other authenticated accounts receive
403. The route is available to the local caller in single-user mode.

```json
{ "metrics": [{ "id": "interrupted_tool_calls", "agentId": "greenhouse", "value": 2 }] }
```

`interrupted_tool_calls` counts top-level Durable tool calls that ended as
interrupted. Counters reset on each restart and rows appear when the counter
first increments. Nested calls inside Code Mode are outside the count.

`GET /api/admin/durable/delivery` reports persistent delivery state across
agents. Multi-user gateways require a superadmin. Single-user gateways expose
it to the local caller. `pending` counts routes awaiting settlement and effects
awaiting send. `queueAgeSeconds` is the age of the oldest of these, or zero when
the queue is empty. `uncertain` counts effects without a confirmed outcome.

```json
{ "queueAgeSeconds": 21.5, "pending": 2, "uncertain": 1 }
```

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
| GET | `/api/model-access/models` | `{ models: [{ provider, model, name, source, credentialType, native?, ready, default, free }] }` |
| POST | `/api/model-access/models/check` | Body `{ provider, model, source? }`; `{ provider, model, ready }` (`422` with `message` if not ready) |
| DELETE | `/api/model-access/:provider` | Remove the owned credential (`204`) |
| POST | `/api/agents` | Create a desktop agent (same guard as the routes above) |

Attempt `state` is `waiting-browser`, `waiting-code`, `done`, `failed`, or
`cancelled`. Model access responses do not return stored keys. Use
`checkOnly: true` to check an API key without saving it.

Each model row identifies one eligible `(source, provider, model)` and reports
the `credentialType` (`oauth` or `api_key`). `source` is one of `owned`, `pi`,
`codex`, `claude-code`, `opencode`, or `environment`. Readiness and the default
are tracked per source. An environment row resolved by the provider itself
carries `native: true`. The agent management models endpoint returns the same row
shape and includes Device rows only on a desktop gateway with relay enabled.

External status entries include a `path` (a home-relative directory or `Keychain`)
and an optional `version`. `warningRequired: true` indicates a Claude login that
needs consent before use. The enable route returns `409 warning_required` with
the terms message until the client resubmits with `warningAccepted: true`.

Agent creation and settings accept `{ provider, model, source? }` and settings
returns the saved `source`. An in-process Pi run uses the saved source for the
agent's primary model. Source-less agents, per-run overrides, and fallback models
use normal credential precedence. Container runs use their own auth runtime.

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
List and refresh rows include `iconDataUri` when the gateway can fetch a PNG
or SVG icon from its HTTPS URL within the 256 KiB limit.
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
- multi-user auth/admin: `/api/auth/*`, `/api/me`, `/api/admin/*`, team and agent-access routes. The gateway returns 404 for Better Auth's `/api/auth/admin/*` namespace.
- webhooks: `/hooks/:agentId/:name/:secret`
- sandbox tool bridge: `/internal/tools` (per-run token required)

See owning package README for exhaustive extension endpoints, especially [projects](../packages/extensions/projects/README.md), [scheduler](../packages/extensions/scheduler/README.md), and [orchestrator](../packages/extensions/orchestrator/README.md).

## WebSocket

Clients can send run request using `agentId` plus logical `sessionKey` or explicit `sessionId`; subscribe/unsubscribe to sessions; subscribe to status/project/subagent events; receive text, thinking, tool, file, done, error, replay, and history-update events.

Use `packages/shared` stream schemas and `apps/gateway/src/server/ws-broker.ts`; do not copy protocol unions from this overview.

## Durable Main

### Account setting

`GET /api/me/durable-mode` returns `{ enabled: boolean, updatedAt?: string,
unsynced?: string[] }`. The setting defaults to off. Existing settings
without a timestamp omit `updatedAt`. Single-user gateways store one setting.
Multi-user gateways require authentication and use the caller's account,
including when a link key authenticates the caller.

`PUT /api/me/durable-mode` accepts `{ enabled: boolean, updatedAt?: string }`
and returns the stored setting. A missing or non-boolean `enabled`, or an
invalid `updatedAt`, returns 400. A PUT without a timestamp saves with the
current time and immediately pushes the change to linked gateways on a
trusted device request. A timestamped PUT applies only to the receiving
gateway and only if the supplied time is newer.

Trusted device GETs reconcile with linked gateways at most once per link
per minute. A link connection also triggers reconciliation. The newest
timestamp wins, and a missing timestamp is older than any valid one. Failures
leave the local save intact. Device GET and toggle responses list affected
gateway names in `unsynced` until a successful sync. Link attempts have a
three-second deadline. `GET /api/me/durable-mode?local=1` returns only the
stored setting.

`GET /api/me/sidebar-order` returns `{ agentIds: string[] }`, initially empty.
It filters out agents the caller can no longer see without updating the file.
`PUT` accepts the same shape, rejecting invalid arrays or empty strings with
400. It keeps the first occurrence of each visible local agent ID, saves that
order for the caller, and returns it. Clients append unlisted agents in the
order returned by the agent list. Multi-user gateways return 401 without an
authenticated account.

### Chat

The WebSocket `send` message and `POST /api/agents/:id/messages` accept
`clientSendId`, a client-generated id of up to 128 ASCII letters, digits,
underscores or hyphens. Reuse that id to retry a composed send and mint a fresh
id for each new send. It deduplicates admission within the caller's Durable
Main, including after a gateway restart.

With Durable mode on, send, history, and subscribe select the caller's Main
for active non-sandboxed agents when `sessionId` is absent or equals
`durable-main`. Logical keys such as `main` and `web-*` all resolve to that
Main. An explicit legacy session id uses the legacy runner. Ordinary sends
without a `clientSendId` also use the legacy runner. Main rejects project and
desktop turn ids and attachments.

Both the agent list and agent detail include `durable: true` when Durable mode applies
to that agent for the caller. Otherwise it omits the field.
The send endpoint still waits for settlement and returns `payloads` and `meta`
with `sessionId` and `durationMs`. A failed or withheld reply returns an error
status with `{ error }`. The socket receives ordered public `text` across tool
rounds, then `done` or `error`. If a provider retry replaces text the socket
already sent, the send ends with `error` and history shows the stored reply.
A Main WebSocket subscription receives the owner's `active_turn` snapshots
and `history_updated` events for Main and their threads. Main events carry
`sessionId: "durable-main"` and thread events carry `sessionId: "thread:<id>"`.
The initial active snapshot covers Main. Clients get a thread's initial live
state from its HTTP feed and refresh it on matching events. `subscribeFeed`
still streams Main's feed.
An interrupted send settles with `meta.aborted: true`.

The history route serves the existing simple or full view, paging, and active
turn fields. The synthetic id is identical across accounts and resolves using
the authenticated caller. Sidebar, search, compact, delete and share routes
continue to use legacy sessions.

Full history includes captured view references on tool calls and results. The
existing `POST /api/agents/:agentId/sessions/:sessionId/mcp-apps/:toolCallId/:operation`
route accepts `durable-main` when Durable mode applies and reads the
caller’s record. An unknown record or a record owned by another user returns
404.

### Stop

`POST /api/agents/:id/stop` stops the current run in the caller's Durable Main.
Send `{ "runId": "<observed id>" }` to bind the stop to a specific run, or omit
the id to stop whichever run is current. Both outcomes return HTTP 200.
`{ "status": "stopped" }` confirms the abort. `{ "status": "already_finished" }`
means Main was idle or the supplied id no longer matched. The route returns
403 when the caller lacks access and 404 for unknown or non-Durable agents.
Queued sends kept by the abort start immediately afterward. If the gateway
restarts before they start, it resumes them for callers with Durable Main access.

Main also accepts trimmed `/stop` and `/abort` as unbound stop commands, including
sends without a `clientSendId`. The HTTP send returns the same stop result.
WebSocket sends return `done` with `meta.stopStatus` set to `stopped` or
`already_finished`, or an `error` with message `Forbidden` when access is denied.
The model and the transcript receive neither command.

### Memory

`GET /api/agents/:id/memory` reads the authenticated caller's memory for the
agent. The feed access check applies. Denied callers receive 403 and
ineligible agents return 404. An empty memory returns 200 with empty lists.

- `topics` entries contain `id`, `kind` (`open`, `decision`, or `digest`),
  `title`, `note`, `refs`, and `updatedAt`. Resolvable references contain
  `id`, `role`, `sender` when present, `timestamp`, and a clipped `text` quote
  from the caller's public Main feed. The newest resolved reference supplies
  `updatedAt`, or `null` when none resolve. A thread digest also has `threadId`.
- `plan` contains `goals`, `nextSteps`, and `updatedAt`.
- `gauge` contains `inputTokens` from the active context since the latest
  seam and `ceilingTokens` from the Main model's compaction ceiling, or
  `null` when the ceiling is unavailable.

A dashboard's `chatHref` for a caller with access to an eligible Durable
agent is `/chat/<agentId>?dashboard=<id>`. This opens Main alongside the
dashboard, including for legacy dashboards. The legacy session and new-chat
links still apply when Durable mode is off or the agent is ineligible.

### Feed

When Durable mode applies, `/api/agents/:id/feed` exposes the caller's Main.
IDs take the form `m_<entry id>` and remain stable across gateway restarts and
context resets. An assistant item groups consecutive answer and tool rounds.

User items carry a `sender` and a `surface` of `web`, `slack`, `mattermost`,
`webhook`, or `job`. For webhook and job digests, `sender` is the route or job
name. The digest is a passive entry. The child transcript has no feed route.
Assistant items with channel delivery include `deliveries`, an array of
`{ surface, state }` entries. A delivery is `pending` while queued or sending,
`sent` after a channel receipt, or `uncertain` when the post could not be
confirmed. Delivery changes appear in live feed frames.

Assistant items and the current `live` state can include a `plan` object
with `steps` (1–20 entries with `id`, `text`, `status`, and an optional
one-line `note` of 1–200 characters) and an optional one-line `explanation`.
Step status is `pending`, `in_progress`, `completed`, or `attention`.
The agent writes the note and status. Slack and Mattermost render an attention
step as `- [ ] text (needs attention)` and indent the note two spaces on the next line. The latest checklist replaces the previous one in the answer
group. It can arrive before any live text and stays on the assistant item
after the turn ends and across reloads and restarts. Its tool calls are
hidden from the activity trace and tool count.

An interrupted top-level tool produces one localized `role: "failure"` item
with `kind: "tool_interrupted"` after its round's tool results. It appears in
feed windows, watch updates, and compatibility history. The notice persists
across reloads and restarts and contains no tool arguments or output. Nested
calls inside replay-safe Code Mode do not produce a notice.

Native Main compaction adds a `role: "seam"` item with its own stable `id`,
`timestamp`, label `text`, and `reason` (`threshold`, `overflow`, or `manual`).
`carried.firstKept` gives the first retained entry ID and `carried.indexed` is
the number of older requests in the model's summary. All earlier feed items
remain pageable. A mid-run seam appears immediately before the grouped
assistant item. The summary stays in model context.

| Request | Result |
| --- | --- |
| `GET /api/agents/:id/feed?limit=50` | Latest items in feed order with `hasBefore`, `hasAfter`, and the current `live` state. |
| `GET /api/agents/:id/feed?before=<id>` | Items immediately before the anchor. |
| `GET /api/agents/:id/feed?after=<id>` | Items immediately after the anchor. |
| `GET /api/agents/:id/feed?around=<id>` | Items around and including the anchor. |
| `GET /api/agents/:id/feed/search?q=<text>&limit=20` | Case-insensitive matches in public user and assistant text, newest first. |
| `GET /api/agents/:id/feed/messages/:messageId` | An assistant item's public reasoning, tool calls and results. |

Windows accept limits from 1 through 200 and one selector. Search accepts limits
from 1 through 50. Invalid limits or multiple selectors return 400. A missing or
out-of-scope anchor, or a detail request for a user message, failure notice, or seam,
returns 404. Before the first send the caller's tail and search are empty.
Search and compatibility history omit seams. In compatibility history,
`activeContextUsage` counts input and cache tokens from the latest assistant
usage after the most recent seam. It reports zero until that usage is available.

Send `subscribeFeed` on `/ws` with the agent ID and optional window limit.
Each subscription starts at sequence 1 with a `feed_snapshot`. A snapshot
replaces the client window. For a `feed_delta`, update or append the listed
items by ID and then discard all items before `dropBefore` when present.
Both frames carry the latest `hasBefore` and `live` values and may include seams.
Reconnects, changes coalesced during a pending send, and reorderings such as
inserting a seam ahead of a visible answer receive a fresh snapshot.
While a run is live, `live.runId` and the compatibility `active_turn.runId`
carry its opaque stop id when available. The id stays stable through steers,
tool rounds, and after-run work. A kept-input run started by a stop receives
a different id. Idle feed windows have `live: null`.
If account or agent access is revoked or Durable mode is turned off, the
gateway ends the subscription with `feed_end`. Send `unsubscribeFeed` to stop
receiving updates.

Code Mode file and MCP views retain their nested call IDs in live and full
history. URL-encode the entire call ID in the MCP Apps route, including any
slashes. When Durable mode applies, either `main` or `durable-main` selects the
caller's Main in that route.

## Durable threads

Threads are private to the caller and their agent. Enable Durable mode for
the account to use these routes. In single-user mode the caller is `local`.
An unavailable agent or disabled Durable mode returns 404.

| Request | Body | Success |
| --- | --- | --- |
| `POST /api/agents/:id/threads` | Optional `{ messageId?, title?, dashboardId? }` | 201 with the new thread |
| `GET /api/agents/:id/threads` | | 200 with open and closed threads, newest activity first |
| `POST /api/agents/:id/threads/:threadId/close` | `{ generation }` | 200 with the archived thread |
| `POST /api/agents/:id/threads/:threadId/reopen` | | 200 with the open thread |

Each response row has `id`, `title`, `preview`, `createdAt`, `lastActivityAt`,
`closed`, `generation`, and optional `dashboardId` and `forkedFrom`. Dates are
Unix milliseconds. By default, the title comes from the first new user message
(up to 80 characters), then the forked message, then `New thread`. The preview
comes from the latest new message (up to 120 characters), then the forked
message, then an empty string. Activity starts at creation and follows the
latest new message. `dashboardId` is a caller-provided string of 1–128
characters and survives closing and reopening.

Create an empty thread with no `messageId`. Supply a public `m_<n>` ID from
the caller's Main to inherit history through that user message or the whole
settled assistant answer. A missing or inaccessible message returns 404
`Message not found`. An unsettled assistant answer returns 409
`Message is still running`. The first send places a snapshot of available
agent memory in model context before the new input.

Close requires the current generation. It starts at 1 and advances once per
successful reopening. Retrying a close at the same generation completes any
pending effects and returns the same archived thread. A mismatched generation
returns 409 `Stale generation`. A live turn returns 409
`Stop the thread before closing it`. Closing `main` or `durable-main` returns
400 `Main cannot be closed`. Missing and other users' threads return 404
`Thread not found`. Each close replaces the thread's digest in the topic map
and adds one model-visible note to Main. Reopening finishes pending close
effects and preserves the digest. Reopening an already open thread returns
its current generation.

Send with `POST /api/agents/:id/messages` and
`{ "sessionId": "thread:<threadId>", "clientSendId": "<client id>", "message": "<text>" }`.
The response's `meta.sessionId` uses the same thread reference. Sending to an
archived thread returns 409 `Thread is closed`. Read both open and archived
threads by adding `?thread=<threadId>` to the feed, feed search, or message detail
route. Forked messages keep their original IDs. Stop a running thread with
`POST /api/agents/:id/stop` and `{ threadId, runId? }`, or send `/stop` or
`/abort` with the thread's `sessionId`. Thread chat uses HTTP. Main keeps its
own WebSocket events, compatibility history, and channel delivery.

## Durable legacy chats

Both routes use the authenticated caller's canonical JSONL history for the
requested agent. URL-encode `:sessionId`, including any `#` or `%`. Both routes
accept archived chats by ID, read the file without backfilling from Pi, and
leave legacy files untouched.

| Request | Success |
| --- | --- |
| `GET /api/agents/:id/legacy-sessions/:sessionId` | 200 with `{ agentId, sessionId, title, archived, messages }` |
| `POST /api/agents/:id/legacy-sessions/:sessionId/continue` | 201 with the new [private thread](#durable-threads) |

The GET returns the full persisted `FullHistoryMessage[]` in transcript order
and a boolean `archived` flag. The POST takes no body and creates a thread whose
first model request includes a handoff with the legacy transcript and available
agent memory. The handoff points to `legacy_history` to recover older messages
and includes the archive flag when needed.

An unsafe session ID returns 400. Missing or foreign sessions and agents
unavailable in Durable mode return 404. Agent access denial returns 403.

## Rooms

A room uses an existing chat project ID. The owner's first request for that
room creates its record. The owner and current members can read the full message
history. Chat project files, notes, and instructions retain owner-only access.
Single-user mode uses `local` as the owner. Rooms are available independently of
the Durable mode preference.

| Request | Body | Success (200) |
| --- | --- | --- |
| `GET /api/rooms` | | `{ items: [{ id, name, role, ownerUserId }] }` |
| `GET /api/rooms/:roomId` | | `{ id, name, role, ownerUserId, members, agents }` |
| `POST /api/rooms/:roomId/members` | `{ userId }` | `{ ok: true }` |
| `DELETE /api/rooms/:roomId/members/:userId` | | `{ ok: true }` |
| `POST /api/rooms/:roomId/agents` | `{ agentId }` | `{ ok: true }` |
| `DELETE /api/rooms/:roomId/agents/:agentId` | | `{ ok: true }` |
| `POST /api/rooms/:roomId/messages` | `{ clientSendId, message }` | `{ id, seq, duplicate }` |
| `GET /api/rooms/:roomId/feed` | | `FeedWindow` |
| `GET /api/rooms/:roomId/feed/messages/:messageId` | | `FeedDetail` |

Lists include rooms with records. Names come from the owner's project. The
caller role is `owner` or `member`. The detail lists member user IDs and agent
IDs. Missing and inaccessible rooms return 404. Management is owner-only and
returns 403 for members. Adding an ineligible user, adding a member in
single-user mode, removing the owner, and adding an unavailable agent return
400. An owner can remove a registered agent after losing access to it.

Sends accept a string message and a client ID of 1–128 letters, digits, dashes
or underscores. Attachments and stop commands are unsupported. Reusing a
client ID in the same room as the same author returns the original ID and
sequence with `duplicate: true`.

Mention a registered agent with `@<agentId>`. A word character immediately
before the `@` prevents a match. Letters, digits, underscores and hyphens
belong to the ID, so `@scout.notes` mentions `scout`. Matching ignores case
unless registered IDs differ only by case, in which case the spelling must
match exactly. Only members' messages can start a run by mentioning an agent.
Untagged messages contribute context in room order, including during a turn.
Added agents receive a handoff of earlier room history and begin to see new
messages. Removing an agent withdraws its queued room inputs and aborts its run.
Room turns use Durable for active, non-sandboxed agents regardless of account
preferences.

Feed windows are ordered by increasing sequence. The default limit is 50 and the
allowed range is 1–200. Supply at most one of `before`, `after`, or `around`
with an `r_<seq>` anchor. A missing anchor or detail ID returns 404. All items
have `id`, `text`, and `timestamp` (Unix milliseconds). Member messages have
`role: "user"`, the display name in `sender`, and `surface: "web"`. Public agent
answers appear once with `role: "assistant"`, the agent name in `sender`, and
`toolCallCount: 0`. Thread digests have `role: "user"` and
`sender: "Thread digest"`. Window `live` is null and details add empty
`reasoning` and `toolCalls` arrays.

Send `{ "type": "subscribeRoomFeed", "roomId": "orchard", "limit": 50 }` to
`/ws`. The subscription uses the same snapshot and delta rules as the agent
feed, with `roomId` as the feed identifier. It replaces the current feed
subscription. Send `unsubscribeFeed` to stop. An inaccessible room returns
a WebSocket `error`. Removing a member or deleting a project ends the affected
watches with `feed_end` and `reason: "forbidden"`. Project deletion also
removes its room data.

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
