---
name: dashboard
description: >-
  Build and maintain Yoplai Canvas dashboards backed by live SQLite data. Use
  when an answer is recurring, data-heavy, or something people will revisit;
  when asked for a dashboard, report, OKRs, PTO, recruiting/ATS, clients,
  customer health, or a QBR; or when updating an existing dashboard.
---

# Dashboard

Create a dashboard when the answer is recurring, data-heavy, or will be revisited. Answer small one-off questions inline.

## Required workflow

1. Inspect existing `data/dashboards/`, `data/`, and `data/migrations/`. Update existing files in place; do not rewrite a dashboard that only needs a refinement.
2. For a starter, copy the matching files from this skill's `templates/` directory. Available HR templates: `okr-me`, `okr-company`, `pto-me`, `pto-team`, `ats`, `candidate`. Available CS templates: `clients`, `client`, `qbr`.
3. Keep derived SQLite databases under `data/`. Keep their schema in `data/migrations/`; every mutable table has an `updated_at` column. If markdown or another source is authoritative, keep the database rebuildable from it. See [data.md](references/data.md).
4. Put each page at `data/dashboards/<slug>.html`; `data-db` paths are relative to the workspace root (for example `data/hr.db`). Use live SQL blocks and the Canvas runtime exactly as described in [canvas.md](references/canvas.md). Use the Dashboard Kit and ECharts patterns in [kit.md](references/kit.md).
5. Aggregate in SQL. For large sources, precompute rollups with scheduled jobs instead of sending raw rows to the browser.
6. Personalize with `:viewer_email`; use URL parameters for drill-downs. Never put credentials, tokens, private keys, or other secrets in HTML, SQL, URLs, or browser data.
7. Validate every query before sharing. `dashboard_link` checks without a viewer or URL parameters, so personalized and drill-down queries may appear empty. Substitute a real email/id and run each query with `sqlite3`; confirm expected rows.
8. Call `dashboard_link` after every create or update, and every time you share a dashboard link, even one published earlier. Reply on the current channel—web, Slack, Discord, or elsewhere—with the `link` it returns, copied exactly; never rewrite its host or path from memory or other docs. Never say only “it is in your dashboards tab.” When summarizing the dashboard in that reply, quote numbers only from the query results you actually ran with `sqlite3`; never compute or estimate figures in prose.

## Start from a template

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

## Maintain

When chat supplies a correction, update the relevant SQLite rows and their `updated_at`, then reload the existing link. When layout or presentation changes, make the smallest edit to the existing HTML. Re-run affected SQL with concrete bindings and call `dashboard_link` again.
