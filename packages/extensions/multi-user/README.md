# Multi-User Extension

The `multi-user` extension adds OAuth authentication, per-user agent access
control, and per-user isolation of session/history state to Yoplai. Without it,
Yoplai runs as a single-user gateway with no authentication on `/api/*`. With
it, every `/api/*` route requires either a Better Auth session cookie or an
`Authorization: Bearer <token>` API key, and each agent's runtime state is
scoped to the calling user.

The extension is opt-in: add an `extensions.multiUser` block to the gateway
config with `enabled: true`, OAuth client credentials, and a session secret.

## What It Owns

- A SQLite database (`auth.db`) of users, sessions, agent assignments, and
  API keys, managed by [Better Auth](https://better-auth.com).
- Google OAuth sign-in via Better Auth's social provider integration.
- An admin role (auto-assigned to the first registered user) plus an
  `approved` flag gating non-admin access.
- Team membership, pool-agent forks, and team-based agent access. Non-staff
  users only see and run forked agents assigned to one of their teams; staff
  bypass that membership check.
- The `createAuthMiddleware` mounted on `/api/*`, plus `requireAdmin` and
  `requireAgentAccess` middleware used by other extensions.
- Bearer-token API auth via the `@better-auth/api-key` plugin (see below).
- Per-user data directories under `$YOPLAI_HOME/sessions/users/<userId>/` for sessions,
  Claude session maps, and conversation history.

The extension does not own agent execution, conversation storage, or routing —
it only owns auth, authorization, and the per-user data namespace.

## Storage

```text
$YOPLAI_HOME/
├── auth.db                # Better Auth tables: user, session, account,
│                          # verification, apikey, plus agent_assignments
└── sessions/
    └── users/
        └── <userId>/
            ├── sessions.json
            ├── claude-sessions.json
            └── history/
```

`auth.db` uses WAL mode with foreign keys on. All Better Auth tables (including
`apikey` from the api-key plugin) are auto-migrated on every boot via
`getMigrations(auth.options).runMigrations()`.

Custom tables:

- `teams` and `team_members` own many-to-many user membership.
- `agent_forks` links one source pool agent to one stable runnable fork and an
  optional team. Deleting or unassigning a team leaves the fork teamless and
  inert rather than deleting its workspace.
- `agent_assignments` is retained only for compatibility. A one-shot,
  transaction-backed migration converts legacy assignments into teams,
  memberships, and fork links; authorization no longer reads the allowlist.

## Configuration

```jsonc
{
  "extensions": {
    "multiUser": {
      "enabled": true,
      "sessionSecret": { "envVar": "YOPLAI_SESSION_SECRET" },
      "oauth": {
        "google": {
          "clientId": { "envVar": "GOOGLE_CLIENT_ID" },
          "clientSecret": { "envVar": "GOOGLE_CLIENT_SECRET" },
        },
      },
      "allowedDomains": ["example.com"],
    },
  },
}
```

- `sessionSecret` — required when enabled. Signs Better Auth session cookies.
- `oauth.google.clientId` / `clientSecret` — required. The only social
  provider currently wired.
- `allowedDomains` — optional email-domain allowlist. Sign-in is rejected for
  any other domain. Omit to allow all.

`sessionSecret` and OAuth credentials are `SecretRef`s, so they can resolve
from env vars, files, or inline literals.

### Approval flow

The very first user to sign in is auto-approved and granted the `admin` role.
Every subsequent user lands with `approved: false` and the default `user`
role. Until an admin promotes / approves them via `PATCH /api/admin/users/:id`,
their requests are rejected with `403 forbidden` (but the session is created
so the UI can render an "awaiting approval" state).

## HTTP API

The extension mounts three route prefixes: `/api/auth/*`, `/api/me`, and
`/api/admin/*`. Better Auth contributes the `/api/auth/*` surface
(sign-in / sign-out / OAuth callbacks / api-key CRUD); the extension itself
adds the rest:

```http
GET    /api/me                          # current user + legacy assignment ids
DELETE /api/user/token/:id              # revoke an API key (audited)
GET    /api/teams                       # globally visible team catalog
GET    /api/teams/:id/members           # team member profiles
GET    /api/teams/:id/agents            # team fork links
GET    /api/pool-actions                # caller-specific pool card actions
GET    /api/admin/users                 # list users
PATCH  /api/admin/users/:id             # approve / set role
POST   /api/admin/teams                 # create team
PATCH  /api/admin/teams/:id             # update team
DELETE /api/admin/teams/:id             # delete team
POST   /api/admin/teams/:id/members     # add member
DELETE /api/admin/teams/:id/members/:userId
GET    /api/admin/forks                 # list fork provenance
POST   /api/admin/forks/assign          # fork once and assign
POST   /api/admin/forks/:poolId/reassign
POST   /api/admin/forks/:poolId/unassign
```

Non-admin callers get `403` from any `/api/admin/*` route. `/api/me`, team
reads, pool actions, and `DELETE /api/user/token/:id` require any authenticated
user. Agent chat/read/write authorization derives from team membership, not the
legacy assignment endpoints.

## Bearer-Token API Auth

Headless callers (curl, CI scripts, the scheduler hitting `/api/schedules`)
authenticate by sending an API key:

```bash
curl -H "Authorization: Bearer <token>" http://127.0.0.1:4000/api/schedules
```

The middleware looks for the `Authorization: Bearer` header on every `/api/*`
request, calls `auth.api.verifyApiKey({ body: { key } })`, and on success
loads the owning user, builds the same `RequestAuthContext` shape as the
cookie path, and runs the standard approval + agent-access checks. If the
header is absent, the cookie path runs unchanged. Bearer tokens follow the
same authorization rules as cookies — there is no admin bypass.

- **Storage:** the `@better-auth/api-key` plugin stores SHA-256 hashes in the
  `apikey` table; plaintext is shown only at creation.
- **Revocation:** every request re-verifies the key — there is no in-memory
  cache, so revocation takes effect on the next request.
- **Audit log:** `DELETE /api/user/token/:id` emits a structured
  `user_token.revoked` log line via the extension's logger. The plugin's
  built-in `/api/auth/api-key/delete` endpoint stays available but is silent.

### CLI: `yoplai user token`

```text
yoplai user token create --user <email-or-id> [--name <name>]
yoplai user token list
yoplai user token revoke <token-id>
```

The CLI uses a hybrid auth model:

1. The first `create` boots the multi-user extension in-process, resolves the
   user, mints a key directly against the local `auth.db`, prints the
   plaintext key **once**, and caches it to `~/.yoplai/user-token.json` with
   mode `0600`. This avoids the bootstrap problem (you need a token to manage
   tokens).
2. All subsequent commands (and any `create` after the cache exists) hit the
   gateway over HTTP using the cached token as `Authorization: Bearer`.
3. `revoke` calls the audited `DELETE /api/user/token/:id` wrapper.

Stop the gateway before running the bootstrap `create`, or rely on SQLite WAL
to keep the write safe — both processes touching `auth.db` concurrently is
supported but discouraged.

## Per-User Isolation

When multi-user is enabled, every agent run is rewritten to read and write
under `$YOPLAI_HOME/sessions/users/<userId>/`:

- `sessions.json` — pi/Claude session id → conversation id mapping.
- `claude-sessions.json` — same shape, narrowed to Claude.
- `history/` — full transcripts.

Helpers `getUserDataDir`, `getUserSessionsPath`, `getUserHistoryDir` are
exported from the package root for other extensions that need to honor the
isolation.

There is no migration path from a single-user `$YOPLAI_HOME` into per-user
ownership — enabling multi-user mode is a fresh start for auth-owned state.

## Operational Notes

- Better Auth's session cookie cache TTL is 300s. The middleware refreshes
  approval from the DB on every request when the cached session shows
  `approved: false`, so newly approved users do not have to wait for the
  cache to expire.
- WebSocket upgrades go through the same `getValidatedAuthContext` path, so
  bearer tokens authenticate WS clients too.
- The auth middleware skips `/api/auth/*`, `/api/capabilities`,
  `/api/branding/logo`, and `/api/theme.css` — these always answer
  unauthenticated requests (still attaching context if a valid session or
  bearer is present).
- API sub-apps receive the auth context via the `x-yoplai-auth-context`
  header so `requireAdmin` and `getRequestAuthContext` work inside nested
  routers.
