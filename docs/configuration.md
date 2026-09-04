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

Agent entries may be exact directories or glob patterns relative to config file. Every matched directory must contain flat `agent.yaml`; its `id` must match directory basename. If `agents` is omitted outside pool mode, Yoplai looks in `$YOPLAI_HOME/agents`.

Migrate old centralized agent records with:

```bash
pnpm yoplai agents migrate
```

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
  - SOUL.md
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
| `sdk`                                 | `pi` (default), `claude`, or `openclaw`                     |
| `description`, `avatar`, `role`       | Optional UI metadata                                        |
| `model.provider`                      | Provider id; required for Pi                                |
| `model.model`                         | Model id                                                    |
| `model.base_url`                      | Claude SDK API/proxy URL                                    |
| `model.auth_token`                    | Claude SDK auth override; prefer `$env:`                    |
| `auth.mode`                           | `oauth`, `api_key`, or `proxy` for Pi                       |
| `auth.profileId`                      | Optional Pi credential profile id                           |
| `reasoning`                           | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`          |
| `thinkLevel`                          | Deprecated alias for `reasoning`                            |
| `queueMode`                           | `queue` or `interrupt`                                      |
| `retryMaxAttempts`                    | Attempts for a transient provider error; default 3          |
| `retryBaseDelay`                      | Initial retry delay in seconds; default 2                   |
| `introMessage`                        | Custom message shown after `/new`                           |
| `discord`, `slack`, `telegram`, `irc` | Supported per-agent transport config                        |
| `heartbeat`, `dream`, `webhooks`      | Periodic and webhook-triggered behavior                     |
| `extensions`                          | Per-agent tool-extension opt-ins/overrides                  |
| `globalSkills`                        | Include global agent skills when true                       |
| `sandbox`                             | Per-agent Docker isolation settings                         |
| `onecliToken`                         | Per-agent OneCLI proxy token, usually `$env:...`            |

On first run Yoplai creates missing `AGENTS.md`, `SOUL.md`, and `USER.md` without overwriting existing files.

Pi turns that fail on a transient provider error (rate limit, 5xx, queue/backpressure hint, connection reset) are retried in place, on the host and inside the sandbox alike. Retry delays double after each attempt unless the provider supplies a `Retry-After` hint. Eligibility is per turn, not per run: only the failed assistant turn is dropped from the model context, then the run resumes in place, so tool calls and results from earlier turns are preserved and the user message is never re-sent. Partial text streamed by the failed turn is discarded with it. The dropped turn stays in the session transcript for history.

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
| `pool`                               | Optional pool-agent directory/glob for forked multi-user mode       |
| `defaultProjectManager`              | Preferred board/project lead agent id                               |
| `gateway`, `ui`, `server`, `web`     | Network and public/base URL settings                                |
| `sessions.idleMinutes`               | Logical-session idle rotation; default 360                          |
| `extensions`                         | Built-in/external extension configuration                           |
| `extensionsPath`                     | External extension directory; defaults to `$YOPLAI_HOME/extensions` |
| `sandbox`, `onecli`, `oauth`         | Isolation, proxy, and host OAuth settings                           |
| `branding`                           | Optional organization name/logo                                     |
| `agentFab`                           | Enable global quick-chat control                                    |
| `notifications.channels`             | Named Discord/Slack delivery targets                                |
| `dream`                              | Global nightly-consolidation prompt/timeout/window                  |
| `env`                                | Lowest-precedence instance env values; prefer `.env` for secrets    |
| `taskboard`, `projects`, `subagents` | Legacy/compatibility config surfaces; prefer owning extensions      |

Schema in `packages/shared/src/types.ts` is final source of truth. Extension-specific fields belong in [Extensions](extensions.md) and owning package READMEs.

### Session auto-titles

Set `extensions.sessions.autoTitleModel` to choose model used for lead-session titles:

```json
{
  "extensions": {
    "sessions": { "autoTitleModel": "anthropic/claude-haiku" }
  }
}
```

When omitted, gateway selects cheapest available Anthropic Haiku model and refuses Opus/thinking models for auto-title work.

### Notification channels

Named channels are referenced by scheduler, project orchestration, and `yoplai notify`:

```json
{
  "notifications": {
    "channels": {
      "default": { "slack": "C0123456789" },
      "alerts": { "discord": "1234567890" }
    }
  }
}
```

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

## Gateway and UI

| Setting                    | Meaning                                 |
| -------------------------- | --------------------------------------- |
| `gateway.port`             | API/WS port; default 4000               |
| `gateway.bind`             | `loopback`, `lan`, or `tailnet`         |
| `gateway.host`             | Explicit bind host override             |
| `ui.enabled`               | Start web UI with gateway; default true |
| `ui.port`                  | UI port; default 3000                   |
| `ui.bind`                  | `loopback`, `lan`, or `tailnet`         |
| `ui.tailscale.mode`        | `off` or `serve`                        |
| `ui.tailscale.resetOnExit` | Reset serve config on exit (`tailscale serve reset`, wipes non-Yoplai entries too); default false |

Prefer `loopback` until authentication and a secure access path are configured. For Tailscale Serve, both gateway and UI binds must be loopback; Yoplai maps UI below `/yoplai` and API/WS to gateway.

## Sessions

`sessionKey` is logical conversation name (default `main`). `sessions.idleMinutes` defaults to 360. Agent `queueMode: queue` appends follow-ups to active work; `interrupt` aborts active run before starting new one.

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
