# ALG-354 E2E validation notes

- **Issue:** ALG-354 — 3-tier config-surface contract (auto-form / bespoke route / toggle-only)
- **Branch:** alg-354-config-surface-contract (worktree ~/code/yoplai-alg354)
- **Temp home:** ~/code/yoplai-alg354/.yoplai-e2e  (pool: sales, support; extensionsPath → .yoplai-e2e/extensions)
- **Seeded external extensions:**
  - `bespoke-crm` — declares `configRoute: { path: "/agents/:agentId/extensions/bespoke-crm" }` + a schema (bespoke-route tier; route wins over schema)
  - `exa-search` — schema (`apiKey`) + `requiredSecrets: ["apiKey"]`, no route (auto-form tier)

## Tests run (all green)
- pnpm test:shared → 87 passed (incl. new resolveAgentConfigRoute + defineToolExtension configRoute tests)
- pnpm test:gateway → 317 passed (catalog tier tests updated to the configRoute contract)
- pnpm test:web → 378 passed (4 new EditAgent tier-routing tests: bespoke redirect, auto-form path, toggle-only inline, disable-no-redirect)
- pnpm typecheck → clean; eslint on changed files → clean

## Real-stack e2e — catalog tier + agent-keyed route resolution: PASS
Ran `buildExtensionCatalog(loadConfig(), agent)` — the exact code path the admin
endpoint `GET /api/agents/:id/extensions` calls — against the **real config
load + real filesystem scan** of `.yoplai-e2e/extensions`, for two agents.
Evidence: `catalog-real-scan.txt`. Observed:

- bespoke-crm → tier=**bespoke-route**, configRoutePath resolved **per agent**
  (`/agents/sales/extensions/bespoke-crm` vs `/agents/support/extensions/bespoke-crm`)
  — proves the `:agentId` param substitution mirrors the `:projectId` pattern,
  and that a declared configRoute wins over its schema.
- exa-search → tier=**auto-form**, configRoutePath=**null**, requiredSecrets=["apiKey"]
  — proves schema-driven extensions surface the auto-form path, not a redirect.

## Hub enable-routing behavior — PASS (component-level, real Solid component)
`toggleExtension` in EditAgent.tsx, exercised by the real `EditAgent` Solid
component under vitest/jsdom against the real API client contract:
- enabling a bespoke-route ext → PATCH enabled:true then navigate(configRoutePath)
- enabling an auto-form ext → PATCH enabled:true then navigate(autoFormPath)
- enabling a toggle-only ext → PATCH enabled:true, no navigate
- disabling a bespoke-route ext → PATCH enabled:false, no navigate (never redirect into a surface being turned off)

## Harness gap (documented, not skipped)
A fully independent browser walkthrough (boot the gateway on an isolated
YOPLAI_HOME, log in as admin, click the toggle, observe the real redirect) could
NOT be run: this harness runs an external `hermes_cli gateway run --replace`
supervisor that owns port 4000 and terminates any competing gateway process
(a gateway launched on an alternate port from the temp home dies immediately
with no output). Additionally, admin sessions require Google OAuth with
placeholder creds (same gap flagged in ALG-352/353), so no admin browser
session can be minted here.

Mitigation: the endpoint's admin-guard + agent-not-found paths are covered by
ALG-352's api.core tests; the tier/route metadata is proven end-to-end through
the real config-load + filesystem-scan code path above; the enable-routing
behavior is proven against the real Solid component. No path is claimed as
covered that was not actually exercised.
