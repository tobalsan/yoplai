# Webhooks

Agent webhooks expose secret URLs that start agent runs from external HTTP events, with per-request sessions by default and optional gate-controlled conversation sessions.

## Configure

Add webhooks to agent `agent.yaml`:

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

On startup Yoplai creates `$YOPLAI_HOME/webhook-secrets.json` with restrictive permissions and logs URL:

```text
[webhooks] sales/notion -> http://127.0.0.1:4000/hooks/sales/notion/<secret>
```

Keep URL secret private and serve public webhooks over TLS. The same URL is shown on the agent's **Webhooks** page.

## Run as

Open an agent's configuration, then **Webhooks**, to choose **Mine** or **Team**
for each webhook. Team is the default for new and existing webhooks and uses
only team connections. Mine uses the signed-in owner's personal OAuth/MCP
connections first, with team fallback when no personal connection exists.
Mine requires multi-user mode and an authenticated user.

The setting is saved in `agent.yaml`:

```yaml
webhooks:
  incoming:
    prompt: "Review event: $WEBHOOK_PAYLOAD"
    credentialMode: owner # team (default) or owner
    ownerUserId: example-user-id
```

The UI and API derive `ownerUserId` from the authenticated session. Other
users see **Owned by <name>** and cannot change the setting, including
superadmins. Only the owner can switch back to Team, which clears the owner.
If an owner leaves, an operator must edit `agent.yaml` to recover the webhook.
An owner whose agent access has been revoked cannot start a run; the existing
run error logging and trace stream report the access failure.

After verification handshakes and signature checks, owner mode returns HTTP
409 with `Webhook owner is missing; assign an owner before running it` when
the owner is absent, or `Owner credentials require multi-user mode` when
multi-user mode is disabled. No run starts in either case. URLs, signatures,
and provider verification handshakes are unchanged.

## Enabled

Each webhook has an ON/OFF switch (`enabled`, default `true`). A disabled
webhook returns `404 Webhook not found` (same as an unknown one) before secret
checks or verification handshakes, and starts no run. Saved as
`enabled: false`; turning it back on removes the key.

```yaml
webhooks:
  incoming:
    prompt: "Review event: $WEBHOOK_PAYLOAD"
    enabled: false
```

## Settings API

`GET /api/agents/:id/webhooks` returns, per webhook, `name`, `credentialMode`,
`enabled`, `url`, and optional owner id/display name. `url` is the full secret
URL (`<base>/hooks/<agentId>/<name>/<secret>`), so treat the response as
sensitive. `<base>` is `server.baseUrl` when set (trailing slash removed); else
the gateway's local address. Prompts and signing secrets are never returned.
`PATCH /api/agents/:id/webhooks/:name` accepts `credentialMode` (`team` or
`owner`) and/or `enabled` (boolean) in one request and returns the updated
item; client-supplied owner ids are rejected. Both endpoints require permission
to configure the agent's extensions; changing an owner-mode webhook (including
`enabled`) also requires its owner.

## Durable mode

An eligible owner with Durable mode enabled gets a private child conversation
for each delivery. The child starts with a handoff from the owner's Main and
runs with background authority. Device tools are unavailable. Main receives
one short `<route> · webhook` digest after the child settles and Main is idle.
The child uses the agent's configured model and reasoning.

