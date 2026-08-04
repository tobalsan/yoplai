# Yoplai - LLM Context Document

## Project Goal

Yoplai is a lightweight, self-hosted multi-agent gateway. It provides a unified interface to run AI agents across web, messaging, CLI, scheduled jobs, and project orchestration. Designed for solo developers managing multiple agents with minimal operational overhead.

## How to use this document

This is the repository's LLM-facing map. Start with **Architecture** and **Agent Runtime Flow**, then jump to the owning package README for detailed extension configuration. The main sections are:

- **Architecture** — ownership and important modules by workspace
- **Runtime Data** and **Config Schema** — durable files and configuration contracts
- **Agent Runtime Flow** — startup, execution, sessions, history, and protocols
- **Services** — scheduler and messaging behavior
- **API Endpoints** — gateway HTTP surface
- **Development** — local commands and runtime conditions
- **Orchestrator extension progress** — tracker and worker-runner architecture

`README.md` is the human-facing setup guide. Package-specific operational detail belongs beside its owner under `packages/extensions/*/README.md`; this document records cross-package architecture and invariants.

## Architecture

```
yoplai/
├── apps/
│   ├── gateway/     # Node.js server, CLI, agent runtime
│   └── web/         # Solid.js mobile-first chat UI
├── container/
│   └── agent-runner/ # Standalone Docker entrypoint for sandboxed agents
├── packages/
│   ├── extensions/  # First-party gateway extensions
│   └── shared/      # Zod schemas, shared types
└── ~/.yoplai/        # Default YOPLAI_HOME runtime config & data
```

### apps/gateway

Core TypeScript/Node.js application. Exports:

- **CLI** (`src/cli/index.ts`): `yoplai gateway`, `yoplai agent list`, `yoplai send`, `yoplai notify`, `yoplai projects ...`, `yoplai subagents ...`, `yoplai scheduler ...`, `yoplai eval run`
- **Evals** (`src/evals/`): Headless single-turn runtime for Harbor eval tasks. `yoplai eval run --agent <id> --instruction-file <path>` boots config + extensions + `runAgent()` only (no HTTP server or long-running extension services), aggregates the stream into `result.json`, and emits an ATIF `trajectory.json`. `--config <path>` loads that exact config file without replacing the process-wide default config cache, and `--model <id>` runs with that model on the agent's configured provider (not merely changing reported metadata).
- **Server** (`src/server/`): Hono-based HTTP API + WebSocket streaming
  - `src/server/run-request.ts` normalizes REST/WebSocket agent run inputs before `runAgent()`: validation, session key defaults/resolution, multi-user user IDs/context, inbound attachment paths, and empty reset-trigger intro responses.
  - `src/server/ws-broker.ts` owns the `/ws` broker: WebSocket auth attach, per-session subscriptions with active-turn replay, status subscribers, project file/agent fanout, subagent change fanout, and web-origin run dispatch through `normalizeRunRequest()`.
- **Media** (`src/media/`): local upload/download support under `$YOPLAI_HOME/media`, with inbound/outbound metadata, `GET /api/media/download/:id`, 25MB server-side upload cap, image/document MIME allowlist, and document text extraction helpers for PDF/docx/xls/xlsx/csv/txt/md
- **Agent Runtime** (`src/agents/`): Pi SDK integration (Pi packages pinned at `^0.80.6` under the `@earendil-works` scope; runtime helpers that moved out of the `@earendil-works/pi-ai` root in 0.80.0 — `getEnvApiKey`, `completeSimple` — are imported from `@earendil-works/pi-ai/compat`; built-in coding tools are enabled by name via `createAgentSession({ tools: ["read", "bash", "edit", "write"] })`), session management, sandbox container mount/argument helpers in `src/agents/container.ts`, and the Docker-backed container adapter in `src/sdk/container/adapter.ts`
  - `src/agents/run-lifecycle.ts` owns gateway session run state transitions behind `SessionRunLifecycle`: active streaming/abort state, adapter handles, queue vs interrupt joins, pending follow-up messages, turn buffering, history event emission, and final turn flushing. `runAgent()` still resolves agents/sessions, handles `/abort` and `/think`, selects adapters, invokes SDKs, and drains non-native queued runs.
- **Scheduler** (`packages/extensions/scheduler/`): Interval/daily job execution. Scheduled fires default to unique sessions (`scheduler:<jobId>:<runId>`) unless `payload.sessionId` explicitly overrides the target. Scheduler job files may include optional top-level `model: { provider, model }`; when present, scheduled runs use that provider/model instead of the agent default. When enabled, scheduler injects self-only agent tools (`scheduler.list_jobs`, `scheduler.create_job`, `scheduler.update_job`, `scheduler.delete_job`, `scheduler.get_latest_output`); `create_job`/`update_job` accept an optional `timeoutMs` (per-run timeout, default 30 minutes). Gateway hot reload polls config, agent YAML, and agent cron files every 5 seconds. See `packages/extensions/scheduler/README.md`.
- **Discord** (`packages/extensions/discord/`): Extension-owned Discord bot runtime with channel/DM routing; legacy per-agent config remains supported input. Agent-level `discord.forumChannels` subscribes agents to forum parent channels: new forum threads spawn fresh sessions and write thread-session bindings, while user replies in bound threads resume the stored session. The `discord.create_forum_thread(channel_id, title, body)` agent tool creates a forum thread, posts the starter body, binds the returned thread to the current session, and enables scheduler/proactive handoffs that resume from user replies.
- **Slack** (`packages/extensions/slack/`): Extension-owned Slack Bolt Socket Mode runtime with channel/DM routing, thread replies, reactions (off by default; opt in per channel with `reactionNotifications`), `/new`/`/stop` slash commands, `!new`/`!stop` bang commands (detected at start of regular messages — no slash command setup needed, works with multiple bots), optional live thinking thread replies, Slack mrkdwn conversion, inbound file attachment downloads to Yoplai media, outbound `file_output` uploads via Slack `files.uploadV2`, and cross-source broadcasts in v2 modular config. `slack.create_thread(channel, text)` posts a thread parent and binds `(channel, parent timestamp, agent)` to the active session; an inbound reply with that binding resumes the bound session before normal Slack routing and is delivered in the same thread, even with `threadPolicy: "never"`. It accepts channel IDs or user IDs (resolved as DMs). A bound DM-thread reply does not reach the main session; the one-time main-session DM visibility note applies only to a later top-level reply after proactive `slack.send_message`. See `docs/examples/slack-thread-cron.md` for the scheduler handoff.
- Inbound Slack/Discord message runs now normalize `channel`, `place`, `conversation_type`, and `sender`, render a fallback-filled `[CHANNEL CONTEXT]` block, and append it to the true system prompt. This applies to both in-process and sandbox/container runs. First-party gateway/CLI runs do not get channel context. Web UI runs in multi-user mode pass a name-only `[USER CONTEXT]` block from the authenticated OAuth profile.
- **Extensions** (`src/extensions/`): Registry/runtime composition that validates configuration, mounts routes, and owns extension lifecycle. Most built-ins load only when configured under `extensions.<id>`; Discord, Slack, Telegram, IRC, and heartbeat may also load from supported per-agent configuration, while webhooks load when an agent declares webhooks.
  - Built-in `projects` and `board` are optional packages from core's perspective: gateway loads them through runtime optional imports only when configured, and the web route registry discovers optional route modules only when present. `board` explicitly depends on `projects` and `subagents`.
  - `subagents` is an opt-in first-party extension for project-agnostic CLI subagent runtime; load it by adding an `extensions.subagents` block (e.g. `{}`) to the gateway config. It owns `/api/subagents`, `yoplai subagents ...`, process lifecycle, normalized logs, `subagent_changed` websocket broadcasts, run storage under `$YOPLAI_HOME/sessions/subagents/runs/<runId>`, and contributes subagent command guidance through `Extension.getSystemPromptContributions()`. Codex/Claude CLI lifecycle chatter remains in raw `logs.jsonl` but is filtered from the logs API and latest-output summaries. Default `/api/subagents` list responses also merge project-backed subagent sessions so orchestrator runs are visible to `yoplai subagents list --status running`; `projectId` scopes project-backed lookup to one project before `sliceId`, `status`, `cwd`, and `includeArchived` filtering.
  - `multiUser` is an auth extension that enables Better Auth + SQLite, guards `/api/*` and `/ws`, exposes `/api/auth/*`, `/api/me`, `/api/admin/*`, keeps session/history storage isolated per user, and must finish startup before the HTTP server begins accepting requests. While a logged-in browser session is pending approval, web auth gates poll authoritative `/api/me` every few seconds and on window focus so admin approval grants access without re-login. Superadmins can start read-only impersonation ("View as") from `/admin/users`; gateway stores target user in memory keyed by admin session, `/api/me` and reads use target context, non-GET writes are blocked except end/signout/status, and WebSocket sends return `read_only_impersonation` while subscribes remain target-scoped.
  - `langfuse` is an optional tracing extension. Its registry entry is lazy-loaded, has no routes, validates `publicKey`/`secretKey` from extension config or `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY`, and subscribes to `agentEventBus` stream/history events. `langfuse/tracer.ts` maps `agentId:sessionId` to traces, honors per-run trace context (`enabled`, explicit `surface`/`name`, metadata), buffers text/thinking into generations, maps HistoryEvent user/meta/tool_call/tool_result data into generation input/model/usage and tool spans, finalizes on `done`/`error`, catches flush/shutdown failures as warnings, and idle-cleans traces after 30 minutes.
  - `system_prompt` history events now capture the harness-assembled prompt text itself. Langfuse generation observations are emitted as chat-style input arrays (`system` + `user`), so the Langfuse UI shows the real system prompt section. `system_context` remains separate metadata for normalized Slack/Discord channel details.
  - `webhooks` is auto-loaded when any agent has `webhooks` config. It registers `/hooks/:agentId/:name/:secret`, stores generated URL secrets in `$YOPLAI_HOME/webhook-secrets.json` with `0600` permissions, validates secrets from an mtime-cached file read so rotations take effect without restart, rotates them with `yoplai webhooks rotate <agentId> <webhookName>`, resolves inline or workspace-contained `.md`/`.txt` prompts relative to the agent workspace, interpolates `$WEBHOOK_ORIGIN_URL`, `$WEBHOOK_HEADERS`, and `$WEBHOOK_PAYLOAD`, enforces per-webhook `maxPayloadSize` bytes (default 1MB) while streaming request bodies, and runs each invocation in a fresh `webhook:<agentId>:<name>:<requestId>` session with source/surface `webhook`. Optional `verification: { location: "header"|"payload", fieldName }` short-circuits setup requests containing that header or JSON payload key before signature verification or agent invocation; requests without the configured field continue through normal webhook handling. `langfuseTracing: false` disables Langfuse tracing for that webhook; async webhook failures emit traceable `agent.stream` error events when tracing is enabled. Known GitHub, Notion, and Zendesk webhooks verify HMAC-SHA256 signatures when `signingSecret` is configured, with `$env:VAR` resolution.
  - Tool-style extensions use `packages/shared/src/tool-extension.ts`; root `extensions.<id>` supplies defaults, and `agent.yaml` `extensions.<id>` opts an agent in unless `enabled: false`.
  - Agent folders may define `.env` next to `agent.yaml`. Startup resolves each agent config's `$env:` refs against that agent-local env layered over `$YOPLAI_HOME/.env`, `yoplai.json env`, and `process.env`; extension tools receive the same map as `ctx.env`. Do not rely on these values being injected into the in-process Pi SDK global `process.env` or sandbox container env.
  - The `projects` extension owns the project agent tools (`project.create`, `project.get`, `project.update`, `project.comment`). In-process Pi runs and sandbox/container Pi runs both receive these only through the unified extension tool path, so disabling the `projects` extension removes the sanitized `project_*` tools from agent-visible custom tools.

### apps/web

Solid.js SPA with dark/light theme support. Two views:

- `AgentList`: Select agent to chat with
- `ChatView`: WebSocket-based streaming chat with Simple/Full view modes

Features:

- **Simple mode**: Text-only messages (default)
- **Full mode**: Shows thinking blocks (collapsed), tool calls with JSON args, tool results with diffs, model metadata (provider/model/tokens). The full-view toggle and model metadata are superadmin-only (`hasSuperadminRole` in `ChatView`); regular admins and users get simple view only, matching multi-user mode's chat-access boundary.
- Live tool indicators during streaming
- Collapsible blocks auto-collapse if content >200 chars
- Thinking indicator dots while waiting for response
- `BoardView` chat now uses full lead-agent history per selected agent/session key, renders through `BoardChatRenderer`, streams assistant text plus live tool calls/results over `/ws`, supports file picker and drag-and-drop attachments through chat media uploads, keeps the textarea editable while a run is active, shows separate Send/Stop controls, and keeps queued follow-up user messages separate until the active run picks them up
- `apps/web/src/components/BoardChatRenderer.tsx` now exists as a standalone full-history board log renderer: it exports `BoardLogItem`, `buildBoardLogs()`, and `BoardChatLog` for rendering structured assistant/user text, thinking blocks, tool calls, and inline diffs from `FullHistoryMessage[]`
- Project `AgentChat` virtualizes only larger persisted history/log lists (`>=80` rows) with `@tanstack/solid-virtual`, remeasures visible rows on pane resize, and keeps the bottom row anchored while the live streaming row stays outside the virtualized region
- ChatView preserves optimistic user/error messages on failed runs instead of immediately reloading stale history when streaming ends with an error; interrupted runs also keep any streamed assistant text that arrived before `/abort`/Stop, and full-mode chat renders transport/run errors inline
- Projects board shell uses split sidebars:
  - Left sidebar: Yoplai logo + capability-driven primary navigation
  - Right context panel tabs: `Agents` (lead agents + subagents with live status), `Chat`, `Feed`
  - Recent projects live at the bottom of the right context panel
  - Collapsed sidebars hover-expand as overlays above the main pane instead of reflowing it
