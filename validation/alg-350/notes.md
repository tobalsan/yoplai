# ALG-350 E2E Validation Notes

- Branch: `alg-350-edit-agent-shell` (base `origin/teams`), issue ALG-350
  (Edit-Agent page shell + card overlay entry)
- Parent: ALG-349 (Edit-Agent page: extension config hub + team edit)
- Temp home: `.yoplai-e2e/` (isolated; never touched `~/.yoplai`)
- Ports: gateway `http://127.0.0.1:4001`, UI `http://127.0.0.1:3001`
  (auto-picked; 4000/3000 busy)

## Change under test

Web-UI-only slice on top of the pool catalog (`AgentCatalog.tsx`):

1. New admin-gated route `/agents/:agentId/edit` → `EditAgent.tsx`, a minimal
   Edit-Agent page that fetches the pool, identifies the target agent, and
   renders name / role / avatar. Non-admins are redirected home.
2. Each pool catalog card gains a subtle hover/focus highlight and a small
   admin-only edit icon overlaid top-right that links to that agent's edit
   route. Non-admins never see the icon.
3. Inline Move/Assign (`AssignToTeam`) controls are untouched.

## Tests run first (all green)

- `pnpm test:shared` → 81 passed
- `pnpm test:gateway` → 290 passed
- `pnpm test:web` → 369 passed, including:
  - `apps/web/src/pages/EditAgent.test.tsx` (3): renders name/role/avatar for
    admin; not-found for unknown id; non-admin redirect + no page render.
  - `apps/web/src/pages/AgentCatalog.test.tsx` (7): existing 5 action-state
    tests still pass (Move/Assign untouched) + 2 new: admin sees edit icon
    linking to `/agents/<id>/edit`; non-admin sees no edit icon.
- `pnpm build:web` → clean (Rollup bundle built; markers present, see below).
- eslint on changed files → clean.

## Real-stack E2E (against live gateway + isolated home)

Real gateway + web dev stack booted with the temp home
(`YOPLAI_HOME=$(pwd)/.yoplai-e2e pnpm dev`), multiUser enabled, two pool agents
(`sales`, `support`). Evidence: `guard-route-transcript.txt`,
`01-edit-route-served.html`.

- PASS UI SPA shell serves the new route: `GET /agents/sales/edit` → 200,
  `GET /agents/support/edit` → 200, `GET /agents` → 200.
- PASS Edit-page data source requires authentication on the live gateway:
  `GET /api/pool` (unauth) → 401 `{"error":"unauthorized"}`,
  `GET /api/agents` (unauth) → 401. Note: `/api/pool` is auth-gated but NOT
  admin-gated — by design it returns the same name/role/avatar catalog to every
  authenticated user (only per-card actions are gated). The Edit-Agent admin
  gate is therefore a UI-affordance gate (hide icon + redirect non-admins),
  not a data gate; no admin-only data is exposed by this page.
- PASS built bundle (`apps/web/dist/assets/index-O19FIYIW.js`) contains the new
  affordance markers: `catalog-edit` (card overlay) ×6 and `edit-agent-name`
  (edit page) ×2, plus the `/edit` route literal.

## Admin-gating coverage

The page and the edit affordance are gated two ways, both proven by unit tests
against the real component + mocked session:

- Client visibility: `hasAdminRole()` (admin/superadmin) hides the card edit
  icon and, on the page, redirects non-admins to `/` before any render
  (`EditAgent.test.tsx` "redirects a non-admin", `AgentCatalog.test.tsx`
  "does not show the edit icon to a non-admin").
- Server data: the only data source (`/api/pool`) requires authentication (401
  unauth), verified live above. It is not admin-gated and exposes no admin-only
  fields (visibility is intentionally global across the catalog), so the
  client-side admin gate leaks no data.

## Harness gap (documented, not skipped)

Full authenticated browser walkthrough (log in as an admin, hover a card, click
the icon, land on the rendered Edit-Agent page) could NOT be exercised in this
harness, for the same reason recorded in `validation/alg-342/notes.md`:
multiUser requires Google OAuth to mint a real session, and the e2e config uses
placeholder OAuth credentials, so no logged-in browser session (admin or user)
can be created here. No headless browser / playwright / claude-in-chrome tooling
is available in this environment either.

What is proven instead:
- Route wiring and SPA serving are exercised on the live stack (200s above).
- The data source gating is exercised live (401s above).
- The admin-only visibility, non-admin redirect, agent identification
  (name/role/avatar), not-found handling, and the untouched Move/Assign
  behavior are fully covered by unit tests running the real Solid components
  against a mocked session and the real `fetchPool` seam.
