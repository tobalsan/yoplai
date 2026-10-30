# Webhooks

Agent webhooks expose secret URLs that start isolated agent runs from external HTTP events.

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

Keep URL secret private and serve public webhooks over TLS.

## Prompts

`prompt` can be inline text or workspace-relative `.md`/`.txt` file. Paths outside workspace are rejected.

Available interpolation:

- `$WEBHOOK_ORIGIN_URL`
- `$WEBHOOK_HEADERS`
- `$WEBHOOK_PAYLOAD`
- `$WEBHOOK_GATE_CONTEXT` — gate context serialized as JSON, or empty when absent

Each request uses fresh `webhook:<agentId>:<name>:<requestId>` session. Langfuse uses `webhook` surface unless `langfuseTracing: false`.

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

The gate runs in the agent workspace. `.sh` and `.bash` files run under Bash
without an executable bit; other files must be executable. Stdin receives the
raw POST body, or the serialized query string for GET. The inherited environment
is supplemented with `WEBHOOK_AGENT_ID`, `WEBHOOK_NAME`, `WEBHOOK_REQUEST_ID`,
`WEBHOOK_ORIGIN_URL`, and `WEBHOOK_HEADERS` (JSON).

The last non-empty stdout line decides whether the agent runs:

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

Gate failures **fail open**: missing files, spawn errors, non-zero exits,
signals, and timeouts log an error with agent, webhook, reason and stderr tail,
then run the agent. Gates are killed when the webhooks extension stops.
The HTTP response stays immediate and unchanged: `{ ok, requestId }`.

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
