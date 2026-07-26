# ALG-342 E2E Validation Notes

- Branch: `alg-342-membership` (base `teams`), issue ALG-342 (User↔team membership + team detail)
- Temp home: `.yoplai-e2e/` (isolated; never touched `~/.yoplai`)
- Ports: gateway `http://127.0.0.1:4001`, UI `http://127.0.0.1:3001` (auto-picked; 4000/3000 busy)

## Tests run first (all green)
- `pnpm exec vitest run packages/extensions/multi-user` → 86 passed (incl. new membership.test.ts 10, db.test.ts +1, admin-routes.test.ts +4)
- `pnpm test:web` → 355 passed (incl. new api/teams.test.ts 3)
- `pnpm exec tsc -b packages/extensions/multi-user apps/web` → clean
- eslint on changed files → clean

## Real-stack E2E (against live gateway + isolated home)
Real gateway booted with the temp home and created the schema:
- `sqlite3 .yoplai-e2e/auth.db '.schema team_members'` shows the M2M table with
  composite PK `(teamId,userId)`, FKs to `teams`/`user` (cascade), and `idx_team_members_user_id`.
  Evidence: this notes file + `membership-api-transcript.txt`.

Membership behavior exercised through the real gateway's `auth.db` via the
compiled `membership.ts`/`teams.ts` stores (`membership-api-transcript.txt`):
- PASS user in multiple teams: `teamsForUser(user-1)=["alpha","beta"]`
- PASS listing both directions: `usersForTeam(alpha)=["user-1","user-2"]`
- PASS idempotent add: row count stays 1 on re-add; original `addedBy` preserved
- PASS real teamless set: `usersOnlyInTeam(alpha)=["user-2"]`;
  `deleteTeam(beta)` → `{deleted:true, teamlessUsers:["user-1"], teamlessAgents:[]}`
- PASS remove: `usersForTeam(alpha)=["user-2"]` after removing user-1
- PASS FK cascade: after deleting beta, `teamsForUser(user-1)=[]`

Guard surface (`api-guard-transcript.txt`) — routes mounted on the live gateway:
- PASS `GET /api/teams/:id/members` unauth → 401
- PASS `POST /api/admin/teams/:id/members` unauth → 401
- PASS `DELETE /api/admin/teams/:id/members/:userId` unauth → 401
- UI `/teams` serves (200).

## Harness gap (documented, not skipped)
Full browser add/remove-through-the-UI and the authenticated admin-vs-user
403/200 API split could NOT be exercised: multiUser requires Google OAuth to
mint a real session, and the e2e config uses placeholder OAuth credentials, so
no logged-in browser session (and thus no admin/user cookie) can be created in
this harness. The admin-guard (403 for non-admin) and idempotent 200 add paths
are fully covered by `admin-routes.test.ts` against the real Hono app + auth
middleware; the unauthenticated 401s above confirm the routes are wired on the
live gateway. Membership persistence/mechanics are proven end-to-end against the
real gateway DB as above.