- Projects home uses a simplified project kanban with columns `Triage`, `Shaping`, `Active`, `Ready to merge`, and `Done`; any number of columns can be expanded and the expanded set is persisted. The create form stores the initial idea/prompt in `README.md` (frontmatter + body) so shaping agents can turn it into `PITCH.md`, includes an editable project-level `repo` field, prefills that field from a selected area's `repo`, and validates non-empty paths on blur through `POST /api/projects/validate-repo` without blocking creation. The header `Archive` action opens `/projects/archive`, which groups `.archive` projects and `cancelled` projects separately instead of rendering an archive section above the kanban.
- Board project scanning is cached in-process: `/api/board/projects` uses in-flight dedupe, a 10s stale-while-revalidate endpoint cache, cached lifecycle metadata/counts, startup warmup, and `README.md` watcher invalidation. Worktree branch discovery reads `.git/HEAD`/`.git/worktrees/*` directly; only dirty/ahead still use git and are TTL-cached with `.git/index` watcher invalidation. Pass `?profile=true` to get `X-Profile-Ms`. `/api/board/activity?projectId=PRO-N` aggregates project, slice, thread, and subagent activity while rejecting project identifiers that could resolve outside the configured projects root.
- `/api/board/projects` returns `{ items, lifecycleCounts }`. The lifecycle list cold-loads without `?include=done`, keeps cancelled projects visible, uses `lifecycleCounts.done` for the collapsed Done header, and lazy-loads Done cards only after the user expands that bucket.
- `/api/board/projects` enriches each project with `worktrees[]` from cached Space queue data, convention-attributed git worktrees, explicit project README frontmatter declarations (`worktrees: [{"repo":"~/code/yoplai","branch":"feat/example"}]` or path strings), and live subagent runtime state matched by exact `cwd`/worktree path. Git worktree attribution prefers explicit frontmatter, then branch prefixes (`space/<projectId>`, `space/<projectId>/*`, `<projectId>/*`), then active `PRO-*` branch tokens, then active `PRO-*` path tokens. Worktrees that do not match any active project are emitted under the synthetic `__unassigned` board project. Space and git worktrees are deduped by canonical path plus project worker slug, so stale Space paths from older workspace roots still collapse with git-discovered `space/<projectId>/<worker>` entries; set `YOPLAI_BOARD_WORKTREE_DIAGNOSTICS=1` to log raw and canonical source paths during the join. Space cache watcher and subagent change events invalidate the board endpoint cache; live run lookup uses the subagents extension's in-memory `getLiveSubagentRunsByCwd()` helper.
- `/` is the board home when the board extension is configured as `capabilities.home`: `BoardView` with persistent lead-agent chat on the left, `Scratchpad` as the default canvas tab, and `Project lifecycle` as the second tab. The lead-agent default is `localStorage("yoplai:board:selected-agent")` when valid, else top-level `yoplai.json.defaultProjectManager` when it matches a configured agent, else the first visible agent. The lifecycle tab embeds the grouped lifecycle list and opens `BoardProjectDetailPage` inline (Pitch/Slices/Thread/Activity) when a project card is clicked. `/board` remains the standalone lifecycle list route.
- Board-home project lifecycle navigation is an inner canvas swap: embedded project, slice, and tab changes update browser history from inside `BoardView` without router navigation, so the left lead-agent chat stays mounted while `/board/projects/:projectId` and `/board/projects/:projectId/slices/:sliceId` still work after refresh.
- Areas homepage includes a quick-create flow with slugified ids from title and a native color picker
- Area cards show per-status project counts and support inline area editing (`title`, `color`, `order`, `repo`)
- Area title click routes to `/projects?area=<id>`; board header shows selected area + `Back to Areas` link
- Left sidebar nav shell (`LeftNavShell` wrapping `AgentSidebar`) is the single shell for the whole app — it is reused on `/projects`, `/agents`, `/teams`, `/agents/:id/edit`, `/admin/users`, and `/chat/:agentId/:view?` routes for consistent navigation. Nav links: `Agents` is visible to every user; `Teams` is visible only when multi-user forked-agent mode is enabled; `Admin` (→ `/admin/users`) is visible only to admin/superadmin (`hasAdminRole`). The sidebar logo shows custom org branding (`capabilities.branding?.name`/`logo`) when set, else falls back to the default "Yoplai" wordmark — never both.
- Web app fetches `/api/capabilities` on boot; if `projects` is disabled, `/` falls back to the core agent list instead of the Areas route
- Web API client functions are split by domain under `apps/web/src/api/`: `agents`, `chat`, `realtime`, `board`, `projects`, `slices`, `subagents`, `space`, and `media`. `apps/web/src/api/index.ts` is the barrel import for app code, while `client.ts` remains a compatibility re-export for older tests/imports.
- Web realtime client plumbing lives in `apps/web/src/api/realtime-client.ts`: `subscribeToRealtime()` is the browser WebSocket adapter for session/status/project/subagent interests, and `useProjectRealtime()` is the project-scoped helper. `realtime.ts` keeps the older `subscribeToSession`/`subscribeToStatus`/file/subagent wrappers on top of that seam.
- Shared web chat runtime lives in `apps/web/src/lib/chat-runtime.ts`. It owns reusable Solid signal state for pending attachments, streaming blocks, queued lead-agent sends, history loading, session subscriptions, and aborts. Concurrent history loads use latest-request-wins state updates so an older response cannot replace a newer refresh for the same agent/session. `BoardView` uses the full runtime for board lead-agent chat; `ChatView` and `AgentChat` use the shared attachment runtime, with AgentChat keeping its separate lead/subagent send and polling paths for CLI-specific behavior.
- When `/api/capabilities` reports `multiUser: true`, the app gates protected routes behind Better Auth session checks, exposes `/login`, and shows the admin page for `/admin/users` (user list, authorize/reject, and — superadmin-only — role changes and "View as" impersonation)
- `/board` is Board extension lifecycle home route. It renders grouped project list (`ProjectListGrouped`): active + shaping expanded, done + cancelled collapsed, with search, area chips, drag-move, rich card basics.
- `/board/projects`, `/board/projects/:projectId`, and `/board/projects/:projectId/slices/:sliceId` render inside the Board shell so the left chat pane stays mounted while lifecycle navigation changes. `BoardProjectDetailPage` drives project tabs from `?tab=pitch|slices|thread|activity`; nested board slice URLs keep the project header/tab strip visible, force the project tab to Slices, and pass `?tab=specs|tasks|validation|thread|agent` to the inline `SliceDetailPage`. Board-hosted slice detail passes `routeBase="board"` so slice sub-tabs keep generating `/board/projects/:projectId/slices/:sliceId?...` URLs even when rendered from an embedded project canvas. `/projects/:projectId` and `/projects/:projectId/slices/:sliceId` reuse the same Board-style detail through a Projects route adapter, translating internal Board URLs to `/projects/...` while preserving the global left nav and dropping the old Projects detail/right-sidebar layout. **Post-refactor model: slices are kanban unit; projects track lifecycle only (`triage → shaping → active → ready_to_merge → done / cancelled`; archive is location-based under `.archive`).** Project Pitch is a single editable `PITCH.md` surface through `DocEditor`; legacy projects without `PITCH.md` render the body of `README.md` as fallback, while frontmatter still comes only from `README.md`; legacy project-level `SPECS.md` files remain on disk but are ignored by project detail. Thread renders THREAD.md comments as cards plus an add-comment form, with no free-form doc editor. Slices tab embeds `SliceKanbanWidget` (scoped to project). Legacy `ProjectsBoard`/`ProjectsOverview` replaced for board lifecycle surfaces. Slice blocker UI reads `frontmatter.blocked_by` from `/api/projects/:id/slices`; unresolved blocker IDs remain blocking, matching the orchestrator fail-safe.
- Slice detail routes (`/projects/:projectId/slices/:sliceId`) expose a single editable Specs prose surface backed by `SPECS.md`, followed by `TASKS.md`, `VALIDATION.md`, Thread, and Agent tabs. Legacy slices without `SPECS.md` render the stripped `README.md` body as specs fallback; `README.md` remains only the YAML frontmatter carrier and is not a user-facing tab. Thread renders timestamped `THREAD.md` sections as comment cards with markdown bodies and includes a simple add-comment form backed by `POST /api/projects/:id/slices/:sliceId/comments`; project and slice thread textareas submit on Cmd/Ctrl+Enter. Slice doc saves suppress their own websocket refetches briefly so the editor does not remount/scroll-reset while typing. The Recent Runs sidebar shows relative timestamps from `lastActive` or `startedAt` when available.
- Project overview worktree rows combine Space `queueStatus` with live `agentRun.status` into working/failed/conflict/stale/pending/skipped/integrated/idle pills and expand locally to show cwd-filtered runtime subagent runs through `SubagentRunsPanel`. The panel fetches `/api/subagents?cwd=...` only when a worktree is expanded, then lazy-loads normalized logs when a run is expanded and exposes stop/archive/delete controls. The `__unassigned` overview entry is pinned at the bottom, bypasses filters/search, is read-only, and shows active runtime subagents whose `cwd` does not match any real project worktree. Board project overview rows show title/count above area/status. In the Board tab, Pitch/Specs Edit opens the existing project or slice detail editor inline in the right pane with same-URL history close behavior.
- `SPECS.md` split view includes one checklist toggle in the lower pane header that collapses/expands both Tasks and Acceptance Criteria for more document space
- Right context panel shows last 5 recently viewed projects (from `localStorage`) at the bottom, with truncated titles and relative viewed timestamps
- Optional web extension routes are registered through `apps/web/src/lib/web-route-registry.tsx`, which discovers `apps/web/src/extensions/*/routes.tsx` with `import.meta.glob` and filters by `/api/capabilities`; core `App.tsx` must not hard-import board/projects route or component modules, so `pnpm build:web` can pass when optional web extension route files are absent.
- Optional extension route bundles are lazy-loaded and imported only when their owning capability is enabled
- Global quick chat is opt-in via root config `agentFab: true`; when enabled, it is available from a bottom-right floating bubble and opens a route-persistent lead-agent overlay with header agent picker, streaming chat, and image attachment upload support
- Agent `ChatView` file attachments support drag-and-drop with zone feedback on the history pane, composer, and `+` attach button, in addition to the picker button
- Project-detail lead-agent launches persist per-project `sessionKeys`; the UI binds the opened chat to the exact returned project session key instead of the agent's global `main` session
- LeadSession storage now exists for project/slice lead chats: `packages/extensions/projects/src/lead-sessions/store.ts` persists `<projectDir>/lead-sessions.json`, serializes in-process index mutations with atomic renames, lazily migrates legacy README frontmatter `sessionKeys` to deterministic `lead:<projectId>:legacy:<agentId>` records, and keeps transcripts under `<projectDir>/sessions/<transcriptRef>/history.jsonl`. API routes are `GET/POST /api/projects/:id/lead-sessions`, `PATCH/DELETE /api/lead-sessions/:id`, `GET /api/lead-sessions/:id/transcript`, and `POST /api/lead-sessions/:id/messages`; mutations emit `lead_session_changed` over `/ws`. First successful lead-session assistant turns trigger an async one-shot auto-title job when `titleLocked` is false; `extensions.sessions.autoTitleModel` may specify the model, otherwise the gateway picks the cheapest available Anthropic Haiku model and refuses Opus/thinking models.
- Fresh project-detail lead-agent launches now show an immediate pending spinner and render subscribed text/tool activity live while the run is in progress, instead of waiting for final history reload
- Project-detail lead-agent rows support reset/remove actions: remove clears the project `sessionKeys` entry, and reset clears the bound session state then reuses the canonical `project:<id>:<agentId>` key
- Lead-agent reset immediately clears visible chat history without a page reload because lead chat identity now keys on `agentId + sessionKey + sessionNonce`
- Global agent chat can browse/resume past lead-agent sessions: `GET /api/agents/sessions` enumerates user-scoped history JSONL files, sidebar lists recency-grouped sessions across agents, `/chat/:agentId?session=<sessionId>` fetches/subscribes/sends by explicit `sessionId`, and resumed sessions do not move the `main` pointer.
- Access-controlled extension catalog for the Edit-Agent hub: `GET /api/agents/:agentId/extensions` (staff or same-team members in multi-user mode) returns every available extension — built-in static registry (`apps/gateway/src/extensions/registry.ts`) plus a runtime scan of `$YOPLAI_HOME/extensions` (`discoverExternalExtensions`) — each with the agent's enabled state (`agent.extensions[id].enabled !== false`), config JSON-schema (from `Extension.configJsonSchema`, populated by `defineToolExtension` via `zod-to-json-schema`), `requiredSecrets`, a config tier, and (for bespoke extensions) an agent-resolved `configRoutePath`. Discovery is accurate — unloadable built-ins are omitted (no ghosts), each id appears once. Builder + tier logic live in `apps/gateway/src/extensions/catalog.ts`; the Edit-Agent page lists them with a clickable on/off toggle.
- **3-tier config-surface contract (ALG-354):** enabling an extension in the Edit-Agent hub routes to one of three tiers, decided by catalog metadata (`ExtensionCatalogEntry.tier`), so a new extension self-registers a config surface with minimal boilerplate:
  - Catalog entries also report `configured` and value-free `missingConfig`. An enabled but invalid extension is shown as **Needs configuration** and routes to its existing config surface; runtime skips it entirely until configuration is valid.
  - `bespoke-route` — the extension declares an optional agent-keyed `configRoute` (`{ path }`, e.g. `"/agents/:agentId/extensions/mcp"`) on the `Extension` shape / via `defineToolExtension`. The path **must** include the `:agentId` param (mirrors the `:projectId` param used by project extension routes); `resolveAgentConfigRoute(route, agentId)` in `packages/shared/src/types.ts` substitutes the real agent id (url-encoded) into `configRoutePath`, and the hub **redirects there on enable**. The matching client `<Route>` is mounted by the web route registry (`apps/web/src/lib/web-route-registry.tsx`): the existing `WebRouteExtension` self-registration shape gained an optional `configRoute` so an extension's `routes.tsx` can render the redirect target. This is the escape hatch for custom config UI (e.g. `mcp`'s file-based config). Declaring `configRoute` is the _only_ wiring an extension needs — it wins over `auto-form` even if it also exposes a schema.
  - `auto-form` — no `configRoute`, but the extension exposes a _meaningful_ config JSON-schema (properties beyond `enabled`). Enabling **surfaces the schema-driven form path** `/agents/:agentId/extensions/:extensionId/config` (`autoFormPath` in `apps/web/src/api/extensions.ts`). That path renders the **generic auto-form** (`apps/web/src/pages/ExtensionConfigForm.tsx`, mounted as a core route in `App.tsx`): it fetches the one catalog entry (`fetchAgentExtension`), turns the extension's JSON-schema + `requiredSecrets` into form fields via the pure helper `apps/web/src/lib/auto-form-schema.ts` (`buildAutoFormFields` drops the base `enabled` toggle, maps schema types to text/number/boolean inputs, and renders any `requiredSecrets` field as a **masked/password input**), and on submit splits values with `splitAutoFormValues` and writes through the ALG-353 path via `patchAgentExtension` with `{ enabled: true, config, secrets }` — secrets become `$env:` refs in `agent.yaml` with the value in the agent's `.env`, non-secrets persist as plain values in `agent.yaml`, and the extension is enabled. `exa` (single `apiKey` secret) is the tracer auto-form extension. This is the common case.
  - `toggle-only` — no `configRoute` and no meaningful schema. Enabling **flips inline, instant, no redirect.**
  - Tier precedence in `resolveTier` (`catalog.ts`): `configRoute` present → `bespoke-route`; else meaningful schema → `auto-form`; else `toggle-only`. Backend API `routePrefixes` do **not** make an extension bespoke — only a declared `configRoute` (a config _UI_ surface) does. **Disabling** any extension is always an inline flip regardless of tier (turning a config surface off never redirects into it). Routing logic: `toggleExtension` in `apps/web/src/pages/EditAgent.tsx`.
