# Configuration

Yoplai uses v3 configuration: instance settings live in `$YOPLAI_HOME/yoplai.json`, and each agent has its own workspace containing `agent.yaml`.

## Paths and discovery

`YOPLAI_HOME` defaults to `~/.yoplai`. `yoplai.json` is required and is not created automatically.

```json
{
  "version": 3,
  "agents": ["agents/*"],
  "sessions": { "idleMinutes": 360 },
  "gateway": { "bind": "loopback", "port": 4000 },
  "ui": { "enabled": true, "bind": "loopback", "port": 3000 },
  "extensions": {}
}
```

Agent entries may be exact directories or glob patterns relative to config file. Every matched directory must contain flat `agent.yaml`; its `id` must match directory basename. If `agents` is omitted, Yoplai discovers `$YOPLAI_HOME/agents/*`. Yoplai ignores the legacy top-level `pool` key and logs one warning per process.

Migrate old centralized agent records with:

```bash
pnpm yoplai agents migrate
```

## Agent management from the web UI

Use **New agent** on the Agents page to create an agent under
`$YOPLAI_HOME/agents/<id>/`. Open **Agent settings** in its chat to change
its identity, avatar, model, reasoning, instructions, and skills. The model
picker and instruction writer use the gateway's existing run credentials.
Enabling management lets eligible creators use those credentials. If the
model cannot generate instructions, creation uses a template.

| `agentManagement` | Single-user gateway | Multi-user gateway |
| --- | --- | --- |
| Unset | On when the bound gateway listener is loopback | Off by default |
| `false` | Off | Off |
| `true` | On | Admins and superadmins |
| `"admin"` | On | Admins and superadmins |
| `"anyone"` | On | Approved users create and edit their own agents. Staff edit agents they can chat with. |
| `"superadmin"` | On | Superadmins only |

A headless gateway behind a loopback reverse proxy should set
`agentManagement: false` to opt out of the loopback default. Management is
always on for the local single-user desktop gateway. Each linked gateway
applies its own policy. **Create on** offers the gateways where you can
create, and the model picker follows your choice.

When you open the web UI from a LAN address, set `web.baseUrl` to the URL
you use in the browser, including its scheme and port. The gateway checks
that origin on agent management writes.

On a multi-user gateway, a superadmin can change the mode at **Admin →
Agent management**. A value in `yoplai.json` takes precedence and locks
the form. Otherwise the gateway uses the saved mode in
`$YOPLAI_HOME/agent-management.json`, then the default. Saving the mode in
Admin applies immediately.

New multi-user agents start Private to their creator, including when an
admin creates them. Ownership is recorded in `.created-by.json`. Owners
keep chat access when the mode changes. Members can edit and set their
own agents Public in `"anyone"` mode. The **Sharing** switch controls
company-wide chat access. Staff manage team assignments and can use the
switch when they have both edit and visibility permissions. Agents with
no access row are Public by default.

| Skill group | Source | Default and controls |
| --- | --- | --- |
| Global | Built-ins and `skill-library/default` | Always on. A default skill's `.yoplai.json` can restrict which agents receive it. |
| Agent | The agent's workspace `skills/` | On by default. Anyone who can edit the agent can turn a workspace skill off in `skills.disabled` in `agent.yaml`. Multi-user System skills are shown in the sidebar only to superadmins. |
| User | Your own and shared skills | Off by default. Anyone with chat access can enable their own selection for this agent, including in read-only settings. |

Personal skill selections are saved under `agents.<id>` in each user's
`skill-library/users/<user-id>/state.json`. The old `enabled` list is
ignored, so previously enabled personal skills start off for every agent.

## Agent configuration

```yaml
id: agent-1
name: Agent One
description: General assistant
model:
  provider: anthropic
  model: claude-sonnet-4-5
auth:
  mode: oauth
reasoning: medium
queueMode: queue
system_files:
  - PERSONA.md
  - USER.md
extensions:
  scheduler:
    enabled: true
```

Common fields:

