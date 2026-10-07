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
- `SessionRunLifecycle` owns active state, aborts, queue/interrupt joins, buffered follow-ups, history events, and final flushing.
- `normalizeRunRequest()` is the shared REST/WebSocket input normalization path.
- `ExtensionRuntime` is the source of loaded routes, tools, prompt contributions, capabilities, and lifecycle state.

### `apps/web`

Solid.js SPA. It consumes `/api/capabilities` and loads optional extension routes only when enabled.

- `src/api/`: domain API clients and realtime client
- `src/lib/chat-runtime.ts`: shared streaming/history/attachment runtime
- `src/lib/web-route-registry.tsx`: optional extension route discovery
- `src/extensions/`: extension-owned route bundles
- core chat supports simple/full history, streaming, attachments, aborts, and explicit sessions

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

Standalone Node 22 process for sandboxed agents. It reads `ContainerInput` JSON from stdin, runs Pi or Claude, streams framed events on stdout, and writes framed `ContainerOutput`. It may import `@yoplai/shared` and SDK packages, but never gateway source.

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
extensions:
  scheduler:
    enabled: true
```

Key rules:

- Root `extensions.<id>` configures/loads an extension; agent `extensions.<id>` opts an agent into tool-style extensions unless `enabled: false`.
- Agent folders may contain `.env`. `$env:NAME` resolves from agent-local env layered over `$YOPLAI_HOME/.env`, `yoplai.json` `env`, and `process.env`.
- Agent-local resolved values are passed to extension hooks as `ctx.env`; do not assume they enter global `process.env` or sandbox env.
- External extensions default to `$YOPLAI_HOME/extensions` or `extensionsPath`; directories and symlinked directories are supported.
- Projects root is `extensions.projects.root`; top-level `projects.root` is deprecated fallback only.
- Onboarding tour (multi-user only): `user_onboarding` table in `auth.db` (`createOnboardingStore`, `packages/extensions/multi-user/src/onboarding.ts`) stores per-user `done|skipped` + timestamp, exposed at `GET/PUT/DELETE /api/me/onboarding` (`supported:false` in single-user mode). Web: `apps/web/src/onboarding/` (`steps.ts` route/target table, `OnboardingTour.tsx` driver.js controller mounted in `Layout`, `state.ts` step signal in sessionStorage + `restartTour`). Targets use `data-tour` attributes; keep them when editing the agent catalog, edit-agent, extension details, credential tabs, OAuth connect card and chat composer.
- Multi-user mode is enabled with `extensions.multiUser.enabled: true`, not a top-level `multiUser` key. It needs at least one sign-in method: `oauth.google` and/or `emailAndPassword: { enabled: true }`; `/api/capabilities` exposes `authMethods` so the login page renders only configured methods.
- Secrets written by the agent-extension config API become `$env:` references in `agent.yaml`; plaintext values go into the agent `.env`.
- The same API accepts `credentialScope: "personal"` for authenticated agent users: any declared config field is accepted (`config` replaces prior setting overrides, `secrets` merge), requester identity comes from auth, and tokens are encrypted in `CredentialStore` under `extension-config:<id>` without writing YAML/env. `credentialScope: "team"` (or omitted) preserves the existing writer and is open to anyone with agent access (staff or same-team members), as are enable/disable writes and team OAuth grants. Saving personal credentials also sets `enabled: true` for the agent. The Edit-Agent hub shows a checkmark when credentials exist in either scope (`oauthConnected` for OAuth extensions); "off" means removing credentials, except settings-less extensions, which use Enable/Disable on their details page. Catalogs expose personal secret presence and the requester's own setting overrides (`personalConfigValues`); team non-secret `$env:` refs are resolved for display. Runtime overlays the requester's values (secrets and setting overrides) in both agent and root hook config, and recreates token-backed tools at execution: requester personal → existing team config → refusal with an absolute form link. Settings the requester did not override stay shared; userless runs use team tokens only; scheduled owner-mode runs resolve tokens for the job owner. Missing tokens do not prevent unrelated tools or startup; invalid shared settings remain validation errors. Personal token values cannot be `$env:` references. Agent members unset whole-team credentials with `DELETE /api/agents/:id/extensions/:extensionId/credentials` (`removeSecrets` in `agent-config-writer.ts`: removes secret fields from `agent.yaml` plus their writer-managed `.env` values; settings stay); personal values are removed via the My connections `DELETE` route.
- Host OAuth token persistence requires `oauth.encryptionKey` (typically `$env:OAUTH_ENCRYPTION_KEY`) and fails closed rather than writing plaintext.
- Built-in Google OAuth connections are scoped to agent/provider plus team or personal Yoplai user. `src/credentials/` owns the provider-independent encrypted store/resolver; the OAuth adapter reads legacy records as team. Web REST/WS identity flows through extension hooks and tool contexts, and factory OAuth tools re-resolve at execution: personal requester → team → connect link. Userless runs use team only; an unusable personal grant asks for reconnect rather than changing accounts.
- Scheduler jobs store `ownerUserId` and `credentialMode`. Authenticated chat/web creation defaults to owner mode, while legacy and userless jobs use team mode. Owner runs pass the recorded user identity to credential resolution; missing personal credentials can use team, while an unusable personal credential fails the run and delivers a reconnect error. The agent page **Scheduled jobs** tab only lists jobs (plain-language recurrence via `cronstrue`) and switches credential mode; jobs are created in chat.
- Slack `!pair` issues an ephemeral ten-minute single-use link bound to the bot's verified workspace and message sender. `packages/extensions/slack/src/pairing.ts` stores hashed tokens and workspace/user → existing Yoplai user mappings in `slack-pairing.db`; routes require web login and a fresh Slack `users.info` email match (trimmed, case-insensitive; missing email fails closed). Each Slack message/reaction/control run resolves its own sender into trusted `RunAgentParams.userId`; absent pairing is unpaired and uses team credentials only. Unpaired message runs add a `sender_identity` Slack context block telling the model to call `slack.pair` and label team data as the team's. `slack.pair` (no args; extra args ignored) finds the run's trusted sender via an in-memory active-sender registry (`requester.ts`, matched by agent + session) issues a fresh link, and returns only a `<slack-pair-link>` placeholder; the bot substitutes the real URL into the reply (or appends it if the model omits the placeholder) because models mistype long random tokens; the model never chooses the recipient, and redemption still requires a web login whose email matches that sender. Pairing assumes equal Slack/Yoplai emails and requires `users:read.email`; Slack OpenID Connect is the documented future alternative for differing emails.
- Slack credential refusals use an ephemeral `/api/slack/connect/:token` link generated from the trusted active sender; shared OAuth tool factories and the host token tool guard request it via `requestCredentialConnectLink`. Unpaired flows reuse pairing redemption before any credential save/start; paired flows enforce the existing owner and agent access. All connections are personal. The combined form replaces separate pairing/scope screens; paired OAuth goes directly to the provider. Completion posts a bounded confirmation in the original thread; no auto-resume. `ctx.credentialConnect` owns host OAuth/token persistence, while `registerCredentialOAuthConnector` lets extension-owned OAuth use the same trusted start/completion seam. Extension OAuth requires a trusted, extension-defined `targetId` beside `extensionId`; the link snapshots it and completion must return the same ID (see `docs/slack-credential-connect.md`).
- External extensions receive `ctx.credentials` in `start`: the host encrypted generic store supports scoped get/save/delete and personal → team resolution. Use `ctx.credentialConnect.requestLink(context, target)` and `registerOAuthConnector(extensionId, start)` for Slack connection hooks; these use host registries even when an extension installs its own shared package. Startup and runtime activation bind registration to the extension's own ID. Call the returned unregister in `stop`. MCP OAuth routes enforce agent access; the MCP UI selects personal/team for status, authorization, and disconnect.
- Sandboxed runs using OAuth, whether selected by `agent.yaml` or a per-run model override, have provider credentials pre-refreshed on the host and receive short-lived access tokens via `ContainerInput.oauthTokens` (`apps/gateway/src/sdk/container/oauth-tokens.ts`); the runner renews only providers authorized for that run through `POST /internal/oauth-token` under a 10-minute threshold. Refresh tokens never enter the container. See `docs/container-isolation.md`.
- `pnpm init-dev-config` creates repo-local `.yoplai/yoplai.json` from `scripts/config-template.json` with free ports.

## Runtime data

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
| `auth.db`                          | Better Auth SQLite DB when multi-user extension is enabled |
| `audit.db`                         | Gateway-owned append-only settings audit; secret values are never stored |
| `projects.json`                    | Project numeric ID counter                                 |
| `tool-labels.json`                 | Maintenance-model-generated friendly tool-call label templates (`GET /api/tool-labels`) |

Canonical history drives history APIs, web UI, Langfuse, compaction, channel context, and media blocks. Pi session files are SDK-owned runtime state; code may use them only for resume/backfill/fallback behavior.

Multi-user mode scopes session maps and canonical history beneath `sessions/users/<userId>/`. There is no automatic migration from existing single-user history into user ownership.

## Agent runtime flow

1. Load and validate v3 config; discover `agent.yaml` files.
2. Resolve configured extensions, secrets, capabilities, routes, lifecycle, and services.
3. Resolve requested agent plus logical `sessionKey` or explicit `sessionId`.
4. Ensure missing workspace system files, then resolve prompt/system files.
5. Collect extension prompt contributions and agent tools.
6. Select in-process or sandbox adapter and stream normalized history events.
7. Flush canonical history and settle lifecycle state; then drain queued non-native work.

Workspace bootstrap creates missing `AGENTS.md`, `SOUL.md`, and `USER.md` from `docs/templates/` without overwriting existing files. `AGENTS.md` is implicitly prepended; `system_files` controls remaining prompt-file order.

Pi discovers skills and commands from workspace and user Pi directories. Extension tool names are provider-sanitized for the model while gateway dispatch retains original extension/tool identity.

Yoplai also ships a built-in `dashboard` skill to host and sandboxed Pi agents. It teaches the Canvas file/data/maintenance contract and includes cloneable HR, OKR, and customer-success templates backed by seeded SQLite data; workspace skills can complement it without requiring a global-skills opt-in.

### Sessions and concurrency

- `sessionKey` is a logical key, default `main`; mapping persists in `sessions.json`.
- explicit `sessionId` bypasses logical-key resolution.
- `/new` and `/reset` rotate the session; `/compact` compacts older context.
- sessions expire after `sessions.idleMinutes`, default 360.
- queue mode buffers/follows active work; interrupt mode aborts current run then starts the new turn.
- explicit `/abort` and `/stop` pause active durable tasks; ordinary durable-task follow-ups are forced to queue.
- canonical history preserves normalized user, assistant, thinking, tool, system-context, and file blocks.
- An assistant turn whose complete text is `NO_REPLY` (optionally wrapped in Markdown or followed by a period) remains in canonical history but emits no text or delivery payload; the web UI hides it in simple view and shows the raw token in full view.
- Agent-authored inbound turns may identify their sender and hop count. The runner stops conversations that exceed `agentLoop.maxAgentTurns` (default 8 consecutive agent turns) or `agentLoop.maxHops` (default 5); a human-authored turn resets the consecutive-turn counter. Discord's top-level `extensions.discord.allowBots` can admit explicitly mentioning bot authors and maps them to `discord:<botUserId>` agent senders on the same channel session.

### WebSocket

`/ws` supports send and persistent subscription modes. Clients can:

- send a run for `agentId` with `sessionKey` or `sessionId`
- subscribe/unsubscribe to session updates
- subscribe to agent status and extension-owned project/subagent events
- receive text, thinking/tool/file events, completion/error, replay, and history-update signals

Use schemas in `packages/shared` and broker code in `apps/gateway/src/server/ws-broker.ts` as protocol source of truth; do not duplicate event unions in feature code.

### Sandbox/container flow

- Gateway builds Docker args/mounts in `src/agents/container.ts` and `src/sdk/container/`.
- Each run gets a unique container name, token, and IPC namespace.
- Agent data mounts writable at `/workspace/data`; uploads mount read-only at `/workspace/uploads`.
- Workspace `.env` is shadowed; only explicitly forwarded safe env and sandbox env reach container.
- Custom mounts must pass configured allowlist/blocklist checks.
- Extension prompt/tool metadata is serialized into `ContainerInput`; tools call back through authenticated `/internal/tools`.
- Outbound file requests must resolve inside allowed data paths; gateway copies/registers them in managed media storage.
- Container event/output framing constants and schemas live in `packages/shared`.
- Default `yoplai-agent:latest` rebuilds when build-context content changes; custom images are not rebuilt.

Host and sandbox Pi agents share the Yoplai base system prompt from `packages/shared/src/pi-system-prompt.ts`; sandbox runs append container-specific instructions.

Pi supports extension tools in and out of containers. Sandbox Claude fails loudly when extension tools are present rather than silently omitting them.

## Extension map

Extensions load through `extensions.<id>` unless documented auto-load compatibility applies. Package README is authoritative for configuration and detailed behavior.

| Extension      | Ownership                                                                | Reference                                                            |
| -------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `board`        | Board/project web shell and board APIs; depends on projects + subagents  | [README](../packages/extensions/board/README.md)                     |
| `discord`      | Discord routing, forum threads, reactions, proactive tools/delivery      | [README](../packages/extensions/discord/README.md)                   |
| `heartbeat`    | Periodic agent check-ins gated by scheduler                              | [`packages/extensions/heartbeat`](../packages/extensions/heartbeat/) |
| `irc`          | IRC transport, routing, batching, formatting                             | [README](../packages/extensions/irc/README.md)                       |
| `langfuse`     | Stream/history tracing and observations                                  | [`packages/extensions/langfuse`](../packages/extensions/langfuse/)   |
| `multiUser`    | Better Auth, teams, pool/forks, access isolation, bearer tokens          | [README](../packages/extensions/multi-user/README.md)                |
| `orchestrator` | Tracker-driven daemon and protocol worker runners                        | [README](../packages/extensions/orchestrator/README.md)              |
| `projects`     | Project/slice documents, subagent runs, Space integration, CLI/API       | [README](../packages/extensions/projects/README.md)                  |
| `scheduler`    | Recurring cron and one-shot jobs, scripts/gates, outputs, delivery sinks | [README](../packages/extensions/scheduler/README.md)                 |
| `slack`        | Slack Socket Mode transport, threads, files, proactive tools             | [README](../packages/extensions/slack/README.md)                     |
| `subagents`    | Project-agnostic CLI subagent runtime                                    | [README](../packages/extensions/subagents/README.md)                 |
| `telegram`     | Telegram transport and proactive delivery                                | [README](../packages/extensions/telegram/README.md)                  |
| `webhooks`     | Signed inbound webhooks and isolated webhook sessions                    | [`packages/extensions/webhooks`](../packages/extensions/webhooks/)   |

Tool-style extensions use `packages/shared/src/tool-extension.ts`. Their `oauth` declaration accepts a static requirement or `(config: ResolvedToolExtensionConfig) => OAuthRequirement`, with agent settings overriding root defaults in `config.merged`. Catalog/connect links and tool execution resolve the matching scopes; missing granted scopes produce `insufficient_scope` with a scoped reconnect URL. Extensions may contribute routes, CLI commands, capabilities, services, system-prompt text, tools, delivery sinks, OAuth requirements, and web routes. Keep behavior with its owning package; core should depend only on extension contracts and optional imports.

Canvas is a core gateway feature. Agents use `dashboard_link` to publish a single `.html` file from `data/dashboards/<slug>.html` in their workspace (for sandboxed agents this is the always-writable `/workspace/data` mount, i.e. the host agent data dir). SQL `data-db` paths are relative to the workspace root, e.g. `data/app.db`; host agents are confined to their workspace and sandboxed agents to `data/`. Configure it with root `canvas.enabled` and optional `canvas.baseUrl`; links default to the platform public URL. Viewer requests require the normal login flow and agent team access when multi-user mode is enabled, and every page is served under a restrictive sandbox CSP.

Canvas records the latest 20 distinct dashboard contents observed by `dashboard_link`, `dashboard_versions`, or a viewer request. Agents can use `dashboard_versions` to list or restore those copies without changing the dashboard link. Managed versions are skipped when the agent workspace has its own `.git` entry because Git already provides history.

Agents use `dashboard_delete` to remove a dashboard HTML file, its stable registry entry, and its managed versions. Deletion is idempotent, preserves `.db` files, invalidates the old viewer link, and lets a recreated slug receive a new link with fresh history.

The web agent detail page has a Dashboards tab for accessible agents. `GET /api/agents/:id/dashboards` uses the per-agent access middleware and discovers workspace HTML files through the Canvas registry; it returns each dashboard's HTML title (or filename), slug, file modification time, viewer link, required `params`, and normalized `linksTo` slugs. Dashboards that require URL arguments declare `<meta name="yoplai:params" content="id">` (comma-separated names allowed); optional arguments do not need this meta. The API stays flat; the tab nests required-argument dashboards beneath every same-agent parent that calls `YOPLAI.link` to them, recursively with ancestor-cycle protection. These child rows have no Open/Copy actions. Dashboards without required arguments stay top-level; unreachable required-argument dashboards appear under **Needs parameters**.

Dashboard pages can use the public Dashboard Kit (cached for a week) at `/d-assets/v2/kit.css` and `/d-assets/v2/kit.js`. Load `/d-assets/v2/echarts.js`, `/d-assets/v2/marked.js`, and `/d-assets/v2/purify.js` as needed; `/d-assets/v2/sample.html` demonstrates the "needs attention" callout, KPI strips (formatted values, deltas, sparklines), status pills, segmented filters, searchable/sortable CSV tables with formatters, links, severity dots and a show-all row cap, ranked links, tabs, filters, sanitized markdown, themed chart types, dark tokens, and print styling. `/d-assets/v1/` still resolves to the same backward-compatible files for existing pages. The dashboard skill's `references/kit.md` holds the design rules agents follow. Dashboards automatically inherit app colours from `$YOPLAI_HOME/theme.css` and follow the web UI's light/dark choice: the web UI mirrors its theme into a `yoplai-theme` cookie, and the gateway stamps `data-theme` on the served page from that cookie (falling back to the viewer's OS `prefers-color-scheme` when the cookie is absent or invalid). Set `data-theme="light"` or `data-theme="dark"` directly on the dashboard's `<html>` to override; an explicit value always wins over the cookie/OS default. Asset routes are a fixed allowlist and contain no agent or user data; HTML assets (`sample.html`) are served with the same sandbox CSP as dashboards.

Dashboards can declare live SQLite queries with `<script type="application/sql" data-name="items" data-db="data/app.db">...</script>`. On every page load, Canvas takes a confined read-only snapshot of the database and its WAL, binds `:viewer_email`, `:viewer_name`, `:today`, and URL query parameters, and injects results into `YOPLAI.data` before page scripts run. A dashboard may declare up to 20 queries; each query has a 100KB SQL, two-second execution, 5,000-row, and 5MB serialized-result limit. At most four query workers run process-wide, with a bounded queue. `YOPLAI.viewer`, `YOPLAI.params`, and `YOPLAI.link(slug, params)` provide viewer context and same-agent drill-down links; query failures render on the page and appear as `queryErrors` in `dashboard_link` results.

Page code belongs in one `<script type="module">` (classic inline scripts share the browser's global scope, so a top-level `const top` throws and blanks the page). `dashboard_link` also returns `problems`, a static lint of the page produced with `node:vm` without executing its code: script syntax errors, global-name collisions between classic scripts, echarts.js/kit.js load order, `/d-assets/v1/` use, `YOPLAI.data` names without a matching query, inline `on*=` handlers when modules are used, and queries that returned 0 rows. Agents fix every `problems` and `queryErrors` entry before sharing the link. Dashboard Kit registers `error`/`unhandledrejection` listeners that show a `.dk-error-banner` at the top of the page (max 3 distinct messages).

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

- **Core agents:** `/api/agents`, status, messages, history, sessions, extension catalog/config
- **Realtime:** `/ws`
- **Media:** `/api/media/*`
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
