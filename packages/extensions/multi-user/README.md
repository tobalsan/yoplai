# Multi-User Extension

The `multi-user` extension adds Better Auth authentication, per-user agent access
control, and per-user isolation of session/history state to Yoplai. Without it,
Yoplai runs as a single-user gateway with no authentication on `/api/*`. With
it, every `/api/*` route requires either a Better Auth session cookie or an
`Authorization: Bearer <token>` API key, and each agent's runtime state is
scoped to the calling user.

The extension is opt-in: add an `extensions.multiUser` block to the gateway
config with `enabled: true`, at least one sign-in method (Google OAuth and/or
email/password), and a session secret.

## What It Owns

- A SQLite database (`auth.db`) of users, sessions, agent assignments, and
  API keys, managed by [Better Auth](https://better-auth.com).
- Google OAuth and/or email/password sign-in via Better Auth.
- A superadmin role (auto-assigned to the first registered user) plus an
  `approved` flag gating non-admin access.
- Team membership, pool-agent forks, and team-based agent access. Users and
  admins see and run Public forks and Private forks assigned to their teams; only
  superadmins bypass that check. Admins manage agents owned by their teams and
  teams they belong to; only superadmins create or delete teams.
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
- `agent_forks` links one source pool agent to one stable runnable fork; `agent_fork_teams`
  records its explicit team links. The fork boolean `public` grants chat access independently
  of ownership. A one-shot upgrade migrates legacy All teams forks to Public and clears
  their old team links; later Private changes survive restart.
  Deleting an explicit team link leaves the fork teamless only when it was its last link,
  rather than deleting its workspace.
- `agent_assignments` is retained only for compatibility. A one-shot,
  transaction-backed migration converts legacy assignments into teams,
  memberships, and fork links; authorization no longer reads the allowlist.

## Configuration

```jsonc
{
  "extensions": {
    "multiUser": {
      "enabled": true,
      "sessionSecret": "$env:YOPLAI_SESSION_SECRET",
      "oauth": {
        "google": {
          "clientId": "$env:GOOGLE_CLIENT_ID",
          "clientSecret": "$env:GOOGLE_CLIENT_SECRET",
        },
      },
      "emailAndPassword": { "enabled": true },
      "allowedDomains": ["example.com"],
    },
  },
}
```

- `sessionSecret` — required when enabled. Signs Better Auth session cookies.
- `oauth.google.clientId` / `clientSecret` — optional. The only social
  provider currently wired.
- `emailAndPassword.enabled` — optional. Enables Better Auth email/password
  sign-up and sign-in (`POST /api/auth/sign-up/email`,
  `POST /api/auth/sign-in/email`) and the login page form.
- At least one of `oauth.google` or `emailAndPassword.enabled: true` is
  required when enabled. `/api/capabilities` reports the active methods as
  `authMethods: { google, emailAndPassword }`.
- `allowedDomains` — optional email-domain allowlist. Sign-in is rejected for
  any other domain. Omit to allow all.
- New users receive no explicit team membership. Existing `autoJoinPublicTeams`
  configuration keys are accepted and ignored.

`sessionSecret` and OAuth credentials are strings. Prefer `$env:NAME`
references so plaintext secrets stay outside tracked configuration.

### Approval flow

The very first user to sign in is auto-approved and granted the `superadmin` role.
Every subsequent user gets the default `user` role and is auto-approved
unless `autoApprove: false` is set, in which case they land with
`approved: false`. Until an admin promotes / approves them via `PATCH /api/admin/users/:id`,
their requests are rejected with `403 forbidden` (but the session is created
so the UI can render an "awaiting approval" state).

### Agent visibility and team membership

Public agents are available to every approved user, including users without a team.
Private agents require membership in at least one linked team; superadmins bypass
this restriction. Agent team links describe ownership, independently of visibility.
Only superadmins and admins sharing an owning team can change visibility, team
credentials/OAuth, or pause/resume/delete Team scheduled jobs. Public grants no
management permission. Personal connections and member-level operations remain
available to users who can chat the agent.

When no agent pool is configured, agents without a fork record are treated as
Public for access: every approved user and admin can list and use them, including
HTTP/WebSocket chat, avatars and capability self-enable. Existing fork records,
including same-id forks migrated from legacy assignments, keep their own Public
or linked-team rules; inaccessible agents are hidden from the list. Pool behavior,
approval checks and management permissions stay unchanged. An ordinary admin
cannot manage team credentials on a plain agent without an owning fork team.

The **All users** team flag remains a locked, live membership rule for all current
and future users. The legacy team `private` API field remains inert and is hidden
from the UI. Staff see a **No team** list including pending users; adding someone
to a manageable team removes them from that list immediately. Any All users team
makes the list empty because every user belongs to it.

Scheduler routes require chat access to the relevant agent, and agentless lists
exclude inaccessible agents' jobs. Pending regular users cannot access Public
agents until approved; staff retain the existing approval exception.

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
GET    /api/admin/users/no-team         # users without any live team
PATCH  /api/admin/users/:id             # approve / set role
POST   /api/admin/teams                 # create team
PATCH  /api/admin/teams/:id             # update team
DELETE /api/admin/teams/:id             # delete team
PUT    /api/admin/teams/:id/members     # { mode: "all" } or { mode: "list", userIds }
POST   /api/admin/teams/:id/members/:userId # single-user add, no body
DELETE /api/admin/teams/:id/members/:userId
GET    /api/admin/forks                 # list fork provenance
PUT    /api/admin/forks/:poolId/teams   # { mode: "list", teamIds }; mode all rejected
PATCH  /api/admin/forks/:poolId/visibility # { public: boolean }
DELETE /api/admin/teams/:teamId/agents/:poolId
```

Non-admin callers get `403` from any `/api/admin/*` route. `/api/me`, team
reads, pool actions, and `DELETE /api/user/token/:id` require any authenticated
user. Agent chat authorization derives from Public visibility or team membership;
agent management requires owning-team admin membership or superadmin. Visibility
and membership changes are audited and notify connected clients.

Team create and PATCH bodies accept a boolean `private`; all team reads and
listings return it for compatibility; it no longer affects enrollment or access.

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
  `/api/branding/logo`, `/api/branding/icon`, `/api/manifest.webmanifest`,
  and `/api/theme.css` — these always answer
  unauthenticated requests (still attaching context if a valid session or
  bearer is present).
- API sub-apps receive the auth context via the `x-yoplai-auth-context`
  header so `requireAdmin` and `getRequestAuthContext` work inside nested
  routers.
