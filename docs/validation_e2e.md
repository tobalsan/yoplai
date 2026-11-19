# E2E Validation Playbook

Use this after finishing any ALG-339 child issue. Unit tests are still required,
but the issue is not done until the changed behavior is proven against a real
gateway, a real web UI, and an isolated `YOPLAI_HOME`.

This document is a reusable recipe. Each worker should adapt the final scenario
steps to the slice they implemented.

## Principles

- Never validate against `~/.yoplai` or a real customer config, and never use
  real OAuth credentials (e.g. a customer `YOPLAI_HOME`). E2E auth uses
  email/password with dummy accounts; no human OAuth step is needed.
- Always use a temporary `YOPLAI_HOME` inside the working repo.
- Always launch the actual gateway/web stack, not only unit tests.
- Capture evidence under `validation/`.
- Keep the seeded config minimal. Add only the pool agents, fork dirs, teams,
  users, and auth state needed by the slice.

## 1. Prepare a Temporary Home

From the repo root:

```bash
rm -rf .yoplai-e2e validation
mkdir -p .yoplai-e2e/{pool,agents} validation
```

Create two tiny pool agents. Keep them cheap and deterministic; the goal is to
validate routing/access/UI, not model quality.

```bash
mkdir -p .yoplai-e2e/pool/sales .yoplai-e2e/pool/support

cat > .yoplai-e2e/pool/sales/agent.yaml <<'EOF'
id: sales
name: Sales
role: Sales Assistant
description: Handles sales handoffs.
model:
  provider: openai
  model: gpt-4o-mini
system: You are the Sales test agent. Reply with "sales-ok".
EOF

cat > .yoplai-e2e/pool/support/agent.yaml <<'EOF'
id: support
name: Support
role: Support Assistant
description: Handles support handoffs.
model:
  provider: openai
  model: gpt-4o-mini
system: You are the Support test agent. Reply with "support-ok".
EOF
```

Write the temporary config:

```bash
cat > .yoplai-e2e/yoplai.json <<'EOF'
{
  "version": 3,
  "pool": "pool/*",
  "agents": "agents/*",
  "gateway": {
    "host": "127.0.0.1",
    "port": 4000
  },
  "ui": {
    "enabled": true,
    "port": 3000
  },
  "extensions": {
    "multiUser": {
      "enabled": true,
      "emailAndPassword": { "enabled": true },
      "sessionSecret": "e2e-session-secret-at-least-32-characters"
    }
  }
}
EOF
```

If the slice needs a pre-existing runnable agent, copy one from `pool` into
`agents` and update the config or database link state required by the slice.
Do not point this temp config at a real Yoplai/customer pool unless the slice
specifically needs those definitions.

## 2. Run Required Tests First

Run the scoped tests for the changed packages, serially:

```bash
pnpm test:shared
pnpm test:gateway
pnpm test:web
```

For narrow changes, an exact test file is fine:

```bash
pnpm exec vitest run <path-to-test-file>
```

Do not use `pnpm test -- <path>`.

## 3. Launch the Real Stack

Start the dev gateway/web stack with the temporary home:

```bash
YOPLAI_HOME=$(pwd)/.yoplai-e2e pnpm dev
```

`pnpm dev` auto-picks free ports if `4000` or `3000` are busy. Record the actual
gateway and UI ports printed in the banner. Leave this process running; use a
second terminal/pane for browser, API, and SQLite checks.

Use those ports for every command below:

```bash
export YOPLAI_E2E_HOME="$(pwd)/.yoplai-e2e"
export YOPLAI_E2E_API="http://127.0.0.1:<gateway-port>"
export YOPLAI_E2E_UI="http://127.0.0.1:<ui-port>"
```

## 4. Sign In Without OAuth

The seed config enables email/password auth only. The first account to sign up
becomes an approved `superadmin`; later accounts are `user` and unapproved
until an admin approves them.

Create users with one cookie jar each (password `e2e-password-123`):

```bash
mkdir -p .yoplai-e2e/cookies
for u in admin alice bob; do
  curl -s -c ".yoplai-e2e/cookies/$u.txt" \
    -H 'content-type: application/json' \
    -X POST "$YOPLAI_E2E_API/api/auth/sign-up/email" \
    -d "{\"email\":\"$u@e2e.test\",\"password\":\"e2e-password-123\",\"name\":\"$u\"}"
done
```

Approve a user with the admin jar (`PATCH /api/admin/users/:id`, body
`{"approved": true}`; add `"role": "admin"` to promote, superadmin only):

