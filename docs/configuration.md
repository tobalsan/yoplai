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
| `sdk`                                 | `pi` (default), `claude`, or `openclaw`                     |
| `description`, `avatar`, `role`       | Optional UI metadata                                        |
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
| `retryBaseDelay`                      | Initial retry delay in seconds; default 2                   |
| `introMessage`                        | Custom message shown after `/new`                           |
| `discord`, `slack`, `telegram`, `irc` | Supported per-agent transport config                        |
| `heartbeat`, `dream`, `webhooks`      | Periodic and webhook-triggered behavior                     |
| `reflect`                             | `true` or `{ enabled, cadence, provider, model, timeoutMs }`. Adds a self-improvement prompt so the agent saves lessons in the same turn. Off by default. Only `enabled` has an effect now; the other fields are reserved |
| `extensions`                          | Per-agent tool-extension opt-ins/overrides                  |
| `globalSkills`                        | Include global agent skills when true                       |
| `sandbox`                             | Per-agent Docker isolation settings                         |
| `onecliToken`                         | Per-agent OneCLI proxy token, usually `$env:...`            |

On first run Yoplai creates missing `AGENTS.md` and `USER.md` without overwriting existing files. Custom prompt files such as `PERSONA.md` in the example above must be created explicitly and listed in `system_files`.

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
| `canvas`                             | Dashboard serving (`enabled`, optional public `baseUrl`)            |
| `apps`                               | Isolated MCP Apps origin and listener port                         |
| `sessions.idleMinutes`               | Logical-session idle rotation; default 360                          |
| `agentLoop`                          | Agent-to-agent loop limits (`maxAgentTurns`, `maxHops`)             |
| `extensions`                         | Built-in/external extension configuration                           |
| `extensionsPath`                     | External extension directory; defaults to `$YOPLAI_HOME/extensions` |
| `sandbox`, `onecli`, `oauth`         | Isolation (incl. `sandbox.gatewayTransport`: `http`/`socket`), proxy, and host OAuth settings |
| `maintenance`                        | Model for gateway-owned background LLM tasks                        |
| `modelRouting`                       | Optional routing classifier/table configuration; defaults off       |
| `branding`                           | Optional organization name/logo/icon                                |
| `notifications.channels`             | Named Discord/Slack delivery targets                                |
| `dream`                              | Global nightly-consolidation prompt/timeout/window                  |
| `env`                                | Lowest-precedence instance env values; prefer `.env` for secrets    |
| `taskboard`, `projects`, `subagents` | Legacy/compatibility config surfaces; prefer owning extensions      |

Schema in `packages/shared/src/types.ts` is final source of truth. Extension-specific fields belong in [Extensions](extensions.md) and owning package READMEs.

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

### Model routing

Model routing currently provides configuration validation and a standalone classifier; the chat run path does not call it. `off`, `shadow`, and `enforce` are accepted configuration stages, with `off` the default. Chat integration, model switching, and quota-based pool selection are future work (ALG-594); changing the stage today does not switch a chat's model.

Merge the top-level `modelRouting` object from [the example configuration](examples/model-routing.json) into `yoplai.json`. It contains a versioned, global table of 13 categories. Each row has `id`, `definition`, `examples`, two `{ provider, model, effort }` picks (`claude` and `chatgpt`), and a `pool` preference: `either`, `prefer_claude`, or `prefer_chatgpt`. Picks use Pi provider/model identifiers and supported reasoning levels (`off` rather than `none`). Loading and hot reload check the structural schema, including duplicate category IDs. For active routing, startup additionally checks catalog models, supported efforts, floor and agent category references, and that each opted-in agent retains at least two categories; these cross-configuration checks do not run on hot reload.

| Setting | Default | Meaning |
| --- | --- | --- |
| `mode` | `off` | Configuration stage: `off`, `shadow`, or `enforce` |
| `version` | `unversioned` | Operator-supplied table version |
| `classifier` | `{ "provider": "openai", "model": "gpt-6-luna" }` | Pi classifier model, using OpenAI's classifier operation |
| `thresholds.score` | `0.8` | Minimum confident category score |
| `thresholds.pace` | `1.15` | Reserved pool pacing threshold |
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

Omitting `categories` uses the global table; an explicit list is combined with the floor. The agent flag is configuration for the future chat integration, and has no chat-routing effect yet.

The classifier requires `OPENAI_API_KEY` in the gateway process environment, including values loaded from `$YOPLAI_HOME/.env`. Agent-local credentials and ChatGPT/Codex subscription OAuth do not authenticate this classifier. Missing credentials, timeouts, invalid responses, and exhausted retries return an unavailable result so callers can retain the configured agent model; no vendor request is needed for table validation.

Gateway callers create the standalone module with `createRoutingClassifier(config, { createRuntime?, getApiKey? })` from `src/model-routing/classifier.ts`, then call `checkWorkRequest({ agentId, text, signal? })` or `classifyCategory({ agentId, text, categories?, signal? })`. Category restrictions are combined with the floor; omitting them uses the full table. Successful results have `status: "ok"`: the predicate returns `isWorkRequest` and `probability`, while category classification returns `category`, `score`, and the full `probabilities` distribution for eligible categories. Failures have `status: "unavailable"` with a `reason`; callers decide whether to lock a category by checking `score >= config.thresholds.score` after a successful category result.

The example merges Pom's per-agent definitions into one global definition per category and deduplicates examples across agents. Review these definitions before rollout: a CRM record list or a simple Excel export remains `single_tool_call`, while an authored report, analytical spreadsheet, or deck is `office_deliverable`. Gordon's base picks map to `anthropic`/`openai-codex`; the pinned offline Pi catalog lacks `gpt-6.1-terra`, so the example uses `gpt-5.6-terra`. `edit_agent_dashboard` copies the office picks with `prefer_claude`; `lead_contact_lookup` copies the single-tool picks with `either`.

Source pool guidance with conditions is flattened into one preference: support and web research prefer ChatGPT; writing, office work, summaries, SaaS workflows, hard reasoning, orchestration, and dashboards prefer Claude; the remaining categories use either pool. In particular, summary input length, workflow risk, high-stakes exceptions, and orchestration worker placement are guidance for operator review rather than executable conditions in this table.

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

The gateway captures MCP view results and provides isolated view routes. Web chat remains text-only until the inline view host is installed (artifacts slice 1c).

`apps.port` defaults to `4001` and binds on the gateway's interface. For trusted local chat origins, the view origin defaults to the other loopback host, as in Dar: chat on `localhost` or a `*.localhost` name gets `http://127.0.0.1:<apps.port>`, and chat on `127.0.0.1` or `[::1]` gets `http://localhost:<apps.port>`. Apps such as tldraw treat `*.localhost` as production and stop rendering without a license. If that port is taken, the gateway continues with views unavailable. `pnpm dev` does not probe the apps port: choose another `apps.port` when needed.

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

Remote chat origins, including Tailscale Serve, require an explicit `apps.origin`. Missing or invalid origins and listener startup failures leave chat working with text only. `POST view` accepts only configured trusted chat origins from its browser `Origin` header. `/api/capabilities` reports `apps.available` for listener readiness; eligibility is also checked for each view request.

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
