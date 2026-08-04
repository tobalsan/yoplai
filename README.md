# Yoplai

Multi-agent gateway for AI agents. Exposes agents via web UI, Discord, Slack, CLI, and scheduled jobs.

![Dashboard](./yoplai.png)

**Main features:**

- Multi-agent orchestration spaces
- Project management with Kanban boards
- Direct chat with CLI agents
- Board home view with full-history chat rendering, live tool-call streaming, stop button, queued follow-ups while streaming, and reactive canvas tabs
- Drag-and-drop file attach in chat history, composer, or `+`
- Virtualized long-thread project agent chat with smart near-bottom autoscroll
- Specs and task management
- Activity feed
- Local media foundation for image/document uploads and agent-created file downloads
- File-based by default; optional SQLite only for multi-user auth

## Quick Start

```bash

# Clone the repo
git clone https://github.com/tobalsan/yoplai.git
cd yoplai

# Install
pnpm install
```

## Run as a Service (macOS)

Run the gateway (UI included) as a background launchd agent that auto-starts on login and restarts on crash:

```bash
pnpm yoplai gateway install    # write plist + load
pnpm yoplai gateway status     # show pid, ports, log paths
pnpm yoplai gateway stop       # bootout
pnpm yoplai gateway start      # bootstrap + kickstart
pnpm yoplai gateway uninstall  # bootout + remove plist
```

- Plist: `~/Library/LaunchAgents/com.yoplai.gateway.plist` (label `com.yoplai.gateway`).
- Logs: `$YOPLAI_HOME/logs/gateway.{out,err}.log`.
- `install` is idempotent (boots out any existing instance first).
- macOS only for now; Linux/systemd not yet supported.

## Configuration

The app uses a main config file at `$YOPLAI_HOME/yoplai.json` (default: `~/.yoplai/yoplai.json`).

> **Upgrading from AIHub?** The old `~/.aihub`/`aihub.json`/`AIHUB_*` env vars still work as a fallback and log a deprecation warning; migrate to `~/.yoplai`/`yoplai.json`/`YOPLAI_*` when convenient.
> All data is saved as markdown files in the projects folder.
> By default, if you don't specify anything, all projects are saved in `~/projects`.
> Project document layout is centralized in `ProjectDocumentStore`: project metadata stays in `README.md`, pitch in `PITCH.md`, comments in `THREAD.md`, slices under `slices/<sliceId>/`, and `SCOPE_MAP.md` is generated.
> Config uses v3: `$YOPLAI_HOME/yoplai.json` holds global settings and optional `agents` discovery globs; each lead agent lives in its own workspace with `agent.yaml`. If `agents` is omitted and no root `pool` is configured, Yoplai defaults to `$YOPLAI_HOME/agents` and fails startup clearly if that folder does not contain agent workspaces.
> Config has a single extension model. Root `extensions.<id>` holds shared extension defaults, and `agent.yaml` `extensions.<id>` opts that agent into tool-style extensions with optional per-agent overrides.
> Projects can opt into the slice orchestrator daemon with `extensions.projects.orchestrator`. When enabled, it polls configured slice status bindings, starts `Worker` subagents for `todo`, starts `Reviewer` subagents for `review`, and starts `Merger` subagents for `ready_to_merge`. The dispatcher is split internally into dispatch policy, prompt factory, and run planner modules. Slices can declare `blocked_by` prerequisites; blocked slices are skipped until every blocker is `done`, `ready_to_merge`, or `cancelled`. HITL bursts require `hitl_channel` to name an existing `notifications.channels` key.
> Orchestrated Worker/Reviewer/Merger prompts tell agents to pass their role via `--author` when posting project or slice comments, so THREAD.md keeps role attribution.
> Orchestrator run indexes and small event metadata stay in SQLite, while new raw runner events are written beside the owning project `WORKFLOW.md` as `<project>/.yoplai/codex/<timestamp>-<encoded-run-id>.jsonl`. Inspect them with `tail -f <project>/.yoplai/codex/*.jsonl` or `jq -c . <project>/.yoplai/codex/<run>.jsonl`; `/api/orchestrator/runs/:id/logs?since=<cursor>` still reads both JSONL-backed runs and legacy DB-only runs.

```json
{
  "notifications": {
    "channels": {
      "default": { "slack": "C0123456789" }
    }
  },
  "extensions": {
    "projects": {
      "orchestrator": {
        "enabled": true,
        "poll_interval_ms": 30000,
        "hitl_channel": "default",
        "statuses": {
          "todo": { "profile": "Worker", "max_concurrent": 2 },
          "review": { "profile": "Reviewer", "max_concurrent": 2 },
          "ready_to_merge": { "profile": "Merger", "max_concurrent": 2 }
        }
      }
    }
  }
}
```

Startup now resolves `$env:` refs once and threads the resolved config through runtime/component context.
Core routes now live in `apps/gateway/src/server/api.core.ts`. Component-owned routes mount through the component lifecycle, declare their own API route prefixes, and disabled component endpoints return `404 { error: "component_disabled", component: "<id>" }` without eagerly loading disabled component modules.
The main HTTP app now delegates `/api/*` requests into the live component-mutated API router, so `pnpm dev` sees newly enabled route-owning components instead of a stale route snapshot.
WebSocket routing lives behind `apps/gateway/src/server/ws-broker.ts`, with the web app consuming session/status/project/subagent realtime interests through `apps/web/src/api/realtime-client.ts`.
OneCLI now uses the dedicated top-level `onecli` config section for native proxy/gateway wiring.

The app has two levels of agents: lead agents that you configure in the main config file, and subagents, that are started using either Claude Code, Codex, or Pi CLI coding agents. This means you have to have them installed to use subagents.