```bash
ALICE_ID=$(curl -s -b .yoplai-e2e/cookies/alice.txt \
  "$YOPLAI_E2E_API/api/auth/get-session" | jq -r .user.id)
curl -s -b .yoplai-e2e/cookies/admin.txt \
  -H 'content-type: application/json' \
  -X PATCH "$YOPLAI_E2E_API/api/admin/users/$ALICE_ID" \
  -d '{"approved":true}' | jq .user
```

Sign in again later (e.g. after a restart) with `POST /api/auth/sign-in/email`.
Better Auth rejects `/api/auth/*` POSTs that carry a cookie but no `Origin`
(`403 MISSING_OR_NULL_ORIGIN`), so always send an `Origin` header there:

```bash
curl -s -b .yoplai-e2e/cookies/bob.txt -c .yoplai-e2e/cookies/bob.txt \
  -H "Origin: $YOPLAI_E2E_API" -H 'content-type: application/json' \
  -X POST "$YOPLAI_E2E_API/api/auth/sign-in/email" \
  -d '{"email":"bob@e2e.test","password":"e2e-password-123"}'
```

Gateway routes such as `/api/admin/*` do not need the `Origin` header.

In the browser, prefer the login page form: open
`$YOPLAI_E2E_UI/login` (optionally `?returnTo=/agents`), enter the email and
password, and submit. This exercises the real post-login redirect. "No account?
Create one" switches the form to sign-up. As a shortcut, run this from a page on
the UI origin:

```js
await fetch("/api/auth/sign-in/email", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: "alice@e2e.test", password: "e2e-password-123" }),
});
location.reload();
```

## 5. Seed Slice-Specific State

Seed only what the issue needs.

Examples:

- Superadmin/role issue: create first user, verify it becomes `superadmin`,
  then promote/demote another user.
- Teams CRUD issue: create a team, edit name/description/color/icon, delete it.
- Membership issue: create two users and two teams, assign one user to both.
- Agent assignment issue: assign `sales` from the pool, verify a runnable fork
  appears under `.yoplai-e2e/agents`.
- Access issue: create one allowed user and one denied user, then prove chat/API
  access differs.
- UI action-state issue: create pool agents covering each state: no fork,
  fork assigned to user's team, fork assigned to another team, teamless fork.

Prefer public/admin APIs or UI flows. Direct SQLite writes are acceptable only
when the slice under test is not responsible for creating that data.

## 6. Validate Through the Browser

Drive browser scenarios with either the `playwright-cli` skill or the
claude-in-chrome MCP tools. Save screenshots and DOM snapshots into
`validation/`.

Minimum browser checks for ALG-339 slices:

1. Open `${YOPLAI_E2E_UI}` and confirm the app is using the temp home data.
2. Open `/agents` and confirm pool agents render from `.yoplai-e2e/pool`.
3. Open `/teams` and verify the slice-specific team UI behavior.
4. If the slice changes auth/access, validate with at least two users:
   one allowed and one denied.
5. Capture `validation/01-*.png` plus a matching `validation/01-*.dom.txt`
   for each meaningful state.

For chat/access slices, browser validation must prove the actual user path:

- An allowed user can reach the chat action and send to the assigned agent.
- A denied user can see the pool/team information but cannot chat/run it.
- A staff user can bypass team membership when the PRD says staff bypass applies.

## 7. Validate APIs and Persistence

After the browser check, re-fetch server state.

Useful probes:

```bash
curl -s "$YOPLAI_E2E_API/api/capabilities" | jq .
curl -s "$YOPLAI_E2E_API/api/pool" | jq .
curl -s "$YOPLAI_E2E_API/api/agents" | jq .
```

Inspect persisted files:

```bash
find "$YOPLAI_E2E_HOME" -maxdepth 3 -type f | sort
sqlite3 "$YOPLAI_E2E_HOME/auth.db" '.tables'
```

For assignment/access slices, verify both sides:

- Filesystem: fork folders exist or remain absent as expected.
- Database: team, membership, and agent-team link rows match the UI.
- Runtime/API: allowed users can access the agent; denied users cannot.

## 8. Guard-Surface Checklist

Use this when the slice touches access control.

Prove the denied user is blocked from every surface implemented by that slice:

- `/api/agents`
- `/api/agents/:id`
- `/api/agents/:id/history`
- REST run dispatch
- WebSocket send
- WebSocket subscribe/status, when applicable
- upload/media routes tied to agent sessions, when applicable
- bearer/API-token access, when applicable

