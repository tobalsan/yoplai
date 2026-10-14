---
name: dashboard
description: >-
  Build and maintain Yoplai Canvas dashboards backed by live SQLite data. Use
  when an answer is recurring, data-heavy, or something people will revisit;
  when asked for a dashboard, report, OKRs, team/company KPI rollups, PTO,
  recruiting/ATS, clients, customer health, or a QBR; or when updating an
  existing dashboard; or when asked to visually check, verify, or screenshot a
  dashboard (Chromium and playwright-cli are available in the sandbox).
---

# Dashboard

Create a dashboard when the answer is recurring, data-heavy, or will be revisited. Answer small one-off questions inline.

## Contract

These hold on every page; the platform, sharing, and data safety depend on them.

1. Inspect `data/dashboards/`, `data/`, and `data/migrations/` first. Update existing files in place instead of rewriting.
2. Pages live at `data/dashboards/<slug>.html`. Load only platform assets (`/d-assets/v2/…`); Canvas CSP blocks everything else. Follow [canvas.md](references/canvas.md) for SQL blocks and the runtime. Link only to pages that exist in `data/dashboards/`: `YOPLAI.link` throws on an unknown slug and breaks the page, so create the drill-down page (e.g. copy the template's `client.html`) or leave the link out.
3. Put all page code in one `<script type="module">`; a classic script breaks on names like `top` or `location`. Use `addEventListener`, not inline `on*=` handlers. Use `dashboard_link` for static/query validation and the visual recipe below for browser checks.
4. Keep derived SQLite databases under `data/`, schema in `data/migrations/`, every mutable table with `updated_at`. If markdown or another source is authoritative, keep the database rebuildable from it. See [data.md](references/data.md).
5. Aggregate in SQL; precompute rollups with scheduled jobs for large sources.
6. Personalize with `:viewer_email`; use URL parameters for drill-downs. Put no credentials, tokens, keys, or other secrets in HTML, SQL, URLs, or browser data.
7. Validate every query before sharing. `dashboard_link` runs without a viewer or URL parameters, so personalized queries may look empty. Substitute real values, run each query with `sqlite3`, and confirm it returns the expected rows and scope.
8. Call `dashboard_link` after every create or update, and every time you share a link. Fix every `problems` and `queryErrors` entry. Reply with the returned `link` copied exactly; do not rebuild host or path from memory. For pages needing URL parameters, share the entry page or append the real query string to the link.
9. When summarizing in chat, quote only numbers from query results you ran; do not compute or estimate figures in prose.
10. To remove a dashboard, call `dashboard_delete` with its slug (keeps shared `.db` files).
11. Maintenance is surgical: update rows and `updated_at` for data corrections, make the smallest edit to existing HTML for presentation changes, re-run affected SQL with real bindings, call `dashboard_link` again.

## Check it visually

In the sandbox, Chromium and `playwright-cli` are already installed. Never install a browser or Playwright, or write a render script. Use the gateway rendering, which runs the same dashboard queries and kit as viewer pages with `YOPLAI.viewer = { email: null, name: null }`; screenshots show the no-viewer rendering, so personalized data can be empty.

Replace `<slug>` with the dashboard filename including `.html` (for example `clients.html`):

```bash
cd /tmp
playwright-cli open "$YOPLAI_DASHBOARD_URL_PREFIX/<slug>/html?token=$YOPLAI_AGENT_TOKEN&theme=light"
playwright-cli resize 1280 800
playwright-cli console
playwright-cli screenshot --full-page --filename=/tmp/shot-light.png
# For tabs/expanders: playwright-cli snapshot, then click eN and screenshot again.
playwright-cli close
```

Then use `read /tmp/shot-light.png` to see the image. Always check light and dark (`theme=dark`) and a 420 px width (`playwright-cli resize 420 800`) before sharing a link. Append actual URL parameters for drill-down pages; `YOPLAI.link` carries authentication and theme to the target. Fix every console error (the kit also shows `.dk-error-banner`), then rerun the checks. `snapshot` is cheaper than a screenshot for checks such as "is the table there?" Close the browser when done: it holds about 200 MB.

Browser state/output defaults to `/tmp/playwright`, outside the workspace. Keep the token URL private; share only the viewer link returned by `dashboard_link`. Give the Bash tool an explicit timeout so a hung browser command returns an error and the turn can continue.

## Design

Start from what the reader will do with the page: monitor, read, work through a list, look up one thing, compare, or find a starting point. Pick the shape that fits, using [layouts.md](references/layouts.md); mixing shapes is fine. Then use the components and visual conventions in [kit.md](references/kit.md).

Templates are starters for their data workflows (schema, migrations, drill-down links). Their layout is one example, not the house style. For a new kind of page, take the data pieces and choose the layout fresh; a page that opens with a "Needs attention" callout and KPI strip only when it has something to flag reads better than one that always does.

## Starters

Available HR templates: `pto-me`, `pto-team`, `ats`, `candidate`. OKR templates: `okr-teams`, `okr-me`, `okr-reports` (see [okr.md](references/okr.md); OKRs live in their own `data/okr.db`, never `data/hr.db`, because they are shared more widely than confidential HR data). CS templates: `clients`, `client`, `qbr`.

### Copying a template

Copy only the requested dashboard family and its migration/seed files. Run the SQL with `sqlite3`, then validate and publish:

```sh
mkdir -p data/dashboards data/migrations
cp <skill-dir>/templates/hr/dashboards/pto-me.html data/dashboards/
cp <skill-dir>/templates/hr/data/migrations/001_hr.sql data/migrations/
cp <skill-dir>/templates/hr/data/sample.sql data/
sqlite3 data/hr.db < data/migrations/001_hr.sql
sqlite3 data/hr.db < data/sample.sql
sqlite3 -header data/hr.db "SELECT * FROM pto WHERE lower(employee_email)=lower('henry@example.com');"
```

For the CS wiki workflow, read [cs-wiki.md](references/cs-wiki.md). It rebuilds `data/cs.db` from markdown, then supports `clients` → `client?id=…` → `qbr?id=…&quarter=…`.