Agents can optionally run inside ephemeral Docker containers for filesystem, network, and credential isolation. See [Container Isolation](#container-isolation) below for setup.

### Lead agents

Lead agent configuration is optional, as orchestration is done via CLI subagents.
If you want lead agents, point `yoplai.json` at agent workspace folders, or omit `agents` to use `$YOPLAI_HOME/agents` in non-pool mode. Each workspace contains `agent.yaml` and prompt files.

```bash
export YOPLAI_HOME="${YOPLAI_HOME:-$HOME/.yoplai}"
mkdir -p "$YOPLAI_HOME/agents/my-agent" "$YOPLAI_HOME/agents/openclaw-agent"
cat > "$YOPLAI_HOME/yoplai.json" << 'EOF'
{
  "version": 3,
  "agents": "./agents/*",
  "extensions": {
    "projects": {
      "enabled": true,
      "root": "/your/custom/projects/path"
    },
    "scheduler": {
      "enabled": true
    }
  }
}
EOF
cat > "$YOPLAI_HOME/agents/my-agent/agent.yaml" << 'EOF'
id: my-agent
name: My Agent
model:
  provider: anthropic
  model: claude-sonnet-4-5-20250929
EOF
cat > "$YOPLAI_HOME/agents/openclaw-agent/agent.yaml" << 'EOF'
id: openclaw-agent
name: Cloud
sdk: openclaw
openclaw:
  gatewayUrl: ws://127.0.0.1:18789
  token: your-openclaw-gateway-token
  sessionKey: agent:main:main
model:
  provider: openclaw
  model: claude-sonnet-4
EOF
```

Run `pnpm yoplai agents migrate` to convert older v2 configs with centralized `agents[]` records into per-agent `agent.yaml` folders. Find it in help via `pnpm yoplai --help` (shows `agents`), then `pnpm yoplai agents --help` (shows `migrate`).

For repo-local dev, `pnpm init-dev-config` writes `./.yoplai/yoplai.json` from `scripts/config-template.json`, picking the first free UI port in `3001-3100` and the first free gateway port in `4001-4100`.

### Built-in extensions

Yoplai v3 is modular. These are the built-in extension IDs you can enable under `extensions`:

- `board`: Board workspace, project projections, activity, and scratchpad tools
- `discord`: Discord guild/DM/forum transport
- `heartbeat`: periodic agent check-ins and alert delivery
- `irc`: native IRC transport
- `langfuse`: stream/history tracing, generations, tool spans, and usage
- `multiUser`: Better Auth + SQLite auth, teams, and per-user isolation
- `orchestrator`: tracker-backed autonomous worker orchestration
- `projects`: areas, project/slice documents, project subagents, and Space workflows
- `scheduler`: recurring cron runner for per-agent `cron/jobs.json` jobs
- `slack`: Slack Socket Mode channel/DM/thread transport
- `subagents`: project-agnostic CLI subagent runtime
- `telegram`: Telegram private/group transport
- `webhooks`: agent HTTP webhook triggers

Most extensions load only when configured under `extensions.<id>`. Discord, Slack, Telegram, IRC, and heartbeat can also load from supported per-agent configuration. Webhooks load when an agent declares `webhooks`.
Inbound Slack and Discord messages now append a normalized `[CHANNEL CONTEXT]` block to the actual agent system prompt. It includes the channel (`slack` or `discord`), place (`#channel`, `#channel / thread`, or `direct message / <peer>`), conversation type, sender, and fallback-filled channel/topic/thread/history fields. The same block is persisted in full history as a system message and forwarded to Langfuse as both trace input and generation `systemPrompt` metadata. First-party gateway/web/CLI messages do not get this block.

### Webhooks

Agents can be triggered by external HTTP webhooks. Configure webhooks in the agent's `agent.yaml`:

```yaml
id: sales
name: Sales
model: { provider: anthropic, model: claude-sonnet-4 }
webhooks:
  notion:
    prompt: "Payload: $WEBHOOK_PAYLOAD"
    langfuseTracing: true
    signingSecret: "$env:NOTION_WEBHOOK_SECRET"
    verification:
      location: payload
      fieldName: verification_token
    maxPayloadSize: 1048576
```

On startup, Yoplai creates `$YOPLAI_HOME/webhook-secrets.json` and logs the full URL:

```text
[webhooks] sales/notion -> http://127.0.0.1:4000/hooks/sales/notion/<secret>
```

`prompt` can be inline text or a `.md`/`.txt` file path relative to the agent workspace; paths outside the workspace are rejected.
Supported interpolation variables: `$WEBHOOK_ORIGIN_URL`, `$WEBHOOK_HEADERS`, `$WEBHOOK_PAYLOAD`.
Each webhook invocation uses a fresh `webhook:<agentId>:<name>:<requestId>` session.
When Langfuse is enabled, webhook traces use surface `webhook` unless `langfuseTracing: false`.
Set `verification` for setup requests that include a known header or payload field, such as Notion's `verification_token`; matching requests return `{ "ok": true, "verification": true }` without signature checks or agent invocation. Requests that do not include the configured field continue through normal webhook handling.
Known GitHub, Notion, and Zendesk webhooks verify HMAC-SHA256 signatures when `signingSecret` is set.
Payloads are capped at `maxPayloadSize` bytes per webhook, defaulting to 1MB.
Example prompt templates live in `docs/examples/webhooks/`.

Rotate a webhook URL secret with:

```bash
yoplai webhooks rotate sales notion
# or: yoplai webhooks rotate sales notion
```

Running gateways pick up rotated secrets without restart.

### Multi-User Mode

Enable multi-user auth with `extensions.multiUser` in `$YOPLAI_HOME/yoplai.json`:

```json
{
  "version": 3,
  "agents": "./agents/*",
  "extensions": {
    "multiUser": {
      "enabled": true,
      "oauth": {
        "google": {
          "clientId": "$env:GOOGLE_CLIENT_ID",
          "clientSecret": "$env:GOOGLE_CLIENT_SECRET"
        }
      },
      "allowedDomains": ["example.com"],
      "sessionSecret": "$env:BETTER_AUTH_SECRET"
    }
  }
}
```

Required config:

- `extensions.multiUser.enabled: true`
- `extensions.multiUser.oauth.google.clientId`
- `extensions.multiUser.oauth.google.clientSecret`
- `extensions.multiUser.sessionSecret`
- `extensions.multiUser.allowedDomains` if you want to restrict signups by email domain

Bootstrap flow:

1. Set Google OAuth credentials and `BETTER_AUTH_SECRET`, then restart the gateway.
2. Gateway creates `$YOPLAI_HOME/auth.db`, runs Better Auth migrations, and mounts `/api/auth/*`.
3. The first Google OAuth user becomes `admin`.
4. That admin approves later signups and manages roles at `/admin/users`.
5. Admins manage agent access by assigning agents to teams at `/teams`; any user can chat an agent whose team they belong to.

Roles are `user` / `admin` / `superadmin`. Admins can authorize pending users and reject/approve access from `/admin/users`. Only superadmins can promote/demote roles, start "View as" impersonation, or use chat's full-view mode (thinking blocks, tool call/result detail, model metadata) — regular admins get the same simple chat view as any user.

Notes:

- Multi-user mode adds `/login`, `/api/me`, and `/api/admin/users`.
- Gateway initializes the Better Auth runtime before opening the HTTP listener, so `/api/auth/*` is live as soon as the server starts.
- Sessions/history move to per-user paths under `$YOPLAI_HOME/sessions/users/<userId>/`.
- Headless callers (curl, CI, scripts) can use `yoplai user token create|list|revoke` to mint bearer API keys and call `/api/*` with `Authorization: Bearer <token>` instead of a browser cookie.
- There is no migration for existing single-user session/history data. Treat enablement as a fresh start.

### Extensions

Extensions own optional gateway routes, lifecycle hooks, prompt contributions, and agent tools. Tool-style extensions are config-driven, stateless tool bundles mounted per agent.

- Root `extensions.<id>` holds shared defaults for both first-party and external extensions.
- `agent.yaml` `extensions.<id>` opts an agent into a tool-style extension and can override root defaults. Presence is enough to enable it unless `enabled: false`.
- External extensions load from `extensionsPath` when set, otherwise `$YOPLAI_HOME/extensions` (default `~/.yoplai/extensions`).
- Discovery follows real directories and symlinked extension directories.
- The helper for migrated tool bundles exports from `packages/shared/src/tool-extension.ts`.
- Gateway startup resolves extension secrets, validates configured mounts, warns on missing extension ids, and fails early on invalid config or missing required secrets.
- Agents can define gateway-side secret aliases in `agents/<id>/.env` next to `agent.yaml`. Agent config `$env:` references and extension-tool `ctx.env` both use the resolved per-agent map, with precedence `agent/.env > $YOPLAI_HOME/.env > yoplai.json env > process.env`, so agents can reuse standard names such as `SLACK_TOKEN` without leaking values to other agents.
- Extensions can append system-prompt guidance and expose Zod-object-backed tools to Pi agents. Yoplai includes sanitized extension tool aliases in Pi's tool allowlist so tools like Board scratchpad are callable in-process and in Pi containers. Pi container runs serialize extension prompt/tool metadata and execute tools through `/internal/tools`; sandbox Claude fails loudly if extension tools are configured.
- The Board extension stores user content in `$YOPLAI_HOME` by default. Set `extensions.board.contentRoot` to use a custom content directory. Its `/api/board/projects` endpoint keeps a short in-memory stale-refresh cache for project rows and lifecycle counts; use `?profile=true` to return `X-Profile-Ms`. Project README frontmatter can explicitly attach ad-hoc worktrees with `worktrees: [{"repo":"~/code/yoplai","branch":"feat/example"}]` or path strings.

### OneCLI

Use top-level `onecli` for native gateway/proxy config:

```json
{
  "onecli": {
    "enabled": true,
    "gatewayUrl": "http://localhost:10255",
    "dashboardUrl": "http://localhost:10254",
    "mode": "proxy",
    "ca": { "source": "file", "path": "~/.onecli/gateway/ca.pem" }
  }
}
```

- `gatewayUrl` is required when `onecli` is configured.
- `mode` currently supports only `"proxy"`.
- `ca.source="file"` is used to propagate the same CA path to Node and Python trust env vars.
- Per-agent proxy tokens are set via `onecliToken` on each agent config (see [Agent Options](#agent-options)).
- Claude and Pi agent runs now use scoped proxy env injection when native `onecli` is enabled for that agent.
- Legacy `$secret:` lookup is removed. Use `$env:` for config values and top-level `onecli` for native gateway/proxy wiring.

### Container Isolation

Run agents inside ephemeral Docker containers for per-invocation filesystem, network, and credential isolation. Each agent invocation spawns a fresh container (`docker run -i --rm`) that reads input from stdin and writes output to stdout. The container is removed automatically when it exits.

**When to use this:**

- Multi-tenant deployments where agents must not share filesystems or credentials
- Running untrusted or third-party agent code
- Compliance requirements for credential isolation

**Prerequisites:**

- Docker must be installed and running on the gateway host
- The `yoplai-agent` container image must be built (see below)
- (Optional) OneCLI proxy for credential injection and network egress control

#### 1. Build the agent image

From the repo root:

```bash
docker build -t yoplai-agent:latest -f container/agent-runner/Dockerfile .
```

This builds a `node:22-slim` image with the agent-runner entry point. It does **not** contain any credentials — those are injected at runtime via the proxy or stripped from the input.

#### 2. Enable sandbox for an agent

Add a `sandbox` block to the agent's `agent.yaml`:

```yaml
id: sandboxed-agent
name: Sandboxed Agent
model:
  provider: anthropic
  model: claude-sonnet-4-5-20250929
sandbox:
  enabled: true
```

That's the minimum. All other sandbox settings have sensible defaults.

#### 3. (Optional) Configure global sandbox defaults

Add a top-level `sandbox` block for network and mount security settings:

```json
{
  "sandbox": {
    "sharedDir": "~/agents/shared",
    "network": {
      "name": "yoplai-agents",
      "internal": true
    },
    "mountAllowlist": {
      "allowedRoots": ["~/agents", "~/projects"],
      "blockedPatterns": [".ssh", ".gnupg", ".aws", ".env"]
    }
  }
}
```

OneCLI proxy config lives in the top-level `onecli` block (see [OneCLI](#onecli)) — the container adapter reads from there automatically. Set `onecliToken` on each sandboxed agent so the container authenticates with OneCLI.

#### Per-agent sandbox options

| Field               | Default                            | Description                                                            |
| ------------------- | ---------------------------------- | ---------------------------------------------------------------------- |
| `enabled`           | `false`                            | Enable container isolation for this agent                              |
| `image`             | `yoplai-agent:latest`              | Docker image to use                                                    |
| `network`           | From global `sandbox.network.name` | Docker network name                                                    |
| `memory`            | `2g`                               | Memory limit                                                           |
| `cpus`              | `1`                                | CPU limit                                                              |
| `maxRunTime`        | `1800`                             | Max seconds before the container is stopped and killed                 |
| `timeout`           | _(legacy alias)_                   | Deprecated; equivalent to `maxRunTime` when `maxRunTime` is unset      |
| `workspaceWritable` | `false`                            | Allow the agent to write to its workspace mount                        |
| `env`               | `{}`                               | Extra environment variables (secret values are automatically filtered) |
| `mounts`            | `[]`                               | Additional bind mounts (validated against the allowlist)               |

Sandbox containers also inherit safe top-level `yoplai.json.env` entries. Per-agent `sandbox.env` is applied on top.

#### How it works

When `sandbox.enabled` is `true`, the gateway replaces the normal in-process agent run with a container spawn:

1. Gateway builds Docker args and bind mounts from the agent + global config
2. Spawns `docker run -i --rm --name yoplai-agent-<id>-<ts> ...`
3. Writes a `ContainerInput` JSON payload to the container's stdin
4. Agent-runner inside the container executes the agent turn (Pi SDK or Claude CLI)
5. Container writes structured output to stdout between sentinel markers
6. Gateway parses the output and routes the response to the client
7. Container is removed on exit (`--rm`)

The public adapter remains `getContainerAdapter()`, with internal container modules for launch specs, protocol framing, input building, file output registration, and extension tool bridging.

**Follow-up messages** while a container is running are delivered via filesystem IPC — the gateway writes JSON files to a bind-mounted input directory that the agent-runner polls.

**Orchestration tools** (subagent spawn, project CRUD) call back to the gateway's `/internal/tools` endpoint from inside the container.

**Extension tools** are serialized into `ContainerInput.extensionTools` by the gateway and executed through `/internal/tools`. Extension system-prompt contributions are serialized through `ContainerInput.extensionSystemPrompts`.

#### Network and credential model

With the default `--internal` Docker network, containers have **no direct internet access**. All outbound HTTPS (LLM API calls, connector calls) is routed through the OneCLI proxy, which injects per-host credentials. **No credentials ever exist inside the container** — no env vars, no files, no mounted configs.

If you don't use OneCLI, containers can still run but will need direct network access (set `internal: false` or override the per-agent `network`).

#### Security features

- **Ephemeral containers**: fresh environment every invocation, no persistent state
- **Read-only workspace**: agent identity files (SOUL.md, skills) are mounted read-only by default
- **`.env` shadowing**: if the workspace contains a `.env` file, it is shadowed with `/dev/null` inside the container
- **Top-level config env propagation**: safe `yoplai.json.env` entries are forwarded into sandbox containers
- **`sandbox.env` filtering**: secret-looking env vars (keys containing KEY/SECRET/TOKEN/etc., values starting with `sk-`/`ghp_`/etc.) are automatically stripped
- **Mount allowlist**: custom mounts are validated against `sandbox.mountAllowlist.allowedRoots` and blocked if they match `blockedPatterns`
- **Path traversal prevention**: container mount paths with `..` or non-absolute paths are rejected
- **Unprivileged execution**: containers run as non-root (`--user <uid>:<gid>`)
- **Orphan cleanup**: stale containers from crashed runs are cleaned on gateway startup and shutdown
- **Graceful shutdown**: SIGTERM/SIGINT stops all running containers before the gateway exits

#### Startup behavior

On gateway startup, if any agent has `sandbox.enabled: true`:

1. The Docker network is created (if it doesn't exist): `docker network create --internal yoplai-agents`
2. Stale containers from previous runs are removed: `docker rm -f` all `yoplai-agent-*` containers

On gateway shutdown (SIGTERM/SIGINT), all running sandbox containers are stopped.

## Starting the app

```bash
# Build & run
pnpm build && pnpm build:web
pnpm yoplai gateway
```

Open http://localhost:3000

## Project Structure

```
apps/
  gateway/    # Server, CLI, agent runtime, opt-in components
  web/        # Solid.js chat UI
packages/
  extensions/ # First-party gateway extensions
  shared/     # Types & schemas
```

## Web UI Navigation

- Single unified left sidebar (`LeftNavShell`/`AgentSidebar`) wraps every route — `/`, `/projects`, `/agents`, `/teams`, `/agents/:id/edit`, `/admin/users`, and `/chat/:agentId`. Primary links are capability-driven; `Admin` (→ `/admin/users`) is visible only to admin/superadmin. The sidebar logo shows custom org branding when configured, otherwise the default "Yoplai" wordmark — never both.
- Main route: `/` for Areas overview (new homepage)
- Areas homepage supports quick area creation with auto-generated ids and color picker selection
- Project routes: `/projects` shows the cached Board-backed Projects kanban (`Triage`, `Shaping`, `Active`, `Ready to merge`, `Done`), `/projects/archive` groups archived and cancelled projects, and `/projects/:id` reuses the Board-style project detail (`Pitch`, `Slices`, `Thread`, `Activity`) with the global left nav. The Projects create form stores the initial idea in `README.md` for shaping agents to turn into `PITCH.md`, exposes an editable repo field, prefills it from the selected area repo, and validates the path on blur without blocking creation. Moving a project to `Shaping` or any `shaping:*` stage requires an explicit project-level repo. The Board extension's `Projects` tab embeds the two-pane Projects Overview with client-side filters/search and worktree run state from `/api/board/projects`
- Right sidebar tabs: `Agents`, `Chat`, `Feed`
- Collapsed left/right sidebars hover-expand as overlays instead of pushing the main content
- Legacy direct-chat agent list remains at `/agents`
- `Archived` button lives in the projects header (top-right) and toggles archived-projects section
- Left sidebar nav is persistent across `/projects`, `/agents`, `/teams`, `/admin/users`, and `/chat/:agentId`
- The full project editor remains available from the overview through `?detail=1`; it opens `ProjectDetailPage` over the overview for Pitch editing, chat, activity, changes, and slice spec work
- Board project detail uses one editable Pitch surface backed by `PITCH.md`; legacy projects without `PITCH.md` display the `README.md` body as fallback while `README.md` remains the frontmatter carrier. Project-level `SPECS.md` files are legacy artifacts and are not surfaced in project detail. The header title can be edited inline from its hover edit icon, saved with Enter/check, or cancelled with Escape.
- Slice detail uses one editable Specs surface backed by `SPECS.md`; legacy slices without `SPECS.md` display the `README.md` body as fallback while slice `README.md` remains the frontmatter carrier. `TASKS.md`, `VALIDATION.md`, and `THREAD.md` remain separate slice tabs; the Thread tab supports adding timestamped comments from the UI, with Cmd/Ctrl+Enter to submit.
- Project detail is mobile/tablet responsive: `<=768px` uses a single-column `Overview | Chat | Activity | Changes | Spec` tabbed view, and `769px-1199px` uses a `280px` left rail with merged center/right tabs
- In `SPECS.md` view, one top-right toggle collapses/expands both Tasks and Acceptance Criteria to free more room for the markdown pane
- Right context panel `Recent` list shows the 5 most recently viewed projects from browser localStorage
- Web UI fetches `/api/capabilities` on boot, hides disabled extension navigation, and lazy-loads optional route bundles only when enabled
- Intercom-style quick chat can be enabled with root config `agentFab: true`; it appears globally as a fixed bottom-right bubble and opens a lead-agent overlay with agent picker, streaming chat, and image attachments
- Lead `ChatView` aborts preserve any assistant text already streamed before `/abort` or the Stop button, then show an `Interrupted` marker instead of dropping the partial reply
- Project-detail UI spawns use name-based session slugs, so the generated session folder follows the displayed agent name instead of a random id
- Project detail center-panel chat keeps `Send` available while a run is active and also shows `Stop` (lead: `/abort`; subagent: interrupt endpoint for codex/claude/pi); subagent follow-ups sent mid-run stay queued in the UI and flush after the active CLI run completes
- Changes tab branch header is expandable: click branch aggregate stats to view per-file pending +/- counts (when available)
- Space Commit Log rows show relative commit age (`now`, `1m`, `2h`, `3d`) beside author metadata

## CLI

```bash
pnpm yoplai gateway [--port 4000] [--host 127.0.0.1] [--agent-id <id>]
pnpm yoplai agent list
pnpm yoplai send -a <agentId> -m "Hello" [-s <sessionId>]

# Notifications CLI (Discord/Slack)
pnpm yoplai notify --channel default --message "Hello" [--from <agentId>] [--surface discord|slack|both] [--mention userId]
# --from resolves bot tokens from agent.yaml; YOPLAI_AGENT_ID is used when --from is omitted.

# Projects CLI (yoplai projects; uses gateway API)
pnpm yoplai projects list [--status <status>]
pnpm yoplai projects create --title "My Project" [pitch] [--pitch <text>|@file|-] [--status <status>] [--area <area>] [--repo <path>]
pnpm yoplai projects get <id>
pnpm yoplai projects update <id> [--title <title>] [--status <status>] [--readme <text>|-] [--specs <text>|-]
pnpm yoplai projects pitch <id> --from-readme [--force]
pnpm yoplai projects move <id> <status>
pnpm yoplai projects start <id> [--agent <cli|yoplai:id>] [--subagent <name>] [--name <run-name>] [--model <id>] [--reasoning-effort <level>] [--thinking <level>] [--mode <main-run|clone|worktree|none>] [--branch <branch>] [--slug <slug>] [--prompt-role <coordinator|worker|reviewer|legacy>] [--allow-overrides] [--include-default-prompt|--exclude-default-prompt] [--include-role-instructions|--exclude-role-instructions] [--include-post-run|--exclude-post-run] [--custom-prompt <text>|-]
pnpm yoplai projects rename <id> --slug <slug> [--name <name>] [--model <id>] [--reasoning-effort <level>] [--thinking <level>]
pnpm yoplai projects status <id> [--slug <slug>] [--list] [--limit <n>] [--json]

# Slices CLI (local filesystem)
pnpm yoplai slices add --project <PRO-N> "Slice title" [specs]
pnpm yoplai slices add --project <PRO-N> "Slice title" --specs <text|@file|->
pnpm yoplai slices specs <sliceId> --from-readme [--force]
pnpm yoplai slices block <sliceId> --on <blockerId>[,<blockerId>...]
pnpm yoplai slices unblock <sliceId> [--from <blockerId>[,<blockerId>...]]

# Agent-folder config migration (v2 -> v3 centralized agents[] to agent.yaml)
pnpm yoplai agents migrate
pnpm yoplai agents --help
pnpm yoplai agents migrate --help

# Projects extension config migration (legacy v1 -> v2 entries)
pnpm yoplai projects config migrate [--config <path>] [--dry-run]
pnpm yoplai projects config validate [--config <path>]

# Note: `projects config migrate` is separate from `agents migrate`.
# v1 -> v2 migration only adds compatibility entries when legacy config explicitly implied them.

# `--subagent <name>` resolves a config-defined subagent from `yoplai.json`.
# The server applies that subagent's locked defaults for harness/model/reasoning/runMode/type.
# Override locked fields only with `--allow-overrides`.
# Lead agents launch with `--agent yoplai:<id>` and use project-scoped sessions.

# Override API URL (highest precedence)
YOPLAI_API_URL=http://127.0.0.1:4000 pnpm yoplai projects list
# Backward-compatible alias
YOPLAI_URL=http://127.0.0.1:4000 pnpm yoplai projects list
# Config file fallback ($YOPLAI_HOME/yoplai.json, default ~/.yoplai/yoplai.json): { "apiUrl": "http://127.0.0.1:4000" }
# Local config commands honor: --config > $YOPLAI_HOME/yoplai.json
# Legacy fallback: YOPLAI_CONFIG still works, but only to derive YOPLAI_HOME with a deprecation warning.
# Dev launchers (`pnpm dev`, `pnpm dev:web`, gateway config loading) honor YOPLAI_HOME too.

# Install the `yoplai` command globally via pnpm link
# From repo root:
pnpm --filter @yoplai/gateway build
pnpm link --global ./apps/gateway

# OAuth authentication (Pi SDK agents)
pnpm yoplai auth login           # Interactive provider selection
pnpm yoplai auth login anthropic # Login to specific provider
pnpm yoplai auth status          # Show authenticated providers
pnpm yoplai auth logout <provider>
```

`yoplai projects move <id> shaping` and `yoplai projects move <id> shaping:<stage>` fail unless the project has an explicit `repo` in its frontmatter. `yoplai projects create --area <area>` copies the area's repo into the new project when the area has one; explicit `--repo` wins.

Project Space model:

- `main-run` executes in project Space (`space/<projectId>` branch, `.../.workspaces/<projectId>/_space` worktree).
- `worktree` and `clone` remain isolated worker sandboxes.
- Worker commits are queued as `pending`; they are cherry-picked only on explicit `POST /api/projects/:id/space/integrate` (UI: Integrate Now).
- Per-entry queue controls are available via:
  - `POST /api/projects/:id/space/entries/skip`
  - `POST /api/projects/:id/space/entries/integrate`
- Changes tab also supports "Rebase on main" (`POST /api/projects/:id/space/rebase`) and space-level conflict fixing (`POST /api/projects/:id/space/rebase/fix`), surfaced through `ProjectSpaceState.rebaseConflict`.
- Conflicts block queue until resolved by the original worker.
- `POST /api/projects/:id/space/conflicts/:entryId/fix` resumes the original conflicting worker with rebase instructions (no new worker/worktree).
- Worker deliveries can include `replaces` metadata (entry IDs or worker slugs) so matching pending entries auto-transition to `skipped`.
- `POST /api/projects/:id/space/merge` merges `space/<projectId>` into base branch, pushes base when a remote exists, optionally cleans worker+Space worktrees/branches, clears queue, and marks project `status: done`.
- On re-delivery after a conflict, gateway updates the original conflict entry in-place and clears `integrationBlocked`.
- Queue statuses: `pending`, `integrated`, `conflict`, `skipped`, `stale_worker`.
- Stale handling: clone deliveries can be marked `stale_worker`; worktree runs can auto-rebase with `YOPLAI_SPACE_AUTO_REBASE=true`.
- Optional write lease (`YOPLAI_SPACE_WRITE_LEASE=true`) enforces exclusive `main-run` writer access via project `space-lease.json`.

Project subagent CLIs:

- Supported: `claude`, `codex`, `pi`
- List configured runtime profiles with `yoplai subagents profiles` or `yoplai subagents profiles --json`.
- Removed: `droid`, `gemini` (API returns validation error)
- Lead agents continue to run through the embedded Pi SDK; project subagents run as external CLIs.

## SPECS Task/Acceptance Format

Slice Specs views parse `SPECS.md` with a specific markdown shape for `## Tasks` and `## Acceptance Criteria`.
Both sections now support optional `###` subgroup headings for organization.
The coordinator prompt also reminds agents to use this parse-safe format when updating `SPECS.md`.
Coordinator prompts now include:

- Canonical main repository path (not worker clone/worktree paths).
- Project Space worktree path (`.workspaces/<projectId>/_space`) for integration context.
- Available config-defined subagent types from `yoplai.json`.
- `yoplai projects` delegation preflight (`command -v yoplai && yoplai projects --version`) before `yoplai projects start --subagent ...`.
- `yoplai projects start --subagent <name>` delegation examples that avoid locked flags unless `--allow-overrides` is set, plus a reminder to choose an exact configured subagent name from `## Available Subagent Types` (or inspect Yoplai config first if none are listed).
- Post-run comment instructions use `--author <your name>`; the deprecated Cloud/openclaw follow-up step was removed.
  `yoplai slices comment` also accepts `--author <name>` for slice THREAD.md attribution.
  Shell tool cards show a warning callout (`No output captured`) when exec/bash output is structurally empty.
  Worker/reviewer prompts remain scoped to their run workspace (`clone`/`worktree`/`main-run`/`none`).
  Worker prompts explicitly require committing implementation once checks pass.

Repo resolution for subagent runner modes (`clone`/`worktree`/`main-run`) now falls back to the project area's `repo` when project `frontmatter.repo` is unset.

Use exact `## Tasks` and `## Acceptance Criteria` headings; optional `###` subgroup headings are supported within either section.

## OAuth Authentication

Pi SDK agents can use OAuth tokens instead of API keys. Supported providers: `anthropic`, `openai-codex`, `github-copilot`, `google-gemini-cli`, `google-antigravity`.

```bash
# Login once
pnpm yoplai auth login anthropic

# Configure agent to use OAuth
```

```yaml
# agents/my-agent/agent.yaml
id: my-agent
name: My Agent
auth: { mode: oauth }
model: { provider: anthropic, model: claude-opus-4-5 }
```

```bash
# Login once (OpenAI Codex)
pnpm yoplai auth login openai-codex

# Configure agent to use OAuth with OpenAI Codex
```

```yaml
# agents/my-agent/agent.yaml
id: my-agent
name: My Agent
auth: { mode: oauth }
model: { provider: openai-codex, model: gpt-5.3-codex-spark }
```

**API Key auth (e.g. OpenRouter):**

```json
// $YOPLAI_HOME/yoplai.json
{
  "version": 3,
  "agents": "./agents/*",
  "env": { "OPENROUTER_API_KEY": "sk-or-..." }
}
```

```yaml
# agents/my-agent/agent.yaml
id: my-agent
name: My Agent
auth: { mode: api_key }
model:
  provider: openrouter
  model: anthropic/claude-sonnet-4
```

Credentials stored in `$YOPLAI_HOME/auth.json` (default: `~/.yoplai/auth.json`). Tokens auto-refresh when expired.

## OpenClaw SDK

Connect to an [OpenClaw](https://github.com/openclaw/openclaw) gateway to use an OpenClaw agent from Yoplai. This allows you to interact with OpenClaw agents through the Yoplai web UI.

If you use the `sessionKey: agent:main:main`, then it while share the same conversation context. The first two elements must match the configured agents in OpenClaw, e.g. if you configured a `main` agent, the session key must start with `agent:main:`, otherwise it will create a new agent profile in `~/.openclaw`. The third key is how control the behavior. Using `main` will continue in the OpenClaw main session, while anything else will create a new session id `third_key-openclaw`.

```yaml
# agents/cloud/agent.yaml
id: cloud
name: Cloud
sdk: openclaw
openclaw:
  gatewayUrl: ws://127.0.0.1:18789
  token: your-openclaw-gateway-token
  sessionKey: agent:main:main
model: { provider: openclaw, model: claude-sonnet-4 }
```

| Field                 | Description                                                             |
| --------------------- | ----------------------------------------------------------------------- |
| `openclaw.gatewayUrl` | WebSocket URL of the OpenClaw gateway (default: `ws://127.0.0.1:18789`) |
| `openclaw.token`      | Gateway authentication token (from your OpenClaw config)                |
| `openclaw.sessionKey` | Target session key to connect to                                        |

**Finding the session key:**

Run `openclaw sessions list` on the OpenClaw side to see available sessions:

```bash
openclaw sessions list
# Output shows session keys like: agent:main:main, agent:main:whatsapp:..., etc.
```

**Notes:**

- `model` is still required for schema validation
- The `model` field doesn't control the actual model (that's configured in OpenClaw) - it's just for display/validation
- Set `OPENCLAW_DEBUG=1` environment variable to log WebSocket frames for debugging

## API

| Endpoint                                         | Method          | Description                                           |
| ------------------------------------------------ | --------------- | ----------------------------------------------------- |
| `/api/agents`                                    | GET             | List agents                                           |
| `/api/agents/:id/messages`                       | POST            | Send message                                          |
| `/api/agents/:id/history`                        | GET             | Session history (?sessionKey=main&view=simple\|full)  |
| `/api/schedules`                                 | GET/POST        | List/create schedules                                 |
| `/api/schedules/:agentId/:id`                    | PATCH/DELETE    | Update/delete schedule                                |
| `/api/schedules/:agentId/:id/run`                | POST            | Run schedule immediately                              |
| `/api/projects`                                  | GET/POST        | List/create projects                                  |
| `/api/projects/:id`                              | GET/PATCH       | Get/update project                                    |
| `/api/projects/:id/space`                        | GET             | Get project Space state                               |
| `/api/projects/:id/space/integrate`              | POST            | Resume/pick pending Space queue                       |
| `/api/projects/:id/space/entries/skip`           | POST            | Mark selected pending Space entries as skipped        |
| `/api/projects/:id/space/entries/integrate`      | POST            | Integrate selected pending Space entries              |
| `/api/projects/:id/space/merge`                  | POST            | Merge Space into base branch (`cleanup` default true) |
| `/api/projects/:id/space/commits`                | GET             | Get Space commit log                                  |
| `/api/projects/:id/space/contributions/:entryId` | GET             | Get per-entry contribution details                    |
| `/api/projects/:id/space/conflicts/:entryId/fix` | POST            | Resume original conflicted worker                     |
| `/api/projects/:id/space/lease`                  | GET/POST/DELETE | Read/acquire/release Space write lease (flagged)      |
| `/api/projects/:id/changes`                      | GET             | Get project changes (Space-first source)              |
| `/api/projects/:id/commit`                       | POST            | Commit project changes in resolved source             |
| `/api/projects/:id/pr-target`                    | GET             | Get compare URL for PR creation from current branch   |
| `/ws`                                            | WS              | WebSocket streaming (send + subscribe)                |

Project API details: `docs/projects_api.md`

## Configuration

`$YOPLAI_HOME/yoplai.json` (default: `~/.yoplai/yoplai.json`) stores global settings and agent discovery globs:

```json
{
  "version": 3,
  "agents": "./agents/*",
  "sessions": { "idleMinutes": 360 },
  "gateway": { "port": 4000, "bind": "tailnet" },
  "extensions": {
    "scheduler": { "enabled": true },
    "projects": { "root": "~/projects" }
  },
  "ui": { "port": 3000, "bind": "loopback" },
  "env": { "OPENROUTER_API_KEY": "sk-or-..." }
}
```

Each matched workspace must contain `agent.yaml`:

```yaml
id: agent-1
name: Agent One
model:
  provider: anthropic
  model: claude-sonnet-4-5-20250929
reasoning: off
queueMode: queue
system_files:
  - SOUL.md
  - USER.md
```

The `id` must match the workspace folder name. The workspace directory is the directory containing `agent.yaml`.

Project lead-session titles can be generated with `extensions.sessions.autoTitleModel`; when omitted, Yoplai uses the cheapest available Anthropic Haiku model and refuses Opus/thinking models for title generation.

### Agent Options

| Field              | Description                                                                          |
| ------------------ | ------------------------------------------------------------------------------------ |
| `id`               | Unique identifier                                                                    |
| `name`             | Display name                                                                         |
| `system_files`     | Ordered prompt files; `AGENTS.md` is always prepended when present                   |
| `sdk`              | Agent SDK: `pi` (default), `claude`, or `openclaw`                                   |
| `model.provider`   | Model provider (required for Pi SDK)                                                 |
| `model.model`      | Model name                                                                           |
| `model.base_url`   | API proxy URL (Claude SDK only)                                                      |
| `model.auth_token` | API auth token (Claude SDK only, overrides env)                                      |
| `auth.mode`        | `oauth`, `api_key`, or `proxy` (Pi SDK only)                                         |
| `reasoning`        | off, minimal, low, medium, high, xhigh; `thinkLevel` is a deprecated alias           |
| `queueMode`        | `queue` (inject into current run) or `interrupt` (abort & restart)                   |
| `discord`          | Discord bot config (legacy per-agent; prefer [Channels](#channels) extension config) |
| `slack`            | Slack bot config (per-agent token; see [Channels](#channels) section)                |
| `heartbeat`        | Periodic check-in config (see below)                                                 |
| `dream`            | Nightly self-consolidation config (see [Nightly dreams](#nightly-dreams))            |
| `sandbox`          | Container isolation config (see [Container Isolation](#container-isolation))         |
| `onecliToken`      | Per-agent OneCLI proxy access token (e.g. `"$env:ONECLI_MY_AGENT_TOKEN"`)            |

### Gateway Options

| Field          | Description                                                                    |
| -------------- | ------------------------------------------------------------------------------ |
| `gateway.port` | Gateway port (default: 4000)                                                   |
| `gateway.bind` | `loopback` (127.0.0.1), `lan` (0.0.0.0), or `tailnet` (auto-detect tailnet IP) |
| `gateway.host` | Explicit host (overrides `bind`)                                               |

### UI Options

| Field                      | Description                                                                    |
| -------------------------- | ------------------------------------------------------------------------------ |
| `ui.enabled`               | Auto-start web UI with gateway (default: true)                                 |
| `ui.port`                  | Web UI port (default: 3000)                                                    |
| `ui.bind`                  | `loopback` (127.0.0.1), `lan` (0.0.0.0), or `tailnet` (auto-detect tailnet IP) |
| `ui.tailscale.mode`        | `off` (default) or `serve` (enable HTTPS via `tailscale serve`)                |
| `ui.tailscale.resetOnExit` | Reset tailscale serve on exit (default: true)                                  |

**Tailscale serve (`ui.tailscale.mode: "serve"`):**

- Requires Tailscale installed and logged in
- Both `gateway.bind` and `ui.bind` must be `loopback` (or omitted)
- UI is served at `https://<tailnet>/yoplai/` (base path `/yoplai`)
- Serve must map `/yoplai` -> `http://127.0.0.1:3000/yoplai` and `/api`,`/ws` -> gateway (default `http://127.0.0.1:4000`)
- MagicDNS hostname (e.g. `https://machine.tail1234.ts.net`) only works from other devices
- Local access requires `http://127.0.0.1:<port>` (gateway: 4000, ui: 3000 by default)

### Environment Variables

Set env vars in config (applied at load time, only if not already set):

```json
{
  "env": {
    "OPENROUTER_API_KEY": "sk-or-...",
    "GROQ_API_KEY": "gsk-..."
  }
}
```

Shell env vars take precedence over config values.

Per-agent `.env` files are gateway-side aliases for extension tools. Trusted native adapters that spawn child processes can pass the resolved map as child env without mutating global `process.env`; in-process adapters keep aliases in explicit contexts only. They are not sandbox secret injection: sandbox containers do not receive `$YOPLAI_HOME/.env` or `agents/<id>/.env`, and workspace `.env` files are still shadow-mounted to `/dev/null`.

## Scheduling

Create via CLI:

```bash
# Every hour
yoplai scheduler add my-agent --cron "0 * * * *" --tz UTC \
  -m "Run hourly check"

# Daily at 9am New York time, pinned to a model
yoplai scheduler add my-agent --cron "0 9 * * *" --tz America/New_York \
  -m "Generate standup summary" \
  --provider anthropic --model claude-sonnet-4

yoplai scheduler list --agent my-agent
yoplai scheduler run my-agent <job-id>
yoplai scheduler rm my-agent <job-id> -y
yoplai scheduler tail my-agent <job-id>
```

Jobs live in `<agent-workspace>/cron/jobs.json`; each run writes hybrid markdown output under `<agent-workspace>/cron/output/<job-id>/`. Optional job-level `model: { provider, model }` overrides the agent default for scheduled fires. Manual `scheduler run` fires use the same execution path and output location as cron fires, work even when the job is disabled, and do not change the next scheduled fire time. A second run of the same job is rejected while that job is already executing; if a scheduled fire collides with a manual run of the same job, that scheduled fire is skipped and the next cron fire is recomputed. When scheduler is enabled, agents also get self-only scheduler tools to create/list/update/delete jobs and read latest output. Gateway polls config, agent YAML, and cron job files every 5 seconds for hot reload.

Or directly via the HTTP API:

```bash
curl -X POST localhost:4000/api/schedules -H "Content-Type: application/json" -d '{
  "name": "Hourly check",
  "agentId": "my-agent",
  "schedule": { "cron": "0 * * * *", "tz": "UTC" },
  "model": { "provider": "anthropic", "model": "claude-sonnet-4" },
  "payload": { "message": "Run hourly check" }
}'

curl -X POST localhost:4000/api/schedules/my-agent/<job-id>/run
```

## Nightly dreams

Agents opt in to a nightly self-consolidation run through their `agent.yaml`. A dream reads sessions since its last successful run, stages transcripts under `dreams/sessions/`, and asks the agent to consolidate durable lessons. Its journals and state live in `dreams/`.

```yaml
# agent.yaml
dream: true # runs daily at 00:00 using the agent's configured model

# Or choose a time and a dedicated model:
dream:
  enabled: true
  time: "02:30"
  provider: anthropic
  model: claude-sonnet-4
```

`provider` and `model` must be set together. Dreaming is disabled unless configured. Trigger a run immediately, or inspect its input window without modifying the workspace:

```bash
yoplai dream my-agent
yoplai dream my-agent --dry-run
```

## Channels

Yoplai supports Discord, Slack, and IRC as messaging channels. Shared transports are opt-in via `extensions` in `yoplai.json`; agents opt in through `agent.yaml`.

### IRC

See [IRC extension setup and configuration](packages/extensions/irc/README.md).

### Discord

Connect your agent to Discord with support for guilds, DMs, reactions, and slash commands.

**Prerequisites:** Create a Discord application at https://discord.com/developers/applications, create a bot, enable **Message Content Intent**, copy the **Bot Token** and **Application ID**, then invite the bot with Send Messages, Read Message History, and Add Reactions permissions.

Inbound Discord messages inject normalized channel context into the real agent system prompt. Thread replies, for example, render `place: #projects / launch-plan`, `conversation_type: thread_reply`, and `sender: <best display name or id fallback>`.

**Basic setup** (bot responds when mentioned):

```json
{
  "extensions": {
    "discord": {
      "enabled": true,
      "token": "$env:DISCORD_BOT_TOKEN",
      "channels": {
        "CHANNEL_1": { "agent": "main", "requireMention": true }
      },
      "dm": { "enabled": true, "agent": "main" }
    }
  }
}
```

Set `"showToolCalls": true` (on `extensions.discord` or per-agent `agent.discord`) to stream the agent's tool calls as live, batched one-line notes in the channel/thread while a turn runs; off by default.

See [docs/discord.md](docs/discord.md) for the full config reference including guild policies, reaction notifications, broadcast mode, per-channel settings, slash commands, and tool-call visibility.

### Slack

Connect your agent to Slack via Bolt.js + Socket Mode (no public URL required). Supports channel messages, DMs, thread replies, reactions, slash commands, inbound file attachments, and outbound agent file uploads.

**Prerequisites:**

1. Create a Slack app at https://api.slack.com/apps
2. Enable **Socket Mode** and generate an **App-Level Token** (`xapp-`) with `connections:write` scope
3. Install the app to your workspace and copy the **Bot Token** (`xoxb-`)
4. Add bot scopes: `app_mentions:read`, `channels:history`, `channels:read`, `chat:write`, `commands`, `files:read`, `files:write`, `im:history`, `im:read`, `im:write`, `reactions:read`, `reactions:write`, `users:read`
5. Enable **Socket Mode** in the app settings

Inbound Slack messages inject the same normalized channel-context block into the real agent system prompt, using Slack display names when available and id fallbacks otherwise.

**Basic setup** (single-agent, all channels):

```json
{
  "extensions": {
    "slack": {
      "enabled": true,
      "token": "$env:SLACK_BOT_TOKEN",
      "appToken": "$env:SLACK_APP_TOKEN",
      "channels": {
        "C01ABCDEF": { "agent": "main" }
      },
      "dm": { "enabled": true, "agent": "main" }
    }
  }
}
```

**Multi-channel routing** with per-channel thread policy and user allowlists:

```json
{
  "extensions": {
    "slack": {
      "enabled": true,
      "token": "$env:SLACK_BOT_TOKEN",
      "appToken": "$env:SLACK_APP_TOKEN",
      "channels": {
        "C01ABCDEF": {
          "agent": "main",
          "requireMention": false,
          "threadPolicy": "always"
        },
        "C02GHIJKL": {
          "agent": "assistant",
          "threadPolicy": "follow",
          "users": ["U01ADMIN", "U02DEV"]
        }
      },
      "dm": {
        "enabled": true,
        "agent": "main",
        "allowFrom": ["U01ADMIN"]
      },
      "broadcastToChannel": "C03BROADCAST"
    }
  }
}
```

#### Slack Config Reference

| Field                          | Description                                                   |
| ------------------------------ | ------------------------------------------------------------- |
| `token`                        | Bot token (`xoxb-`), use `$env:SLACK_BOT_TOKEN`               |
| `appToken`                     | App-level token (`xapp-`), use `$env:SLACK_APP_TOKEN`         |
| `channels`                     | Map of channel IDs to routing config                          |
| `channels.<id>.agent`          | Agent ID to route to                                          |
| `channels.<id>.requireMention` | Require @mention to trigger (default: `true`)                 |
| `channels.<id>.threadPolicy`   | `always` (default), `never`, or `follow`                      |
| `channels.<id>.users`          | Allowed Slack user IDs (empty = all allowed)                  |
| `channels.<id>.reactionNotifications` | `off` (default), `all`, `own`, or `allowlist`            |
| `channels.<id>.reactionAllowlist` | Allowed reacting user IDs when mode is `allowlist`          |
| `dm.enabled`                   | Enable DM support                                             |
| `dm.agent`                     | Agent ID for DMs                                              |
| `dm.allowFrom`                 | Allowed Slack user IDs for DMs (empty = all allowed)          |
| `broadcastToChannel`           | Post non-Slack agent responses to this channel                |
| `historyLimit`                 | Recent messages included as context (default: 20)             |
| `clearHistoryAfterReply`       | Clear history buffer after reply (default: `false`)           |
| `mentionPatterns`              | Additional regex patterns that trigger a response             |
| `showThinking`                 | Show live thinking text in a thread reply (default: `false`)  |
| `deleteThinkingOnComplete`     | Delete thinking text when the run completes (default: `true`) |

#### Thread Policy

| Value    | Behavior                                                           |
| -------- | ------------------------------------------------------------------ |
| `always` | Always reply in a thread (default, keeps channels clean)           |
| `never`  | Always reply directly in channel                                   |
| `follow` | Thread if user message was in a thread, otherwise reply in channel |

#### Slash Commands

| Command           | Description                                      |
| ----------------- | ------------------------------------------------ |
| `/new [session]`  | Start new conversation                           |
| `/stop [session]` | Stop current agent run                           |
| `/help`           | Show routing policy and config (ephemeral)       |
| `/ping`           | Health check: agent name, SDK, model (ephemeral) |

Slash commands enforce the same `users` and `allowFrom` allowlists as message routing.
Slack uses `/stop` instead of `/abort`; both route to the same internal abort behavior.

#### Web Chat Context Compaction

The web chat supports `/compact` for agent sessions. Yoplai asks the same agent model to summarize older context, then replaces the stored session with that compacted summary plus the last 8 user/assistant turns. The context usage indicator turns red at 75% and compaction runs automatically before the next send at 80%; if compaction fails at that point, the send is blocked.

#### Slack App Manifest Commands

Add these slash commands to the Slack app manifest so they appear in Slack autocomplete. Replace request URLs with any valid HTTPS URL; Socket Mode delivers commands to Bolt without requiring a public Yoplai URL.

```yaml
features:
  slash_commands:
    - command: /new
      description: Start a new Yoplai conversation
      usage_hint: "[session]"
      should_escape: false
      url: https://example.com/slack/commands
    - command: /stop
      description: Stop the current Yoplai run
      usage_hint: "[session]"
      should_escape: false
      url: https://example.com/slack/commands
    - command: /help
      description: Show Yoplai Slack help
      should_escape: false
      url: https://example.com/slack/commands
    - command: /ping
      description: Check Yoplai bot health
      should_escape: false
      url: https://example.com/slack/commands
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - channels:history
      - channels:read
      - chat:write
      - commands
      - files:read
      - files:write
      - im:history
      - im:read
      - im:write
      - reactions:read
      - reactions:write
      - users:read
settings:
  socket_mode_enabled: true
```

#### Behavior Notes

- **Typing indicator**: Adds/removes `:thinking:` reaction on user message during processing
- **Thinking display**: When `showThinking` is true, posts live-updated `_🧠 Thinking: ..._` text in the message thread
- **Message chunking**: Responses split at 4000 chars, preserving mrkdwn code blocks
- **Single-agent mode**: Omit `channels` config to route all messages to the first configured agent
- **Broadcast**: Subscribe to agent events from other sources (web, CLI, etc.) and post to `broadcastToChannel`
- **Reactions**: Off by default. Set a channel's `reactionNotifications` to `all`, `own`, or `allowlist` to trigger agent runs with reaction context.

#### Per-Agent Tokens

Each agent can have its own Slack bot (own `token`/`appToken` pair) in the same workspace. This lets different agents appear as different bots with different names and avatars:

```yaml
# agents/main/agent.yaml
id: main
name: Main Agent
model: { provider: anthropic, model: claude-sonnet-4 }
slack:
  token: "$env:SLACK_MAIN_BOT_TOKEN"
  appToken: "$env:SLACK_MAIN_APP_TOKEN"
```

```yaml
# agents/assistant/agent.yaml
id: assistant
name: Helper
model: { provider: anthropic, model: claude-sonnet-4 }
slack:
  token: "$env:SLACK_HELPER_BOT_TOKEN"
  appToken: "$env:SLACK_HELPER_APP_TOKEN"
```

Each agent creates its own Slack app at https://api.slack.com/apps with its own bot token and Socket Mode connection. Per-agent `slack` config supports the same fields as the component config (`channels`, `dm`, `historyLimit`, etc.).

**Note:** Per-agent mode and shared-token mode can coexist — agents with `slack` in `agent.yaml` get their own bots, while `extensions.slack` creates an additional shared bot for channel-based routing.

## Heartbeat

Periodic agent check-ins with channel delivery for alerts.

```yaml
# agents/my-agent/agent.yaml
id: my-agent
name: My Agent
model: { provider: anthropic, model: claude-sonnet-4 }
heartbeat:
  every: 30m
  prompt: Check on your human
  ackMaxChars: 300
```

| Field         | Description                                                            |
| ------------- | ---------------------------------------------------------------------- |
| `every`       | Interval (`30m`, `1h`, `0` to disable). Default: `30m`                 |
| `prompt`      | Custom prompt. Falls back to `HEARTBEAT.md` in workspace, then default |
| `ackMaxChars` | Max chars after token strip to still be "ok". Default: 300             |

**How it works:**

1. Agent is prompted at the interval
2. Agent replies with `HEARTBEAT_OK` token if all is well
3. If no token (or substantial content beyond `ackMaxChars`), the reply is delivered to the configured channel as an alert
4. Heartbeat runs don't affect session `updatedAt` (preserves idle timeout)
5. Completed runs write hybrid markdown output to `<agent-workspace>/cron/output/__heartbeat__/` with frontmatter plus prompt/response sections

If the scheduler extension is disabled or unavailable, heartbeat logs a warning and does not run.

## Custom Models

Add custom providers via `$YOPLAI_HOME/models.json` (default: `~/.yoplai/models.json`):

```json
{
  "providers": {
    "my-provider": {
      "baseUrl": "https://api.example.com/v1",
      "apiKey": "PROVIDER_API_KEY", // supports direct env var resolution,
      "models": [{ "id": "my-model", "displayName": "My Model" }]
    }
  }
}
```

Synced to Pi SDK's agent dir on each run.

`pnpm update-models` includes models declared here and in v3 `agent.yaml` files when refreshing web context usage data. If a model has `contextWindow` in `models.json`, that value is used; otherwise the script tries OpenRouter first, then falls back to `https://models.dev/api.json`.

## Skills

Each agent can have their own skills. Skills (and other custom agent resources like commands) should be available to any coding harnesses, therefore, we use a generalized folder name. Therefore, place agent skills in `{agent_workspace}/agent/skills/`

To have them auto-loaded at runtime, they must be placed in the folder expected by the agent harness (currently only Pi). Currently, the process is manual, so for each agent, you need to create a symlink to the `./agent` folder, e.g.:

```bash
# Inside the agent workspace folder
ln -s agent .pi
```

## Development

```bash
pnpm dev          # dev mode: auto-finds ports, disables Discord/scheduler/heartbeat
pnpm dev:gateway  # gateway only with hot reload (no --dev flag, all services enabled)
pnpm dev:web      # web UI only
```

### Remote Web Dev (Projects on Another Machine)

If your web UI runs on machine A but projects live on machine B:

1. On machine B, run gateway and expose it on a reachable interface:

```json
{
  "gateway": {
    "bind": "lan",
    "port": 4000
  }
}
```

2. On machine A, configure the proxy target:

```json
{
  "gateway": {
    "host": "<machine-b-host-or-ip>",
    "port": 4000
  }
}
```

3. On machine A, run `pnpm dev:web` only.

In web dev mode, Vite proxies `/api` and `/ws` to `gateway.host:gateway.port`, so Kanban loads projects from machine B.

Do not run `pnpm dev`, `pnpm dev:gateway`, or `pnpm yoplai gateway` on machine A with a remote `gateway.host`; those commands start a local gateway process that will try to bind that host and can fail with `EADDRNOTAVAIL`.

### `apiUrl` vs `gateway.host`/`gateway.port`

| Setting                         | Used by                                         | Purpose                                                                                                             |
| ------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `apiUrl` (or `YOPLAI_API_URL`)  | `yoplai projects` CLI                           | Direct base URL for CLI HTTP requests                                                                               |
| `gateway.host` + `gateway.port` | Gateway server config; reused by `pnpm dev:web` | Gateway listen host/port for gateway process. In `pnpm dev:web`, these same values are reused as Vite proxy target. |

In short: `apiUrl` controls CLI target. Web app uses relative `/api`/`/ws`; in `pnpm dev:web`, proxy target currently comes from `gateway.host`/`gateway.port`.

### Dev Mode

`pnpm dev` runs with the `--dev` flag, which:

- **Auto-finds free ports** if 4000/3000 are in use (scans up to +50)
- **Disables external services**: messaging transports, scheduler, and heartbeats
- **Skips Tailscale serve** setup
- **Visual indicators**: console banner, `[DEV :port]` browser title, orange sidebar badge

Run multiple dev instances simultaneously - each gets unique ports.

For production-like testing with all services:

```bash
pnpm yoplai gateway  # no --dev flag
```

## Data

- Config: `$YOPLAI_HOME/yoplai.json` (default: `~/.yoplai/yoplai.json`)
- Auth: `$YOPLAI_HOME/auth.json` (OAuth/API key credentials)
- Models: `$YOPLAI_HOME/models.json` (optional)
- Schedules: `<agent-workspace>/cron/jobs.json` and outputs under `<agent-workspace>/cron/output/`
- Session map: `$YOPLAI_HOME/sessions.json` maps logical session keys to runtime session IDs.
- Canonical chat history: `$YOPLAI_HOME/history/*.jsonl`. This is the normalized transcript used by the API, web UI, tracing, compaction, system context rows, and media/file blocks.
- Pi runtime sessions: `$YOPLAI_HOME/sessions/*.jsonl`. These are SDK-owned resume/session files; Yoplai may backfill canonical history from them for legacy sessions or use them as a streaming fallback.
