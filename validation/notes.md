# ALG-437 validation

- Branch: `ALG-437-dashboards-tab`
- Temporary home: `.yoplai-e2e`
- Gateway/UI: `http://127.0.0.1:4001`, `http://127.0.0.1:3001`
- Focused tests: Canvas 35/35, REST access 10/10, EditAgent 25/25.
- Static checks: `pnpm typecheck` passed; `pnpm lint` passed with 121 existing warnings and 0 errors; `git diff --check` passed.
- Browser: Alice opened the Sales agent Dashboards tab, saw title/slug/updated time, opened the stable link with HTTP 200 and matching content, and copied the exact link. Admin saw the empty state after the dashboard file was temporarily moved out of discovery and then restored.
- API: Alice received 200 for the accessible agent; Bob received 403; an admin received 404 for a missing agent.
- Evidence: `01-dashboard-list.png`, `01-dashboard-list.dom.txt`, `02-dashboard-empty.png`, `02-dashboard-empty.dom.txt`.
