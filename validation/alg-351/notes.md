# E2E Validation — ALG-351 (Rehome team edit to Edit-Agent page)

- Branch/issue: alg-351-rehome-team-edit / ALG-351 (base: teams)
- Temp home: ./.yoplai-e2e (YOPLAI_HOME)
- Gateway port: 4001 (4000 was in use), UI port: 3000
- Admin bearer minted via `user token create` bootstrap path for a seeded superadmin
  (auth.db seed only — not this slice's data, per playbook §4).

## Tests run
- pnpm test:web  -> 44 files / 370 passed
- pnpm exec vitest run apps/web/src/pages/{EditAgent,AgentCatalog}.test.tsx -> 11 passed
- pnpm --filter @yoplai/shared build + pnpm build:web -> clean

## Real-stack E2E (gateway 4001 + real APIs the page calls)
The Edit-Agent Team-assignment section calls the exact admin fork APIs exercised below.

1. Create teams Red, Blue (POST /api/admin/teams) -> 200, ids returned.
2. ASSIGN never-forked pool agent `sales` -> Red
   POST /api/admin/forks/assign {poolId:sales, teamId:Red}
   -> fork {sourcePoolId:sales, forkAgentId:fork__sales, teamId:Red}
   -> fork folder created on disk: .yoplai-e2e/forks/fork__sales/agent.yaml (id: fork__sales)
   (this is the page's never-forked path: assignPoolToTeam)  ✅ PASS
3. REASSIGN forked agent `sales` Red -> Blue
   POST /api/admin/forks/sales/reassign {teamId:Blue}
   -> fork.teamId now Blue; DB row agent_forks: sales|fork__sales|<Blue>
   (this is the page's forked path: reassignFork)  ✅ PASS
4. Persistence: agent_forks table row + forks/fork__sales folder persist.  ✅ PASS
5. Admin gate: unauthenticated POST to /api/admin/forks/assign and
   /api/admin/forks/:poolId/reassign both -> 401.  ✅ PASS
6. SPA route GET /agents/sales/edit -> 200 (page served).  ✅ PASS

## UI wiring
- Built web bundle no longer contains `catalog-assign` (inline controls removed).  ✅
- Built web bundle contains `edit-agent-team` (new page section).  ✅
- AgentCatalog.tsx source: 0 references to AssignToTeam.  ✅

## Harness gap
A fully authenticated *browser* click-through (admin login -> open edit page ->
pick team -> click Assign/Move) cannot be run: multiUser requires Google OAuth and
the e2e config uses placeholder client creds, so no logged-in browser session can
be minted (same documented gap as ALG-350). The admin-gated UI branch, the
never-forked assign path, and the forked reassign path are covered by unit tests
against the real Solid component + real teams API seam, and the underlying
admin-guarded fork APIs the page calls are proven end-to-end above (assign +
reassign + persistence + 401 gate) against the live gateway.
