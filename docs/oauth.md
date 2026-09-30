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

An explicit per-run model override, such as a scheduler job's `model`, resolves
credentials for the overridden provider independently of the agent's default
`auth.mode`. For example, an API-key agent can run a job with `openai-codex`
after `yoplai auth login openai-codex`; the agent's normal runs keep their
configured authentication behavior.

## Extension OAuth connections

Host OAuth framework manages provider authorize/callback/status/disconnect routes per agent. Extensions declare required provider/scopes and receive refreshed access token through runtime context.

In the web connection card, choose **Just me** to use your Google account only for your own requests, or **Whole team** to share it with everyone on that agent. Personal connections require a signed-in Yoplai user (multi-user mode). At each tool call, the gateway selects that requester's personal connection, falls back to the team connection if none exists, or returns a connect link. It never uses another user's personal connection. A revoked personal grant requires reconnecting rather than silently switching accounts.

The connection card shows and disconnects the selected scope. Google extensions on the same agent reuse that scoped Google connection. Existing agent-only connections are read as team connections and move to encrypted scoped records on their next save; current agents keep their access. Runs without a Yoplai user continue to use team credentials.

`GET /api/oauth/:provider/authorize?agent=<id>` asks for the scope; passing `scope=personal` or `scope=team` starts authorization directly. Personal ownership comes from the authenticated session, never a caller-supplied user ID. Status and disconnect accept the same scope; status without it reports the requester's effective connection.

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
