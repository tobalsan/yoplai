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
- Google profile photos refresh on each sign-in without replacing locally edited names or emails. Photos appear in the sidebar, teams, user pickers, sharing dialogs and admin user list; missing or failed images show initials.
- A superadmin role (auto-assigned to the first registered user) plus an
  `approved` flag gating non-admin access.
- Team membership and agent access. Users and admins see and run Public agents
  and Private agents linked to their teams. Superadmins see and run every agent. Admins manage agents owned by their teams and
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
- `agent_forks` stores agent access records and `agent_fork_teams` stores their
  team links. A one-shot upgrade migrates legacy All teams rows to Public and
  clears their old links. Later changes to visibility persist across restarts.
  Removing a team link changes access to the agent and leaves the workspace intact.
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

Human chat requesters may ask a Pi agent to update its own `AGENTS.md` through
`agent_update_instructions` when their eligible account is `admin` or `superadmin`.
`shared_update_system_file` requires `superadmin`. These gateway checks use the
run's requester, refuse automation and missing account identities, and treat the
single-user operator as superadmin. Admins may update instructions for any agent
they can chat with. See [chat instruction updates](../../../docs/configuration.md#updating-instructions-from-chat).

### Agent visibility and team membership

Public agents are available to every approved user, including users without a team.
Private agents require membership in at least one linked team; superadmins bypass
this restriction. Agent team links describe ownership, independently of visibility.
Only superadmins and admins sharing an owning team can change visibility, team
credentials/OAuth, or pause/resume/delete Team scheduled jobs. Public grants no
management permission. Personal connections and member-level operations remain
available to users who can chat the agent.

Agents with no access record are Public by default. The first team assignment
creates a Private record. An admin can add their own team to a Public agent,
and a superadmin can set visibility before the first assignment. A Private agent
with no links can be managed by a superadmin. Existing records, including
migrated legacy assignments, continue to govern chat and list access.

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
GET    /api/teams/:id/agents            # team agent links
GET    /api/admin/users                 # list users
GET    /api/admin/users/no-team         # users without any live team
PATCH  /api/admin/users/:id             # approve / set role
POST   /api/admin/teams                 # create team
PATCH  /api/admin/teams/:id             # update team
DELETE /api/admin/teams/:id             # delete team
PUT    /api/admin/teams/:id/members     # { mode: "all" } or { mode: "list", userIds }
POST   /api/admin/teams/:id/members/:userId # single-user add, no body
DELETE /api/admin/teams/:id/members/:userId
GET    /api/admin/forks                 # list agent access records
PUT    /api/admin/forks/:poolId/teams   # { mode: "list", teamIds }; mode all rejected
PATCH  /api/admin/forks/:poolId/visibility # { public: boolean }
DELETE /api/admin/teams/:teamId/agents/:poolId
```

The legacy route parameter `:poolId` takes the agent ID.

Non-admin callers get `403` from any `/api/admin/*` route. `/api/me`, team
reads, and `DELETE /api/user/token/:id` require any authenticated
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

## Gateway Link (remote side)

A local gateway links to this remote through a browser consent and gets its own
API key. The flow is a loopback redirect with PKCE (S256). The device
authorization plugin stays disabled. `GET /api/capabilities` reports
`gatewayLink: { version: 1, method: "loopback-pkce" }` only after the link
routes are ready and crash recovery has finished.

1. The local gateway posts `{ challenge, state, callbackUri, deviceLabel,
   replaceLinkId? }` to `POST /api/auth/gateway-link/requests` and gets a
   request ID. The callback must be exactly
   `http://127.0.0.1:<port>/api/relay/link/callback`.
2. The browser opens `/gateway-link?request=<id>`. Login returns to this page.
   `GET /api/auth/gateway-link/requests/:id` shows safe details and a consent
   nonce that is bound to the request and the session.
3. The user approves or refuses (`POST .../approve`, `POST .../deny`). Each
   answer returns the callback address with `#code=...&state=...` or
   `#error=access_denied&state=...`.
4. The local gateway posts `{ code, verifier, callbackUri }` to
   `POST /api/auth/gateway-link/token` and gets the key once.

Rules of the routes:

- Request and token routes refuse any `Origin`. Consent writes need the exact
  configured web origin (`getTrustedOrigins`), a real cookie session, and the
  nonce. A bearer, a forwarded context, and an impersonating session never
  count. Bodies are JSON, at most 4 KiB, with no repeated key.
- A code lasts 60 seconds, a request five minutes, and a key 90 days. The code
  burns at its first exchange, also when the verifier is wrong.
- Limits: five request starts per source per minute, 1,000 pending requests,
  ten consent writes per user per minute, ten exchanges per code and 30 per
  source per minute. The source is the socket peer. A peer on loopback (the
  proxy of a deployment) may name the client in the last `X-Forwarded-For` entry.
- Each link has one key, named `Desktop: <device> (<id8>)` (32 characters at
  most) with the reserved prefix `gl_<22 characters>`. The service writes the
  candidate prefix to `gateway_link_issuances` before it creates the key, so
  recovery at start finds and disables a key that a crash left behind. The
  generic key routes refuse a `gl_` prefix on create and any update of a
  managed key.
- A managed key works only while its link is active, owned by the key owner,
  not expired, and the owner is eligible. Revoke from the owner page
  (`/account/gateway-links`, `POST .../revoke` with `{ linkId }`) or with the
  link's own bearer. A deleted key row counts as revoked.
- A lost first exchange response leaves a key that nobody holds. Revoke it on
  the owner page, then start a new link. The consent page helps: it lists the
  older links of the account with the same device name (`sameDeviceLinks`) and
  tells the user to revoke them first. A re-link of a saved link ID needs no
  such step: the new consent disables the uncertain key first.
- One gateway process per `auth.db`. `getManagedKeyState(keyId, ownerId)` lets
  a socket check its key.

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