| Field                                 | Meaning                                                     |
| ------------------------------------- | ----------------------------------------------------------- |
| `id`                                  | Unique id; must match workspace folder                      |
| `name`                                | Display name                                                |
| `system_files`                        | Ordered prompt files; `AGENTS.md` is prepended when present |
| `sdk`                                 | `pi` (default)                                            |
| `description`, `avatar`              | Optional UI metadata                                        |
| `model.provider`                      | Provider id; required for Pi                                |
| `model.model`                         | Model id                                                    |
| `model.base_url`                      | Claude SDK API/proxy URL                                    |
| `model.auth_token`                    | Claude SDK auth override; prefer `$env:`                    |
| `auth.mode`                           | `oauth`, `api_key`, or `proxy` for Pi                       |
| `auth.profileId`                      | Optional Pi credential profile id                           |
| `reasoning`                           | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`   |
| `thinkLevel`                          | Deprecated alias for `reasoning`                            |
| `queueMode`                           | `queue` or `interrupt`                                      |
| `retryMaxAttempts`                    | Attempts for a transient provider error; default 3          |
| `fallback_model`                      | Optional fallback `{ provider, model }`                     |
| `modelRouting`                        | Pi chat opt-in; defaults disabled, optional `categories`; see [routing guide](model-routing.md) |
| `retryBaseDelay`                      | Initial retry delay in seconds; default 2                   |
| `introMessage`                        | Custom message shown after `/new`                           |
| `discord`, `slack`, `telegram`, `irc` | Supported per-agent transport config                        |
| `heartbeat`, `dream`, `webhooks`      | Periodic and webhook-triggered behavior                     |
| `reflect`                             | `true` or `{ enabled, cadence, provider, model, timeoutMs }`. Adds a self-improvement prompt so the agent saves lessons in the same turn. Off by default. Only `enabled` has an effect now; the other fields are reserved |
| `extensions`                          | Per-agent extension opt-ins/overrides and channel settings |
| `globalSkills`                        | Include global agent skills when true                       |
| `sandbox`                             | Per-agent Docker isolation settings                         |
| `onecliToken`                         | Per-agent OneCLI proxy token, usually `$env:...`            |

On first run Yoplai creates missing `AGENTS.md` and `USER.md` without overwriting existing files. Custom prompt files such as `PERSONA.md` in the example above must be created explicitly and listed in `system_files`.

Mattermost, Slack and Telegram settings may also live under `extensions.mattermost`, `extensions.slack` and `extensions.telegram` in `agent.yaml`. The loader validates these blocks and exposes them to the per-agent bots; an existing top-level channel block takes precedence. A nested `enabled: false` prevents that bot from starting after a restart, unless a top-level block exists. Incomplete settings leave the agent available and log only the invalid field paths. Tokens may remain `$env:NAME` references resolved from the agent's `.env`; no file migration is needed.

Pi turns that fail on a transient provider error (rate limit, 5xx, queue/backpressure hint, connection reset) are retried in place, on the host and inside the sandbox alike. Retry delays double after each attempt unless the provider supplies a `Retry-After` hint. Eligibility is per turn, not per run: only the failed assistant turn is dropped from the model context, then the run resumes in place, so tool calls and results from earlier turns are preserved and the user message is never re-sent. Partial text streamed by the failed turn is discarded with it. The dropped turn stays in the session transcript for history.

### Updating instructions from chat

Ask a Pi agent explicitly to change its instructions, for example, "From now on, always answer in French." The agent uses gateway tools to write on the host; sandbox mounts of `AGENTS.md` and `agent.yaml` remain read-only.

| Tool | Replaces | Allowed requester |
| --- | --- | --- |
| `agent_update_instructions({ expected, content })` | The calling agent's own `AGENTS.md` | Admin or superadmin |
| `shared_update_system_file({ file, expected, content })` | An existing Markdown file directly in `$YOPLAI_HOME/shared` | Superadmin only |

The single-user operator counts as a superadmin. In multi-user mode, the run must identify an eligible account; an admin may change instructions for any agent they can chat with. Plain users must ask an admin, and shared-file changes require a superadmin.

Both tools require a human chat source (`web`, `slack`, `discord`, `telegram`, `mattermost`, `irc`, or `threadit`) with no agent sender. Scheduled jobs, webhooks, heartbeats, dreams, orchestrator runs, and agent-to-agent turns are refused. Human replies in bound Slack and Mattermost threads remain eligible even when the run is marked `background`.

IRC trusts configured `humanNicks` as the user in single-user mode; nicknames are not authenticated. All other IRC authors are treated as agent senders and refused.

Multi-user changes currently require the web app or Slack with a linked eligible account. Discord, Mattermost, Telegram, IRC, and Threadit do not supply a platform account ID; these surfaces must use the web app or ask an admin. Single-user mode works on every listed chat surface.

`expected` is the full current file text and `content` the full replacement. A stale `expected` refuses the write: re-read and retry. A missing `AGENTS.md` can be created with `expected: ""`. Shared `file` must be a bare `.md` filename: no paths, `..`, new files, or symlink escapes. This shared folder is separate from the sandbox's `/shared` mount setting.

Successful calls return a unified diff; shared-file results also identify every configured agent that loads the file. Web chat shows the diff in the tool block; agents confirm the changed file in one short reply on messaging surfaces. Updated instructions and shared files apply on the next turn without a reload. Agents change these files only on an explicit user request; lessons still belong in skills or `memory.md`.

Deployments that copy repository files such as `config/shared/*.md` into `$YOPLAI_HOME/shared` overwrite chat edits on the next deploy; these tools do not push changes back to that repository.

## Environment and secrets

Use shell environment, `$YOPLAI_HOME/.env`, or agent-local `.env`; reference values as `$env:NAME`.

```dotenv
# $YOPLAI_HOME/.env
OPENROUTER_API_KEY=...
```

Provider SDKs and `$env:OPENROUTER_API_KEY` config references can resolve that value. Agent-local resolution precedence is agent `.env`, `$YOPLAI_HOME/.env`, `yoplai.json` `env`, then `process.env`. Shell variables already present are not overwritten by root config. Agent-local values are gateway-side aliases and extension context; do not assume they enter global process or sandbox environment.

Never commit `.env`, `auth.json`, agent credentials, bot tokens, or webhook secrets. `$secret:` support was removed; use `$env:`.

## Root configuration reference

Core `yoplai.json` fields:

| Field                                | Meaning                                                             |
| ------------------------------------ | ------------------------------------------------------------------- |
| `version`                            | Config version; current value is `3`                                |
| `agents`                             | Agent directory or glob, or array of them                           |
| `defaultProjectManager`              | Preferred board/project lead agent id                               |
| `gateway`, `ui`, `server`, `web`     | Network and public/base URL settings                                |
| `canvas`                             | Dashboard serving (`enabled`, optional public `baseUrl`)            |
| `apps`                               | Isolated MCP Apps origin and listener port                         |
| `sessions.idleMinutes`               | Logical-session idle rotation; default 360                          |
| `agentLoop`                          | Agent-to-agent loop limits (`maxAgentTurns`, `maxHops`)             |
| `extensions`                         | Built-in/external extension configuration                           |
| `extensionEnvAllowlist`              | Optional array of shared env names allowed in agent extension blocks |
| `extensionsPath`                     | External extension directory; defaults to `$YOPLAI_HOME/extensions` |
| `sandbox`, `onecli`, `oauth`         | Isolation (incl. `sandbox.gatewayTransport`: `http`/`socket`), proxy, and host OAuth settings |
| `maintenance`                        | Model for gateway-owned background LLM tasks                        |
| `modelRouting`                       | Session routing classifier/table; `mode` defaults `off`; see [routing guide](model-routing.md) |
| `modelQuota`                         | Host subscription polling; `enabled` defaults `false` (restart required); see [quota ownership](model-routing.md#poller-ownership-per-host) |
| `branding`                           | Optional organization name/logo/icon                                |
| `notifications.channels`             | Named Discord/Slack/Mattermost delivery targets                     |
| `dream`                              | Global nightly-consolidation prompt/timeout/window                  |
| `env`                                | Lowest-precedence instance env values; prefer `.env` for secrets    |
| `taskboard`, `projects`, `subagents` | Legacy/compatibility config surfaces; prefer owning extensions      |

Schema in `packages/shared/src/types.ts` is final source of truth. Extension-specific fields belong in [Extensions](extensions.md) and owning package READMEs.

### Extension environment references

An `agent.yaml` setting under `extensions.<id>` can use `$env:NAME` when
`NAME` is defined in that agent's workspace `.env` or listed in the shared
`extensionEnvAllowlist` in `yoplai.json`. Add names from the gateway process
environment, the gateway home `.env`, or `yoplai.json` `env` to the allowlist
when an agent extension needs to use them. At load, the gateway drops each
disallowed setting or array entry and logs the agent, extension, and env name.
Agent root fields and gateway-wide extension settings keep their usual
environment resolution.

### Branding

```json
{
  "branding": {
    "name": "Acme AI",
    "logo": "branding/logo.svg",
    "icon": "branding/icon.png"
  }
}
```

Paths are relative to `$YOPLAI_HOME`. The icon should be a square PNG of at least 512px. Yoplai uses it for the browser favicon, the Safari and iOS app icon, and the web app manifest.

### Maintenance model

Gateway-owned work such as core session titles uses `maintenance` when set:

```json
{
  "maintenance": {
    "provider": "anthropic",
    "model": "claude-haiku-4-5"
  }
}
```

Both fields are required. The Pi model runtime resolves its credentials from an existing OAuth login, a stored API key, or the provider's host environment key; OneCLI is not used. When omitted, maintenance work uses the session agent's configured model.

### Image generation

Set `imageGeneration` at the top level of `yoplai.json` to enable the `generate_image` tool for every agent, including sandboxed, scheduled, and background runs. Omit the setting or set `enabled: false` to hide the tool. A configured entry defaults to `enabled: true`.

```json
{
  "imageGeneration": { "provider": "openai-codex" }
}
```

This uses the gateway's connected ChatGPT OAuth account and defaults to `gpt-image-2`. The account's image quota is shared across agents. The Codex image endpoint is undocumented and may change or restrict access.

For another backend, set both `provider` and `model` to an image-generation entry in the Pi catalog, such as OpenRouter's `google/gemini-3.1-flash-image-preview`. The gateway resolves that provider's credentials independently of the agent's chat model.

Generated images are saved in the conversation files folder. The agent calls `send_file` to preview the image in chat and can reuse the saved path. Each revised prompt generates a fresh image. Failures are final for that call, with no model fallback. Codex errors distinguish quota exhaustion, a missing or expired connection, and rejected access. Other provider errors use a fixed message that omits backend response text.

### Model routing

Model routing chooses and durably locks a model for eligible chat sessions of opted-in Pi agents. `off` (the default) bypasses routing, `shadow` records a pick while keeping the usual model, and `enforce` applies enforce-mode locks. Shadow locks are never promoted. See the [routing guide](model-routing.md) for eligibility, quota policy, failure behavior, rollout and rollback.

Merge the top-level `modelRouting` object from [the example configuration](examples/model-routing.json) into `yoplai.json`. It contains a versioned, global table of 13 categories. Each row has `id`, `definition`, `examples`, two `{ provider, model, effort }` picks (`claude` and `chatgpt`), and a `pool` preference: `either`, `prefer_claude`, or `prefer_chatgpt`. Picks use Pi provider/model identifiers and supported reasoning levels (`off` rather than `none`). Loading and hot reload check the structural schema, including duplicate category IDs. For active routing, startup additionally checks catalog models, supported efforts, floor and agent category references, and that each opted-in agent retains at least two categories; these cross-configuration checks do not run on hot reload.

| Setting | Default | Meaning |
| --- | --- | --- |
| `mode` | `off` | Routing stage: `off`, `shadow`, or `enforce` |
| `version` | `unversioned` | Operator-supplied table version |
| `classifier` | `{ "provider": "openai", "model": "gpt-6-luna" }` | Pi classifier model, using OpenAI's classifier operation |
| `thresholds.score` | `0.8` | Minimum confident category score |
| `thresholds.pace` | `1.15` | Above this weekly pace, switch away from a preferred pool when both pools have known quota |
| `budgets.predicateMs` | `2000` | Predicate deadline in milliseconds |
| `budgets.categoryMs` | `4000` | Category deadline in milliseconds |
| `maxRetries` | `1` | Bounded retry count, `0`–`2`, within the stage deadline |
| `floor` | support, office, writing, single-tool categories | Category IDs retained in restricted agent category sets |
| `table` | `[]` | Global category definitions and model picks |

The exact default floor is `customer_support_reply`, `office_deliverable`, `writing_marketing`, and `single_tool_call`; each must exist in an active table. Agents may opt in and optionally restrict their categories in `agent.yaml`:

```yaml
modelRouting:
  enabled: true
  categories: [office_deliverable, single_tool_call, web_research]
```

Omitting `categories` uses the global table; an explicit list is combined with the floor. Omitting the per-agent `modelRouting` object leaves routing disabled; when present, it requires an `enabled` boolean. Only opted-in Pi chat turns route; other agents and automation keep their configured model.

The classifier requires `OPENAI_API_KEY` in the gateway process environment, including values loaded from `$YOPLAI_HOME/.env`. Agent-local credentials and ChatGPT/Codex subscription OAuth do not authenticate this classifier. Missing credentials, timeouts, invalid responses, and exhausted retries return an unavailable result so callers can retain the configured agent model; no vendor request is needed for table validation.

Routing mode and agent opt-in changes apply to following turns after hot reload (default mtime polling interval: 5000 ms); running turns are not interrupted. Catalog/effort/category validation runs at startup only, so restart after table changes and for the first switch to `enforce`. `off` retains durable locks, and re-enabling enforcement resumes stored enforce locks.

Root `modelQuota: { "enabled": true }` starts this host's OAuth subscription pollers at gateway startup; omitting it or setting `enabled: false` leaves polling off. Changing it requires restart. Passive Claude quota-header capture runs either way. The store is in memory and local to this gateway; see [poller ownership and host separation](model-routing.md#poller-ownership-per-host). On an `either` routing row, unknown/stale quota locks the usual model; a preferred row may keep its preference.

The example merges Pom's per-agent definitions into one global definition per category and deduplicates examples across agents. Review these definitions before rollout: a CRM record list or a simple Excel export remains `single_tool_call`, while an authored report, analytical spreadsheet, or deck is `office_deliverable`. Gordon's base picks map to `anthropic`/`openai-codex`; the pinned offline Pi catalog lacks `gpt-6.1-terra`, so the example uses `gpt-5.6-terra`. `edit_agent_dashboard` copies the office picks with `prefer_claude`; `lead_contact_lookup` copies the single-tool picks with `either`.

Source pool guidance with conditions is flattened into one preference: support and web research prefer ChatGPT; writing, office work, summaries, SaaS workflows, hard reasoning, orchestration, and dashboards prefer Claude; the remaining categories use either pool. In particular, summary input length, workflow risk, high-stakes exceptions, and orchestration worker placement are guidance for operator review rather than executable conditions in this table.

### Notification channels

Named channels are referenced by scheduler, project orchestration, and `yoplai notify`:

```json
{
  "notifications": {
    "channels": {
      "default": { "slack": "C0123456789", "mattermost": "abcdefghijklmnopqrstuvwxyz" },
      "alerts": { "discord": "1234567890" }
    }
  },
  "extensions": {
    "mattermost": {
      "url": "$env:MATTERMOST_URL",
      "token": "$env:MATTERMOST_BOT_TOKEN"
    }
  }
}
```

`mattermost` is a channel ID (normally 26 characters), not a channel name. For example, `MATTERMOST_URL` can be `https://mattermost.example.com`. Mattermost uses the `--from` agent's top-level `mattermost` block when present, otherwise root `extensions.mattermost`; its `url` and `token` always come from the same block. Both accept `$env:NAME` references, including agent-local env values.

The default notify surface, `all`, sends to every surface with an ID on the channel key; `both` remains an alias of `all`. Explicit `discord`, `slack`, or `mattermost` selects only that surface. A configured surface with missing credentials returns a failed result; the overall notification succeeds if any surface succeeds. `notifications.adminChannel` can name a Mattermost channel key for provider-quota alerts, and orchestrator HITL channels use these same targets.

## Extensions

Root `extensions.<id>` configures and loads extension. Tool-style extensions additionally require agent `extensions.<id>` opt-in unless documented otherwise.

```json
{
  "extensions": {
    "projects": { "enabled": true, "root": "~/projects" },
    "scheduler": { "enabled": true }
  }
}
```

See [Extensions](extensions.md).

### Extension catalog

The `extensionCatalog` setting in `yoplai.json` controls the catalog.

| Setting | Meaning |
| ------- | ------- |
| `extensionCatalog.enabled` | Defaults to `true`. Set it to `false` to disable the catalog. |
| `extensionCatalog.url` | Defaults to `https://github.com/tobalsan/yoplai-extensions/releases/latest/download/catalog.json`. |

Use HTTPS for the catalog URL. The gateway accepts HTTP for direct loopback requests only. Every redirect must use HTTPS.

## Gateway and UI

| Setting                    | Meaning                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| `gateway.port`             | API/WS port; default 4000                                                                         |
| `gateway.bind`             | `loopback`, `lan`, or `tailnet`                                                                   |
| `gateway.host`             | Explicit bind host override                                                                       |
| `ui.enabled`               | Start web UI with gateway; default true                                                           |
| `ui.port`                  | UI port; default 3000                                                                             |
| `ui.bind`                  | `loopback`, `lan`, or `tailnet`                                                                   |
| `ui.tailscale.mode`        | `off` or `serve`                                                                                  |
| `ui.tailscale.resetOnExit` | Reset serve config on exit (`tailscale serve reset`, wipes non-Yoplai entries too); default false |

Prefer `loopback` until authentication and a secure access path are configured. For Tailscale Serve, both gateway and UI binds must be loopback; Yoplai maps UI below `/yoplai` and API/WS to gateway.

### MCP Apps

The gateway captures MCP view results and provides isolated view routes. The main web chat displays views inline or in a resizable side panel and reuses one view per server/resource URI within a session. See [MCP App views](web-ui.md#mcp-app-views) for display modes, replay and state-loss limits; no extra configuration enables the panel or reuse.

`apps.port` defaults to `4001` and binds on the gateway's interface. For trusted local chat origins, the view origin defaults to the other loopback host, as in Dar: chat on `localhost` or a `*.localhost` name gets `http://127.0.0.1:<apps.port>`, and chat on `127.0.0.1` or `[::1]` gets `http://localhost:<apps.port>`. Apps such as tldraw treat `*.localhost` as production and stop rendering without a license. `pnpm dev` does not probe the Apps port; choose another `apps.port` if it is taken. Desktop launches pick an Apps port before starting the gateway. If the listener still fails to bind, the gateway normally continues with views unavailable. With `YOPLAI_WEB_DIST` set (as in the packaged desktop app), the gateway exits instead and the desktop app shows its startup error page with Restart.

For a proxied deployment:

```json
{
  "apps": {
    "origin": "https://views.example.net",
    "port": 4001
  }
}
```

Use a different registrable domain from the chat for production. Add DNS and a proxy site forwarding only to the apps listener; do not apply `X-Frame-Options: SAMEORIGIN` to that site, and verify the final headers through the proxy. Keep the chat site's framing protection. The configured origin must be a bare HTTPS origin with a different hostname from the chat; a different port on the same hostname does not isolate cookies. HTTP is allowed only on loopback or `*.localhost`. Authentication cookies remain host-only; do not configure a cross-subdomain cookie domain.

Remote chat origins, including Tailscale Serve, require an explicit `apps.origin`. Missing or invalid origins leave chat working without Apps views. `POST view` accepts only configured trusted chat origins from its browser `Origin` header. `/api/capabilities` reports `apps.available` for listener readiness; eligibility is also checked for each view request.

Views receive only declared CSP origins; wildcards and entries with paths are dropped. `resourceDomains` also accepts the `blob:` and `data:` schemes. Camera, microphone and geolocation are disabled. Results larger than 5 MB are not captured; view HTML is limited to 5 MB. Tickets expire after one hour, and session deletion removes captured records and revokes tickets; archiving retains them. Replay re-reads the view resource without re-running the tool. See [the gateway contract](llms.md#mcp-apps-gateway) for routes and protocol details.

## Sessions

`sessionKey` is logical conversation name (default `main`). `sessions.idleMinutes` defaults to 360. Agent `queueMode: queue` appends follow-ups to active work; `interrupt` aborts active run before starting new one.

Agent-to-agent callers can identify the sending agent and hop count. Root `agentLoop.maxAgentTurns` defaults to 8 consecutive agent-authored inbound turns per conversation, and `agentLoop.maxHops` defaults to 5. Either value can be overridden for an agent with the same `agentLoop` object in `agent.yaml`. Human-authored turns reset the consecutive-turn counter; turns over either limit are completed silently without invoking the model.

## Project and board roots

Project storage root is `extensions.projects.root`; deprecated top-level `projects.root` is fallback only. Board-owned user content defaults beneath `$YOPLAI_HOME`; set `extensions.board.contentRoot` to override.

## Compatibility and migration

Yoplai still accepts deprecated `AIHUB_HOME`, `YOPLAI_CONFIG`, `AIHUB_CONFIG`, other `AIHUB_*` aliases, `$AIHUB_HOME` placeholders, `~/.aihub`, and `aihub.json` with warnings. Migrate to `YOPLAI_HOME`, `YOPLAI_*`, `$YOPLAI_HOME`, `~/.yoplai`, and `yoplai.json`; compatibility is fallback, not preferred configuration.

Use `pnpm yoplai agents migrate` for centralized v2 `agents[]` records. Do not hand-convert current v3 agent folders back into inline objects.

## OneCLI

OneCLI native proxy config is top-level:

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

`gatewayUrl` is required; only `proxy` mode is supported. Set agent `onecliToken` separately. Container behavior is covered in [Container isolation](container-isolation.md).
