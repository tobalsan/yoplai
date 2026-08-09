# OAuth

Yoplai has two OAuth layers:

1. Pi provider authentication for lead-agent model access.
2. Host extension OAuth connections (for tools such as Google Drive).

## Pi provider login

Build CLI, then log in:

```bash
pnpm build
pnpm yoplai auth login
pnpm yoplai auth login anthropic
pnpm yoplai auth status
pnpm yoplai auth logout anthropic
```

Provider list comes from installed Pi SDK. Common IDs include `anthropic`, `openai-codex`, `github-copilot`, `google-gemini-cli`, and `google-antigravity`.

Configure agent:

```yaml
id: my-agent
name: My Agent
auth:
  mode: oauth
model:
  provider: anthropic
  model: claude-sonnet-4-5
```

Credentials live in `$YOPLAI_HOME/auth.json`; protect this file and backups. OAuth tokens refresh through Pi SDK when supported.

### API-key mode

Use env-backed credentials rather than tracked plaintext:

```dotenv
# $YOPLAI_HOME/.env
OPENROUTER_API_KEY=...
```

```yaml
id: my-agent
name: My Agent
auth: { mode: api_key }
model:
  provider: openrouter
  model: anthropic/claude-sonnet-4
```

`auth.mode` values:

- `oauth`: require OAuth credential
- `api_key`: use API key/env credentials
- `proxy`: provider/custom proxy resolution

## Extension OAuth connections

Host OAuth framework manages provider authorize/callback/status/disconnect routes per agent. Extensions declare required provider/scopes and receive refreshed access token through runtime context.

Tokens are stored under `$YOPLAI_HOME/oauth/`. Persistence requires `oauth.encryptionKey` and fails closed rather than writing plaintext:

```json
{
  "oauth": {
    "encryptionKey": "$env:OAUTH_ENCRYPTION_KEY",
    "providers": {
      "google": {
        "clientId": "$env:GOOGLE_CLIENT_ID",
        "clientSecret": "$env:GOOGLE_CLIENT_SECRET"
      }
    }
  }
}
```

Connections expose connected, needs-reconnect, or disconnected state. Refresh failures that invalidate grant require reconnect; disconnect best-effort revokes provider grant.

For Google Drive, follow [Google Drive OAuth setup](oauth-google-drive-setup.md).

## Multi-user Google login

Multi-user authentication uses separate `extensions.multiUser.oauth.google` settings. See [multi-user extension README](../packages/extensions/multi-user/README.md). Do not confuse login OAuth with per-agent extension connections or Pi provider auth.
