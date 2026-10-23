# Yoplai — LLM Repository Map

## Project goal

Yoplai is a lightweight, self-hosted multi-agent gateway. It runs agents across web chat, messaging, CLI, scheduled jobs, and project orchestration while keeping configuration and runtime data local.

This document is the cross-package map for coding agents. Use it to find ownership and understand invariants. `README.md` is the beginner self-hosting path, `docs/README.md` indexes advanced user guides, and package READMEs remain authoritative for exhaustive extension detail.

## Repository layout

```text
yoplai/
├── apps/
│   ├── gateway/              # Node.js gateway, CLI, agent runtime, HTTP/WS API
│   └── web/                  # Solid.js web application
├── container/
│   └── agent-runner/         # Standalone sandbox container entrypoint
├── packages/
│   ├── extensions/           # First-party optional extensions
│   └── shared/               # Zod schemas, shared types, protocol contracts
├── docs/                     # Cross-package guides and workspace templates
└── scripts/                  # Development/config/model maintenance scripts
```

### `apps/gateway`

Core TypeScript/Node.js process. Main ownership:

- `src/cli/`: `yoplai` command tree and gateway service management
- `src/config/`: v3 config loading, agent discovery, env-reference resolution, validation, reload
- `src/agents/`: run orchestration, session lifecycle, workspace bootstrap, sandbox helpers
- `src/sdk/`: Pi, Claude, OpenClaw, and container adapters
- `src/server/`: Hono HTTP API, WebSocket broker, auth middleware, request normalization
- `src/history/`: canonical history operations
- `src/extensions/`: extension registry, runtime, route/tool/prompt composition, lifecycle
- `src/media/`: inbound uploads, document extraction, outbound files
- `src/oauth/`: host-side per-agent OAuth connection framework
- `src/tasks/`: durable task ledger
- `src/evals/`: headless single-turn Harbor eval runner

Important seams:

- `runAgent()` resolves agent/session, handles commands, selects adapter, and runs turns.
- Restart gate: the gateway writes `$YOPLAI_HOME/run/active-turns.json` (`agents/active-turns.ts`, atomic temp+rename) on every streaming-session change, and clears it at startup. Extensions report running children with `ExtensionContext.setActiveWork(extensionId, items)` (subagents, project subagents, and orchestrator do this); each call replaces that extension's list. `yoplai gateway idle` and `yoplai gateway restart` read the file; a missing file or dead PID means idle. `restart --force` skips the check.
- `SessionRunLifecycle` owns active state, aborts, queue/interrupt joins, buffered follow-ups, history events, and final flushing.
- Activated runs initiated with `source: "web"` append `lastWebCompletion: { id: <uuid>, endedAt: <server ms> }` session metadata after their transcript or failure notice is persisted. Session summaries expose the latest valid marker without changing `lastActivity`; the run's session-scoped `status` event carries the same marker as optional `completion`. Aborts (including forced cleanup), queued acknowledgements, pre-run rejections and non-web runs never create markers. A failed marker write still releases the run lifecycle. Browser notifications must use this marker, never ordinary `idle` events.
- Once the durable answer claims completion, Stop reports no active run while marker persistence settles; the run remains reserved so follow-ups cannot start early. Deleting a chat uses the existing caller-scoped session reset: abort, wait up to two seconds for settlement, then remove history and bindings. A still-stopping adapter returns HTTP 409 without deleting history, so deletion can be retried safely.
- `RunAgentParams.userId` remains the requester for credentials and identity; `sessionOwnerId` selects persisted history/session storage (`undefined` defaults to requester, `null` means shared). Trusted `requesterId` distinguishes unpaired transport senders; different requesters queue separate turns with their own context, attachments, callbacks, and delivery target.
- `normalizeRunRequest()` is the shared REST/WebSocket input normalization path.
- `ExtensionRuntime` is the source of loaded routes, tools, prompt contributions, capabilities, and lifecycle state.
- Extension logging uses `ctx.logger.info/warn(message, fields)` and `ctx.logger.error(message, error, fields)` for top-level structured fields. Pass a short error string when full diagnostics belong only in persisted run/output artifacts. Thrown tool errors with integer HTTP status 400–499 or explicit `code: "invalid_input"` log at warning; unmarked validation errors remain errors.

### `apps/web`

Solid.js SPA. It consumes `/api/capabilities` and loads optional extension routes only when enabled.

- `src/api/`: domain API clients and realtime client
- `src/lib/chat-runtime.ts`: shared streaming/history/attachment runtime
- `src/lib/web-route-registry.tsx`: optional extension route discovery
- `src/extensions/`: extension-owned route bundles
- `src/components/ui/`: shared primitives (Modal, ConfirmDialog, Button, TextField, TextAreaField) used by chat projects and sidebar; scoped styles, no external UI library
- core chat supports simple/full history, streaming, attachments, aborts, and explicit sessions
- Main `ChatView` copies complete agent turns as semantic HTML plus clean text through `lib/reply-clipboard.ts` and `lib/clipboard.ts`; tool/thinking/file/failure content is excluded. It hides reply copying during the active turn and for incomplete history turns. Code copying is opt-in via `renderMarkdown({ copyCode: true })` with a ChatView-owned delegated handler, including streaming HTML replacement; other markdown surfaces keep their default rendering.

`SessionSearch` mounts once in the app layout. Search is first in sidebar navigation
(then optional Board/Orchestrator, Agents and existing items); the old Sessions
header and inline title filter are removed. Cmd/Ctrl+K opens the focused palette
on every page except login, including embedded chats, without sending `/new`.
The Board project palette is retired. The palette debounces 200 ms, aborts on
each input change, guards all async state against stale responses, and highlights
query words using text nodes. Arrows/Enter open an encoded chat URL; Escape is
captured so it cannot abort a chat underneath. Empty input shows no sessions.

Home keeps extension-owned routes first; otherwise a personal main-agent preference opens a fresh `/chat/<agentId>` via `startNewChat` on every home visit. Users without an accessible preference see a character-select overlay on the catalog; deliberate dismissal lasts only for that visit. One eligible agent auto-saves, zero shows the catalog, and load/save failures retain a usable catalog or picker. The chat header has a star button (filled when the chat agent is the main agent) that reopens the picker, plus a settings cog linking to `/agents/<id>/edit` (pool id in forked mode, hidden without a match) with history state `backTo` so the edit page Back link returns to that chat (default `/agents`); the Agents catalog lists the main agent first with an accent glow, and each card's top-left star opens a confirmation dialog before saving, staying in place. A click anywhere on a chattable card (outside its links/buttons) starts a new chat; the Chat link stays as the keyboard path. Agents navigation remains `/agents` and the logo remains `/`. Blank home chats must not create persisted session files before a user message.

`/api/me/main-agent` (GET/PUT/DELETE) stores `{ mainAgentId, pickerDismissedAt, updatedAt }` atomically in `main-agent.json` beneath the user's session area (config root in single-user mode, `sessions/users/<id>` in multi-user mode), without an auth.db migration or audit entry. The browser-safe `@yoplai/shared/main-agent` eligibility helper is shared by gateway and web: fork catalogs permit only `chat` entries' runnable `chatAgentId`, never template IDs. GET reports current accessibility, picks clear dismissal, and dismissal timestamps come from the server. See [main-agent home](specs/main-agent-home.md) for behavior and E2E scenarios.

Core `App.tsx` must not hard-import optional board/projects route modules. Optional bundles must remain lazy and capability-gated so core web builds work without them.

### `packages/shared`

Owns schemas and protocol contracts used across gateway, web, extensions, and container runner:

- gateway/agent/schedule schemas and shared API types
- canonical history and stream event schemas
- container input/output framing contracts
- extension and tool-extension contracts
- browser-safe exports such as `@yoplai/shared/types`

Browser code should use browser-safe subpaths, not the package root, which also exports Node-only helpers.

### `container/agent-runner`

Standalone Node 24 process for sandboxed agents. It reads `ContainerInput` JSON from stdin, runs Pi or Claude, streams framed events on stdout, and writes framed `ContainerOutput`. It may import `@yoplai/shared` and SDK packages, but never gateway source.

Container tool deadlines and verified shutdown live in gateway `sdk/container/`;
the runner's `bash-deadline.ts` wraps native Pi Bash to respect the gateway's
non-renewable `ContainerInput.turnDeadlineAt` and report timeout reductions.

Gateway tools (extensions, MCP, `dashboard_link`, `extract_document`, and
`describe_image`) expose an optional `timeout` in seconds in the container.
Positive finite values are honored without a policy cap; missing or invalid
values default to 300 seconds. The runner strips this metadata from extension
arguments and trims the budget to the remaining turn time minus one second,
reporting `timeout reduced to Ns: turn time limit`. A per-call timeout returns
a tool error and lets the agent continue; the watchdog allows 15 seconds of grace.
Extension tool authors receive `context.signal?: AbortSignal`: forward it to
network calls and check it before progress or side effects. Cancellation is
cooperative; a timeout does not prove a remote side effect did not happen.
Run cancellation and container shutdown abort in-flight gateway calls, and
late results/progress are discarded. External MCP clients must forward the
signal themselves; the platform cannot cancel their remote transport alone.
The same call deadlines, correlation IDs, and cancellation apply over HTTP
and Unix-socket gateway transport. Browser CLI commands use the Bash deadline
wrapper; terminal watchdog timeouts retain their localized failure notices.

## Configuration invariants

Yoplai uses v3 configuration. Default config is `$YOPLAI_HOME/yoplai.json`, where `YOPLAI_HOME` defaults to `~/.yoplai`. `yoplai.json` is required; runtime does not create it automatically.

Minimal shape:

