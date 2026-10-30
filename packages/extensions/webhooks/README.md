# Webhooks Extension

Exposes secret URLs that start an agent run from an inbound HTTP request
(GitHub, Notion, Zendesk, or anything that can `POST`).

## Enable

No `yoplai.json` config. The extension loads as soon as any agent declares a
`webhooks` block in its `agent.yaml`:

```yaml
# agents/sales/agent.yaml
webhooks:
  github:
    prompt: prompts/github-webhook.md
    signingSecret: "$env:GITHUB_WEBHOOK_SECRET"
  ping:
    prompt: "Someone pinged us from $WEBHOOK_ORIGIN_URL: $WEBHOOK_PAYLOAD"
```

| Field             | Default   | Notes                                                                                |
| ----------------- | --------- | ------------------------------------------------------------------------------------ |
| `prompt`          | required  | Inline text, or a workspace-relative `.md`/`.txt` file (paths outside are rejected). |
| `signingSecret`   | —         | HMAC secret for known providers (see [Signatures](#signatures)). `$env:` supported.  |
| `verification`    | —         | `{ location: header \| payload, fieldName }` for provider setup handshakes.          |
| `maxPayloadSize`  | `1048576` | Bytes. Larger bodies get `413`.                                                      |
| `langfuseTracing` | `true`    | Trace runs under the `webhook` surface.                                              |

## URL

On gateway start, each webhook gets a random secret stored in
`$YOPLAI_HOME/webhook-secrets.json` (mode `0600`), and its URL is logged:

```text
[webhooks] sales/github -> https://yoplai.example.com/hooks/sales/github/<secret>
```

Base URL comes from `server.baseUrl`, else `gateway.host`/`gateway.port`. Paste
the full URL into the provider. Treat it as a credential; serve it over TLS.

```bash
curl -X POST "https://yoplai.example.com/hooks/sales/ping/<secret>" \
  -H "Content-Type: application/json" \
  -d '{"hello":"world"}'
# {"ok":true,"requestId":"3f1c..."}
```

Both `GET` and `POST` are accepted; for `GET`, the query string is the payload.
The response returns immediately — the agent runs in the background, in a fresh
`webhook:<agentId>:<name>:<requestId>` session.

| Status | When                                           |
| ------ | ---------------------------------------------- |
| `200`  | Accepted (or verification handshake answered). |
| `401`  | Missing/wrong URL secret, or bad signature.    |
| `404`  | Unknown agent/webhook, or agent inactive.      |
| `413`  | Payload over `maxPayloadSize`.                 |

## Prompt variables

Replaced in the prompt before the run:

- `$WEBHOOK_PAYLOAD` — raw request body (not parsed)
- `$WEBHOOK_HEADERS` — request headers as JSON
- `$WEBHOOK_ORIGIN_URL` — full request URL
- `$WEBHOOK_GATE_CONTEXT` — gate context as JSON, or empty when absent

```md
<!-- agents/sales/prompts/github-webhook.md -->

GitHub event headers: $WEBHOOK_HEADERS

Payload: $WEBHOOK_PAYLOAD

Summarize the event and open follow-up tasks if a PR needs review.
```

Ready-made templates: [`docs/examples/webhooks/`](../../../docs/examples/webhooks/).

Prompt files support strict YAML frontmatter for `model`, `reasoning`, `script`,
and `scriptTimeoutMs`. Gate scripts can skip a request or pass context to the
agent; gate failures wake the agent. See [Frontmatter](../../../docs/webhooks.md#frontmatter)
for the example, contract, and validation rules. File edits apply on the next
request without a restart.

## Signatures

With `signingSecret` set, HMAC-SHA256 of the raw body is checked for known
providers, detected by webhook name (contains `github`/`notion`/`zendesk`) or
by signature header:

| Provider | Header                        | Format         |
| -------- | ----------------------------- | -------------- |
| GitHub   | `x-hub-signature-256`         | `sha256=<hex>` |
| Notion   | `x-notion-signature`          | `<hex>`        |
| Zendesk  | `x-zendesk-webhook-signature` | `<base64>`     |

Unknown providers skip signature checks — the URL secret is the only guard.

## Verification handshake

Some providers send a setup request before real events. If the request carries
the configured field, Yoplai logs it, returns `{"ok":true,"verification":true}`,
and does not run the agent. Notion example:

```yaml
webhooks:
  notion:
    prompt: prompts/notion-webhook.md
    signingSecret: "$env:NOTION_WEBHOOK_SECRET"
    verification:
      location: payload
      fieldName: verification_token
```

Grab the token from the gateway log and paste it back into Notion.

## Rotate a URL secret

```bash
yoplai webhooks rotate sales github
# New URL: https://yoplai.example.com/hooks/sales/github/<new-secret>
# Old URL is immediately invalid.
```

Running gateways pick up the new secret without restart. Update the provider
right away.
