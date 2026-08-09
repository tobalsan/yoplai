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
- Multi-user mode is enabled with `extensions.multiUser.enabled: true`, not a top-level `multiUser` key.
- Secrets written by the agent-extension config API become `$env:` references in `agent.yaml`; plaintext values go into the agent `.env`.
- Host OAuth token persistence requires `oauth.encryptionKey` (typically `$env:OAUTH_ENCRYPTION_KEY`) and fails closed rather than writing plaintext.
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
| `auth.db`                          | Better Auth SQLite DB when multi-user extension is enabled |
| `projects.json`                    | Project numeric ID counter                                 |

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

### Sessions and concurrency

- `sessionKey` is a logical key, default `main`; mapping persists in `sessions.json`.
- explicit `sessionId` bypasses logical-key resolution.
- `/new` and `/reset` rotate the session; `/compact` compacts older context.
- sessions expire after `sessions.idleMinutes`, default 360.
- queue mode buffers/follows active work; interrupt mode aborts current run then starts the new turn.
- explicit `/abort` and `/stop` pause active durable tasks; ordinary durable-task follow-ups are forced to queue.
- canonical history preserves normalized user, assistant, thinking, tool, system-context, and file blocks.

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

Pi supports extension tools in and out of containers. Sandbox Claude fails loudly when extension tools are present rather than silently omitting them.

## Extension map

Extensions load through `extensions.<id>` unless documented auto-load compatibility applies. Package README is authoritative for configuration and detailed behavior.

| Extension      | Ownership                                                               | Reference                                                            |
| -------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `board`        | Board/project web shell and board APIs; depends on projects + subagents | [README](../packages/extensions/board/README.md)                     |
| `discord`      | Discord routing, forum threads, reactions, proactive tools/delivery     | [README](../packages/extensions/discord/README.md)                   |
| `heartbeat`    | Periodic agent check-ins gated by scheduler                             | [`packages/extensions/heartbeat`](../packages/extensions/heartbeat/) |
| `irc`          | IRC transport, routing, batching, formatting                            | [README](../packages/extensions/irc/README.md)                       |
| `langfuse`     | Stream/history tracing and observations                                 | [`packages/extensions/langfuse`](../packages/extensions/langfuse/)   |
| `multiUser`    | Better Auth, teams, pool/forks, access isolation, bearer tokens         | [README](../packages/extensions/multi-user/README.md)                |
| `orchestrator` | Tracker-driven daemon and protocol worker runners                       | [README](../packages/extensions/orchestrator/README.md)              |
| `projects`     | Project/slice documents, subagent runs, Space integration, CLI/API      | [README](../packages/extensions/projects/README.md)                  |
| `scheduler`    | Cron jobs, scripts/gates, outputs, delivery sinks                       | [README](../packages/extensions/scheduler/README.md)                 |
| `slack`        | Slack Socket Mode transport, threads, files, proactive tools            | [README](../packages/extensions/slack/README.md)                     |
| `subagents`    | Project-agnostic CLI subagent runtime                                   | [README](../packages/extensions/subagents/README.md)                 |
| `telegram`     | Telegram transport and proactive delivery                               | [README](../packages/extensions/telegram/README.md)                  |
| `webhooks`     | Signed inbound webhooks and isolated webhook sessions                   | [`packages/extensions/webhooks`](../packages/extensions/webhooks/)   |

Tool-style extensions use `packages/shared/src/tool-extension.ts`. Extensions may contribute routes, CLI commands, capabilities, services, system-prompt text, tools, delivery sinks, OAuth requirements, and web routes. Keep behavior with its owning package; core should depend only on extension contracts and optional imports.

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
- **Webhooks:** `/hooks/:agentId/:name/:secret`
- **Container bridge:** `/internal/tools` with per-run token validation

Multi-user mode guards `/api/*` and `/ws`. Cookie sessions and Better Auth API keys resolve to the same request auth context. Extension routes should disappear with `extension_disabled` behavior when their owner is unavailable.

## CLI map

Primary commands include:

- `yoplai gateway ...` — run/install/manage gateway
- `yoplai agent list`, `yoplai agents migrate`
- `yoplai send`, `yoplai notify`
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