```json
{
  "version": 3,
  "agents": ["agents/*"],
  "extensions": {
    "scheduler": {},
    "subagents": {}
  },
  "gateway": { "bind": "loopback", "port": 4000 },
  "ui": { "bind": "loopback", "port": 3000 }
}
```

`agents` entries are exact directories or glob patterns, including nested and brace globs. Every matched directory must contain a flat `agent.yaml`; inline agent objects in `yoplai.json` are not supported. Glob discovery ignores `.git` directories.

Typical agent file:

```yaml
id: assistant
name: Assistant
model:
  provider: anthropic
  model: claude-sonnet-4-5
language: en
extensions:
  scheduler:
    enabled: true
```

Key rules:

- `agent.yaml` may set `language: en | fr` for fixed run-failure notices; it defaults to `en`.
- Optional root `notifications.adminChannel` names an entry in `notifications.channels`. Only provider quota failures notify it, at most once per provider/model per hour; rate limits and overloads do not.
- A terminal run failure is persisted as a safe assistant history entry with `meta.stopReason: "error"` and `meta.failure.kind`. Its fixed user-facing text is localized by the agent language; raw provider errors remain diagnostic data and must not be shown as the notice.
- Root `extensions.<id>` configures/loads an extension; agent `extensions.<id>` opts an agent into tool-style extensions unless `enabled: false`.
- Agent folders may contain `.env`. `$env:NAME` resolves from agent-local env layered over `$YOPLAI_HOME/.env`, `yoplai.json` `env`, and `process.env`.
- Agent-local resolved values are passed to extension hooks as `ctx.env`; do not assume they enter global `process.env` or sandbox env.
- Agent env files are read on every resolution; key names log once per content change per agent and absolute path. Reloads preserve this log state; empty/missing files stay silent and reset the observed content.
- External extensions default to `$YOPLAI_HOME/extensions` or `extensionsPath`; directories and symlinked directories are supported.
- Projects root is `extensions.projects.root`; top-level `projects.root` is deprecated fallback only.
- Onboarding tour (multi-user only): `user_onboarding` table in `auth.db` (`createOnboardingStore`, `packages/extensions/multi-user/src/onboarding.ts`) stores per-user `done|skipped` + timestamp, exposed at `GET/PUT/DELETE /api/me/onboarding` (`supported:false` in single-user mode). Web: `apps/web/src/onboarding/` (`steps.ts` route/target table, `OnboardingTour.tsx` driver.js controller mounted in `Layout`, `state.ts` step signal in sessionStorage + `restartTour`). Targets use `data-tour` attributes; keep them when editing the agent catalog, edit-agent, extension details, credential tabs, OAuth connect card and chat composer.
- Top extensions and system flags: global superadmin flags in `$YOPLAI_HOME/top-extensions.json` (`{ extensions: string[], mcp: string[], system: { extensions: string[], mcp: string[] } }`, `apps/gateway/src/extensions/top-extensions.ts`). Missing `system` data reads as empty lists. MCP servers use `normalizeMcpServerUrl` (`@yoplai/shared/mcp-url`: lowercase scheme/host, path kept, no query/hash/trailing slash), so one flag covers every agent using that URL; stdio servers cannot be flagged. `GET /api/top-extensions` (any signed-in user) returns both flags; `GET/PUT /api/admin/top-extensions` is superadmin-only (single-user allowed), GET adds `candidates`, and PUT sanitizes both flag sets and audits `top_extensions.update`. A PUT omitting `system` preserves current system flags. In multi-user mode, saving a system flag removes its Top star; Edit-Agent hides system items from users/admins even when enabled, and shows them with a System badge to superadmins. Filtering affects only this list: direct details/API access, runtime tools, agent configuration and My connections stay unchanged. Single-user mode ignores system flags (no controls/badges/filtering or Top exclusion). Web: `apps/web/src/pages/admin/Extensions.tsx` (`/admin/extensions`, Extensions tab in `AdminLayout`) manages both flags; user management is multi-user-only and Extensions/MCP servers are superadmin-only. MCP candidate icons use the MCP extension's `$YOPLAI_HOME/mcp/icons.json` hostname cache (hostname, then root domain).
- Connect prompt (multi-user only): `apps/web/src/components/ConnectToolsPrompt.tsx` auto-opens on `/chat/:agentId` once per user × agent when no tour step is shown on that page (a pending step on another route, e.g. a new user landing straight in chat, doesn't block it; a step appearing closes it unseen) and some Top connectable item (OAuth/secret extension or OAuth MCP server) needs action; rows are Connected (personal) / Already connected for the team / Enable (usable credentials, extension off) / Connect (OAuth popup, personal scope) / Set up (swaps the list for `ExtensionConfigForm` with `agentId` + `personalOnly`: no scope tabs or remove action, saves personal credentials — which enables the extension — then refreshes rows and returns to the list). Disabled extensions don't get `configured` checked, so the client requires every required secret to be covered; a broken personal OAuth grant counts as not connected (no team fallback). Enable — and OAuth success from the modal — uses a personal-scope PATCH resending `personalConfigValues`, because members get `team_requires_admin` on team-scope enables. Seen state: `user_agent_connect_prompt` in `auth.db` (`packages/extensions/multi-user/src/connect-prompt.ts`), `GET/PUT/DELETE /api/me/connect-prompt/:agentId` (`supported:false, seen:true` without multi-user). Sidebar **Connect tools** (same row as **Restart tour**, chat routes only, hidden while nothing is starred) reopens it via `openConnectPrompt` in `onboarding/state.ts`.
- Multi-user mode is enabled with `extensions.multiUser.enabled: true`, not a top-level `multiUser` key. It needs at least one sign-in method: `oauth.google` and/or `emailAndPassword: { enabled: true }`; `/api/capabilities` exposes `authMethods` so the login page renders only configured methods.
- Google sign-in refreshes `user.image` while preserving local name/email edits (`multi-user/src/auth.ts`). User/member and sharing-recipient lists include `image`; web `UserAvatar` owns direct photo rendering with no referrer, initials on missing/failed images, and retry when the URL changes.
- Multi-user access: `canUserUseAgent` in `runtime-state.ts` (exported from the package root) treats agents without fork records as Public when the live runtime has no pool (`getPoolAgentIds().length === 0`). Approved users and admins can list and use these agents, including HTTP/WS chat, avatars and capability self-enable. Existing fork records, including migrated same-id assignments, keep Public/shared-team rules via `canUserChatAgent`; lists and detail gates agree. Pooled behavior is unchanged; superadmin and admin unforked-template bypasses stay in callers, and the admin template exception is excluded from list filtering. `canManageAgent(auth, agentId)` allows superadmin or an admin sharing a fork team, ignoring Public; teamless forks and no-pool plain agents require superadmin for management. Exception: `PUT /api/admin/forks/:poolId/teams` lets any admin add or remove their own teams on a Public fork (other teams stay), so EditAgent shows them the team buttons; Private forks still need a shared team. Admins still get catalog metadata, but the Agents page shows them only agents they can chat plus unforked agents to assign. Superadmins see every card. Forks expose `public: boolean` and `{ mode: "list", teamIds }`; legacy All teams rows migrate once, after team-link backfill, to Public with cleared links/legacy teamId. New mode `all` writes return 400. `GET /api/teams` returns `canManage` per team.
- Sign-up creates no explicit team memberships. The retired `autoJoinPublicTeams` config key is accepted and ignored; All users membership remains live. Team `private` stays in storage/API but is inert and hidden. Staff-only `GET /api/admin/users/no-team` includes pending profiles and returns empty while any All users team exists. `POST /api/admin/teams/:teamId/members/:userId` adds one user, guards team management, refuses All users teams, and audits changed membership. Teams shows a staff-only No team view. `PATCH /api/admin/forks/:poolId/visibility` accepts `{ public }`, guards agent management, audits before/after, and notifies list changes. EditAgent shows visibility only to staff (read-only without management); team agents show visibility badges. Removing an agent from a team (Teams dialog X or EditAgent team pills) asks for confirmation (`lib/team-removal.ts`); when no team is left, the warning says only a superadmin can assign a Private agent again (any admin for a Public one). `autoApprove: false` still blocks pending regular users from all agents upstream.
- Secrets written by the agent-extension config API become `$env:` references in `agent.yaml`; plaintext values go into the agent `.env`.
- The same API accepts `credentialScope: "personal"` for authenticated agent users: any declared config field is accepted (`config` replaces prior setting overrides, `secrets` merge), requester identity comes from auth, and tokens are encrypted in `CredentialStore` under `extension-config:<id>` without writing YAML/env. The record is keyed per (user, extension), shared across agents via a sentinel credential agentId (helpers `getPersonalExtensionTokens`/`storePersonalExtensionTokens`/`deletePersonalExtensionTokens` in `extension-tokens.ts`; legacy per-agent records promote lazily; removal writes a tombstone so legacy rows are not resurrected). Saving still enables the extension only on the agent where it was saved. `credentialScope: "team"` (or omitted) preserves the existing writer; for credential- or OAuth-backed extensions it requires agent management (`canManageAgent`), independent of Public (`403 team_requires_admin` otherwise), as do platform team OAuth grants and team credential removal. This covers settings-only PATCHes and disable for these extensions. The dynamically loaded external MCP extension has its own authorization outside this repo. Settings-only extensions stay editable by any agent member. Catalog/OAuth/MCP status expose `canConfigureTeam` so the UI shows the team tab read-only. Saving personal credentials also sets `enabled: true` for the agent. Any connection (OAuth or token) turns the extension on for the agent: the web enables via that personal-scope PATCH (resending `personalConfigValues`) so non-admin members can, and falls back to `{ enabled: true }` in single-user mode. The Edit-Agent hub shows a checkmark when credentials exist in either scope (`oauthConnected` for OAuth extensions); "off" means removing credentials, except settings-less extensions, which use Enable/Disable on their details page. Catalogs expose personal secret presence and the requester's own setting overrides (`personalConfigValues`); team non-secret `$env:` refs are resolved for display. Runtime overlays the requester's values (secrets and setting overrides) in both agent and root hook config, and recreates token-backed tools at execution: requester personal → existing team config → refusal with an absolute form link. Settings the requester did not override stay shared; userless runs use team tokens only; scheduled owner-mode runs resolve tokens for the job owner. Missing tokens do not prevent unrelated tools or startup; invalid shared settings remain validation errors. Personal token values cannot be `$env:` references. Admins unset whole-team credentials with `DELETE /api/agents/:id/extensions/:extensionId/credentials` (`removeSecrets` in `agent-config-writer.ts`: removes secret fields from `agent.yaml` plus their writer-managed `.env` values; settings stay); personal values are removed via the My connections `DELETE` route.
- Slack `slack.add_reaction` uses the current message's registered timestamp only with a unique trusted requester match; other contexts require explicit `channel` and `timestamp`. Non-allowlisted proactive DM replies and reactions use `slack:<D-channel>` in the requester's store, ignoring bound session/owner routing; allowlisted DMs retain `main` and delivery threading stays unchanged.
- Host OAuth token persistence requires `oauth.encryptionKey` (typically `$env:OAUTH_ENCRYPTION_KEY`) and fails closed rather than writing plaintext.
- OAuth extensions without secret fields keep settings per scope: `resolveExtensionTokenConfig` overlays the requester's personal settings (`overlayOAuthPersonalSettings`; unset booleans are `false`, not the team value) only when they hold a personal grant for the provider; otherwise and for userless runs the team/agent config applies. The catalog keeps `oauth.scopes` team-based, adds `oauth.personalScopes` (personal overlay regardless of grant) and `personalConfigValues`. `ExtensionDetails` shares the `OAuthConnectCard` tab with `ExtensionConfigForm`; Connect saves the tab's unsaved settings first (`hasUnsavedSettings`/`saveSettings`) then redirects in the same tab with the current page path as `returnTo`. Settings pages consume callback result flags immediately, select `oauth_scope`, and remove the flags without reloading; chat connect prompts retain popups.
- Built-in Google OAuth connections are team (per agent/provider) or personal (per Yoplai user/provider, shared across all agents via a sentinel credential agentId in `OAuthConnectionStore`; legacy per-agent personal grants are promoted lazily on first read; reauthorization requests the union of existing and requested scopes). `src/credentials/` owns the provider-independent encrypted store/resolver; the OAuth adapter reads legacy records as team. Web REST/WS identity flows through extension hooks and tool contexts, and factory OAuth tools re-resolve at execution: personal requester → team → connect link. Userless runs use team only; an unusable personal grant asks for reconnect rather than changing accounts.
- Scheduler jobs store immutable `createdByUserId`, `ownerUserId`, and `credentialMode`. Mine (`owner`) is private; Team (`team`) clears ownership and is visible/editable to everyone with agent access. Team list responses resolve `createdByDisplayName` from the multi-user DB; cards identify the creator. Authenticated chat/web creation defaults to owner mode, while legacy and userless jobs use team mode. Owner runs pass the recorded user identity to credential resolution; missing personal credentials can use team, while an unusable personal credential fails the run and delivers a reconnect error. The agent page **Scheduled jobs** tab lists jobs (plain-language recurrence via `cronstrue`), switches credential mode, and pauses/resumes jobs via an on/off switch (`PATCH { enabled }`), and deletes jobs behind a confirmation dialog (`DELETE`); jobs are created in chat. Pausing/resuming/deleting a Team job requires management of its agent in multi-user mode (route `403 team_requires_admin`, chat `update_job`/`delete_job` refused; UI controls locked for regular users, with agent ownership enforced on the server for admins); owners manage their private jobs. Every named-agent scheduler REST route requires chat access; agentless lists filter out inaccessible agents. Public widens Team-job list/create/edit/run, without granting management.
- Slack `!pair` issues an ephemeral ten-minute single-use link bound to the bot's verified workspace and message sender. `packages/extensions/slack/src/pairing.ts` stores hashed tokens and workspace/user → existing Yoplai user mappings in `slack-pairing.db`; routes require web login and a fresh Slack `users.info` email match (trimmed, case-insensitive; missing email fails closed). Each Slack message/reaction/control run resolves its own sender into trusted `RunAgentParams.userId`; absent pairing is unpaired and uses team credentials only. Unpaired message runs add a `sender_identity` Slack context block telling the model to call `slack.pair` and label team data as the team's. `slack.pair` (no args; extra args ignored) finds the run's trusted sender via an in-memory active-sender registry (`requester.ts`, matched by agent + session) issues a fresh link, and returns only a `<slack-pair-link>` placeholder; the bot substitutes the real URL into the reply (or appends it if the model omits the placeholder) because models mistype long random tokens; the model never chooses the recipient, and redemption still requires a web login whose email matches that sender. Pairing assumes equal Slack/Yoplai emails and requires `users:read.email`; Slack OpenID Connect is the documented future alternative for differing emails.
- Slack credential refusals use an ephemeral `/api/slack/connect/:token` link generated from the trusted active sender; shared OAuth tool factories and the host token tool guard request it via `requestCredentialConnectLink`. Unpaired flows reuse pairing redemption before any credential save/start; paired flows enforce the existing owner and agent access. All connections are personal. The combined form replaces separate pairing/scope screens; paired OAuth goes directly to the provider. Completion posts a bounded confirmation in the original thread; no auto-resume. `ctx.credentialConnect` owns host OAuth/token persistence, while `registerCredentialOAuthConnector` lets extension-owned OAuth use the same trusted start/completion seam. Extension OAuth requires a trusted, extension-defined `targetId` beside `extensionId`; the link snapshots it and completion must return the same ID (see `docs/slack-credential-connect.md`).
- External extensions receive `ctx.credentials` in `start`: the host encrypted generic store supports scoped get/save/delete and personal → team resolution. Use `ctx.credentialConnect.requestLink(context, target)` and `registerOAuthConnector(extensionId, start)` for Slack connection hooks; these use host registries even when an extension installs its own shared package. Startup and runtime activation bind registration to the extension's own ID. Call the returned unregister in `stop`. MCP server and OAuth routes enforce agent access (only the exact OAuth callback is exempt); the MCP UI selects personal/team for authorization and disconnect.
- The installed external `mcp` extension always loads, including on fresh agents without opt-in and despite legacy `enabled: false`; it is hidden from the extension catalog. An agent's existing `mcp.json` (or legacy `configPath`/`agentDir` override) enables its tools, retaining `mcp__<server>__<tool>` names; no file means no MCP tools/cards. The Edit-Agent extension list shows each stdio/HTTP server as its own card, sorted by display name together with normal extensions; the whole card links to `/agents/:agentId/mcp-servers/:serverName` (`McpServerDetails.tsx`, a dedicated route instead of an `mcp:<name>` extension id because the extension details page resolves catalog entries). Edit-Agent waits for the regular catalog, Top flags, and configuration-only MCP list, then paints every card in final Top/name order. Sort keys come only from that fresh configuration response and stay fixed during live refreshes, even when a server reports a new title. Active cards then check independently in parallel: Checking…, ✓ for a usable connection, Reconnect for invalid effective OAuth credentials, or Unreachable/failed status with a per-card Retry button; disabled shared entries are never checked. OAuth servers get Just me/Whole team connect/reconnect/disconnect there; non-OAuth HTTP servers get a JSON editor for their `mcp.json` entry (`GET/POST /api/mcp/servers/config?agent=&server=`; team-wide, stdio read-only, header/env/OAuth-secret values masked as `••••••••` and restored when unchanged, audited as `mcp.server.update`), and Remove (all-users confirm) lives there too. **Add custom extension** accepts an HTTP(S) URL plus `credentialScope`, writes the agent-shared config, and starts OAuth immediately when needed. `GET/POST /api/mcp/servers?agent=:id` list/add (GET `live=0` reads configuration and scoped credential presence without probing MCP or enriching icons; optional `server=:name` filters both modes before any work. Default GET remains live. Details paint the filtered fast response before requesting filtered live status; live status merges only its card into the full-list browser cache. POST accepts `returnTo` for same-tab OAuth) and `POST /api/mcp/servers/remove?agent=:id&server=:name` removes a server for every user. Any agent member may manage shared servers and personal/team grants. Disconnect removes only the selected scoped credentials and keeps the server; Remove requires an all-user warning. Hand-configured definitions remain read-only in the UI. Servers added from the UI get a readable key from their site (`mcp.linear.app` → `linear`, then `linear_2`), and cards show the server-reported name and description (`serverInfo.title`/`description`; sentence-like titles are split at the first colon or dash) once connected, saved as `displayName`/`description` on UI-added `mcp.json` entries. Any server entry, stdio included, may set optional `displayName` and `description` to override the card label (yoplai-only keys; other MCP clients ignore them). Servers without an icon show the official MCP logo. Connected checks reflect successful MCP tool discovery under the requester's effective credentials; HTTP servers without an MCP-provided icon use the host's website icon, falling back to the root domain, cached as a hostname→URL map in `$YOPLAI_HOME/mcp/icons.json`; missing/broken icons use a generic MCP symbol. Focus/OAuth refreshes run per-server live checks in place without reloading the fast list or suspending the page; add/remove reload configuration. Both pages ignore older checks after a newer check or agent/server navigation. Overall `state: "unreachable"` describes transport failure while scoped states still describe stored OAuth grants, so an existing connection keeps Disconnect and never becomes Reconnect solely because discovery failed. The old MCP details page is removed; refusal links lead to the extension hub.
- Sandboxed runs using OAuth, whether selected by `agent.yaml` or a per-run model override, have provider credentials pre-refreshed on the host and receive short-lived access tokens via `ContainerInput.oauthTokens` (`apps/gateway/src/sdk/container/oauth-tokens.ts`); the runner renews only providers authorized for that run through `POST /internal/oauth-token` under a 10-minute threshold. Refresh tokens never enter the container. See `docs/container-isolation.md`.
- `pnpm init-dev-config` creates repo-local `.yoplai/yoplai.json` from `scripts/config-template.json` with free ports.

## Runtime data

Root `enableCronMonitoring` defaults off. When enabled, scheduler runs have
atomic per-run records at `<workspace>/cron/runs/<jobId>/<runId>.json` and
Scheduled jobs titles link to `/agents/:agentId/schedules/:jobId/runs`.
The Scheduled jobs panel polls every two seconds only with the flag on and shows
a pulsing Running badge with elapsed time from `runningForMs` until the run ends.
`GET /api/schedules/:agentId/:id/runs` returns `{ runs }` with running records
first, then newest first; it returns 404 with the flag off. Authorization uses
the job's current Mine/Team mode, so sharing a job also shares its past runs.
Records include effective prompt and original `storageOwnerId` (user ID for
Mine, `null` for Team). Recording is latched at start; quiet-uneventful records
are removed, and startup unconditionally marks leftover running records
interrupted. No backfill or retention limit.

Run rows open `/agents/:agentId/schedules/:jobId/runs/:runId` with the finished
run's final assistant output anchored and its prompt, thinking, and tool activity
above. `GET /api/schedules/:agentId/:id/runs/:runId/trace` returns `{ run, messages }`
using the same flag and job authorization as the runs list. The trusted host
`ExtensionContext.getFullSessionHistory` accessor reads canonical full history
under the recorded `storageOwnerId`, never the viewer's identity; sharing an old
Mine run therefore preserves its original history location.

The accessor returns `{ messages, liveTurn? }`. Its detached live snapshot includes
pending completed tool turns and the current in-memory turn, including buffered
tool results, only when the active session's storage owner matches. Running traces
merge these messages with canonical history without duplicating flushed rows;
pinned sessions attach live data only if its prompt matches the recorded run.
Finished traces use canonical history alone. The runs list polls every two seconds;
the trace polls while running and transitions to the finished view without reload.
Live traces follow the bottom unless the user scrolls up.

Own-session runs return the exact canonical session. Pinned-session runs record
`pinnedSession` and slice from the first user prompt at or after `startedAt` that
matches the recorded effective prompt (including gate context), through the next
user message or history end. This is best effort: concurrent writers and queued
ticks can blur turn boundaries. A missing matching prompt yields an empty trace.

Unless noted, paths are under `$YOPLAI_HOME`:

| Path                               | Owner / meaning                                            |
| ---------------------------------- | ---------------------------------------------------------- |
| `yoplai.json`                      | Instance v3 config                                         |
| `models.json`                      | Custom Pi model providers/context overrides                |
| `agents/<id>/agent.yaml`           | Agent definition                                           |
| `agents/<id>/cron/jobs.json`       | Per-agent scheduler jobs                                   |
| `history/*.jsonl`                  | Canonical single-user transcript store                     |
| `sessions/*.jsonl`                 | Pi SDK runtime resume state; not canonical product history |
| `sessions.json`                    | Logical session-key to runtime-session mapping             |
| `sessions/users/<userId>/...`      | Multi-user session/history isolation                       |
| `sessions/subagents/runs/<runId>/` | Project-agnostic CLI subagent state/logs/history           |
| `media/`                           | Managed inbound/outbound files                             |
| `oauth/`                           | Per-agent OAuth connection records                         |
| `canvas/registry.json`             | Stable dashboard link ids and their owning agent/file      |
| `canvas/pins.json`                 | Personal dashboard registration-id pins, keyed by user id  |
| `skill-library/`                  | Curated `default/<name>/`, private `users/<owner>/<name>/`, ten-version histories, user enable state, atomic user registry and hashed 24-hour import tokens |
| `auth.db`                          | Better Auth SQLite DB when multi-user extension is enabled |
| `audit.db`                         | Gateway-owned append-only settings audit; secret values are never stored |
| `projects.json`                    | Project numeric ID counter                                 |
| `tool-labels.json`                 | Maintenance-model-generated friendly tool-call label templates (`GET /api/tool-labels`) |

Canonical history drives history APIs, web UI, Langfuse, compaction, channel context, and media blocks. Pi session files are SDK-owned runtime state; code may use them only for resume/backfill/fallback behavior. Session sanitization must preserve assistant text-block `textSignature` replay metadata (OpenAI Responses item ID/phase) verbatim; this session-only exception must not exempt credential fields from general storage redaction.

Multi-user mode scopes session maps and canonical history beneath `sessions/users/<userId>/`. There is no automatic migration from existing single-user history into user ownership.

## Agent runtime flow

1. Load and validate v3 config; discover `agent.yaml` files.
2. Resolve configured extensions, secrets, capabilities, routes, lifecycle, and services.
3. Resolve requested agent plus logical `sessionKey` or explicit `sessionId`.
4. Ensure missing workspace system files, then resolve prompt/system files.
5. Collect extension prompt contributions and agent tools.
6. Select in-process or sandbox adapter and stream normalized history events.
   - Pi auth invariant: runtime-resolved OAuth/automatic credentials retain their SDK credential type, including model overrides and fallback models. Only explicit `api_key` selection installs a runtime API-key override; never reclassify an OAuth access token as an API key.
7. Flush canonical history and settle lifecycle state; then drain queued non-native work.

Workspace bootstrap creates missing `AGENTS.md`, `SOUL.md`, and `USER.md` from `docs/templates/` without overwriting existing files. `AGENTS.md` is implicitly prepended; `system_files` controls remaining prompt-file order.

Pi discovers skills and commands from workspace and user Pi directories. Extension tool names are provider-sanitized for the model while gateway dispatch retains original extension/tool identity.

Pi agents can opt into the built-in JavaScript `codemode` tool with `codemode: true` in `agent.yaml`, on the host or in a container. An absent or false flag leaves it off; existing agents are not enabled automatically. The resource loader registers `createCodemodeExtension({ mode: "on", inlineBudget: 1000, models: false })` before reload/session creation, and the session's explicit tool allowlist includes `codemode` only when enabled. Non-Pi adapters are unchanged.

Scripts call registered tools as `await tools.<sanitized_name>(args)` and print only the final selection with `text(...)`. Deferred tools remain callable before loading; scripts discover them with `searchTools()`. Our extension/MCP bridge tools return text: parse a known JSON text response with `JSON.parse` before accessing its fields. Raw child results remain inspectable in display history, but Pi keeps them out of the next model request. Script calls retain tool validation, handlers, cancellation and the existing invisible-tool policy. Classifier/image models are not enabled.

Nested tool start/end events carry optional `parentToolCallId` through runtime, stream/history, persisted tool blocks/results and active-turn snapshots. Chat renders these normal tool calls under their parent, with the child group collapsed by default, including after reload/reconnect. Active-turn snapshots include completed display results so reconnect keeps child output inspectable; these snapshots do not enter the model transcript. This field is separate from subagent `parentToolUseId`. Langfuse parents nested tool spans to the open parent tool span; ordinary tools remain children of the generation. Partial tool updates remain ignored.

Pi 1.3 limits each process to two live codemode workers across sessions. A third script returns a tool error rather than queuing; retry after a worker exits (exit can lag abort). Each container has its own limit. The inline budget caps declarations inside the codemode description only: declared callable tools also receive per-tool codemode notes, so agents with large tool sets still incur fixed description overhead. Enabling this flag on CloudiHub agents is a separate rollout decision after ALG-493.

Pi host and container runs defer non-core extension, MCP, project and document tool schemas by default. All permitted tools stay registered and callable; the initial model declaration includes core tools, configured always-on tools, and the model-only `tool_search` loader. `codemode` remains opt-in. Configure each agent in `agent.yaml`:

```yaml
toolDeferral:
  enabled: true
  alwaysOnTools: [pipedrive.search]
  alwaysOnExtensions: [calendar]
```

Omitted settings resolve to `enabled: true`, `alwaysOnTools: []`, and `alwaysOnExtensions: []`. `alwaysOnTools` uses canonical extension tool names before Pi sanitization/collision resolution; `alwaysOnExtensions` uses owning extension IDs. Core tools are always direct: Pi `read`/`bash`/`edit`/`write`, all `taskLifecycle` and `scheduler` tools, runner `send_file`, gateway `describe_image`, `tool_search`, and enabled `codemode`. Core ownership takes precedence; either always-on list then selects additional direct tools. Overrides never authorize absent tools. `enabled: false` declares every permitted tool directly and omits the loader. The gateway sends the resolved policy and tool metadata in `ContainerInput`.

`tool_search` loads matching schemas for subsequent requests. Loaded tools persist on the current session branch, including a later host invocation/page reload, while still permitted and available; removed tools disappear and newly available tools start deferred. Reconciliation uses Pi's persisted branch declarations and never rewrites historical messages. Scheduler runs use the same discovery path without preloading integrations. Codemode's inline description excludes deferred signatures; loaded callable tools receive its normal script-call notes.

The host owns a deterministic prompt section with one line per deferred namespace, sorted. Extensions use their ID and description; MCP tools use `mcp__<server>` with `<server>` as alias. Optional extension-tool `namespace: { name, displayName?, description?, instructions? }` metadata carries the raw server segment without `mcp__`. A description produces `<displayName or name>: <description>`; without one, the summary uses the first non-empty `instructions` line when present, otherwise only `<name>`. That head is capped at 200 characters. Each line then lists every tool of the namespace: `(<N> tools: <sorted names>)`, with MCP prefixes stripped. A last line tells the model to load a whole namespace with `tool_search` (namespace name as query, limit of at least N). Loaded tools do not shrink the summary; catalog changes replace the section and removed namespaces disappear. Tool-extension prompt contributions retain usage guidance without repeating the exact tool-name/schema inventory. Extension-repo metadata and addendum cleanup are separate (ALG-509).

Discovery works on all Pi tool-calling paths. Anthropic capable models use the initial deferred placeholder and inline changes. OpenAI Responses uses `additional_tools` when `supportsAdditionalTools`, otherwise its synthetic tool-search representation when `supportsToolSearch`, otherwise the current list; openai-codex follows the same capability flags (off by default). OpenAI Completions resends current schemas at the top level. Removal/redefinition may cause a full resend; no path guarantees cache hits or token savings. Transport serialization stays owned by Pi.

Yoplai also ships a built-in `dashboard` skill to host and sandboxed Pi agents. It teaches the Canvas file/data/maintenance contract and includes cloneable HR, OKR, and customer-success templates backed by seeded SQLite data; workspace skills can complement it without requiring a global-skills opt-in.

The **Skills** sidebar page (`/skills`, detail `/skills/:id`) manages Pi-only owned, shared and read-only workspace skills. System skills (operator defaults plus the `dashboard` and vendored `skill-creator` built-ins) are always on, cannot be toggled (`skill_locked`), and appear only in `/admin/skills` (`system` in `/api/admin/skills`). `SkillStore` keeps user content in `skill-library/`, never the auto-discovered root `skills/`; operator defaults are scanned live and may restrict agents with `.yoplai.json` `{ "agents": ["hr"] }`. User skills start off. Legacy `disabledDefaults` in user state is ignored. `resolveRunSkills` rechecks requester eligibility/shares each run, collapses managed names default → own → shared, and exposes the same selection to host staging symlinks and read-only container `/skills/<name>` mounts. Existing Pi discovery and workspace precedence stay unchanged. The source table and the name-collision load order are in [Skill sources](models-and-skills.md#skill-sources). Single-user runs always use `local`; multi-user runs use trusted `userId`, owner jobs use their owner, and Team/userless/eval runs use defaults only. `skill_save({name,files,skillId?})` writes only skills owned by or writable to that requester, preserves shares and records versions; userless multi-user runs refuse it. It is available through both host and container tool bridges.

In multi-user mode, a superadmin marks an agent workspace skill as System with `PUT /api/skills/:id/system` (`{ "system": boolean }`). The ids are in `skill-library/system-agent-skills.json`. `/api/skills` hides these skills, and `/api/skills/:id` returns 404 for non-superadmins. Agents still load them. `/api/admin/skills` lists agent skills with a `system` flag. `/api/skills` lists groups and accepts multipart creation; own-name conflicts return `409 skill_exists` for UI confirmation. `/api/skills/:id` provides read-only Markdown/file detail and deletion; `/content` replaces, `/enabled` changes requester state, `/shares` manages named read/write or platform-wide read grants, `/versions` lists the last ten versions, and `/versions/:versionId/restore` rolls back. `/api/skills/recipients` lists eligible profiles. `/api/admin/skills` and `/api/skills/:id/admin` provide the superadmin list and audited platform-wide disable. No implicit content-write/sharing control is granted to staff. `/api/skills/import-token` creates/lists tokens, and DELETE `/:id` revokes them; only exact `POST /api/skills/import` bypasses session middleware and requires its dedicated token in either mode. JSON import uses `{name,files:[{path,content,encoding?}]}`; multipart uses one zip. Upload body and decoded/expanded content are capped at 25 MiB, with 200 entries and traversal/symlink rejection. The web refreshes on focus and polls while open; Create opens a new chat with the main-agent preference or the existing agent picker and fills in the interview prompt without sending it. `/admin/skills` is the Admin Skills tab. `/api/admin/skills` rows include `ownerActive`. A superadmin moves a user skill to another eligible user with `PUT /api/skills/:id/owner` (`{ ownerId }`, 400 `same_owner`/`ineligible_recipient`). It moves the files and versions, drops a share to the new owner and keeps other shares and enable states. This works when the owner is banned, and `PUT /:id/admin` and the superadmin `DELETE /:id` also work then. `POST /api/skills/:id/default` moves a directory-based agent workspace skill to `skill-library/default/<name>/` (no sidecar, so all agents), removes the workspace folder and its System mark. `GET /api/skills/:id/default` returns `outsidePaths` (absolute, `~/`, `$HOME/` and folder-leaving `../` paths in text files) for the confirm warning. The POST returns 409 `name_taken` for a builtin, default or user skill name (audit `skill.make_default`).

### Sessions and concurrency

- `sessionKey` is a logical key, default `main`; mapping persists in `sessions.json`.
- explicit `sessionId` bypasses logical-key resolution.
- `/new` and `/reset` rotate the session; `/compact` compacts older context.
- sessions expire after `sessions.idleMinutes`, default 360.
- queue mode buffers/follows active work; interrupt mode aborts current run then starts the new turn.
- explicit `/abort` and `/stop` pause active durable tasks; ordinary durable-task follow-ups are forced to queue.
- Session pins are append-only `meta` entries (`key: "pinned"`, value: timestamp or `null`); summaries read the latest value and expose `pinned: number | null`, without changing message recency. `PATCH /api/agents/:agentId/sessions/:sessionId` accepts `pinned: boolean` independently of `title`. The sidebar polls pins into Pinned above Recent (pins excluded from Recent), with the existing recency groups; its row menu offers Pin/Unpin, Move to project, Rename, Archive, and Delete (with icons and separator before Delete). Session and project row menus close on outside click, Escape, or item click; opening one menu closes any other open menu.
- Session archiving is an append-only `meta` entry (`key: "archived"`, value: timestamp or `null`); summaries read the latest value and expose `archived: number | null`. `PATCH /api/agents/:agentId/sessions/:sessionId` accepts `archived: boolean`; attempting to archive the MAIN session returns 400 `{ error: "Main session cannot be archived" }`. `GET /api/agents/sessions` excludes archived sessions by default; pass `?includeArchived=1` to include them (summaries still carry `archived`). Archiving does not modify `pinned` or `project` meta; restoring returns the chat to its prior sidebar location. `/archive` page (linked from sidebar footer in single-user or account menu in multi-user) lists archived sessions with Open, Restore, and Delete actions. Opening an archived session shows a banner "This chat is archived. Sending a message will restore it." with a Restore button; the banner disappears on restore. Sending a message to an archived session automatically unarchives it before the message is sent; if unarchiving fails, an error is shown and the message is not sent.
- Sidebar account panel (multi-user only): the user's avatar/name/email row in the sidebar footer is a toggle button that opens a popover menu above the row with items: Account connections (`/account/connections`, icon `fa-plug`), Archive (`/archive`, icon `fa-box-archive`), separator, and Logout (icon `fa-right-from-bracket`). The menu closes on outside click, Escape, route change, or item click. Single-user mode has no account panel; the Archive link appears in the sidebar footer (below the theme toggle) in single-user mode, while multi-user accesses it via the account menu.
- Project files: `/api/chat-projects/:id/files` supports user-scoped multipart upload (`file`), listing, and DELETE `/:fileId`. Originals reside in the owning project `files/` directory with opaque IDs; `files.json` stores original names and extracted text outside that directory. Uploads reuse media MIME/extension validation and the 25MB limit, plus document extraction; failed extraction retains the original and exposes a warning. Each turn refreshes files: extracted text up to 4,000 characters per file is inlined, larger files are listed by name/ID, and the whole file contribution is capped at 12,000 UTF-8 bytes including omission notices (a conservative upper bound of 12,000 tokens for byte-based BPE tokenizers, roughly 3,000 tokens for ordinary English). Agents receive the absolute host directory, or read-only `/project-files` in sandboxes, with IDs matching the listing. Deletion removes the original and its next-turn context.
- Personal chat projects are a core chat feature, separate from orchestration projects: `ChatProjectStore` persists `chat-projects/<id>/project.json` beneath the user's session area (single-user: config root; multi-user: `sessions/users/<userId>`). `/api/chat-projects` provides user-scoped CRUD. POST creates fast (name only). `POST /chat-projects/:id/instructions/draft` with `{ purpose }` drafts `instructions` via `draftProjectInstructions` (`maintenance/project-instructions.ts`, `config.maintenance` model, else the first agent's model; 30s timeout) passes `sessionId: chat-project-<id>` (OpenCode requires it), falls back to the raw purpose on failure, saves, and returns the project (400 bad purpose, 404 unknown/other-user project). The Create project modal runs create → draft → upload as tracked steps, so retries never recreate the project, redraft after success, or resend uploaded files. Session PATCH accepts `projectId: string | null`, stored as append-only `meta` key `project`; summaries expose the latest `projectId` without changing recency. Deleting a project clears membership and keeps chats. The sidebar shows collapsible Projects above Pinned/Recent, excludes grouped chats from both, and sorts project chats pinned-first then by recency; `/p/:id` lists chats with agent avatars and supports rename/delete. The optional orchestration Projects navigation reads Board.
- Chat project PATCH also stores free-text `instructions`. The project page edits them and starts `/chat/:agentId?project=<id>` after an explicit accessible-agent choice. REST/WebSocket run requests accept optional `projectId`; only a new session's first turn records the `project` metadata. Gateway `ProjectContextResolver` re-reads session membership and project instructions on each turn, injecting one project context block with the fixed wiki-discovery nudge; moved chats pick up their destination's instructions on their next turn, while ungrouped chats receive no block. Project context includes the readable project files directory and opaque file IDs, but no project membership identifiers.
- canonical history preserves normalized user, assistant, thinking, tool, system-context, and file blocks.
- Pi web/manual compaction appends a durable system summary to canonical history and reseeds only the runtime session with the summary plus the last 16 nonempty user/assistant messages. Original content and usage remain archived; web context usage counts only assistant usage after the latest summary. Simple and Full views show collapsed, keyboard-accessible summary disclosures and load older history through `limit`/`before` cursors. Legacy prefix summaries remain readable; originals removed by older destructive compaction cannot be recovered from those files.
- Web compaction rejects unsupported SDKs (including OpenClaw) before changing history. Claude/Codex orchestrator workers use their own native compaction paths; this gateway contract does not apply to them. Host Pi and sandbox Pi runtime paths are scoped by user and agent. Old runtime files that lacked user ownership are not automatically adopted by a user-scoped run. Limited history responses still read and sort the full canonical file; tool associations can extend a page beyond its requested limit.
- Chat project memory: host tools `project_references_add({ title, description, path })` and `project_notes_append({ text })` are registered for project chats in Pi and sandbox runs. Trusted run project/user identity scopes writes; detached, moved, deleted, and non-project runs refuse. The store persists private paths in `references.json` and dated bullets in `NOTES.md`, serializing atomic writes. User-scoped `GET /api/chat-projects/:id/references` returns only public reference metadata; `DELETE /references/:referenceId` removes a reference. `GET/PUT /api/chat-projects/:id/notes` reads/replaces `{ text }`. The project Overview lists reference titles/descriptions with removal; Notes edits the text with a ten-second request timeout. Every turn refreshes title/description/path references and the notes tail (4,000 characters each) in the project context, so another agent in the same user's project sees them; reference paths go to agents only (never the public API/UI) so they can read the file directly; the internal project ID is never rendered. OpenClaw's remote protocol has no host-tool bridge.
- An assistant turn whose complete text is `NO_REPLY` (optionally wrapped in Markdown or followed by a period) remains in canonical history but emits no text or delivery payload; the web UI hides it in simple view and shows the raw token in full view.
- Agent-authored inbound turns may identify their sender and hop count. The runner stops conversations that exceed `agentLoop.maxAgentTurns` (default 8 consecutive agent turns) or `agentLoop.maxHops` (default 5); a human-authored turn resets the consecutive-turn counter. Discord's top-level `extensions.discord.allowBots` can admit explicitly mentioning bot authors and maps them to `discord:<botUserId>` agent senders on the same channel session.
- Mattermost (`packages/extensions/mattermost`) uses a bot account: `ws` on `/api/v4/websocket` (`posted` events, token in the `Authorization` header only) and `fetch` on REST v4; no `@mattermost/client`. Inbound gating order: own/system posts, bots (unless `allowBots`, which still requires a mention and maps to `mattermost:<userId>` agent senders), `dm.allowFrom`/channel `users`, then mentions; unconfigured channels are dropped before gating. Channel exchanges are always threaded; session key `mattermost:<channelId>:<rootPostId>`, DMs use `DEFAULT_MAIN_KEY`. Thread ↔ session bindings live in `mattermost-thread-sessions.db` (its own file: Discord and Slack share `thread-sessions.db`), `source` `inbound` or `agent` (`mattermost.create_thread`); agent-started threads need no mention. Reconnect: exponential backoff, resume via `connection_id` + `sequence_number`; on a new connection id the bot re-reads watched channels over REST (≤10 min) and dedupes by post id. Proactive tools and the `mattermost` delivery sink (`channel` = `CHANNEL_ID[:ROOT_POST_ID]`, or `user`) enforce the same channel/DM allowlist as inbound posts. Bindings persist an owner (Yoplai user ID or shared `null`); replies preserve `sessionOwnerId` while leaving requester `userId` unset. Bound resets clear the original session and bind a fresh one in the same owner storage. Live/recovered delivery resolves canonical usernames before gating and synchronous dedupe claims. Watchdog recovery uses last received traffic; ordinary closes use detection time. REST operations have one 30-second deadline (120 seconds for files) including retries/body reads, forward tool cancellation, and keep indicators off the answer delivery path.

### WebSocket

`/ws` supports send and persistent subscription modes. Clients can:

- send a run for `agentId` with `sessionKey` or `sessionId`
- subscribe/unsubscribe to session updates
- subscribe to agent status and extension-owned project/subagent events
- receive text, thinking/tool/file events, completion/error, replay, and history-update signals

Use schemas in `packages/shared` and broker code in `apps/gateway/src/server/ws-broker.ts` as protocol source of truth; do not duplicate event unions in feature code.

### Sandbox/container flow

The image includes pinned `playwright-cli` and Chromium. Pi Bash inherits `YOPLAI_GATEWAY_URL`, `YOPLAI_AGENT_TOKEN`, and `YOPLAI_DASHBOARD_URL_PREFIX`; browser state/output defaults to `/tmp/playwright`. Use the dashboard skill recipe, then `read` the PNG for an image content block.

- Gateway builds Docker args/mounts in `src/agents/container.ts` and `src/sdk/container/`.
- Each run gets a unique container name, token, and IPC namespace.
- Agent data mounts writable at `/workspace/data`; uploads mount read-only at `/workspace/uploads`.
- Conversation files mount writable at `/workspace/files`, backed by `$YOPLAI_HOME/conversation-files/<opaque-key>` keyed by trusted agent/requester/session identity. Only the current folder is mounted; `/workspace/data` remains shared agent storage. Local Pi uses the same folder through its absolute host path and remains trusted host execution, not filesystem isolation.
- Extension execution receives `context.conversationFiles?: { hostPath, runtimePath }`, plus agent, sessionId, requester userId, and cancellation signal in both Pi and container tool routes. Extensions perform host I/O under `hostPath` and return paths under `runtimePath`; never construct conversation paths from agentId or model arguments.
- Workspace `.env` is shadowed; only explicitly forwarded safe env and sandbox env reach container.
- Container-to-gateway calls (`/internal/tools`, `/internal/oauth-token`) use `host.docker.internal` by default, or a read-only mounted Unix socket serving only `/internal` when root `sandbox.gatewayTransport` is `socket` (`apps/gateway/src/server/internal-socket.ts`, `ContainerInput.gatewaySocketPath`).
- Custom mounts must pass configured allowlist/blocklist checks.
- Extension prompt/tool metadata is serialized into `ContainerInput`; tools call back through authenticated `/internal/tools`.
- Pi `send_file` supports regular files directly in the current conversation folder, rejecting nested paths, traversal, and symlinks; it opens without following symlinks and copies from the pinned descriptor. Container `send_file` uses an internal, run-bound gateway registration operation over the same authenticated transport and retains `/workspace/data` compatibility. Success follows source validation, managed-media copy/registration, and history/card event emission; gateway or transport failures reach the model as tool errors. New outputs carry requester ownership and their download route rejects other users, including users with access to the same agent. Legacy framed `file_output` ingestion remains compatible, with structured failure logging. Finish writing before sending because registration does not wait for concurrent writers or confirm browser receipt.
- Outbound file requests must resolve inside allowed data paths; gateway copies/registers them in managed media storage.
- Container event/output framing constants and schemas live in `packages/shared`.
- Default `yoplai-agent:latest` rebuilds when build-context content changes; custom images are not rebuilt.

Host and sandbox Pi agents share the Yoplai base system prompt from `packages/shared/src/pi-system-prompt.ts`. It tells agents to save requested skills with `skill_save`, not in the workspace `skills/` folder. Sandbox runs append container-specific instructions.

Pi supports extension tools in and out of containers. Sandbox Claude fails loudly when extension tools are present rather than silently omitting them.

## Extension map

Extensions load through `extensions.<id>` unless documented auto-load compatibility applies. Package README is authoritative for configuration and detailed behavior.

| Extension      | Ownership                                                                | Reference                                                            |
| -------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `board`        | Board/project web shell and board APIs; depends on projects + subagents  | [README](../packages/extensions/board/README.md)                     |
| `discord`      | Discord routing, forum threads, reactions, proactive tools/delivery      | [README](../packages/extensions/discord/README.md)                   |
| `heartbeat`    | Periodic agent check-ins gated by scheduler                              | [`packages/extensions/heartbeat`](../packages/extensions/heartbeat/) |
| `irc`          | IRC transport, routing, batching, formatting                             | [README](../packages/extensions/irc/README.md)                       |
| `threadit`     | Threadit board poller (attention items, activities, replies, stop/resume) and `threadit.*` agent tools; `threadit.register` saves a token via `ctx.updateAgentExtensionConfig`, and the poller hot-applies it | [README](../packages/extensions/threadit/README.md)                  |
| `langfuse`     | Stream/history tracing and observations                                  | [`packages/extensions/langfuse`](../packages/extensions/langfuse/)   |
| `mattermost`   | Mattermost bot (WebSocket in, REST out), thread sessions, proactive tools/delivery | [README](../packages/extensions/mattermost/README.md)                |
| `multiUser`    | Better Auth, teams, pool/forks, access isolation, bearer tokens          | [README](../packages/extensions/multi-user/README.md)                |
| `orchestrator` | Tracker-driven daemon and protocol worker runners                        | [README](../packages/extensions/orchestrator/README.md)              |
| `projects`     | Project/slice documents, subagent runs, Space integration, CLI/API       | [README](../packages/extensions/projects/README.md)                  |
| `scheduler`    | Recurring cron and one-shot jobs, scripts/gates, outputs, delivery sinks | [README](../packages/extensions/scheduler/README.md)                 |
| `slack`        | Slack Socket Mode transport, threads, files, proactive tools             | [README](../packages/extensions/slack/README.md)                     |
| `subagents`    | Project-agnostic CLI subagent runtime                                    | [README](../packages/extensions/subagents/README.md)                 |
| `telegram`     | Telegram transport and proactive delivery                                | [README](../packages/extensions/telegram/README.md)                  |
| `webhooks`     | Signed inbound webhooks and isolated webhook sessions                    | [`packages/extensions/webhooks`](../packages/extensions/webhooks/)   |

Tool-style extensions use `packages/shared/src/tool-extension.ts`. Their `oauth` declaration accepts a static requirement or `(config: ResolvedToolExtensionConfig) => OAuthRequirement`, with agent settings overriding root defaults in `config.merged`. Catalog/connect links and tool execution resolve the matching scopes; missing granted scopes produce `insufficient_scope` with a scoped reconnect URL. Extensions may contribute routes, CLI commands, capabilities, services, system-prompt text, tools, delivery sinks, OAuth requirements, and web routes. Keep behavior with its owning package; core should depend only on extension contracts and optional imports.

Tool `outputSchema` is optional Zod beside `parameters` in `defineToolExtension`, converted with `$refStrategy: "none"` for discovery and agent tools; direct `ExtensionAgentTool` and container records use JSON Schema. Preserve it through every explicit tool mapping, including deferred registrations and independent external MCP mappings. Both Pi hosts keep text `content` and raw `details` unchanged, adding a JSON-safe copy of the full raw result as `structuredContent` only for schema-bearing tools. Codemode resolves the object and displays its fields; container preview/spill formatting never truncates the structured value. Only exact top-level `isError === true` sets Pi's error flag; returned errors retain structured data, thrown failures reject, and `ok: false` alone is unchanged. Schemas describe success and are not runtime validators. Schema-less tools keep legacy behavior. Connection refusals add `isError: true`. External MCP uses a generic `CallToolResult` schema (including disconnected refusal stubs), without per-server result schemas. The fields are additive across independently deployed hosts/extensions; canonical history remains text with existing parent linkage. See [tool result schemas](extensions.md#tool-result-schemas).

Canvas is a core gateway feature. Agents use `dashboard_create` once to privately register/publish for the requester, `dashboard_update` to publish edits, and side-effect-free `dashboard_link` to return readable links (no slug returns `{ dashboards, note }`) for a single `.html` file from `data/dashboards/<slug>.html` in their workspace (for sandboxed agents this is the always-writable `/workspace/data` mount, i.e. the host agent data dir). SQL `data-db` paths are relative to the workspace root, e.g. `data/app.db`; host agents are confined to their workspace and sandboxed agents to `data/`. Configure it with root `canvas.enabled` and optional `canvas.baseUrl`; links default to the platform public URL. Owned viewer requests require login, fresh strict account eligibility and dashboard owner/user/platform grants independently of agent/team membership; legacy ownerless pages retain agent access checks, and every page is served under a restrictive sandbox CSP. Because `data/dashboards/` is shared, Canvas adds a system-prompt rule on every run: `dashboard_link` is the only source for the user's dashboards, and the agent treats any other dashboard as nonexistent.

Sandbox visual previews use `GET /internal/dashboards/:slug/html?token=…&theme=light|dark`, scoped to the token owner. They run the viewer rendering pipeline with null viewer bindings, pass other query params to SQL, and preserve authentication/theme in drill-down links. They use the viewer CSP and no-store caching and do not record versions. Always check light, dark, and 420 px width before sharing; close the browser after checking.

Canvas keeps separate durable, atomically replaced published HTML per owned registration, independent of optional history. Readers see published HTML/metadata; owners/writers see live drafts. Missing publication fails closed. Create/update/claim and retained-history restore publish; link/view/list/history reads do not. Managed history keeps 20 distinct publications; Git workspaces may report unmanaged history, but always have durable publication. Restore recreates missing working HTML and preserves current ACLs. SQLite remains live/shared.

Agents use `dashboard_delete` to remove a dashboard HTML file, its stable registry entry, and its managed versions. Deletion is idempotent, preserves `.db` files, invalidates the old viewer link, and lets a recreated slug receive a new link with fresh history.

The web agent detail page has a Dashboards tab for accessible agents. `GET /api/agents/:id/dashboards` uses per-agent access middleware and lists registrations filtered by dashboard access, never auto-registering workspace drafts; it returns each dashboard's HTML title (or filename), slug, file modification time, viewer link, required `params`, and normalized `linksTo` slugs. Dashboards that require URL arguments declare `<meta name="yoplai:params" content="id">` (comma-separated names allowed); optional arguments do not need this meta. The API stays flat; the tab nests required-argument dashboards beneath every same-agent parent that calls `YOPLAI.link` to them, recursively with ancestor-cycle protection. These child rows have no Open action (they show the required params). Rows on the tab and on the Dashboards page share `DashboardListRow`; each row carries `shared` (true only for non-owner recipients, so superadmins see "Owned by <owner>" for dashboards not shared with them). `DashboardAccessDialog` is the Share dialog (people with access plus a General access select that maps to the `{kind:"all"}` share). Dashboards without required arguments stay top-level; unreachable required-argument dashboards appear under **Needs parameters**.

Dashboard pages can use the public Dashboard Kit (cached for a week) at `/d-assets/v2/kit.css` and `/d-assets/v2/kit.js`. Load `/d-assets/v2/echarts.js`, `/d-assets/v2/marked.js`, and `/d-assets/v2/purify.js` as needed; `/d-assets/v2/sample.html` demonstrates the "needs attention" callout, KPI strips (formatted values, deltas, sparklines), status pills, segmented filters, searchable/sortable CSV tables with formatters, links, severity dots and a show-all row cap, ranked links, tabs, filters, sanitized markdown, themed chart types, dark tokens, and print styling. `/d-assets/v1/` still resolves to the same backward-compatible files for existing pages. The dashboard skill's `references/kit.md` holds the design guidance (always-on visual rules plus defaults) and `references/layouts.md` the layout archetypes agents choose from. Dashboards automatically inherit app colours from `$YOPLAI_HOME/theme.css` and follow the web UI's light/dark choice: the web UI mirrors its theme into a `yoplai-theme` cookie, and the gateway stamps `data-theme` on the served page from that cookie (falling back to the viewer's OS `prefers-color-scheme` when the cookie is absent or invalid). Set `data-theme="light"` or `data-theme="dark"` directly on the dashboard's `<html>` to override; an explicit value always wins over the cookie/OS default. Asset routes are a fixed allowlist and contain no agent or user data; HTML assets (`sample.html`) are served with the same sandbox CSP as dashboards.

Dashboards can declare live SQLite queries with `<script type="application/sql" data-name="items" data-db="data/app.db">...</script>`. On every page load, Canvas takes a confined read-only snapshot of the database and its WAL, binds `:viewer_email`, `:viewer_name`, `:today`, and URL query parameters, and injects results into `YOPLAI.data` before page scripts run. A dashboard may declare up to 20 queries; each query has a 100KB SQL, two-second execution, 5,000-row, and 5MB serialized-result limit. At most four query workers run process-wide, with a bounded queue. `YOPLAI.viewer`, `YOPLAI.params`, and `YOPLAI.link(slug, params)` provide viewer context and same-agent drill-down links; query failures render on the page and appear as `queryErrors` in create/update publication results.

Page code belongs in one `<script type="module">` (classic inline scripts share the browser's global scope, so a top-level `const top` throws and blanks the page). `dashboard_create` and `dashboard_update` also return `problems`, a static lint of the page produced with `node:vm` without executing its code: script syntax errors, global-name collisions between classic scripts, echarts.js/kit.js load order, `/d-assets/v1/` use, `YOPLAI.data` names without a matching query, inline `on*=` handlers when modules are used, `YOPLAI.link` targets missing from `data/dashboards/`, and queries that returned 0 rows. Agents fix every `problems` and `queryErrors` entry before sharing the link. Dashboard Kit registers `error`/`unhandledrejection` listeners that show a `.dk-error-banner` at the top of the page (max 3 distinct messages).

The top-level **Dashboards** page lists owned pages grouped by agent (including inaccessible agents) and selected-user/platform-wide shares with owner/mode. Owners manage sharing/delete there without agent access. Dashboard resources use authenticated `GET /api/dashboards`, `GET /api/dashboards/recipients` (minimal eligible profiles), `PATCH /api/dashboards/:id/sharing`, `POST /api/dashboards/:id/claim` and `DELETE /api/dashboards/:id`, outside the agent-gated subtree. Only owners manage/delete owned pages; superadmins read all without implicit write/manage. Sharing grants no agent access. Parameterized pages require independent grants; runtime links and row relationships are filtered per target. Claim preserves its URL, publishes and makes the page owned/private; first claim wins. Missing working files retain registration/publication. Delete/recreate gets a fresh private identity; rename uses create-new/delete-old.

The Dashboards page offers personal Pin/Unpin buttons and moves pinned owned/shared rows into a Pinned section in response order, preserving normal actions. Only `GET /api/dashboards` adds `pinned` flags; the agent tab is unchanged. Idempotent `PUT`/`DELETE /api/dashboards/:id/pin` return `{ ok: true, pinned }` after authentication, eligibility, owned-registration and read-access checks. Pins live separately in `canvas/pins.json`, keyed by user id (`local` in single-user mode), with atomic writes serialized across the whole file. Stale ids never reveal unavailable dashboards, and recreated slugs receive no old pin.

One-time startup migration runs before traffic/jobs, imports old ordinary/sandbox dashboards and persists completion. Existing registry, auth database or session/history JSONL establish an upgraded home; homes without prior runtime state initialize without scanning. Interrupted imports retry safely; later drafts/agents never auto-import. Eval startup skips production discovery and explicitly seeds owned fixtures.

Dashboard authority uses trusted `actorUserId`/`actorKind` independently of credential `userId`. Owner-mode scheduler runs use the saved eligible owner with current agent execution access; only missing mode defaults to Team and explicit owner without owner fails. Team actors publish only platform-wide write/legacy pages. Single-user channels/jobs use a local owner; isolated eval fixtures/runs share their synthetic owner. Unpaired multi-user Slack must pair and re-ask before creation; unsupported userless creation is refused. Publication ACLs do not isolate shared workspace drafts or live SQLite data.

Session history is a core gateway extension (`apps/gateway/src/session-history/`) that gives agents a read-only `session_history` tool, on by default; disable with root `sessionHistory.enabled: false`. It runs in the gateway (so sandboxed and host runs behave identically) and reads canonical history only, scoped to the calling agent (`ctx.agent.id`) and user (`ctx.userId`); when the current session belongs to a chat Project (project read from the session's own `meta project` on disk, never from model args) it also lists/searches/reads every agent's sessions tagged with that same project, addressed as `agent/session` (own-agent sessions keep bare ids; project sessions are listed by persisted history ownership, so sessions of since-removed agents remain accessible, but the current session's project must still exist in the user's store or project access fails closed; membership is re-read each call so moved/cleared sessions drop out; `ProjectContextResolver` sets `project.sessionHistory` from config so `renderAgentContext` adds a `session_history` line only when enabled and the run is a supported Pi run, i.e. not `openclaw`); scheduler/webhook/Slack/compaction and CLI/subagent run sessions are not listed. Actions: `list` (newest first, limit 10, `cursor`), `search` (case-insensitive substring over message text and tool-call args; filters `role`, `tool`, `since`, `session`; newest first, stops at `limit`, default 15), and `read` (`from`/`to` or `around`+`n`, `role`, `full=<idx>` to expand one message, capped at 8000 chars). Output is plain text from the pure condenser `history/condense.ts`: `#idx` anchors, thinking dropped, system messages hidden unless `role=system`, tool call+result merged into one `→ label (ok|ERR: first line, size)` line, text cut at 300 chars with `[+N chars · read full=idx]`, ~4000-char budget with a `more:` continuation line. The current session is marked `★ CURRENT SESSION` in `list`, and search/read results from it carry a note that earlier messages were compacted and these are the originals. Session file enumeration helpers shared with `GET /api/agents/sessions` live in `history/sessions.ts`.

Capability discovery is a factory meta-extension that is always loaded alongside task lifecycle tools. It reads the current built-in/external registry and agent `mcp.json` files on each dead-end lookup; it never resolves extension secrets while listing tools. Its self-enable path reuses the agent extension config writer and live extension reload.

## Projects and orchestration essentials

### Projects

Projects are lifecycle containers; slices are execution units. Project statuses are `triage`, `shaping` (including `shaping:<stage>`), `active`, `ready_to_merge`, `done`, and `cancelled`. Slice statuses are `todo`, `in_progress`, `review`, `ready_to_merge`, `done`, and `cancelled`.

Project documents live below `extensions.projects.root`. `README.md` carries frontmatter, `PITCH.md` carries project pitch, and slices use `README.md` frontmatter plus `SPECS.md`, `TASKS.md`, `VALIDATION.md`, and `THREAD.md`. `SCOPE_MAP.md` is generated; do not edit it manually.

Project IDs allocate through `projects.json`; slice IDs use per-project counters that reconcile against disk. Document writes preserve containment, lifecycle, repo inheritance, and atomicity invariants through the project document store.

Subagent run modes are `clone`, `worktree`, `main-run`, and `none`. External harnesses are `codex`, `claude`, and `pi`. Project CLI details, Space queue/integration behavior, and orchestrator-specific slice automation belong in the [projects README](../packages/extensions/projects/README.md).

### Tracker orchestrator

`extensions.orchestrator` is separate from project slice automation. It polls tracker-scoped work from project `WORKFLOW.md` files and owns worker lifetime, state, logs, recovery, and protocol runners.

- supported trackers: Linear and Plane
- supported protocol runners: Pi RPC, Claude RPC, Codex app-server, generic CLI, fake tests
- workflow frontmatter owns tracker scope/auth, workspace root/hooks, runner/profile/model/thinking, timeouts, concurrency, and prompt
- worker event payloads are JSONL beside each workflow project; SQLite stores observability metadata/history
- orchestrator workers do not run through `/api/subagents`
- shutdown, interrupt, kill, Needs Human, timeout, and restart recovery remain orchestrator-owned

See [orchestrator README](../packages/extensions/orchestrator/README.md) for `WORKFLOW.md`, tracker, webhook, runner, and CLI reference.

## Principal API surfaces

Routes are composed from core plus enabled extensions. Exact route definitions and shared schemas are source of truth.

Access logs emit one completion line. Fast successful GETs for health, session polling/history, chat-project lists/details, skill lists/details (except import-token and recipients), and static assets are quiet; status >= 300 or elapsed > 500 ms still logs. Nested metadata routes and session search remain logged.

- **Core agents:** `/api/agents`, status, messages, history, sessions, extension catalog/config. `GET /api/agents/sessions/search?q=words` shares the sidebar's filename-based enumeration and reads each candidate once for its summary and match. It returns `{ items }` (summaries with avatar plus `match: "title" | "content"`, optional snippet), excludes archived chats, and searches the caller's visible-agent interactive sessions including chat Projects. Case-insensitive substring words must all occur across the shown label (`title || firstUserMessage || sessionId`) and user/assistant text; tool/thinking/system content is excluded. Title matches precede content matches, newest first within each group, capped at 50; blank input returns no items. No index/cache; search remains access-logged.
- **Realtime:** `/ws`
- **Media:** `/api/media/*`. Gateway uploads and Slack share the pure extension/MIME table at `@yoplai/shared/media-types`; Slack excludes SVG. Slack text files and snippets are downloaded in full as attachments, with a marked preview only on failure. JSON joins Markdown/text/CSV raw extraction; PowerPoint (`pptx`, `ppt`) remains unextracted. Only in-process Pi opts into validated host paths for unextracted documents; container/OpenClaw callers keep their own path listings.
- **Capabilities/auth:** `/api/capabilities`, `/api/auth/*`, `/api/me`
- **Multi-user admin:** `/api/admin/users`, `/api/admin/teams`, `/api/admin/forks`, pool/team access routes
- **Scheduler:** `/api/schedules/*`
- **Projects/slices:** `/api/projects/*` (including nested slice routes), lead sessions, project subagents, Space/changes routes
- **Runtime subagents:** `/api/subagents/*`
- **Orchestrator:** `/api/orchestrator/*` plus tracker webhook routes
- **OAuth connections:** `/api/oauth/:provider/*`
- **My connections:** authenticated `/api/agents/:id/connections` lists caller-only OAuth/extension-token presence and team availability; `DELETE /api/agents/:id/connections/:kind/:integration` removes only the caller's personal grant. The web tab also consumes optional MCP scoped status/disconnect routes. OAuth local deletion precedes background upstream revocation, so outages cannot delay fallback.
- **Account Slack pairings:** authenticated `/api/slack/pairings` lists the caller's workspace/user mappings; `DELETE /api/slack/pairings/:workspaceId/:slackUserId` deletes only a matching caller-owned mapping, with a same-origin check. The next sender resolution is unpaired.
- **Webhooks:** `/hooks/:agentId/:name/:secret`
- **Container bridge:** `/internal/tools` with per-run token validation

Multi-user mode guards `/api/*` and `/ws`. Cookie sessions and Better Auth API keys resolve to the same request auth context. Extension routes should disappear with `extension_disabled` behavior when their owner is unavailable.

## CLI map

Primary commands include:

- `yoplai gateway ...` — run/install/manage gateway
- `yoplai agent list`, `yoplai agents migrate`
- `yoplai send`, `yoplai notify`
- `yoplai models refresh` — refresh Pi provider catalogs in `$YOPLAI_HOME/models-store.json`
- `yoplai scheduler ...`
- `yoplai projects ...`, `yoplai slices ...`
- `yoplai subagents ...`
- `yoplai orchestrator ...`
- `yoplai auth ...`, `yoplai user token ...`
- `yoplai eval run ...`

Use `--help` and owning package README for flags. HTTP-oriented CLI commands resolve URL as `YOPLAI_API_URL` then `YOPLAI_URL` then config `apiUrl`; token resolves `YOPLAI_TOKEN` then config token.

## Development and validation

Requires Node `>=22.19.0` and pnpm 11.

```bash
pnpm install
pnpm init-dev-config  # create repo-local .yoplai config
pnpm dev              # gateway + web, dev isolation/port discovery
pnpm dev:gateway      # gateway/shared/web production-mode hot reload
pnpm dev:web          # Vite web only
pnpm build
pnpm build:web
pnpm typecheck
pnpm lint
```

Scoped tests, run serially:

```bash
pnpm test:gateway
pnpm test:web
pnpm test:shared
pnpm test:cli
pnpm exec vitest run <exact-test-file>
```

Do not use `pnpm test -- <path>` for single files. Run `pnpm install` first if `node_modules` is absent. User-facing changes should follow `docs/validation_e2e.md` when applicable.

Dev entrypoints use `NODE_OPTIONS=--conditions=development`, allowing shared/extension source imports without rebuilding `dist`. Production imports resolve built output.

## Change-placement rules

- Cross-package invariants and ownership maps belong here.
- Beginner installation and first-agent setup belong in root `README.md`.
- Advanced cross-domain user workflows belong under `docs/` and its index.
- Exhaustive extension schemas and feature detail belong in package README.
- Shared protocol changes require schema/type updates in `packages/shared` before consumers.
- Optional extension code must stay optional in gateway and web import graphs.
- User-visible behavior/API/config/UI changes require `CHANGELOG.md` entry under `## [Unreleased]`.
