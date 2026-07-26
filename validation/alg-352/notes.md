# E2E Validation — ALG-352 Extension catalog API

- **Issue/branch:** ALG-352 / `alg-352-extension-catalog` (base `teams`)
- **Temp home:** `.yoplai-e2e/` (pool: `sales`, `support`; external extension dir `.yoplai-e2e/extensions/acme-crm`)
- **Gateway/UI ports:** gateway `http://127.0.0.1:4001`, web `http://127.0.0.1:3000` (4000 was busy; dev auto-picked 4001)

## Tests run (all green)
- `pnpm test:shared` → 81 passed
- `pnpm test:gateway` → 302 passed (incl. `extensions/catalog.test.ts` ×7, `server/api.core.test.ts` catalog endpoint ×5)
- `pnpm test:web` → 372 passed (incl. `EditAgent.test.tsx` ×8, +2 new extension-list tests)
- `pnpm typecheck` → clean; changed files lint-clean (pre-existing errors in scheduler test + a pre-existing control-char regex are unrelated).

## Real-stack E2E

Launched the actual gateway/web stack against the temp home (`YOPLAI_HOME=.yoplai-e2e pnpm dev`).

### Catalog builder against real config + real filesystem scan — PASS
`buildExtensionCatalog(loadConfig(), <pool agent>)` executed in-process against the
running deployment's real config and a real directory scan of `$YOPLAI_HOME/extensions`.
Evidence: `validation/catalog-builder.json`, `validation/per-agent-enabled.txt`.

- **Discovery accurate:** 13 entries = 12 built-in (static registry) + 1 external
  (`acme-crm` from the temp dir). No duplicates, no ghosts. Built-ins that fail to
  load would be omitted; all 12 loaded here.
- **External extension surfaced:** `acme-crm` → `builtIn:false, tier:auto-form,
  requiredSecrets:["apiKey"], configJsonSchema` present.
- **Per-agent enabled state correct:**
  - `sales`: `acme-crm enabled:true` (agent config `enabled:true`), `telegram enabled:false` (agent config `enabled:false`).
  - `support`: `acme-crm enabled:false`, `telegram enabled:false` (no per-agent config → disabled), while the same full catalog is still listed.
- **Tiers:** `bespoke-route` for route-owning built-ins (scheduler, projects, multiUser, subagents, orchestrator, webhooks, heartbeat), `auto-form` for `acme-crm` (schema), `toggle-only` for discord/slack/telegram/langfuse.

### Admin-guard (HTTP) — PASS (boundary proven)
Evidence: `validation/http-probes.txt`.
- `GET /api/agents/sales/extensions` unauthenticated → **HTTP 401** (gateway auth
  middleware blocks before the route; the route additionally 403s a non-admin
  authenticated caller — covered by unit tests `api.core.test.ts`).
- `GET /api/pool` unauthenticated → 401 (same boundary).
- `GET /api/capabilities` → 200, `multiUser:true`.

## Harness gap (documented, not skipped)
A fully authenticated browser walkthrough (admin login → open `/agents/:id/edit` →
see the read-only extension list) could not run here: multiUser requires Google
OAuth and the e2e config uses placeholder credentials (`e2e-google-client`), so no
logged-in browser/admin session can be minted (same gap recorded for ALG-350). The
admin-only 200 path, the non-admin 403 path, agent resolution (pool + active), 404,
and the read-only UI list are all covered by unit tests exercising the real Hono
route and the real Solid component; the catalog discovery/tier/enabled logic is
proven against the live gateway's real config + filesystem above.