Do not stop at "the Chat button is hidden". Hidden UI is not an access control
proof.

## 9. Evidence to Leave Behind

Leave `validation/` with:

- screenshots for each browser state;
- DOM snapshots for those states;
- a short `validation/notes.md` containing:
  - branch/issue id;
  - temp home path;
  - gateway/UI ports;
  - test commands run;
  - browser scenarios completed;
  - API/persistence checks completed;
  - any known gap.

If a validation step cannot be run, say why in `validation/notes.md` and in the
issue handoff. Do not claim E2E coverage for a path that was not exercised.

## Team extension settings (ALG-724)

Start the gateway and web UI with `pnpm dev` and the isolated `YOPLAI_HOME`
above. Give a dummy member chat access to the test agent and sign in with
`buu` as that member and as an agent manager. Use one settings-only extension
with a seeded plain value and one extension with a plain Enable/Disable button.

1. As the member, open both extension details pages. Verify that the shared
   value is visible in a disabled input, Save is absent, and Enable/Disable is
   disabled. Confirm the catalog returns `canConfigureTeam: false` and that a
   team PATCH with a plain setting returns 403 and leaves `agent.yaml` intact.
2. As the manager, save a plain setting and change the enabled state. Reload
   both pages and confirm the new values in the catalog and `agent.yaml`.
3. Capture a screenshot and matching DOM snapshot for each role, and save the
   status codes and persistence checks under `validation/`.

## Extension catalog references (ALG-731)

Use the isolated gateway and web UI above. Give a dummy member chat access to
the test agent. Add a Slack block under `extensions` with `enabled: false`
to keep the canary bot offline, `token: canary-channel-token`, and
`applicationId: $env:CANARY_CATALOG_LABEL`. Define `CANARY_CATALOG_LABEL`
as `canary-catalog-label-value` in the agent workspace `.env`.

1. Sign in with `buu` as the member and open the agent's extension details.
   From the same browser session, call `GET /api/agents/:id/extensions`.
   Verify HTTP 200 and check Slack's `configValues` for `token: "********"`
   and `applicationId: "$env:CANARY_CATALOG_LABEL"`. Check the full response
   for the absence of both canary values.
2. As the manager, PATCH a change to `requireMention` on the same extension.
   Verify the response and a fresh GET show the new setting, mask, and
   reference. Verify the token line in `agent.yaml` is unchanged.
3. Capture a screenshot and DOM snapshot from the member's session and save
   the status codes, catalog assertions, and persistence check under `validation/`.

## Dashboard browser checks (ALG-483)

Build the agent image and record its size and increase over the prior image. In the isolated home above, create a sandboxed Pi agent using that image and seed the dashboard skill's CS templates, migrations, and sample data. Use the normal gateway run path to ask the agent to follow "Check it visually" (no installation or render harness), save a screenshot under `/tmp`, and read it. Record time from browser open to PNG: a fresh container must finish within 15 seconds. Capture the read tool's image content block and the model's next response describing something visible only in the screenshot.

Exercise light and dark rendering, `resize 420 800`, a kit tab via `snapshot` then `click eN`, and `clients` → `client?id=…` drill-down. Capture PNGs and DOM snapshots under `validation/`; check `console` for page/query errors, including an intentionally broken query/page. Confirm the owning token gets its page, another agent's slug returns 404, and missing/invalid tokens return 401. Keep live tokens out of saved transcripts.

Run a hung-page navigation with a finite Playwright navigation timeout and an explicit Bash tool timeout. Verify the CLI times out and the agent still responds without a container kill. Confirm browser commands write no state into the read-only workspace and `close` releases the browser. Restart the gateway with the default image and confirm the changed Dockerfile hash triggers its automatic rebuild. Report PASS/FAIL per behavior and document any harness gap explicitly.

## Private dashboards (ALG-475)

Use separate isolated homes for the main multi-user scenario, single-user,
upgrade, fresh-install and eval cases. Never reset the main multi-user home.
Run `pnpm test:shared`, `pnpm test:gateway`, `pnpm test:web` serially, plus exact
changed extension test paths. Keep cookies/credentials outside `validation/`.

Create superadmin, owner Alice, reader Bob, writer Carol, agent-member stranger
Dave, eligible non-member Eve, pending, banned and unapproved-admin accounts.
Use actual browser login, chat tool execution and scheduler dispatch; model,
Slack/container prerequisites that are unavailable are NOT RUN gaps.

Implemented dashboard-scoped contracts, outside the agent-gated subtree:

