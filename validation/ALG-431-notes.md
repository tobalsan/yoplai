# ALG-431 validation

- Branch: `ALG-431-canvas-dashboards`
- Isolated home: `.yoplai-e2e` (removed after validation)
- Gateway/UI: `http://127.0.0.1:4410`, `http://127.0.0.1:3410`
- Tests: `pnpm test:shared` (192 passed), `pnpm test:gateway` (624 passed), `pnpm test:web` (433 passed), `pnpm typecheck` (passed), `pnpm lint` (0 errors; existing warnings)
- Real stack: `YOPLAI_HOME=$(pwd)/.yoplai-e2e pnpm dev`
- Dashboard: `/d/e2e-dashboard-id` returned 200 through the Vite proxy with the exact sandbox CSP and `Cache-Control: no-store`; an unknown id returned 404.
- Browser CSP: headless Chrome executed the inline script, while `fetch("/api/me", { credentials: "include" })` rejected; resulting DOM was `<body data-api="blocked">`.
- Fresh edits: changed the heading from `Canvas E2E v1` to `Canvas E2E v2`; the same link returned `v2` on its next request.
- Auth/team behavior is covered by route tests with authenticated member, authenticated non-member, and unauthenticated contexts; a real multi-user OAuth session was not available in this isolated harness.