The gateway checks `X-GitHub-Delivery`, `webhook-id`, and `Idempotency-Key` in
that order. A stable ID deduplicates within the agent and route in Durable
mode, including after restart. An eligible retry after a route changes hands
stays with the original admission. Deliveries with no ID each get a fresh UUID. See the
[GitHub docs](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks#use-the-x-github-delivery-header),
[Standard Webhooks spec](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md#webhook-headers-sending-metadata-to-consumers),
and [Probo docs](https://www.probo.com/docs/developers/api/webhooks/delivery-and-recovery#http-headers).
Single-user gateways use the local owner. Multi-user team routes use the
existing webhook session path. Owner-mode routes with no owner return 409.

## Prompts

`prompt` can be inline text or workspace-relative `.md`/`.txt` file. Paths outside workspace are rejected.

Available interpolation:

- `$WEBHOOK_ORIGIN_URL`
- `$WEBHOOK_HEADERS`
- `$WEBHOOK_PAYLOAD`
- `$WEBHOOK_GATE_CONTEXT` — gate context serialized as JSON, or empty when absent

Legacy runs use a fresh `webhook:<agentId>:<name>:<requestId>` session unless
the gate returns a valid `sessionScope`. Langfuse uses the `webhook` surface
unless `langfuseTracing: false`.

Durable prompts omit the URL secret and query string, as well as the
authorization, cookie and provider signature headers. Interpolated payload,
headers and gate context are clipped at 4,000, 1,000 and 1,000 characters,
respectively. The gate still receives its usual input.

## Frontmatter

A prompt file can start with YAML frontmatter to choose its model, reasoning,
and a gate script. The file is read on every request: edits apply to the next
call without changing `agent.yaml` or restarting the gateway.

```md
---
model: { provider: anthropic, model: claude-haiku-4-5 }
reasoning: low
script: scripts/check-alert.sh
scriptTimeoutMs: 30000
---
Review this alert: $WEBHOOK_PAYLOAD
Gate findings: $WEBHOOK_GATE_CONTEXT
```

| Key | Default | Meaning |
| --- | --- | --- |
| `model` | Agent default | `{ provider, model }`, both non-empty strings. Stored provider credentials determine authentication, including OAuth; no `mode` setting is needed. |
| `reasoning` | Agent default | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. |
| `script` | None | Gate path relative to the agent workspace. Absolute paths, `..` segments, and symlink escapes are rejected. |
| `scriptTimeoutMs` | `30000` | Positive gate timeout in milliseconds. |

For a sandboxed agent, each gate runs in its own container from `/workspace`.
It can use `/workspace/data` for writes and sees the agent's configured mounts.
Session uploads and conversation files are excluded. For an agent without
sandboxing, the gate runs on the gateway host from the agent's workspace.
See [script isolation](container-isolation.md#scheduler-scripts-and-webhook-gates).

`.sh` and `.bash` files run under Bash without an executable bit. Other files
need a shebang and `chmod +x`. Stdin receives the raw POST body or the serialized
query string for GET. The gate receives `WEBHOOK_AGENT_ID`, `WEBHOOK_NAME`,
`WEBHOOK_REQUEST_ID`, `WEBHOOK_ORIGIN_URL`, and `WEBHOOK_HEADERS` (JSON) in its
environment.

The last non-empty stdout line can return these JSON fields:

| Field | Meaning |
| --- | --- |
| `wakeAgent` | Only `false` skips the agent; otherwise it wakes. |
| `context` | Serialized into `$WEBHOOK_GATE_CONTEXT`, or appended to the prompt when that variable is absent. |
| `sessionScope` | A string that is non-empty after trimming selects `webhook:<agentId>:<name>:<sessionScope>`. The value is used verbatim, without character or length limits. Missing, non-string, empty, or whitespace-only values keep the per-request session. |
| `abort` | Only exact `true` with a valid `sessionScope` stops that session's active run, before deciding whether to wake. Without a valid scope it is ignored. |

A gate can skip a request:

```json
{"wakeAgent": false}
```

This skips the agent, creates no session or Langfuse trace, and logs one info
line: `[webhooks] <agent>/<name> gate: skipped`. Any other successful output,
including empty or non-JSON output, wakes the agent. A gate may return computed
context:

```json
{"wakeAgent": true, "context": {"knownError": true, "fixed": false}}
```

Context is serialized into `$WEBHOOK_GATE_CONTEXT`. If the template does not
use that variable, context is appended as `\n\nGate context:\n<context>`.
Request payloads and substituted values are never interpolated a second time.

Return the same scope for follow-ups in one external conversation. Agent and
webhook name remain part of the key, so scopes are isolated across agents and
webhooks. Follow-ups during an active run use the agent's configured queue
policy: default `queue` queues the turn, `interrupt` stops the current run, and
an active durable task forces `queue`. Normal session idle reset still applies.

For a stop signal that wakes the agent to post its final response:

```json
{"wakeAgent": true, "sessionScope": "<external-session-id>", "abort": true, "context": {"signal": "stop"}}
```

The abort waits for streaming to end, bounded by the existing abort timeout;
after that timeout, streaming state is cleared so the wake can proceed. This
is best effort, not a guarantee that provider execution has settled. It emits
no acknowledgement and does not pause the session's durable task; the woken
agent can pause it itself. Use `wakeAgent: false` with the scope and abort to
stop silently (leaving any durable task active). Unknown or idle sessions are
a harmless no-op and abort-only requests create no session. If the host lacks
abort support or an abort fails, the error is logged and the wake still proceeds.

Gate failures **fail open**: missing files, spawn errors, non-zero exits,
signals, and timeouts log an error with agent, webhook, reason and stderr tail,
then run the agent with the per-request session and no abort. Empty or non-JSON
output also wakes with no scope or abort. Gates are killed when the webhooks
extension stops. The HTTP response stays immediate and keeps the
`{ ok, requestId }` shape. When the owner is eligible for Durable mode, a
stable delivery header yields `webhook:<encoded route>:<encoded delivery id>`.
Other deliveries return a fresh UUID. The gate's `WEBHOOK_REQUEST_ID` is always a fresh UUID.

Invalid YAML, unknown keys, invalid values, or a script path escaping the
workspace log an error naming the prompt file and do **not** run the agent.
An empty or comment-only frontmatter block is valid. Only `.md`/`.txt` prompt
files starting with a `---` line and a later closing `---` line are parsed;
unclosed blocks and inline prompts stay unchanged. A file that previously used
two such lines as Markdown horizontal rules is now interpreted as frontmatter.

## Verification and signatures

`verification` handles provider setup requests containing known header or JSON payload field. Matching setup request returns verification response without invoking agent. Requests without field continue normal processing.

Known GitHub, Notion, and Zendesk integrations verify HMAC-SHA256 when `signingSecret` is set. `$env:` references are supported. Payload limit defaults to 1 MB and can be changed per webhook.

## Rotate URL secret

```bash
pnpm yoplai webhooks rotate sales notion
```

Running gateways detect rotated secrets without restart. Update provider destination immediately after rotation.

Example prompt templates live under [`docs/examples/webhooks/`](examples/webhooks/).