| Request | Body | Success |
| --- | --- | --- |
| `GET /api/dashboards` | — | `{ owned: DashboardRow[], shared: DashboardRow[] }` |
| `GET /api/dashboards/recipients` | — | `{ users: { id, name, email }[] }` |
| `PATCH /api/dashboards/:id/sharing` | `{ shares: Share[] }` | `{ dashboard: DashboardRow }` |
| `POST /api/dashboards/:id/claim` | `{}` | `{ dashboard: DashboardRow }` |
| `DELETE /api/dashboards/:id` | — | `{ ok: true }` |

`Share` is `{kind:"user",id,mode:"read"|"write"}` or
`{kind:"all",mode:"read"|"write"}`; no teams/duplicates/ineligible recipients.
`DashboardRow` includes registration id, agent id/name, title, slug, link,
params/linksTo, updatedAt/publishedAt, legacy/isOwner/shared, ownerName/mode and
owner-only shares. Validation/auth errors use `{error:string}`: unauthenticated
API 401, ineligible API 403, invalid shares 400. Unavailable/unauthorized
dashboard responses use Hono's plain-text 404; publication/IO failures use its
plain-text 500. Clients handle these by status, without assuming JSON errors.
Viewer unauthenticated requests redirect to login; denied viewers return404.
Missing publication is an error and must never return draft HTML.

Capture numbered PNG + DOM files and redacted API/tool/job/persisted evidence:

1. **01 — Create/link:** actual Alice chat calls `dashboard_create`, owns a
   private registration with PUBLISHED-1; Dave/Eve list/view/tool access denied;
   registered-slug takeover denied; `dashboard_link` changes no publication,
   registration or history.
2. **02 — Share/publish:** Alice grants Bob read, Carol write, Eve read; use
   Manage access in the browser. Alice/Carol see DRAFT-2, Bob/Eve PUBLISHED-1;
   actual writer update publishes without ACL changes. SQL changes stay live.
   Readers cannot publish; writers cannot manage/delete. Revoke applies fresh.
3. **03 — Roles/eligibility:** platform read/write, logged-out/pending/banned/
   unapproved-admin exclusion, scoped non-admin picker includes teamless Eve,
   malformed/team/duplicate/ineligible grants rejected without mutation.
   Superadmin reads without write/manage. Agent loss keeps owner management and
   writer draft access while denying chat/job publication.
4. **04 — Relationships:** shared parent, private parameterized child and legacy
   child; inspect runtime links AND row linksTo for member/non-member; each
   target uses its own authorization. Reader title/params come from publication.
5. **05 — Scheduler:** real owner/reader/Team publication runs, platform-write
   success, revoke denial, missing mode Team, owner-without-owner failure,
   creatorless Team converted to owner survives reload, owner agent loss fails.
6. **06 — Actors:** single-user channels/jobs local identity, host/container
   transport, real synthetic-owned evals, unpaired Slack pairing then re-ask,
   unsupported multi-user userless creation refusal. Preserve credentials.
7. **07 — Durability:** ordinary/Git/sandbox publication, same-content update,
   >20 history versions, no history-pruning loss, missing publication fails
   closed, failed replacement preserves complete old page and subsequent retry.
   Exercise finite timeout/failure and prove unrelated work progresses.
8. **08 — Upgrade:** prior registered and disk-only ordinary/sandbox dashboards
   migrate once before runs/traffic; marker commits only on success. Interrupted
   retry has no duplicates. Restart/later agent/draft additions do not import.
   Fresh home without prior runtime state initializes without discovery.
9. **09 — Claim:** browser claim preserves URL, publishes current HTML and
   makes claimant owner/private; former members and Team job denied. Concurrent
   claims yield one owner; subsequent deliberate grants permit recipients.
10. **10 — Lifecycle:** remove draft only, reader still reads publication;
    retained history restore recreates draft/republishes and preserves ACLs;
    restart persists owner/grants/link; owner HTTP/tool delete clears dashboard
    artifacts and retains DB; recreate has fresh identity/private owner. Verify
    revoke/update and delete/recreate races through real dispatch regressions.
11. **11 — Home:** sidebar Agents → Dashboards → Teams with active state;
    owned grouped by agent including inaccessible agents, shared owner/mode,
    empty states, parameterized pages without broken Open, owner access/delete
    from home, non-member direct-link login, single-user sidebar.

Record implementation revision, isolated homes/ports, exact commands and
PASS/FAIL/NOT RUN per scenario/AC in `validation/notes.md`, with evidence links.
Screenshots alone do not establish denied server-side mutation.
