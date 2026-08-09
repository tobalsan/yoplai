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

Each request uses fresh `webhook:<agentId>:<name>:<requestId>` session. Langfuse uses `webhook` surface unless `langfuseTracing: false`.

## Verification and signatures

`verification` handles provider setup requests containing known header or JSON payload field. Matching setup request returns verification response without invoking agent. Requests without field continue normal processing.

Known GitHub, Notion, and Zendesk integrations verify HMAC-SHA256 when `signingSecret` is set. `$env:` references are supported. Payload limit defaults to 1 MB and can be changed per webhook.

## Rotate URL secret

```bash
pnpm yoplai webhooks rotate sales notion
```

Running gateways detect rotated secrets without restart. Update provider destination immediately after rotation.

Example prompt templates live under [`docs/examples/webhooks/`](examples/webhooks/).
