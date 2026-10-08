---
name: dashboard
description: >-
  Build and maintain Yoplai Canvas dashboards backed by live SQLite data. Use
  when an answer is recurring, data-heavy, or something people will revisit;
  when asked for a dashboard, report, OKRs, team/company KPI rollups, PTO,
  recruiting/ATS, clients, customer health, or a QBR; or when updating an
  existing dashboard.
---

# Dashboard

Create a dashboard when the answer is recurring, data-heavy, or will be revisited. Answer small one-off questions inline.

## Contract

These hold on every page; the platform, sharing, and data safety depend on them.

1. Inspect `data/dashboards/`, `data/`, and `data/migrations/` first. Update existing files in place instead of rewriting.
2. Pages live at `data/dashboards/<slug>.html`. Load only platform assets (`/d-assets/v2/…`); Canvas CSP blocks everything else. Follow [canvas.md](references/canvas.md) for SQL blocks and the runtime. Link only to pages that exist in `data/dashboards/`: `YOPLAI.link` throws on an unknown slug and breaks the page, so create the drill-down page (e.g. copy the template's `client.html`) or leave the link out.
3. Put all page code in one `<script type="module">`; a classic script breaks on names like `top` or `location`. Use `addEventListener`, not inline `on*=` handlers. Do not build your own browser test harness; `dashboard_link` is the check.
4. Keep derived SQLite databases under `data/`, schema in `data/migrations/`, every mutable table with `updated_at`. If markdown or another source is authoritative, keep the database rebuildable from it. See [data.md](references/data.md).
5. Aggregate in SQL; precompute rollups with scheduled jobs for large sources.
6. Personalize with `:viewer_email`; use URL parameters for drill-downs. Put no credentials, tokens, keys, or other secrets in HTML, SQL, URLs, or browser data.
7. Validate every query before sharing. `dashboard_link` runs without a viewer or URL parameters, so personalized queries may look empty. Substitute real values, run each query with `sqlite3`, and confirm it returns the expected rows and scope.
8. Call `dashboard_link` after every create or update, and every time you share a link. Fix every `problems` and `queryErrors` entry. Reply with the returned `link` copied exactly; do not rebuild host or path from memory. For pages needing URL parameters, share the entry page or append the real query string to the link.
9. When summarizing in chat, quote only numbers from query results you ran; do not compute or estimate figures in prose.
10. To remove a dashboard, call `dashboard_delete` with its slug (keeps shared `.db` files).
11. Maintenance is surgical: update rows and `updated_at` for data corrections, make the smallest edit to existing HTML for presentation changes, re-run affected SQL with real bindings, call `dashboard_link` again.

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