- Extension write path: `PATCH /api/agents/:agentId/extensions/:extensionId` (staff or same-team members in multi-user mode) updates one agent's `config.extensions`. The writer (`apps/gateway/src/extensions/agent-config-writer.ts`) reads the agent's `agent.yaml`, merges the patch (`{ enabled?, config?, secrets? }`) into `extensions.<id>`, re-validates the whole doc against `AgentYamlConfigSchema`, then writes it back atomically (temp file + rename under a `proper-lockfile` dir lock, imported lazily so it doesn't register signal handlers on the server import graph). Secrets are never written as plaintext into `agent.yaml`: each secret field becomes a `$env:NAME` sentinel there (name = `YOPLAI_<AGENT>_<EXT>_<FIELD>`) while the real value is upserted into the agent's workspace `.env`, matching the runtime `resolveEnvRefs` resolver. After a successful write the endpoint calls `reloadConfig()` to invalidate the in-memory config cache so the change takes effect on the agent's next run, and returns the refreshed catalog. Agent config was read-only at runtime before this — this is the only write path into `agent.yaml`.
- Project-detail left-panel lead status dots now reflect real runtime state via `fetchAgentStatuses()` + `subscribeToStatus()` instead of a hardcoded online indicator
- Lead-agent spawn form hides the irrelevant CLI command preview; only custom subagent spawns show CLI preview
- Theme: CSS custom properties on `:root` with `[data-theme="light"]` override. Toggle in sidebar footer. Persisted to `localStorage('yoplai-theme')`, falls back to `prefers-color-scheme`. Flash-prevention inline `<script>` in `index.html`. Signal in `src/theme.ts`.
- Project detail spawn flow supports lead-agent launch plus config-driven subagent prep in the center panel
- UI-created project agents derive their session folder slug from the displayed agent name, so coordinator/worker/reviewer spawns land under stable name-based session directories instead of random ids
- Project API responses now include `repoValid` on both project detail and project list items; it is `true` only when the resolved repo path exists on disk and contains `.git`
- Project subagent run modes: `clone`, `worktree`, `main-run`, `none` (`none` runs without creating a workspace)
- Project detail center-panel subagent chat follow-ups reuse the selected subagent `runMode` to preserve CLI session cwd continuity (important for Claude CLI resume by `session_id`)
- Subagent resume/follow-up turns are delta-only: only the new user message (+ current-turn attachment marker), without re-prepending project summary context
- Project detail center-panel chat keeps `Send` available while a run is active and also shows `Stop`; lead agents stop via `/abort`, subagents stop via `POST /api/projects/:id/subagents/:slug/interrupt` (codex/claude/pi), and queued follow-up subagent messages flush client-side after the active run exits `running`
- Agent chat shows estimated context usage under the input, turns the indicator red at 75%+, and runs context compaction before the next send at 80%+. `/compact` triggers the same compaction manually. Compaction asks the same agent/model to summarize older context, then rewrites Yoplai canonical history and the Pi runtime session to a hidden compacted summary plus the last 8 user/assistant turns.
- Agent `ChatView` full-mode assistant turns preserve emitted chronology for thinking, text, tool calls, and file blocks. Live streams use a block timeline, tool results attach only to their originating tool call, and successful local stream completion appends the streamed turn without re-fetching/re-sorting history.
- Agent `ChatView` uses a centered transcript layout with quiet assistant text, soft user bubbles, compact single-card tool/result blocks, simplified Simple-mode tool rows, sticky blurred chrome, visible focus states, and reduced-motion fallbacks.
- Subagent config updates are supported post-creation via `PATCH /api/projects/:id/subagents/:slug` (`name`, `model`, `reasoningEffort`, `thinking`); `yoplai projects rename` maps to this endpoint and AgentPanel exposes a per-harness model selector when the run is not active.
- Subagent chat polling guards prevent stale interval races on fast panel re-renders/remounts, preserving run-state UI (spinner, Stop visibility, optimistic queued follow-ups, enabled textarea) until meaningful assistant output arrives.
- Project detail center-panel Activity tab intersperses two entry types in one timeline: thread comments (card-style) and synthesized subagent lifecycle events (plain rows). Start rows are concise (`<cli> started.`); completion/error rows can include short outcome snippets from recent subagent logs. Activity rows show compact relative time (`now|Xm|Xh|Xd ago`) appended after the event text.
- Subagent shell tool cards render a warning state when exec/bash output is empty (`No output captured`) instead of appearing as blank success.
- Project UI live refresh is event-driven via `/ws` broadcasts: board project list and slice kanban refetch on project/slice `file_changed` events and subagent lifecycle `subagent_changed` events, project detail refetches on project file changes (`README.md`/`PITCH.md`/`SCOPE_MAP.md`/`THREAD.md`), slice detail refetches on slice file changes, and project subagent panels refetch immediately on `agent_changed` with a 2s polling fallback to recover from missed websocket events. Slice kanban also watches `agent_changed` and `subagent_changed` with a 250ms debounce to keep per-slice green agent-active pills current. The project watcher observes project roots directly and filters markdown files in code so hidden `YOPLAI_HOME` paths such as `.yoplai/projects` still emit slice markdown changes from CLI/orchestrator writes. Board overview deliberately ignores `agent_changed` because running subagent stream logs can emit it several times per second.
- Project and slice detail `Agent` tabs use `AgentRunChatPanel`: one sidebar with `Lead | Subagents` segments and a shared board-style transcript chat. Lead sessions are scoped to project or slice, support `?tab=agent&lead=<id>` deep links, localStorage last-viewed keys (`lead-session:lastViewed:<projectId[:sliceId]>`), `+ New session`, agent picker until the first user message, rename, archive/unarchive, and non-legacy delete. Subagents keep the PRO-258 runtime run behavior with `?run=<runId>`, Stop/Archive/Delete, queued resume messages, and archived runs in the per-segment bottom section. Live refresh uses `lead_session_changed` and `subagent_changed` websocket pulses.
- The global `/api/subagents/:runId/*` compatibility routes accept both native runtime run ids and project-backed synthetic ids (`PRO-123:<slug>`). Interrupt/archive/delete/logs and resume must route synthetic ids through project subagent storage; resume delegates to `spawnProjectSubagent(..., { resume: true })` so stopped project runs can continue from their saved CLI session.
- `SubagentRunsPanel` remains the compact expandable run inspector for project overview worktree rows and the unassigned runtime section; do not reuse it for direct project/slice `Agent` tabs.
- Right-sidebar `ACTIVE PROJECTS` refresh is event-driven; the old unconditional 5s subagent/project polling loop in `AgentDirectory` was removed to avoid shell-wide rerender churn.
- `subscribeToStatus()` now mirrors `subscribeToFileChanges()`: shared `/ws` socket, 1s reconnect-on-close, and `AgentDirectory` refetches lead-agent statuses on reconnect to recover after gateway/tab/network drops.
- Orchestrator worker log API normalizes protocol-runner persisted events from Codex app-server, Pi RPC, and Claude RPC into transcript-friendly `assistant`/`thinking`/`tool_call`/`error` rows while preserving `rawType`; the dashboard renders these normalized rows instead of depending on old subagent log event shapes. ANSI color escapes are stripped from log text at API normalization time.
- Orchestrator `WORKFLOW.md` `agent.provider` is supported for Pi RPC workers and is passed to Pi as `--provider <provider>`; set it with `agent.model` when Pi's default provider may not be configured.
- Orchestrator `WORKFLOW.md` `agent.thinking` is the canonical workflow-owned thinking/reasoning key. It overrides profile defaults for orchestrator-owned protocol runners. Compatibility aliases are `reasoning`, `reasoningEffort`, and `reasoning_effort`; if multiple keys are set, precedence is `thinking`, `reasoningEffort`, `reasoning_effort`, then `reasoning`. Runner mapping: Pi RPC receives `--thinking <off|low|medium|high|xhigh>`, Codex app-server receives the model effort field (`effort` / `reasoningEffort` equivalent; allowed `low|medium|high|xhigh`), and Claude RPC/Claude Code receives `--effort <low|medium|high|xhigh|max>` rather than the older `--thinking` flag. Invalid explicit-runner workflow thinking values fail workflow config load; profile-only workflows validate against the resolved profile runner before runner startup.
- Codex orchestrator runner starts app-server threads with `cwd`, `approvalPolicy: never`, and legacy `sandbox: "danger-full-access"` by default, and mirrors that on `turn/start` via `sandboxPolicy: { type: "dangerFullAccess" }`. This both runs unattended and lets app-server trust/load project-local `.codex` config for the workspace; override with `agent.settings.approvalPolicy` and `agent.settings.sandboxPolicy`/`sandbox` in `WORKFLOW.md`.
- Claude orchestrator runner spawns `claude --print ... --permission-mode bypassPermissions` by default so workers run unattended; override with `agent.settings.permissionMode`/`permission_mode` in `WORKFLOW.md`.
- Coordinator prompts include canonical main repo path plus project Space worktree path for planning/delegation context.
- Worker/reviewer prompts stay scoped to their own run workspace (`clone`/`worktree`/`main-run`/`none`).
- SpawnForm worker prompt preview is mode-aware: when run mode is `clone` or `worktree`, `## Implementation Repository` points to `~/projects/.workspaces/<projectId>/<slug>` (not the main repo path).
- Runner repo lookup for subagent non-`none` modes falls back to area repo (`.areas/<id>.yaml`) when project `frontmatter.repo` is not set.
- Project detail left panel agent list uses card rows with muted last-message excerpts and top-right relative elapsed timestamps; `+ Create new agent` is a minimalist text action placed above the list
- Project detail page is responsive: at `<=768px` it switches to a single-column `Overview | Chat | Activity | Changes | Spec` tabbed layout, moving `AgentPanel` into `Overview`; at `769px-1199px` it keeps the merged center/right tabs with a fixed `280px` left rail
- Project detail blocks new agent creation when `repoValid` is false and shows a clear message: `No repo configured` or `Repo path not found: <path>`
- Project detail exposes inline title editing in the header: a hover/focus edit icon swaps the title for a prefilled input, saves on check/Enter with non-empty validation, and cancels on Escape.
- Project detail exposes `Actions ▾ → Edit repo…` on both `/projects/:id` and `/board/projects/:projectId`; the modal edits project `frontmatter.repo`, keeps invalid paths inline without a toast, allows clearing the repo, and shows a success toast on valid saves.
- Project detail left panel subagent rows support inline rename (click name, save on Enter/blur; Space is treated as input while editing and does not trigger row selection)
- Project detail Changes tab is Space-first: Space queue dashboard, per-worker contribution drill-down, Integrate Now, Rebase on main, and Space-targeted commit/PR actions
- Changes tab surfaces space-level rebase conflicts via `ProjectSpaceState.rebaseConflict`, with a dashboard-level "Fix rebase conflict" action (`POST /api/projects/:id/space/rebase/fix`) after a rebase attempt (`POST /api/projects/:id/space/rebase`)
- Changes tab branch diff header (`Branch: ... → ...` with aggregate +/- stats) is clickable when pending branch diff files exist, and toggles a compact per-file +/- breakdown list
- Space Commit Log rows include relative elapsed commit time (`now`, `1m`, `2h`, `3d`) next to author metadata
- Slice Specs views parse exact `## Tasks` and `## Acceptance Criteria` headings in `SPECS.md`; optional `###` subgroup headings are supported inside both sections
- Coordinator prompt includes a preflight (`command -v yoplai && yoplai projects --version`), concise `yoplai projects start --subagent <name>` delegation examples, a reminder to choose an exact configured subagent name from the injected `## Available Subagent Types` list (or inspect Yoplai config first if none are listed), explicit `yoplai projects status`/`yoplai projects resume` monitoring rules with a foreground poll-loop example, required project status moves (`in_progress` on dispatch, `review` when ready), Space-branch-only integration discipline including `space.json` commit-state updates on manual integration, and a `SPECS.md` formatting reminder for parse-safe Tasks and Acceptance Criteria checklist updates
- Coordinator prompt explicitly forbids self-performing code review; review/verification must be delegated to a reviewer subagent
- Coordinator delegation guidance forbids adding locked flags (`--agent`, `--model`, `--reasoning-effort`, `--thinking`, `--mode`, `--branch`, `--prompt-role`) unless `--allow-overrides` is explicitly set
- Worker prompt explicitly requires committing implementation after checks are green, and post-run comment instructions now use `--author <your name>` (the deprecated Cloud/openclaw follow-up step was removed). Orchestrator-dispatched Worker and Reviewer prompts explicitly require `--author Worker` / `--author Reviewer` for both `yoplai projects comment` and `yoplai slices comment`; slice comments persist author/date metadata in THREAD.md when `--author` is passed.

Proxies `/api` and `/ws` to gateway (port 4000) in dev mode.

### container/agent-runner

Standalone Node 22 package for sandboxed agent containers. It reads `ContainerInput` JSON from stdin, runs Pi SDK turns or Claude CLI turns (`claude --print --output-format json`) inside the container, streams incremental history events on stdout as `---YOPLAI_EVENT---<json>`, and writes final `ContainerOutput` JSON between `---YOPLAI_OUTPUT_START---` / `---YOPLAI_OUTPUT_END---`. Debug logs must go to stderr only. It may import from `@yoplai/shared` and Pi SDK packages but must not import gateway source.

Container OneCLI proxy wiring:

- `apps/gateway/src/agents/container.ts` injects `ONECLI_URL`, `ONECLI_CA_PATH`, `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, and `NODE_TLS_REJECT_UNAUTHORIZED=0` when top-level `onecli` is configured.
- Queued container follow-ups use collision-resistant IPC filenames, and the runner serializes directory scans so each file is delivered at most once even when Pi steering takes longer than the 500ms polling interval.
- Safe top-level `yoplai.json.env` entries are also forwarded into sandbox containers; per-agent `sandbox.env` overlays them afterward.
- Anthropic uses `ANTHROPIC_BASE_URL=<onecli url>`; OpenAI uses `OPENAI_BASE_URL=<onecli url>/v1`.
- The OneCLI CA cert is mounted at `/usr/local/share/ca-certificates/onecli-ca.pem`.
- `container/agent-runner/src/index.ts` configures the exported proxy client before the SDK run and forwards IPC follow-ups to the active run (`deliverAs: "steer"` for Pi, queued follow-up text for Claude CLI one-shot).
- Gateway `apps/gateway/src/sdk/container/adapter.ts` serializes extension prompt/tool metadata into `ContainerInput.extensionSystemPrompts` and `ContainerInput.extensionTools` because the container runner cannot access the gateway extension registry directly.
- Gateway container adapter internals are split under `apps/gateway/src/sdk/container/`: `launch-spec.ts` builds Docker args/mount/upload prep, `protocol.ts` owns stdout framing/decoding, `input-builder.ts` builds `ContainerInput`, `file-output.ts` validates/registers outbound files, and `tool-bridge.ts` serializes extension prompt/tool metadata.
- `ContainerInput.context` carries normalized Slack/Discord channel context into the runner. Both the Pi and Claude container paths append the rendered block to the true system prompt and emit a `system_context` history event before the user turn.
- Container runs bind `$YOPLAI_HOME/agents/<agentId>/data` to `/workspace/data` writable and session upload copies to `/workspace/uploads` read-only. Non-image inbound attachments are listed in the user prompt with their `/workspace/uploads/...` paths, while gateway-side extracted document text is appended when available (PDF/docx/xls/xlsx/csv/txt/md). The runner emits raw `ContainerFileOutputRequest` protocol events (`---YOPLAI_EVENT---{"type":"file_output","path":"/workspace/data/..."}`); the gateway validates that seam, copies the file to `$YOPLAI_HOME/media/outbound`, registers metadata, emits media-backed `FileOutputEvent`, and persists canonical history as `assistant_file`/`FileBlock`.
- Extension tool calls inside the container route back to the gateway through `/internal/tools`. LLM network egress still uses the OneCLI proxy env when configured; CA trust for HTTPS CONNECT tunneling relies on `NODE_EXTRA_CA_CERTS` (set via container env).
- Container extension tool results larger than 20KB are materialized as JSON files under `/workspace/data/tool-results/`; the model receives a compact pointer plus preview so scripts can consume large results by path instead of reserializing JSON through shell commands.
- Gateway calls `ensureWorkspaceFiles(workspaceDir)` on the host before spawning the container, so workspace template files (AGENTS.md, SOUL.md, etc.) are created for new agents even in sandbox mode.
- Docker-backed agent containers use UUID-suffixed names (`yoplai-agent-<agentId>-<uuid>`) so simultaneous runs for the same agent do not collide on Docker `--name`.
- Orchestration callbacks go to `POST /internal/tools`. `apps/gateway/src/sdk/container/tokens.ts` tracks active per-container tokens, and `apps/gateway/src/server/internal-tools.ts` validates them before dispatching subagent/project operations on the gateway side.
- `yoplai-agent:latest` is content-hashed from the agent-runner Docker build context and rebuilt at startup when those inputs drift. Operator-supplied sandbox images are never hash-checked or rebuilt.
- When `onecli.sandbox.network` is configured, the adapter attaches that extra Docker network asynchronously after `docker run` starts. If Docker rejects startup first (for example a missing bind-mount source), gateway logs now surface the captured `docker run` stderr instead of masking it as a network-connect failure.

### packages/shared

Zod schemas and TypeScript types:

- Config types: `AgentConfig`, `GatewayConfig`, `Schedule`, `StreamEvent`
- Modular runtime types: `Component`, `ComponentContext`, `ValidationResult`
- Extension schemas and the tool-extension helper live under `packages/shared/src/types.ts` and `packages/shared/src/tool-extension.ts`
- **OAuth connect framework** (`packages/shared/src/oauth/`, host runtime in `apps/gateway/src/oauth/`): reusable per-agent OAuth seam. In multi-user mode, authorize, status, and disconnect operations enforce the same team-based agent access policy as chat/media routes; the provider callback is authorized by its short-lived state created during the already-authorized start operation. A provider is pure data — an `OAuthProviderDescriptor` (authorize/token/userinfo URLs, default scopes, authorize params, account extractor) in `providers.ts`; the Google descriptor is the first entry. Client credentials come from a pluggable `OAuthCredentialSource`; BYO (operator supplies client id/secret via `oauth.providers.<id>` in config, `$env:` refs resolved) is mode one. The host exposes `GET /api/oauth/:provider/authorize?agent=<id>` (redirects to the provider with state + PKCE) and `GET /api/oauth/:provider/callback` (exchanges the code, fetches the account label, persists tokens), plus `/status` and `/disconnect`. Connections are stored file-backed under `$YOPLAI_HOME/oauth/`, scoped to a single (agent, provider) pair (not per-user). Extensions declare `oauth: { provider, scopes }` in `defineToolExtension`; the extension runtime injects a `resolveOAuth` hook into the extension hook context, and at `getAgentTools`/`getSystemPromptContributions` time the resolved `config.oauth` carries a fresh access token (`{ connected: true, accessToken, account, scopes }`) or a structured not-connected signal (`{ connected: false, reason, authorizeUrl, message }`) — never a raw secret, never a thrown 401. **Connection reliability (ALG-360):** access tokens refresh silently while the refresh token is valid (`resolveToken` refreshes within a 60s skew of expiry via `refreshAccessToken`), so agents never see an expired token. A stored connection has a lifecycle `status` and the service exposes a three-state machine via `getConnectionState`: `connected` / `needs_reconnect` / `disconnected`. An unrecoverable refresh failure (4xx `invalid_grant`, or an expired token with no refresh token) flips the connection to `needs_reconnect` (retained, not deleted) so the UI can prompt a one-click reconnect; transient failures (network/5xx) keep the still-usable grant. `resolveToken` then returns `reason: "needs_reconnect"` instead of a cryptic error. `/status` returns a first-class `state` field; `disconnect` best-effort revokes the grant at the provider (`revokeUrl`, RFC 7009) before clearing the local record, leaving `disconnected`. The `/connections` web UI renders `needs_reconnect` as a distinct badge with Reconnect + Disconnect actions. **Adding a new provider (e.g. Gmail read-only) is a new descriptor + a BYO client — no changes to the authorize/callback/token-store/resolver machinery.** The `googleDrive` external extension is the first consumer: a single `validate` tool that hits Drive `about` with the injected token. **Tokens at rest (ALG-359):** the file-backed store encrypts token fields (access + refresh) with AES-256-GCM (`apps/gateway/src/oauth/crypto.ts`) before persisting, so a leaked `$YOPLAI_HOME/oauth/*.json` row is ciphertext (`enc:v2:...`), not a live grant. The AES key is derived (scrypt, per-ciphertext salt) from `oauth.encryptionKey` in instance config (`$env:` ref supported, e.g. `$env:OAUTH_ENCRYPTION_KEY`); when unset the store falls back to plaintext and logs a startup warning (dev-only). Legacy plaintext rows still read and are re-encrypted on next save. Operator setup — enabling the Drive API, the consent screen + read-only scope, registering the per-deployment callback URL, and the client/encryption config — is documented in [`docs/oauth-google-drive-setup.md`](./oauth-google-drive-setup.md).
- Browser consumers must import browser-safe subpaths like `@yoplai/shared/types`, `@yoplai/shared/model-context`, and `@yoplai/shared/projectPrompt` instead of the package root, which also re-exports Node-only helpers
- `pnpm update-models` refreshes `packages/shared/src/model-context-data.json` from OpenRouter context lengths for models referenced in `yoplai.json`, v3 `agent.yaml` files discovered from `yoplai.json` `agents`, and `$YOPLAI_HOME/models.json`; any configured model missing from OpenRouter falls back to `https://models.dev/api.json`. `models.json` `contextWindow` values are preserved for custom models/overrides.
- Shared protocol schemas and constants live alongside the types: `HistoryEventSchema`, `StreamEventSchema`, `ContainerRunnerProtocolEventSchema`, `ContainerFileOutputRequestSchema`, `ContainerInputSchema`, `ContainerOutputSchema`, `CONTAINER_EVENT_PREFIX`, `CONTAINER_OUTPUT_START`, and `CONTAINER_OUTPUT_END`.
- History types: `SimpleHistoryMessage`, `FullHistoryMessage`, `ContentBlock` (thinking/text/toolCall/file), `ModelMeta`, `ModelUsage`. Canonical history uses `assistant_file` for persisted downloadable files; `file_output` is only a WebSocket stream event or a raw container runner request, depending on schema.
- API payloads and WebSocket protocol types
  - Projects payloads expose `repoValid` so the UI can block run creation when the resolved repo is missing or not a git repo
  - Coordinator prompts include the canonical repo root as read-only context and explicitly require workers to stay in dedicated worktrees/workspaces, never the main repo, unless explicitly required

### packages/extensions/projects

Projects extension. Owns project APIs, project subagent orchestration, and the gateway-mounted `yoplai projects` command.

- Remote project/subagent commands talk to the gateway API over HTTP.
- Local projects config commands (`yoplai projects config migrate`, `yoplai projects config validate`) read/write `yoplai.json` directly and only cover v1 -> v2 component-entry migration. Agent-folder migration is `yoplai agents migrate` (v2 centralized `agents[]` -> v3 per-agent `agent.yaml`); top-level help shows `agents`, then `yoplai agents --help` shows `migrate`.
- Env URL precedence for HTTP commands: `YOPLAI_API_URL` > `YOPLAI_URL` > `$YOPLAI_HOME/yoplai.json` (`apiUrl`, default home `~/.yoplai/`)
- Token precedence for HTTP commands: `YOPLAI_TOKEN` > `$YOPLAI_HOME/yoplai.json` (`token`, default home `~/.yoplai/`)
- Local config path precedence: `--config` > `$YOPLAI_HOME/yoplai.json` (legacy fallback: derive home from `YOPLAI_CONFIG`)
- Gateway/web dev entrypoints now honor `YOPLAI_HOME`, so `pnpm dev` and `pnpm dev:web` preview the same config home as local config commands
- `yoplai projects --help` hides deprecated agent-management helpers; project-agnostic runtime run management is documented under `yoplai subagents`.
- `yoplai projects create --help` only advertises active create flags (`--title`, `--pitch`, `--status`, `--area`, `--json`); positional `<pitch>` and `--pitch <text|@file|->` write `PITCH.md`, while project-level `--specs` is hidden and rejected with a migration hint. `yoplai projects pitch <PRO-N> --from-readme [--force]` copies the stripped legacy `README.md` body into `PITCH.md`.
- Project-agnostic subagent runtime commands live under the main gateway CLI: `yoplai subagents start|profiles|list|status|logs|resume|interrupt|archive|unarchive|delete`.
- `yoplai subagents profiles` reads local config only and lists `extensions.subagents.profiles[]` as `name cli model type runMode`; `--json` prints the raw profiles array.
- Runtime `--profile <name>` resolves `extensions.subagents.profiles[]` first, then top-level `subagents[]` templates. Both config surfaces use `cli` (`codex`/`claude`/`pi`) for the CLI harness; top-level templates keep `reasoning` while runtime profiles can carry `reasoning`/`reasoningEffort`. Unknown profile names fail with a profile-specific 400 error instead of falling through to missing CLI validation.
- Subagent runtime profile resolution is centralized in `packages/extensions/projects/src/profiles/resolver.ts`. It owns extension-vs-legacy profile precedence, legacy template mapping, run mode normalization, and CLI model/reasoning/thinking defaults used by project runs, orchestrator dispatch, runtime subagent APIs, and gateway profile listing.
- Project subagent run storage is centralized in `packages/extensions/projects/src/subagents/run-store.ts`. `SubagentRunStore` locates `sessions/<slug>` run dirs, lists summaries, reads config/state/progress detail, derives status from terminal state/history/live PID checks, appends history, updates state, toggles archive flags, deletes run dirs, and wraps legacy session migration; runner and API modules use this seam instead of reconstructing session files independently.
- Project subagent runner harness/workspace responsibilities are split behind adapters: `subagents/harness-adapter.ts` owns Codex/Claude/Pi executable resolution, CLI args, and native session-id extraction; `subagents/workspace-adapter.ts` owns `none`/`main-run`/`worktree`/`clone` workspace preparation, repo validation, Space lease release, delivery recording, and kill cleanup. `spawnSubagent()` remains the persistence/process orchestration layer.
- Project document storage is centralized in `packages/extensions/projects/src/projects/document-store.ts`. It owns project/slice layout constants, Markdown/frontmatter formatting, thread parsing/editing, project location across active/`.done`/`.archive`, lifecycle status validation, repo inheritance invariants, slice locks, atomic writes, and generated `SCOPE_MAP.md`; `store.ts` and `slices.ts` delegate these document-model rules while keeping API-facing CRUD signatures stable.
- Projects orchestrator v0.3 (post kanban-slice-refactor) is opt-in via `extensions.projects.orchestrator`. **Config key is a historical artifact** — the key stays at `extensions.projects.orchestrator` to avoid backward-compat breaks even though the dispatcher now operates on slices, not projects. `orchestrator/dispatcher.ts` is the tick coordinator; deeper seams live in `dispatch-policy.ts` (`SliceDispatchPolicy` status/blocker/concurrency decisions), `prompt-factory.ts` (`OrchestratorPromptFactory` Worker/Reviewer/Merger prompt construction), and `run-planner.ts` (`OrchestratorRunPlanner` profile resolution, slugs, worker workspace selection, integration branch spawn inputs). When enabled, the daemon polls at `poll_interval_ms`, enumerates slices per configured status bindings, and dispatches only against slices whose parent project is `active`. Slices under `shaping`/`done`/`cancelled` projects are visible on the board but not dispatched. Each tick first reconciles running orchestrator subagents with their slice status and interrupts stale runs (`Worker → in_progress`, `Reviewer → review`, `Merger → ready_to_merge`); legacy runs without `sliceId` are ignored. Worker spawns move slice `todo → in_progress`; orchestrator Worker `clone`/`worktree` runs ensure and fork from the project integration branch `<projectId>/integration` instead of the runner's `main` fallback. Failed Worker spawn attempts revert the slice to `todo` and record cooldown. Cooldown and dedupe are keyed by `sliceId` (not `projectId`) so one failing slice does not block siblings. Slices with `blocked_by` only dispatch when every blocker resolves globally to `done`, `ready_to_merge`, or `cancelled`; missing blocker IDs remain blocking. Reviewer spawns leave slice in `review`, use the most-recent existing orchestrator Worker workspace for that `sliceId`, and move slice `review → ready_to_merge` (pass) or `review → todo` with a THREAD.md gap comment (fail). Missing worker workspace paths are pruned before reviewer prompt assembly; if no workspace remains, the Reviewer is skipped and the slice returns to `todo` unless a live Worker run still exists. Reviewer failures, stall comments, and Merger conflicts emit in-memory HITL burst events; the daemon batches them for 60s or 5 events, then sends one `yoplai notify` message to the configured `hitl_channel` (which is optional; when set it must reference an existing `notifications.channels` key). When `notify_channel` is set, each tick also checks project integration branches for commits ahead of `main` and sends one daily `yoplai notify --channel <channel> --message <digest>` ping for projects with `done` slices ready for manual main merge; the in-memory daily gate resets when integration is no longer ahead. Merger spawns run for `ready_to_merge`, default to two concurrent runs when `max_concurrent` is omitted, fork from `<projectId>/integration`, merge the latest Worker branch, move the slice to `done` on success, and record `merger_conflict` metadata plus a Merger comment on irrecoverable conflict/validation failure; Merger comments are only a fallback and do not downgrade explicit `merger_outcome` metadata. A ready-to-merge slice with current Merger conflict metadata is parked and will not respawn another Merger until humans move it away from `ready_to_merge`, which clears the metadata. The daemon also detects `in_progress`/`review` slices older than `stall_threshold_ms` (default 30 minutes) with no live subagent run for that slice, logs `action=stall_detected`, and appends one Orchestrator comment to the slice THREAD until the status changes or a new last-run key appears. Manual subagent runs default to `source: "manual"`, do not count against orchestrator concurrency, but do count as live runs for stall detection when they carry the matching `sliceId`. Project auto-transitions to `done` when all child slices are terminal (`done`/`cancelled`) and ≥1 is `done`.
- Project shaping pipeline runs as a second orchestrator phase configured by `extensions.projects.orchestrator.shaping_statuses` (ordered `shaping:<stage>` keys with `profile`, `max_concurrent`, optional `stall_threshold_ms`). Profiles with `type: "shaper"` dispatch at project level (no `sliceId`) when a project's status matches the key; only one shaper runs per project. Prompts load from `.yoplai/prompts/<ProfileName>.md` with `${variable}` substitution and fail on unresolved variables, falling back to a built-in stage prompt. Project moves stamp `last_status_change_at`; stale shaping stages receive an Orchestrator project THREAD comment and move to `shaping:blocked`. Board lifecycle mapping groups any `shaping:*` under Shaping and cards show the sub-status badge. Moving to `shaping` or any `shaping:*` status requires strict project frontmatter `repo`; area-inherited repo does not satisfy this guard, so board drag/drop and `yoplai projects move` return `Cannot move project to Shaping: project repo is not set.` when it is missing.
- Project integration branch helper: `packages/extensions/projects/src/projects/branches.ts` exports `ensureProjectIntegrationBranch(repo, projectId)`, which idempotently creates local branch `<projectId>/integration` from `refs/heads/main` and never fetches, pushes, tracks remotes, or rebases an existing integration branch.
- **Slice CLI surface** (`yoplai slices <verb>`) — `add --project <PRO-XXX> "<title>" [specs] [--specs <text|@file|->] [--repo <abs path>]`, `list [--project] [--status]`, `get <sliceId>`, `move <sliceId> <status>`, `rename <sliceId> "<title>"`, `block <sliceId> --on <blockerId>[,<blockerId>...]`, `unblock <sliceId> [--from <blockerId>[,<blockerId>...]]`, `comment <sliceId> [--author <name>] "<body>"`, `merger-conflict <sliceId> "<summary>"`, `specs <sliceId> --from-readme [--force]`, `cancel <sliceId>`. New slices write specs prose to `SPECS.md`; `README.md` is frontmatter-only unless an explicit README body is supplied by lower-level APIs. Legacy slices without `SPECS.md` fall back to the stripped `README.md` body until migrated. Every mutation regenerates `SCOPE_MAP.md` atomically. Status enum: `todo | in_progress | review | ready_to_merge | done | cancelled`.
- Slice repo invariant: a slice must have a repo directly or inherit `project.frontmatter.repo`. `yoplai slices add`, `POST /api/projects/:id/slices`, and slice update reject empty `slice.repo` when the project has no repo; clearing `project.repo` rejects while any slice lacks its own repo. Empty and whitespace-only repo strings normalize to unset. Existing invalid data is grandfathered until its next create/update mutation.
- Project root resolution is extension-first: `extensions.projects.root` is canonical; deprecated top-level `projects.root` is fallback only. Slice CLI, board routes, project stores, migration, and orchestrator must discover gateway-created slugged project directories via the canonical root.
- **`yoplai projects migrate-to-slices`** — idempotent migration. Wraps each legacy project's `SPECS.md`/`TASKS.md`/`VALIDATION.md` into `slices/<PRO-XXX-S01>/`, generates `SCOPE_MAP.md`, maps legacy project statuses to the new project lifecycle enum + default slice status per spec §10.1. At read/create/update time, legacy `maybe`/`not_now` normalize to `triage`, while `todo`/`in_progress`/`review` normalize to `active`. Refuses to run while gateway is detected running.
- **Project ID allocation** — `projects.json` stores the last allocated numeric ID. Creation is serialized in-process and reconciles that counter with project directories under active, `.done`, `.archive`, and `.trash` roots before reserving the next ID, so concurrent creates and stale counters cannot reuse an existing `PRO-N`.
- **Slice data model** — slices live at `<projectDir>/slices/<PRO-XXX-Snn>/` with `README.md` (YAML frontmatter: `id`, `project_id`, `title`, `status`, optional `blocked_by`, `hill_position`, `created_at`, `updated_at`), `SPECS.md`, `TASKS.md`, `VALIDATION.md`, `THREAD.md`. Per-project counter at `<projectDir>/.meta/counters.json` (`lastSliceId`); allocation heals missing/stale counters from the highest slice directory found under `slices/` before creating the next ID. `SCOPE_MAP.md` is auto-generated — do not edit by hand.
- **Project lifecycle** (post-refactor) — valid project statuses are `triage | shaping | active | ready_to_merge | done | cancelled` plus `shaping:<lowercase-stage>` sub-statuses; archive is separate location state under `.archive`. New projects default to `triage` unless an explicit status is provided. Projects are containers; slice kanban tracks execution. Orchestrator only dispatches active-phase slices for `active` projects; shaping sub-statuses dispatch project-level shapers. Auto-done fires when all child slices reach terminal status and ≥1 is `done`. Cancellation cascades: non-terminal slices flip to `cancelled`.
- **SubagentRun attribution** — `state.json` gains optional `projectId` and `sliceId`. Legacy run files untouched. New runs always populate both. `isActiveOrchestratorRun` lookup filters by `sliceId` with `cwd` fallback for legacy runs. Worktree path for orchestrated slices: `<worktreeDir>/<PRO-XXX>/<PRO-XXX-Snn>-<slug>/`.

## Runtime Data

All stored under `YOPLAI_HOME` (default `~/.yoplai/`):

- `yoplai.json` - Main config (agents, server, scheduler)
- `models.json` - Custom model providers (Pi SDK format; read directly by Pi SDK)
- `webhook-secrets.json` - Generated per-agent webhook URL secrets
- `agents/<id>/cron/jobs.json` - Per-agent schedule jobs; run outputs in `agents/<id>/cron/output/`
- `agents/<id>/dreams/` - Dream journals, successful-run state, and staged session transcripts
- `projects.json` - Project ID counter (`{ lastId }`)
- `sessions.json` - Logical session key -> runtime sessionId mapping with timestamps
- `history/*.jsonl` - Yoplai canonical chat transcripts. The history API, web UI, Langfuse, compaction, system context rows, attachment/file blocks, and gateway-owned metadata read this normalized store.
- `sessions/*.jsonl` - Pi SDK runtime session files. These are SDK-owned resume/session state, not the primary UI/API transcript source. Yoplai may backfill `history/` from these files for old sessions or fall back to them when a Pi turn is still streaming and canonical history has not flushed yet.
- `auth.db` - Better Auth + multi-user SQLite database; only created when `multiUser.enabled: true`
- `sessions/users/<userId>/sessions.json` - Per-user session mapping file when multi-user mode is enabled
- `sessions/users/<userId>/claude-sessions.json` - Per-user Claude session map when multi-user mode is enabled
- `sessions/users/<userId>/history/` - Per-user conversation history directory when multi-user mode is enabled; single-user history files live in `sessions/*.jsonl` beside `sessions.json`
- `sessions/subagents/runs/<runId>/` - Project-agnostic CLI subagent run data (`config.json`, `state.json`, `progress.json`, `logs.jsonl`, `history.jsonl`); concurrent starts reserve labels per parent so the documented label-uniqueness invariant cannot race
- (Pi SDK) auth/settings files under `YOPLAI_HOME` (created after a successful agent run)
  - `yoplai.json` itself is required and is **not** auto-created
- Repo-local dev helper: `pnpm init-dev-config` writes `./.yoplai/yoplai.json` from `scripts/config-template.json` using the first free UI port in `3001-3100` and the first free gateway port in `4001-4100`
- pnpm v11 build-script approvals live in `pnpm-workspace.yaml` `allowBuilds`; native/dev dependencies (`better-sqlite3`, `esbuild`, `koffi`, `protobufjs`) must be explicit booleans so `pnpm install` and script runs do not fail with `ERR_PNPM_IGNORED_BUILDS`

## Config Schema

```typescript
{
  version?: number,              // absent = legacy v1; startup auto-migrates to v2 in memory
  defaultProjectManager?: string, // Optional agent id used as board-home/project lead default; invalid ids warn once and fall back to first agent
  agents: [{
    id: string,
    name: string,
    description?: string,        // Short agent description for UI
    avatar?: string,             // Emoji, image URL, or path relative to workspace
    workspace: string,           // Agent working directory (~ expanded)
    sdk?: "pi"|"claude"|"openclaw",  // Default: pi
    model: {
      provider?: string,         // Required for Pi SDK; optional for Claude
      model: string,
      base_url?: string,         // API proxy URL (Claude SDK only)
      auth_token?: string        // API auth token (Claude SDK only, overrides env)
    },
    auth?: {                     // Auth config (Pi SDK)
      mode?: "oauth"|"api_key"|"proxy",
      profileId?: string         // e.g. "anthropic:default"
    },
    reasoning?: "off"|"minimal"|"low"|"medium"|"high"|"xhigh",  // Primary lead-agent thinking config
    thinkLevel?: "off"|"minimal"|"low"|"medium"|"high"|"xhigh", // Deprecated alias
    queueMode?: "queue"|"interrupt",  // Default: queue
    discord?: { token, applicationId?, dm?, groupPolicy?, guilds?, historyLimit?, replyToMode?, broadcastToChannel?, showToolCalls?, ... },
    webhooks?: Record<string, { prompt: string, langfuseTracing?: boolean, signingSecret?: string, verification?: { location: "header"|"payload", fieldName: string }, maxPayloadSize?: number }>,
    heartbeat?: { every?, prompt?, ackMaxChars? },
    introMessage?: string,           // Custom intro for /new (default: "New conversation started.")
    extensions?: Record<string, {
      enabled?: boolean
      // extension-specific per-agent overrides
    }>,
    sandbox?: {
      enabled?: boolean,             // Default: false
      image?: string,                // Default: yoplai-agent:latest
      network?: string,              // Inherits top-level sandbox.network.name
      memory?: string,               // Default: 2g
      cpus?: number,                 // Default: 1
      maxRunTime?: number,           // Default: 1800 seconds
      timeout?: number,              // Legacy alias; used as fallback if maxRunTime is unset
      workspaceWritable?: boolean,   // Default: false
      env?: Record<string, string>,
      mounts?: Array<{ host: string, container: string, readonly?: boolean }>
    }
  }],
  sandbox?: {
    sharedDir?: string,
    network?: { name?: string, internal?: boolean },  // Defaults: yoplai-agents, true
    onecli?: { enabled?: boolean, url: string, caPath?: string },
    mountAllowlist?: {
      allowedRoots: string[],
      blockedPatterns?: string[]      // Default: .ssh, .gnupg, .aws, .env
    }
  },
  extensions?: Record<string, unknown>, // extension-specific config; use extensions.projects.root for project storage
  extensionsPath?: string,              // external extension directory; default $YOPLAI_HOME/extensions
  server?: { host?, port?, baseUrl? },
  gateway?: { host?, port?, bind? },  // bind: loopback|lan|tailnet
  sessions?: { idleMinutes? },        // Default: 360 (6 hours)
  notifications?: {
    channels?: Record<string, { discord?: string, slack?: string }>
  },
  onecli?: {
    enabled?: boolean,                // Default: false
    mode?: "proxy",                   // Default: "proxy"
    dashboardUrl?: string,
    gatewayUrl: string,
    ca?: { source: "file", path: string } | { source: "system" },
  },
  web?: { baseUrl? },
  projects?: { root? },            // Deprecated fallback; prefer extensions.projects.root
  ui?: { enabled?, port?, bind?, tailscale? }  // enabled: default true; bind: loopback|lan|tailnet; tailscale: { mode: off|serve }
  // Note: tailscale.mode=serve requires gateway.bind and ui.bind to be loopback
}
```

OneCLI notes:

- Use top-level `onecli` for native gateway/proxy wiring.
- Native OneCLI mode routes traffic through the OneCLI gateway with `HTTP_PROXY`/`HTTPS_PROXY`.
- Per-agent OneCLI tokens are set via `agent.onecliToken` (usually `$env:...`).
- `onecli.ca` controls CA trust propagation for TLS interception.

## Multi-User Mode

- Enable with top-level `multiUser.enabled: true`. When disabled, gateway skips Better Auth setup, SQLite creation, auth middleware, and per-user storage paths.
- Better Auth mounts on `/api/auth/*` with Google OAuth and cookie sessions. `GET /api/me` returns the current user plus assigned agent IDs. Admin-only APIs live under `/api/admin/users`, `/api/admin/teams`, and `/api/admin/forks`. Roles are `user` / `admin` / `superadmin`: admins can approve/reject users; only superadmins can change roles or start "View as" impersonation (`requireSuperadmin` on `/admin/impersonate/start`).
- Teams are a first-class entity backed by a `teams` table (`id`, unique `name`, `description`, nullable `color`/`icon`, `createdBy`, `createdAt`). Admins mutate them via `POST/PATCH/DELETE /api/admin/teams` (guarded by `requireAdmin`); any authenticated user lists them via `GET /api/teams`. Unset color/icon fall back to grey and a generic Font Awesome team icon. `DELETE /api/admin/teams/:id` returns `{ deleted, teamlessUsers, teamlessAgents }`; `teamlessUsers` resolves from real membership (users whose only team is the one being deleted) and `teamlessAgents` lists the fork agent ids assigned to the team (their team link is cleared by the `ON DELETE SET NULL` FK — the forks persist teamless/inert). The web Teams page (`/teams`) lists teams and gives admins a create/edit modal (name, description, color picker, Font Awesome icon picker) plus a delete confirmation, and the team detail view lists the team's assigned agents.
- Missing root `pool` means non-forked agent mode: gateway defaults `agents` discovery to `$YOPLAI_HOME/agents`, exposes `forkedAgents: false` in `/api/capabilities`, hides Teams/fork/pool UI, and fails startup clearly if `$YOPLAI_HOME/agents` is absent. Present but empty/invalid `pool` enables forked-agent mode and fails pool validation instead of falling back.
- Pool agent → team assignment forks a read-only pool agent into a writable, runnable copy. An `agent_forks` table records the provenance link `sourcePoolId → forkAgentId → teamId` plus who/when (`createdBy`/`createdAt` for the fork, `assignedBy`/`assignedAt` for the latest team link). `sourcePoolId` is UNIQUE (a pool definition forks at most once), `forkAgentId` is UNIQUE (a fork is one agent), and `teamId` is nullable with an `ON DELETE SET NULL` FK to `teams` (unassign / team-delete leaves the fork teamless/inert, never deleted). The fork id matches `<poolId>`, is stable across reassignment (the folder never moves — only the link's `teamId` changes), and equals the fork folder basename the config loader requires. If copying or validating a new fork fails before its provenance row is written, the partial folder is removed so assignment can be retried after correcting the pool definition. The **fork + assignment deep module** (`forks.ts`) exposes `forkAndAssign(poolId, teamId, by)` (copies the pool workspace into `$YOPLAI_HOME/agents/<forkId>` on first assignment, excluding `.env`/`data`/`uploads`, rewrites the copied `agent.yaml` `id:` line to the fork id, writes the link, and reloads config so the fork is discovered by the `agents` glob), `reassign` (moves the single fork's link to another team), and `unassign` (clears the team link). Fork-once is enforced by reusing an existing fork rather than re-copying. Admin API: `GET /api/admin/forks`, `POST /api/admin/forks/assign` (`{ poolId, teamId }`), `POST /api/admin/forks/:poolId/reassign` (`{ teamId }`), `POST /api/admin/forks/:poolId/unassign` — all guarded by `requireAdmin`; `GET /api/teams/:teamId/agents` lists a team's forks (global visibility). The pool catalog (`/`, `AgentCatalog`) shows admins an "Assign to team" picker (or "Move to team…" with a "will move from previous team" warning when a fork already exists). Forks are written into the agents folder (`$YOPLAI_HOME/agents/<forkId>`) so the standard `agents` glob discovers them like any hand-authored agent — no separate forks glob needed.
- Team-based chat access resolver. Chat access is derived from team membership, not the legacy `agent_assignments` allowlist (which is no longer read as an access source). The **access resolver deep module** (`access.ts`) is a pure membership resolver: `canUserChatAgent(userId, forkAgentId)` is true iff the fork's (non-null) team is one the user belongs to; `getVisibleChatAgents(userId)` returns the union of chattable fork agent ids across the user's teams (sorted, empty for a teamless user). Because a fork holds exactly one team link, "share ≥1 team" reduces to "the fork's team is in the user's team set", which makes teamless-user and teamless-fork both resolve to no access automatically. Staff bypass (admin/superadmin → chat anything) is layered on by the callers that hold the role: `hasAgentAccess` (`middleware.ts`) delegates to `canUserChatAgent`, and `getAgentFilter` (`index.ts`) filters the agent list through `getVisibleChatAgents`; both short-circuit to allow-all for staff and for single-user mode (no multiUser runtime). `deleteTeam` reports the real soon-to-be-teamless users (`usersOnlyInTeam`) and agents. One-shot bootstrap migration (`migrateAssignmentsToTeams` in `db.ts`, guarded by a `schema_migrations` marker) converts each legacy `agent_assignments` agent into one team named `Migrated: <agentId>`, adds its assigned users as members, and writes an `agent_forks` link (keeping the original id as both `sourcePoolId` and `forkAgentId`) so pre-teams installs keep exactly their prior access; it runs exactly once and is a no-op on fresh installs.
- Pool catalog action states. The **pool-catalog resolver deep module** (`catalog.ts`) isolates the branchy per-card presentation logic from the backend access work: `resolvePoolAction(poolId, { id, isStaff })` returns `{ poolId, forked, chatAgentId, action, reason, teamName }` where `action` is one of `chat` (a fork exists, its agent is discoverable/runnable by the gateway config loader, and the user may chat it — they share the fork's team, or they are staff; `chatAgentId` is the fork agent id to route to), `assign_to_team` (no fork yet AND the user is staff), or `none` (visible-but-inert: teamless fork, unshared team, an unforked pool agent for a non-staff user, or a fork whose agent folder is no longer discoverable on disk, e.g. renamed/removed). `reason` is non-null only when `action === "none"` and is one of `no_workspace` (the fork's agent folder isn't discoverable on disk), `unassigned` (no fork yet, or a teamless fork), or `other_team` (a non-member viewing a fork assigned to a different team); `teamName` carries the fork's team display name for the `other_team` case (and for an admin viewing a `no_workspace` fork), null otherwise. It reuses the pure `access.canUserChatAgent` for the membership rule and layers the staff bypass on top (staff always get `chat` for any existing fork, even a teamless one, and `assign_to_team` for an unforked pool agent) — the runnability check runs first, since even staff cannot chat an agent the config loader can't find. The resolver takes an `isAgentRunnable(agentId)` dep (wired to `ctx.getAgent`) and a `getTeamName(teamId)` dep (wired to `teams.getTeam`) to compute these. Any authenticated user reads their per-user action states via `GET /api/pool-actions` (`{ actions: PoolCatalogEntry[] }`, one entry per pool agent in config order); the route resolves `isStaff` from the caller's role via `hasAdminRole`. Visibility stays global — the pool endpoint (`GET /api/pool`) still lists every agent to everyone; only the resolved action is gated. The web pool catalog (`/`, `AgentCatalog`) drives each card off this: Chat link (to `chatAgentId`) for `chat`, and a reason-specific message for both `none` and `assign_to_team` ("This agent has no workspace." for an admin viewing a broken workspace, "This agent has not been assigned to a team." when unassigned — including an admin's unforked `assign_to_team` card — or "<team name> Team" for a non-member viewing another team's agent). Team assignment itself now lives on the Edit-Agent page (reached via the admin edit icon), not an inline card picker.
- Edit-Agent entry point. In forked-agent mode, staff and members who can chat an agent get an edit affordance on its pool catalog card; in non-forked mode every authenticated user can open the runnable agents they already access. The link targets `/agents/:agentId/edit`, where `EditAgent` (mounted inside the unified `LeftNavShell`) reads the pool via `fetchPool()` only when `forkedAgents` is true and otherwise reads runnable agents via `fetchAgents()`. The page identifies the target agent, renders its name/role/avatar and extension catalog, and lets staff or same-team members manage extension configuration. Team assignment controls remain staff-only.
- User↔team membership is a many-to-many relation backed by a `team_members` table (`teamId`, `userId`, `addedBy`, `addedAt`; composite PK `(teamId, userId)`; FKs to `teams`/`user` with cascade delete, plus an index on `userId`). A user may belong to many teams and a team may hold many users. The membership deep module (`membership.ts`) exposes idempotent add (`ON CONFLICT DO NOTHING`), remove, `listTeamsForUser`, `listUsersForTeam`, and `usersOnlyInTeam` (the teamless-set source used by `deleteTeam`). Admins add/remove members via `POST /api/admin/teams/:teamId/members` (body `{ userId }`, 404 for a missing team/user, idempotent 200 on re-add) and `DELETE /api/admin/teams/:teamId/members/:userId`; both are guarded by `requireAdmin`. Any authenticated user reads a team's members via `GET /api/teams/:teamId/members` (global visibility). The Teams page adds a per-team members view: everyone can open it to see members, admins get an add-user picker and per-member remove controls.
- Startup flow:
  1. Gateway loads config and checks `multiUser.enabled`
  2. If enabled, it creates `$YOPLAI_HOME/auth.db`, runs Better Auth migrations, creates the custom `agent_assignments`, `teams`, `team_members`, and `agent_forks` tables, and initializes the auth runtime before binding the HTTP listener
  3. `/api/*` requests require a valid approved session except `/api/auth/*`; `/ws` upgrades are rejected without a valid session
  4. First OAuth user is promoted to `admin`; later allowed-domain users start as unapproved `user`
- Per-user file isolation:

```text
$YOPLAI_HOME/
├── auth.db
├── yoplai.json
└── sessions/
    └── users/
        └── <userId>/
            ├── sessions.json
            ├── claude-sessions.json
            └── history/
```

- Web UI changes in multi-user mode:
  - `/login` shows the Google sign-in entrypoint
  - `AuthGuard` redirects unauthenticated users away from protected routes
  - Sidebar shows account metadata + logout action
  - Admin/superadmin users get an `Admin` nav link to `/admin/users` (user list, authorize/reject; role changes and "View as" are superadmin-only)
- There is no migration path from an existing single-user data directory into per-user ownership. Enabling multi-user mode is a fresh start for auth-owned state.

### Bearer-token API auth

Multi-user mode also accepts `Authorization: Bearer <token>` on every `/api/*` route in place of a cookie session. Tokens are minted per user via the `@better-auth/api-key` plugin, stored hashed at rest in the `apikey` table, and resolve to the same `RequestAuthContext` shape as cookie sessions (so `requireAdmin` / `requireAgentAccess` work unchanged, no admin bypass). Revocation is immediate — each request re-verifies the key. Manage tokens from the CLI: `yoplai user token create --user <email>` (prints the plaintext once and caches it at `~/.yoplai/user-token.json` with mode `0600`), `yoplai user token list`, `yoplai user token revoke <token-id>`. The revoke path hits `DELETE /api/user/token/:id`, which emits a `user_token.revoked` audit log line; the plugin's built-in `/api/auth/api-key/delete` endpoint stays available but is silent.

```bash
T=$(yoplai user token create --user me@example.com --name ci | tail -n1)
curl -H "Authorization: Bearer $T" http://127.0.0.1:4000/api/me
```

## Agent Runtime Flow

1. **Config Load**: `loadConfig()` reads `--config`/explicit file paths when provided, else `$YOPLAI_HOME/yoplai.json` (default `~/.yoplai/yoplai.json`), validates via Zod
   - If `version` is absent, gateway auto-migrates legacy config into v2-style `components` in memory and logs warnings for ambiguous Discord migrations
   - Top-level `env` is copied into the gateway process when unset there already; safe entries are also forwarded into sandbox containers

- Startup then loads configured extensions via `apps/gateway/src/extensions/registry.ts` and installs their resolved runtime state
  - `yoplai projects config migrate` now uses the same shared `migrateConfigV1toV2()` helper to preview or persist the v1 -> v2 rewrite locally
  - Legacy v1→v2 migration is intentionally conservative and only adds compatibility entries when old config explicitly implied them

2. **Model Resolution**: Pi SDK `discoverModels()` reads `YOPLAI_HOME/models.json`
3. **Extension Init**: Extension registry is rebuilt from first-party extensions plus external `extensionsPath` or `$YOPLAI_HOME/extensions`, then configured extension mounts are validated for missing ids/config/secrets. `apps/gateway/src/extensions/registry.ts` remains startup/factory glue; loaded extension state, route matchers, enabled checks, prompt/tool lookup, capabilities, and lifecycle live in `apps/gateway/src/extensions/runtime.ts`.
4. **Session Management**: Per-agent/session state in memory (`sessions.ts`)
5. **Skills**: Auto-discovered via Pi SDK from `{workspace}/.pi/skills`, `~/.pi/agent/skills`, etc.
6. **Slash Commands**: Auto-discovered from `{workspace}/.pi/commands`, `~/.pi/agent/commands`
7. **Bootstrap Files**: On first run, creates workspace files from `docs/templates/`. Injected as contextFiles into system prompt.

- Tool-style extensions are injected at agent session start when `agent.yaml` `extensions.<id>` is present and not `enabled: false`.
- If `extensionsPath` is unset, external extensions are discovered from `$YOPLAI_HOME/extensions` (default `~/.yoplai/extensions`).
- External extension discovery accepts both real directories and symlinked directories.
- Tool-extension parameter schemas are object-only Zod schemas.
- Pi adapter converts extension Zod parameter schemas to JSON Schema custom tools. Because Pi treats the `tools` option as an allowlist, Yoplai includes provider-safe custom tool aliases (for example `scratchpad_read`) in that allowlist for both in-process Pi and container Pi runs.
- Loaded extensions can append agent system-prompt guidance through optional `Extension.getSystemPromptContributions(agent, { config })`. Gateway collection goes through `ExtensionRuntime.getPromptContributions()`; in-process Pi runs append the returned strings directly, while sandbox/container runs serialize them through `ContainerInput.extensionSystemPrompts` for the runner to append.
- Loaded extensions can expose callable agent tools through optional `Extension.getAgentTools(agent, { config })`. Gateway collection/dispatch goes through `ExtensionRuntime.getTools()` / `executeTool()`; in-process Pi runs mount them as `customTools`, while sandbox/container runs serialize definitions through `ContainerInput.extensionTools` and execute them through `/internal/tools` against the same runtime. Model-facing custom tool names are sanitized with `packages/shared/src/tool-names.ts` so providers that reject punctuation see aliases like `scratchpad_read`; gateway dispatch still uses the original extension/tool names.
- Pi lead agents override the Pi SDK default system prompt with Yoplai-specific gateway guidance while preserving SDK-appended project context, extension guidance, skills, date, and working directory sections.
- Pi subagent tools and their appended `Additional tools` system-prompt block are only mounted when the `projects` component is actually loaded.
- Sandbox Claude currently fails loudly when extension tools are present; Pi supports extension tool execution in and out of containers.
- When native `onecli` is enabled for an agent, Claude and Pi runs apply scoped `HTTP_PROXY`/`HTTPS_PROXY` plus CA env vars before the run and restore process env afterward.
- Sandbox container manager helpers in `apps/gateway/src/agents/container.ts` build Docker bind mounts, shadow workspace `.env` with `/dev/null`, validate custom mounts against the sandbox allowlist/blocklist, build `docker run -i --rm` args, and provide Docker network/orphan cleanup helpers. `apps/gateway/src/sdk/container/adapter.ts` composes focused internal modules, spawns ephemeral Docker containers, writes `ContainerInput` to stdin, parses `---YOPLAI_OUTPUT_START---`/`---YOPLAI_OUTPUT_END---` output, queues follow-ups through `$YOPLAI_HOME/ipc/<agentId>/input/*.json`, and stops/kills containers on abort or timeout.
- `yoplai-agent:latest` is content-hashed from the agent-runner Docker build context and rebuilt at startup when those inputs drift. Operator-supplied sandbox images are never hash-checked or rebuilt.
- `apps/gateway/src/server/internal-tools.ts` handles container-to-gateway orchestration callbacks for `project.create`, `project.update`, `project.comment`, and `project.get` (subagent orchestration is CLI-driven via `yoplai projects start`).
- Any adapter/run failure that reaches the shared runner catch is logged to gateway stderr before the error event/HTTP 500 is returned. Pi-only post-prompt `stopReason:error` logging remains in the Pi adapter for extra context.

### Modular foundation status

- Phase 1 modular foundation is in place:
  - shared component contracts + v2 config schemas
  - secret resolution for `$env:` and `$secret:`
  - v1 to v2 runtime migration
  - component registry + startup lifecycle wiring
  - `GET /api/capabilities`
- Startup now resolves config secrets once and stores the resolved config as the runtime config exposed by `ComponentContext.getConfig()`.
- Route-owning components now declare `routePrefixes`, and disabled-component 404 middleware is built from static registry metadata instead of a hardcoded list or eager component imports.
- Core routes now live in `apps/gateway/src/server/api.core.ts`.
- Disabled component route requests return `404 { error: "component_disabled", component }`.
- The main server forwards `/api/*` requests into the live `api.core` router instead of snapshot-mounting it at module load, so component routes registered during startup are reachable in dev/prod.

### Workspace Bootstrap

Templates in `docs/templates/` are copied to `{workspace}/` when missing (using `flag: 'wx'` to avoid overwriting):

| File        | Purpose                                                 |
| ----------- | ------------------------------------------------------- |
| `AGENTS.md` | Prime workspace instructions, memory, safety guidelines |
| `SOUL.md`   | Agent identity/persona, core behaviors, boundaries      |
| `USER.md`   | User profile - name, timezone, context                  |

Bootstrap/config flow:

1. v3 `yoplai.json` discovers agents from `agents` string/string[] entries; each entry may be exact dir or direct-child glob, `.git` directories matched by globs are ignored, and each remaining matched dir must contain flat `agent.yaml`.
2. `ensureWorkspaceFiles(workspaceDir)` writes missing `AGENTS.md`, `SOUL.md`, and `USER.md`, and returns whether none existed before creation.
3. First launches append a concise bootstrap instruction directly to the system prompt; no `BOOTSTRAP.md` is generated.
4. `@yoplai/shared/node/system-files` resolves system prompt files for Pi and container runs: `AGENTS.md` is implicitly prepended, `system_files` controls the remaining order, and default is required `SOUL.md` plus optional `USER.md`.

### Queue Semantics

When agent is already streaming:

- **queue** (default): Inject message via `AgentSession.queueMessage()`. If Pi session not ready, buffer in `pendingMessages` and inject after session creation.
- **interrupt**: Abort current run, wait up to 2s for streaming to end, start new run.

### WebSocket Protocol

Connect to `/ws` endpoint. Supports two modes:

**Send Mode** (request/response):

```typescript
// Client sends:
{ type: "send", agentId: string, sessionKey?: string, sessionId?: string, message: string }

// Server streams back:
{ type: "text", data: string }
{ type: "tool_start", toolName: string }
{ type: "tool_end", toolName: string, isError?: boolean }
{ type: "done", meta?: { durationMs } }
{ type: "error", message: string }
```

**Subscribe Mode** (persistent connection for live updates):

```typescript
// Client subscribes:
{ type: "subscribe", agentId: string, sessionKey: string }

// Server broadcasts events from all runs (including messaging and scheduler backgrounds):
{ type: "text", data: string }
{ type: "tool_start", toolName: string }
{ type: "tool_end", toolName: string, isError?: boolean }
{ type: "done", meta?: { durationMs } }
{ type: "history_updated", agentId: string, sessionId: string }  // UI should refetch history
{ type: "error", message: string }

// Client unsubscribes:
{ type: "unsubscribe" }
```

Web UI uses both: `send` for user messages, `subscribe` for live background updates.

### Session Persistence

Sessions are managed via `sessionKey` (logical name) rather than raw `sessionId`:

- **sessionKey**: Logical key (default: "main") stored in `YOPLAI_HOME/sessions.json`
- **sessionId**: Raw UUID, bypasses key resolution if provided directly
- **idleMinutes**: Sessions expire after 360 minutes (6 hours) of inactivity by default; configurable via `sessions.idleMinutes`
- **resetTriggers**: `/new` or `/reset` force a new session; the trigger is stripped from message

Store format: `{agentId}:{sessionKey}` -> `{ sessionId, updatedAt }`

Web UI persists `sessionKey` per agent in localStorage (default "main"). On mount, fetches history via `GET /api/agents/:id/history?sessionKey=main`. Users can type `/new` to start fresh conversation or `/compact` to summarize older context while keeping the last 8 turns. Left sidebar lists interactive canonical history sessions from `$YOPLAI_HOME/history`, uses configured agent avatars, and polls every 3s/on focus so `/new` and idle-session rotations appear without refresh.

### Chat History And Runtime Sessions

Yoplai keeps two chat-related stores:

- `YOPLAI_HOME/history/{timestamp}_{agentId}-{sessionId}.jsonl` is the canonical Yoplai transcript. API/UI/Langfuse/compaction/system-context/media rows read this normalized store.
- `YOPLAI_HOME/sessions/{timestamp}_{agentId}-{sessionId}.jsonl` is Pi SDK runtime state opened by `SessionManager`. It is not the primary product transcript.

Pi session files use the SDK-native message shape:

```jsonl
{"type":"session","id":"...","timestamp":"...","cwd":"..."}
{"type":"message","timestamp":"...","message":{"role":"user","content":[{"type":"text","text":"..."}],"timestamp":...}}
{"type":"message","timestamp":"...","message":{"role":"assistant","content":[{"type":"thinking","thinking":"..."},{"type":"toolCall","id":"...","name":"...","arguments":{...}},{"type":"text","text":"..."}],"api":"...","provider":"...","model":"...","usage":{...},"stopReason":"..."}}
{"type":"message","timestamp":"...","message":{"role":"toolResult","toolCallId":"...","toolName":"...","content":[{"type":"text","text":"..."}],"isError":false,"details":{"diff":"..."}}}
```

Content block types:

- `text`: Plain text content
- `thinking`: Model reasoning (with thinkingSignature)
- `toolCall`: Tool invocation with id, name, arguments

Canonical history stores normalized `type: "history"` rows with roles like `user`, `assistant`, `toolResult`, and `system`.

The history API parses canonical history into `SimpleHistoryMessage` (text-only) or `FullHistoryMessage` (all blocks + metadata) based on `view` param.
`FullHistoryMessage` can now also include `role: "system"` entries for injected channel context, and the web full/log views surface those rows as `System Context`.

## Services

### Scheduler (`packages/extensions/scheduler/`)

Opt-in extension; load by adding an `extensions.scheduler` block (`{ enabled? }`). `enabled: false` means runtime firing disabled only: the extension still loads so scheduler API/CLI can read/write per-agent `cron/jobs.json`.

Jobs live per agent in `<workspace>/cron/jobs.json` (`{ version: 1, jobs[] }`). Disk jobs omit `agentId`; runtime synthesizes it from the owning workspace, so two agents may reuse the same job id. Schedule shape is `{ cron: string, tz: string, startAt?: ISO8601 }`; `tz` is required and next runs are computed through `cron-parser`. `yoplai agents migrate` rewrites old interval/daily schedules to cron and uses the local system timezone when old jobs omit `tz`. Malformed `cron/jobs.json` logs a warning and is treated as empty. Per-agent in-process writes are serialized and atomically renamed so concurrent API, tool, and run-state saves cannot overwrite newer snapshots. Gateway hot reload polls job files, and scheduler/heartbeat shutdown cannot be undone by an already-pending timer callback re-arming itself.

Each fire dispatches through `ExtensionContext.runAgent({ agentId, message, sessionId, source: "scheduler", trace: { surface: "scheduler", metadata: { jobId, jobName } } })` with default `sessionId = "scheduler:<jobId>:<uuid>"` (the explicit trace surface makes Langfuse name these runs `yoplai:scheduler:<agentId>` instead of falling back to `yoplai:chat:<agentId>`); runs skip (and advance `nextRunAtMs`) when `ctx.isAgentActive(agentId)` is false, so scheduled traffic does not hijack single-agent mode. Ticks are serialized and missed runs do not back-fill. Output writes to `<workspace>/cron/output/<job_id>/YYYY-MM-DD_HH-mm-ss.md` with YAML frontmatter plus `# Cron Job`, `## Prompt`, and `## Response`/`## Error` sections.

CLI: `yoplai scheduler add <agent-id> --cron <expr> --tz <iana> -m <message>`, `list [--agent <id>]`, `update <agent-id> <job-id>`, `rm <agent-id> <job-id>`, and `tail <agent-id> <job-id>`. API breaking changes: update/delete/tail paths are agent-scoped (`/api/schedules/:agentId/:id`), and schedule payloads use cron+required `tz` instead of old interval/daily variants. CLI registration lives in `packages/extensions/scheduler/src/cli/`; wired into the gateway CLI at `apps/gateway/src/cli/index.ts`.

### Discord (`packages/extensions/discord/`)

Carbon-based Discord integration with per-guild/channel routing, reactions, and slash commands.

**Config schema:**

```typescript
discord: {
  token: string,
  applicationId?: string,           // Required for slash commands

  // DM settings
  dm?: { enabled?, allowFrom?, groupEnabled?, groupChannels? },

  // Guild routing
  groupPolicy?: "open"|"disabled"|"allowlist",  // Default: open
  guilds?: Record<guildId, {
    slug?, requireMention?, reactionNotifications?, reactionAllowlist?,
    users?, systemPrompt?, channels?: Record<channelId, { enabled?, requireMention?, users?, systemPrompt? }>
  }>,

  // Behavior
  historyLimit?: number,            // Default: 20
  clearHistoryAfterReply?: boolean, // Default: true
  replyToMode?: "off"|"all"|"first", // Default: off
  mentionPatterns?: string[],       // Regex patterns to trigger bot
  forumChannels?: string[],         // Discord forum channel IDs subscribed by this agent
  broadcastToChannel?: string,      // Broadcast main session to channel
  showToolCalls?: boolean           // Stream batched tool-call notes during a turn (default: off)
}
```

**Features:**

- **Message gating**: Bot filter, DM/guild/channel allowlists, mention requirement, user allowlists
- **Context enrichment**: Channel topic, thread starter, message history (ring buffer)
- **Reactions**: `reactionNotifications` modes: off, all, own (bot's messages), allowlist
- **Tool-call visibility** (ALG-292): `showToolCalls?: boolean` on both component (`extensions.discord`) and per-agent (`agent.discord`) config, off by default. When enabled, the agent's `tool_call`/`tool_result` stream events surface as concise one-line plain-text notes posted live in the channel/thread, coalesced into throttled batches (≥1.5s, or 8-note ceiling) and drained before the final reply (which still posts last, in order). Applies to plain channels and forum threads. Mirrors the Telegram option (ALG-288).
- **Slash commands**: `/new`, `/abort`, `/help`, `/ping` (when `applicationId` set)
- **Forum channels**: `agent.discord.forumChannels` lists Discord forum parent channel IDs for inbound thread workflows. Newly created subscribed threads spawn one fresh `discord:forum:<threadId>:<agentId>` session per subscribed agent, post the reply in the thread, and persist `(threadId, sessionId, agentId, channelId)`. Later user replies in bound threads resume the stored session; missing bindings fall back to the new-thread path with duplicate-spawn suppression.
- **Agent tools**: `discord.create_forum_thread(channel_id, title, body)`, `discord.send_message`, `discord.list_channels`, and `discord.list_users` let scheduled/proactive agents create bound forum handoff threads, discover reachable Discord targets, and send channel or DM messages without waiting for inbound Discord events. The tools prefer a running bot client and fall back to the configured bot token.
- **Typing indicator**: Starts on inbound, 5s keep-alive, stops on done/error, 30s TTL for queued
- **Acknowledgement lifecycle**: Configured reactions are removed on streamed/non-streamed completion, errors, empty replies, and same-thread forum delivery owned by a Discord tool
- **Chunking**: 2000 char limit with code fence preservation

**Session routing:**

- DMs use `sessionKey: "main"` (shares with web UI)
- Guild messages use `sessionId: discord:${channelId}` (per-channel isolation)
- Forum-thread replies use the persisted thread binding; outbound `discord.create_forum_thread` binds the new thread to the current session, and inbound user replies resume that same session.

**Live broadcast:** Main-session responses from other sources (web, scheduler, and other non-Discord surfaces) are broadcast to `broadcastToChannel`. Discord-originated runs are not echoed back (loop prevention via `source` tracking).

### IRC (`packages/extensions/irc/`)

Opt-in native IRC transport. Root `extensions.irc` provides shared connection and channel-to-agent routing; each receiving agent must set `extensions.irc.enabled: true` in its `agent.yaml`. Alternatively, top-level agent `irc` owns a dedicated connection: channel values contain `mode` without `agent`, DM config omits `agent`, and runtime injects agent id as owner. Presence auto-loads IRC; agent-local `$env:` credentials resolve through gateway startup secret resolution. Service handles TLS/plain sockets, keepalive PING/PONG, NickServ identify, nick collision fallback, reconnect, and IRC-safe plain-text replies; application replies remain queued until registration numeric `001`. Replies strip markdown (emphasis/backticks, line-start headings, `[text](url)` and `<url>` links) while preserving newlines; each newline becomes its own IRC message, and long lines split on word boundaries under 450-char/400-byte budgets (oversized single words hard-split codepoint-safe). Channels choose `mention-only` or `reply-all`; DMs may be disabled or assigned to an agent. Top-level `debounceMs` batches a burst of channel lines per channel+sender into one agent turn (mention-only follow-up lines from the same sender join the pending batch without another mention); `dm.debounceMs` batches DM bursts per sender. A coalesced batch counts once toward `maxA2ATurns` and is discarded if its agent is no longer eligible at dispatch. Accepted channel messages and allowed DMs receive a standalone `👀` immediately before agent dispatch; IRC leaves it in place. Debounced messages acknowledge once when their coalesced run dispatches, while ignored or rejected messages do not acknowledge. Ambient context is bounded per channel/DM sender, and `maxA2ATurns` is isolated per channel, resetting only for case-insensitive `humanNicks` matches.

### Heartbeat (`packages/extensions/heartbeat/`)

Periodic agent check-in with Discord alert delivery. Heartbeat depends on scheduler availability as the tick gate; if `extensions.scheduler` is absent or `enabled: false` while heartbeat is configured, heartbeat logs a warning and noops.

**Config:**

```typescript
heartbeat?: {
  every?: string,      // Duration: "30m", "1h", "0" (disabled). Required to enable timers.
  prompt?: string,     // Custom prompt (overrides HEARTBEAT.md)
  ackMaxChars?: number // Max chars after token strip. Default: 300
}
```

**Flow:**

1. Timer fires at `every` interval
2. Prompt resolved: `heartbeat.prompt` > `{workspace}/HEARTBEAT.md` > default
3. Agent runs with `source: "heartbeat"`, `sessionKey: "main"`
4. Reply evaluated:
   - Contains `HEARTBEAT_OK` + content ≤ `ackMaxChars` → status `ok-token`, no delivery
   - Empty reply → status `ok-empty`, no delivery
   - No token or substantial content → status `sent`, delivered to Discord
5. Session `updatedAt` preserved (heartbeat doesn't reset idle timer)
6. Completed runs write `<workspace>/cron/output/__heartbeat__/YYYY-MM-DD_HH-mm-ss.md` with YAML frontmatter (`run_type: heartbeat`, `result_status`) plus `# Heartbeat`, `## Prompt`, and `## Response`/`## Error` sections. Response body is latest assistant text only.

**Token matching:** Strips HTML/Markdown wrappers (`<b>HEARTBEAT_OK</b>`, `**HEARTBEAT_OK**`, etc.)

**Discord delivery:** Requires `discord.broadcastToChannel`. Bot must be ready and gateway connected.

**Skips when:**

- Agent not found
- Heartbeats globally disabled (`setHeartbeatsEnabled(false)`)
- Main session is streaming
- No `broadcastToChannel` configured

**Events:** `onHeartbeatEvent(payload)` for status monitoring. Payload: `{ ts, agentId, status, to?, preview?, alertText?, durationMs?, reason? }`

### Dream (`apps/gateway/src/dream/`)

Opt-in nightly agent self-consolidation. `agent.yaml` accepts `dream: true` for a daily `00:00` run using the agent model, or `{ enabled?, time?, provider?, model? }`; `time` is `HH:MM`, defaults to `00:00`, and `provider`/`model` must be supplied together. Global `yoplai.json` `dream` settings may override the prompt, timeout, and cold-start window. `yoplai dream <agent-id> [--dry-run]` invokes the same runner manually. Each successful run advances `<workspace>/dreams/state.json`; failures retain the window for retry. The runner scopes extension tools to scheduler only and writes/stamps a dated journal under `<workspace>/dreams/`.

## API Endpoints

| Method | Path                                             | Description                                                                                                                 |
| ------ | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/agents`                                    | List active agents                                                                                                          |
| GET    | `/api/agents/:id/status`                         | Agent status                                                                                                                |
| POST   | `/api/agents/:id/messages`                       | Send message (returns result)                                                                                               |
| GET    | `/api/agents/:id/history`                        | Get session history (query: sessionKey, view=simple\|full)                                                                  |
| WS     | `/ws`                                            | WebSocket streaming (JSON protocol)                                                                                         |
| GET    | `/api/schedules`                                 | List schedules                                                                                                              |
| POST   | `/api/schedules`                                 | Create schedule                                                                                                             |
| PATCH  | `/api/schedules/:agentId/:id`                    | Update schedule                                                                                                             |
| DELETE | `/api/schedules/:agentId/:id`                    | Delete schedule                                                                                                             |
| GET    | `/api/projects`                                  | List projects                                                                                                               |
| POST   | `/api/projects`                                  | Create project                                                                                                              |
| GET    | `/api/projects/:id`                              | Get project                                                                                                                 |
| PATCH  | `/api/projects/:id`                              | Update project                                                                                                              |
| GET    | `/api/projects/:id/subagents`                    | List project subagents                                                                                                      |
| POST   | `/api/projects/:id/subagents`                    | Spawn project subagent                                                                                                      |
| PATCH  | `/api/projects/:id/subagents/:slug`              | Rename project subagent run                                                                                                 |
| GET    | `/api/subagents`                                 | List runtime runs plus project-backed runs for default/status views; runtime-only filters support parent/status/cwd/archive |
| POST   | `/api/subagents`                                 | Start project-agnostic CLI subagent run                                                                                     |
| GET    | `/api/subagents/:runId`                          | Get runtime subagent run                                                                                                    |
| POST   | `/api/subagents/:runId/resume`                   | Resume completed/interrupted runtime run                                                                                    |
| POST   | `/api/subagents/:runId/interrupt`                | Interrupt runtime run                                                                                                       |
| POST   | `/api/subagents/:runId/archive`                  | Archive runtime run                                                                                                         |
| POST   | `/api/subagents/:runId/unarchive`                | Unarchive runtime run                                                                                                       |
| DELETE | `/api/subagents/:runId`                          | Delete runtime run record                                                                                                   |
| GET    | `/api/subagents/:runId/logs`                     | Read normalized runtime run logs                                                                                            |
| GET    | `/api/projects/:id/space`                        | Get project Space state                                                                                                     |
| POST   | `/api/projects/:id/space/integrate`              | Resume Space integration queue                                                                                              |
| POST   | `/api/projects/:id/space/entries/skip`           | Mark selected pending Space entries as skipped                                                                              |
| POST   | `/api/projects/:id/space/entries/integrate`      | Integrate only selected pending Space entries                                                                               |
| POST   | `/api/projects/:id/space/rebase`                 | Rebase Space branch onto base and refresh pending workers                                                                   |
| POST   | `/api/projects/:id/space/rebase/fix`             | Spawn Space-level rebase fixer agent in main-run mode                                                                       |
| POST   | `/api/projects/:id/space/merge`                  | Merge Space branch into base + optional cleanup                                                                             |
| GET    | `/api/projects/:id/space/commits`                | Get Space commit log                                                                                                        |
| GET    | `/api/projects/:id/space/contributions/:entryId` | Get per-entry contribution diff/log                                                                                         |
| POST   | `/api/projects/:id/space/conflicts/:entryId/fix` | Resume original conflicted worker                                                                                           |
| GET    | `/api/projects/:id/space/lease`                  | Get Space write lease (feature-flagged)                                                                                     |
| POST   | `/api/projects/:id/space/lease`                  | Acquire Space write lease (feature-flagged)                                                                                 |
| DELETE | `/api/projects/:id/space/lease`                  | Release Space write lease (feature-flagged)                                                                                 |
| GET    | `/api/projects/:id/changes`                      | Get project changes (Space-first source resolution)                                                                         |
| POST   | `/api/projects/:id/commit`                       | Commit project changes in resolved source                                                                                   |
| GET    | `/api/projects/:id/pr-target`                    | Get PR compare target for current resolved branch                                                                           |

### Space-First Workspace Model

- Project Space branch: `space/<projectId>`
- Project Space worktree: `<projectsRoot>/.workspaces/<projectId>/_space`
- Persisted state and queue: `<projectDir>/space.json`
- Space internals are split under `packages/extensions/projects/src/projects/`: `space-state.ts` owns `space.json` parsing/persistence and leases, `space-git.ts` owns git/worktree primitives, `space-policy.ts` owns queue transitions/integration policy, and `space.ts` remains the public compatibility facade. In-process mutations for one `space.json` are serialized and atomically renamed so concurrent worker deliveries and queue actions cannot overwrite one another.

Behavior:

- `main-run` subagents execute in the Space worktree.
- `worktree` and `clone` subagents remain isolated sandboxes.
- Worker commit ranges are derived from `start_head_sha..end_head_sha` and queued.
- Worker deliveries remain `pending` until explicit integration (`POST /api/projects/:id/space/integrate`).
- Per-entry queue control is available via:
  - `POST /api/projects/:id/space/entries/skip` (pending -> skipped for selected IDs)
  - `POST /api/projects/:id/space/entries/integrate` (cherry-pick only selected pending IDs)
- Gateway cherry-picks queued SHAs into Space (`git cherry-pick -x`) only during explicit integrate flow.
- `POST /api/projects/:id/space/rebase` rebases Space onto latest base HEAD and rebases each `pending` worker commit range onto new Space HEAD (updates `startSha`/`shas`; worker rebase conflicts become `status=conflict`).
- If Space rebase itself conflicts, Space stores `rebaseConflict` context and leaves rebase in progress for `POST /api/projects/:id/space/rebase/fix` to spawn `space-rebase-fixer` in `main-run`.
- When queue is fully terminal (`integrated`/`skipped` only), `POST /api/projects/:id/space/merge` merges Space into base (`--ff-only` first, fallback regular merge), pushes base when remote exists, and can clean up worker/Space worktrees+branches.
- Merge flow updates project frontmatter status to `done`.
- On conflict, Space queue is blocked (`integrationBlocked=true`) until the worker resolves and re-delivers.
- `POST /api/projects/:id/space/conflicts/:entryId/fix` resumes the original worker with a rebase prompt against current Space HEAD.
- When that worker re-delivers, gateway updates the same conflict entry in place (new SHAs, status reset, `integrationBlocked=false`) instead of appending a new queue row.
- Worker deliveries can include `replaces: string[]` (entry IDs or worker slugs); matching `pending` entries are auto-marked `skipped`.
- Queue statuses include: `pending`, `integrated`, `conflict`, `skipped`, `stale_worker`.
- Stale worker handling:
  - Clone workers are marked `stale_worker` when their base diverges from Space HEAD.
  - Worktree workers can auto-rebase onto Space HEAD when `YOPLAI_SPACE_AUTO_REBASE=true` (default).
- Optional Space write lease (`YOPLAI_SPACE_WRITE_LEASE=true`):
  - Persists lease at `<projectDir>/space-lease.json`.
  - Enforced for `main-run` workers (acquire on spawn, release on exit/kill).

### Subagent CLI Harnesses

- Supported subagent CLIs: `claude`, `codex`, `pi`.
- Legacy subagent CLIs `droid` and `gemini` are rejected by API validation.
- Runtime split:
  - Lead agents (`sdk: "pi"`) use embedded Pi SDK sessions.
  - Project subagents run as external CLI processes.
- Pi subagent harness uses JSON event mode:
  - Spawn: `pi --mode json --session <session_file> "<prompt>"`
  - Resume: reuses the same `--session <session_file>`.
- Harness-specific model/reasoning flags:
  - Codex: `-m <model>` and `-c reasoning_effort=<xhigh|high|medium|low>` where `<model>` is one of `gpt-5.4`, `gpt-5.3-codex`, `gpt-5.3-codex-spark`, `gpt-5.2`
  - Claude: `--model <model>` and `--effort <low|medium|high|xhigh|max>`
  - Pi: `--model <id>` and `--thinking <off|low|medium|high|xhigh>`
- Spawn payload supports optional `name` (custom run label). If omitted, UI/CLI fall back to slug/CLI naming.
- Project-detail UI spawn form derives the slug from the displayed run name and de-dupes against existing project subagent slugs (`coordinator`, `worker-2`, etc.).
- `yoplai projects start` supports these fields directly:
  - `--agent <cli|yoplai:id>`
  - `--subagent <name>`
  - `--name <run-name>`
  - `--model <id>`
  - `--reasoning-effort <level>`
  - `--thinking <level>`
  - `--prompt-role <coordinator|worker|reviewer|legacy>`
  - `--allow-overrides`
  - `--include-default-prompt|--exclude-default-prompt`
  - `--include-role-instructions|--exclude-role-instructions`
  - `--include-post-run|--exclude-post-run`
- `yoplai projects start --subagent <name>` sends the selected config subagent name; server resolves `cli`/model/reasoning/runMode/type from `yoplai.json`.
- If `--allow-overrides` is set, CLI also sends the resolved defaults client-side and allows explicit override flags.
- Locked fields can be overridden only with `--allow-overrides`.
- Lead-agent launches use `--agent yoplai:<id>` and run in project-scoped sessions keyed as `project:<projectId>:<agentId>`.
- `yoplai projects status <projectId> --list` prints the existing project subagent session slugs (including archived runs); `--json` returns the slug array.

## Single-Agent Mode

`yoplai gateway --agent-id <id>` filters all services to one agent. Useful for isolated testing.

## Gateway as a Service (macOS)

`yoplai gateway install|start|stop|status|uninstall` manages a launchd user agent at `~/Library/LaunchAgents/com.yoplai.gateway.plist` (label `com.yoplai.gateway`, domain `gui/<uid>`). Implementation in `apps/gateway/src/cli/service.ts`. Plist runs `<process.execPath> <abs dist/cli/index.js> gateway` with `WorkingDirectory`/`YOPLAI_HOME` set to `CONFIG_DIR`, logs to `$YOPLAI_HOME/logs/gateway.{out,err}.log`, `RunAtLoad=true`, `KeepAlive={SuccessfulExit:false}` (restart on crash). Uses modern `launchctl bootstrap`/`bootout`/`kickstart -k`. `install` is idempotent (boots out existing first). Pre-rename installs (at `com.aihub.gateway`) are still resolved by all commands, logging a deprecation warning once; `install` migrates them in place to `com.yoplai.gateway`; `uninstall` removes both labels when both are present. `status` parses `launchctl print` for pid/state/last-exit-code and reads `gateway.port`/`ui.port` from config to render an info box. Non-darwin platforms exit with a "macOS launchd only" message — Linux/systemd not yet implemented.

## Direct OAuth Authentication (Pi SDK)

Pi SDK agents can authenticate via OAuth tokens stored in `YOPLAI_HOME/auth.json`. This allows running agents without a separate CLIProxyAPI.

### Supported OAuth Providers

- `anthropic` - Anthropic (Claude Pro/Max)
- `openai-codex` - OpenAI Codex
- `github-copilot` - GitHub Copilot
- `google-gemini-cli` - Google Cloud Code Assist (Gemini CLI)
- `google-antigravity` - Antigravity (Gemini 3, Claude, GPT-OSS)

Note: Run `yoplai auth login` to see current available providers (list from Pi SDK).

### CLI Commands

```bash
# Login to a provider (interactive)
pnpm yoplai auth login

# Login to a specific provider
pnpm yoplai auth login anthropic

# Check authentication status
pnpm yoplai auth status

# Logout from a provider
pnpm yoplai auth logout anthropic

# Send a configured Discord/Slack notification
pnpm yoplai notify --channel default --message "hello" [--from <agentId>] [--surface discord|slack|both] [--mention userId]
# --from resolves bot tokens from agent.yaml; YOPLAI_AGENT_ID is used when --from is omitted.
```

### OAuth Agent Config

```json
{
  "agents": [
    {
      "id": "my-agent",
      "name": "My Agent",
      "workspace": "~/agents/my-agent",
      "sdk": "pi",
      "auth": {
        "mode": "oauth"
      },
      "model": {
        "provider": "anthropic",
        "model": "claude-opus-4-5"
      }
    }
  ]
}
```

The `auth.mode` field is optional and can be:

- `oauth` - Require OAuth tokens (fails if not logged in via `yoplai auth login`)
- `api_key` - Use only API key credentials or env vars (ignores OAuth tokens)
- `proxy` - Use existing provider config (same as default; for proxy-backed providers in `models.json`)

When `auth.mode` is not set (or `proxy`), Pi SDK's AuthStorage resolves credentials with priority:

1. Runtime override (CLI `--api-key`)
2. API key from `auth.json`
3. OAuth token from `auth.json` (auto-refreshed)
4. Environment variable
5. Fallback resolver (`models.json` custom providers)

The `auth.profileId` field is reserved for future multi-profile support.

**Implementation note:** This feature uses Pi SDK's existing AuthStorage rather than custom credential stores. Migration from legacy `~/.pi/agent/oauth.json` is handled automatically by Pi SDK.

### Storage

Credentials are stored in `YOPLAI_HOME/auth.json`:

```json
{
  "anthropic": {
    "type": "oauth",
    "access": "...",
    "refresh": "...",
    "expires": 1767304352803
  },
  "openai": { "type": "api_key", "key": "sk-..." }
}
```

## OpenClaw SDK

The OpenClaw SDK adapter connects Yoplai to an [OpenClaw](https://github.com/openclaw/openclaw) gateway via WebSocket, allowing you to interact with OpenClaw agents through the Yoplai web UI.

**Config:**

```json
{
  "agents": [
    {
      "id": "cloud",
      "name": "Cloud",
      "workspace": "~/agents/cloud",
      "sdk": "openclaw",
      "openclaw": {
        "gatewayUrl": "ws://127.0.0.1:18789",
        "token": "your-gateway-token",
        "sessionKey": "agent:main:main"
      },
      "model": { "provider": "openclaw", "model": "claude-sonnet-4" }
    }
  ]
}
```

| Field                 | Description                                           |
| --------------------- | ----------------------------------------------------- |
| `openclaw.gatewayUrl` | WebSocket URL (default: `ws://127.0.0.1:18789`)       |
| `openclaw.token`      | Gateway auth token                                    |
| `openclaw.sessionKey` | Target session (use `openclaw sessions list` to find) |

**Protocol:** Uses OpenClaw WebSocket protocol v3 with `backend` client mode. Streams `chat` events with `state: delta/final` for responses, `agent` events for tool calls.

**Notes:**

- `workspace` and `model` are required for schema validation but `model` doesn't control the actual model (configured in OpenClaw)
- Set `OPENCLAW_DEBUG=1` to log raw WebSocket frames

## Claude SDK Proxy Configuration

For Claude SDK agents, you can configure a proxy URL and auth token directly in the agent config instead of using environment variables:

```json
{
  "agents": [
    {
      "id": "my-agent",
      "name": "My Agent",
      "workspace": "~/agents/my-agent",
      "sdk": "claude",
      "model": {
        "model": "claude-sonnet-4-5-20250929",
        "base_url": "http://127.0.0.1:8317",
        "auth_token": "sk-dummy"
      }
    }
  ]
}
```

This sets `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` for that agent's runs. Runs with proxy config are serialized to prevent env var cross-contamination.

## Environment Variables in Config

You can set environment variables directly in `yoplai.json` using the `env` field:

```json
{
  "env": {
    "OPENROUTER_API_KEY": "sk-or-...",
    "GROQ_API_KEY": "gsk-...",
    "ANTHROPIC_API_KEY": "sk-ant-..."
  },
  "agents": [...]
}
```

**Behavior:**

- Env vars are applied at config load time (before any agent runs)
- Only applied if not already set in `process.env` (shell env takes precedence)
- Supports any env var recognized by Pi SDK (provider API keys, etc.)

**Common env vars for Pi SDK providers:**

- `ANTHROPIC_API_KEY` - Anthropic
- `OPENAI_API_KEY` - OpenAI
- `OPENROUTER_API_KEY` - OpenRouter
- `GROQ_API_KEY` - Groq
- `GEMINI_API_KEY` - Google Gemini

## Key Dependencies

- **Pi SDK** (`@earendil-works/pi-coding-agent`): Agent runtime, tools, skills, model registry
- **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`): Claude SDK integration
- **Hono**: HTTP server framework
- **Carbon** (`@buape/carbon`): Discord bot integration (Gateway + REST)
- **Zod**: Schema validation
- **Commander**: CLI framework

## Development

```bash
pnpm install
pnpm dev          # gateway + web UI in dev mode
pnpm dev:gateway  # gateway + shared + web UI with hot reload (production mode)
pnpm dev:web      # web UI only (Vite dev server)
pnpm build        # TypeScript compile
pnpm yoplai <cmd>  # Run CLI
```

Set `ui.enabled: false` in config to disable automatic web UI startup.

Dev gateway entrypoints set `NODE_OPTIONS=--conditions=development`, so workspace packages with a development export (`packages/extensions/*` and `packages/shared`) resolve to `src/*.ts` during `pnpm dev`/`pnpm dev:gateway`. This lets extension and shared source edits take effect in dev without rebuilding `dist/`; production imports still use `dist/`.

### Dev Mode (`--dev` flag)

`pnpm dev` runs the gateway with the `--dev` flag, enabling:

- **Auto port discovery**: If ports 4000/3000 are in use, automatically finds free ports (up to +50)
- **Service isolation**: messaging transports, scheduler, and heartbeats are disabled
- **Tailscale skip**: No tailscale serve setup (avoids overwriting production routes)
- **Visual identification**:
  - Console banner showing active ports and disabled services
  - Browser tab title: `[DEV :3001] Yoplai`
  - Orange `DEV` badge in sidebar

Multiple dev instances can run simultaneously, each auto-discovering unique ports.

To run gateway in production mode for testing:

```bash
pnpm yoplai gateway  # No --dev flag, starts all services
```

## Orchestrator extension progress

`packages/extensions/orchestrator` is registered as optional `extensions.orchestrator` with `/api/orchestrator` routes. Current implementation is Symphony-aligned: `extensions.orchestrator.projects[]` lists project folders, each project must contain uppercase `WORKFLOW.md`, and workflow frontmatter owns tracker auth/endpoint, states, workspace root, hooks, agent profile adapter, and prompt. Tracker is a discriminated union on `tracker.kind`: `linear` (`tracker.project_slug`) or `plane` (`tracker.workspace_slug` + `tracker.project_id`, optionally `tracker.module_id` to scope to one module); polling/lookup filters issues by that scope. Workspaces are directory-only per issue under workflow `workspace.root`; core orchestration has no repo label routing or git/worktree behavior. SQLite remains observability/history with project identity. Raw event payloads for new orchestrator runs live beside the configured project `WORKFLOW.md` at `<project>/.yoplai/codex/<timestamp>-<encoded-run-id>.jsonl`; SQLite `events` rows keep metadata (`run_id`, `project_id`, `type`, `created_at`, `log_path`, byte offset, line number, payload preview) and legacy DB-only `events.payload` rows remain readable. Inspect raw logs with `tail -f <project>/.yoplai/codex/*.jsonl` or `jq -c . <project>/.yoplai/codex/<run>.jsonl`; API consumers can keep using `/api/orchestrator/runs/:id/logs?since=<cursor>`. The logs API merges JSONL-backed and legacy rows by SQLite cursor, and if JSONL is archived/deleted it falls back to the preview without corrupting run metadata. Gateway owns worker lifetime: shutdown stops active workers; orchestrator-owned `Needs Human` parks are hard stops for active workers and preserve the finalized run row with outcome plus subagent run id; restart recovery uses tracker state plus preserved workspace directories rather than live reattach authority. Manual release only clears the claim, while interrupt/kill stop workers explicitly. Projects/board remain live until Phase 5 HITL cleanup. The `/orchestrator` web dashboard (`apps/web/src/extensions/orchestrator/routes.tsx`) is a self-contained single file (no projects-extension imports): a daemon status bar (online pulse, active/recent/last-tick stats), Active runs as live rows (status pill, ticking elapsed, project, Open/Interrupt/Kill), a Recent runs list (status pill, Linear identifier, copyable short run hash, project, relative time, exit code), and a per-run drawer with Logs / Events / Workflow tabs. The Logs tab renders the agent transcript as turn blocks (Prompt bubble, assistant markdown, collapsible `exec_command`/tool blocks) by copying the projects "agents" tab renderer (`eventToBoardItem` + `BoardChatLog`) inline rather than importing it, so codex `command_execution` stream events surface as readable shell blocks instead of raw JSON. It uses the shared `:root` design tokens from `index.html` and a scoped `<style>` block; status tones are green=ok/running, amber=interrupted/needs-human, red=failed.

Protocol runner cutover (ALG-155): orchestrator dispatch no longer goes through `/api/subagents`, and the orchestrator package dropped its dependency on `@yoplai/extension-subagents`. Workers run through an orchestrator-owned `WorkerRunner` seam (`packages/extensions/orchestrator/src/worker-runner/runner.ts`) with a runner chain: `pi` (`pi-rpc.ts`), `claude` (`claude-rpc.ts` + `claude-rpc-shim.ts`), `codex` (`codex-app-server.ts`), a generic `cli` harness, and `fake` for tests/dry runs. The runner is selected per project in `WORKFLOW.md` frontmatter `agent.runner` (legacy alias `agent.kind`), defaulting to `pi` when no profile runner is resolved; legacy `agent.profile`-only workflows still select the matched profile `cli`. `agent.thinking` is the canonical workflow override for reasoning/thinking, with compatibility aliases resolved as `thinking`, `reasoningEffort`, `reasoning_effort`, then legacy `reasoning`; it maps to Pi `--thinking`, Codex app-server effort, and Claude `--effort`. Invalid explicit-runner values fail config load, and profile-only workflows validate against the resolved profile runner before runner startup. `pi`, `claude`, and `codex` carry built-in default commands (`codex` defaults to `codex app-server` per the OpenAI app-server spec / Symphony `codex.command`); only `cli` requires an explicit `agent.command` (executable string or `[executable, ...args]`; string commands are not shell-split; whitespace trimmed, empty falls back to the runner default). Pi and Claude custom protocol commands still receive workflow-managed model/thinking flags after configured args. `WorkflowLoader.buildConfig` (`workflow/loader.ts`) validates the runner value, explicit-runner workflow thinking value, enforces the `command` requirement for `cli` only, and rejects non-positive `agent.max_turns`/`turn_timeout_ms`/`stall_timeout_ms`/`max_concurrent`; `worker-runner/thinking.ts` owns effective-runner thinking validation for profile-derived runners. Timeout defaults follow Symphony: `stall_timeout_ms` defaults to `300000` (5 min, consumed by `daemon.ts` stall detection) and `turn_timeout_ms` defaults to `3600000` (1 hour) and is enforced as a real per-turn deadline in all three protocol runners: when a turn exceeds the budget the runner aborts/interrupts it and emits a `worker.<runner>.turn.timeout` event with `status: "interrupted"` and `reason: "turn_timeout"` (ALG-164). Codex app-server JSON-RPC requests have a bounded request timeout and failed startup/continuation removes the session. `agent.profile` is now an optional override: when `extensions.subagents.profiles[]` exists it can still supply runner/model/reasoning defaults, otherwise the runner synthesizes protocol defaults from `runner`. The orchestrator persists its own `worker_id` handles in state and serves active worker IDs/statuses plus logs/events from orchestrator state rather than the subagents extension. The separate `subagents` extension remains available for manual/generic project runs. `yoplai orchestrator init-project` / `init-workflow` scaffold `runner: pi` and accept an optional `--profile` (no longer defaulted to `worker`). See `packages/extensions/orchestrator/README.md` for the full `WORKFLOW.md` `agent` field reference and per-runner YAML examples.

Tracker-agnostic orchestrator, Plane as second tracker (ALG-363): the daemon/CLI/webhook route no longer talk to `LinearClient` directly; they go through a `TrackerClient` interface (`packages/extensions/orchestrator/src/tracker/client.ts`) with `createTrackerClient(config)` switching on `tracker.kind`, plus `trackerScopeKey` (duplicate-project-scope validation) and `isRelevantTrackerWebhook` (webhook relevance) as pure per-kind helpers. `LinearTracker` (`src/linear/tracker.ts`) wraps the existing `LinearClient` byte-for-byte (same GraphQL query, same rate limiting); `PlaneTracker` (`src/plane/tracker.ts`) wraps a new raw-REST `PlaneClient` (`src/plane/client.ts`) with the same cursor pagination, 429-retry, and rate-limit-header handling shape. Agents get `orchestrator.plane_api` (gated by `extensions.orchestrator.plane.exposeApiTool`, default on) alongside the existing `orchestrator.linear_graphql`: it executes a raw Plane REST call using the project's workflow auth, with `path` placeholders `{workspace}`/`{project}`/`{module}`; each tool errors out (without making a request) when called against a project of the other tracker kind. `WorkflowLoader.buildConfig` (`workflow/loader.ts`) validates `tracker.kind` (`Unsupported tracker.kind: <kind> (supported: linear, plane)`) and the Plane-required fields (`api_key` or env fallback from `PLANE_BOT_TOKEN`/`PLANE_OAUTH_TOKEN`/`PLANE_API_KEY`, optional `auth_kind`, `workspace_slug`, `project_id`, optional `module_id`, optional `mention`). Plane auth sends bot/OAuth tokens as `Authorization: Bearer` and API keys as `X-API-Key`. Plane `tracker.mention` resolves a bot display name to one workspace member once via a plain `GET /members/` call, then polls the unfiltered work-items list and filters client-side to items whose `assignees` include the resolved user id, before normal active-state filtering. `init-project` gains `--tracker <linear|plane>` and a `TrackerBootstrap` seam (`src/cli/index.ts`) that creates a Plane project, or a module inside an existing `PLANE_PROJECT_ID` project when set, from `PLANE_BOT_TOKEN` or `PLANE_OAUTH_TOKEN` or `PLANE_API_KEY`, plus `PLANE_WORKSPACE_SLUG`/`PLANE_BASE_URL`/`PLANE_PROJECT_ID`. Plane-specific unit tests (polling scope, mapping, caching, pagination, `getIssue` scoping, webhook relevance) live in `packages/extensions/orchestrator/src/plane/plane.test.ts`; tracker-shared daemon/loader/webhook/agent-tool behavior is covered via fakes in `packages/extensions/orchestrator/src/orchestrator.test.ts`. See `packages/extensions/orchestrator/README.md` for the full Plane `WORKFLOW.md` reference, module-vs-project scoping, and webhook signature header setup.
