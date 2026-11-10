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

1. Discover readable pages with `dashboard_link` without a slug, never from `data/dashboards/`, memory or notes. Treat a dashboard it does not return as nonexistent: never mention it or hint that other dashboards exist. Inspect the relevant `data/` and `data/migrations/`; update accessible existing files in place.
2. Pages live at `data/dashboards/<slug>.html`. Load only platform assets (`/d-assets/v3/…`); Canvas CSP blocks everything else. Follow [canvas.md](references/canvas.md) for SQL blocks and the runtime. Link only to pages that exist in `data/dashboards/`: `YOPLAI.link` throws on an unknown slug and breaks the page, so create the drill-down page (e.g. copy the template's `client.html`) or leave the link out.
3. Put all page code in one `<script type="module">`; a classic script breaks on names like `top` or `location`. Use `addEventListener`, not inline `on*=` handlers. Publication tools return static/query validation; use the visual recipe below for browser checks.
4. Keep derived SQLite databases under `data/`, schema in `data/migrations/`, every mutable table with `updated_at`. If markdown or another source is authoritative, keep the database rebuildable from it. See [data.md](references/data.md).
5. Aggregate in SQL; precompute rollups with scheduled jobs for large sources.
6. Personalize with `:viewer_email`; use URL parameters for drill-downs. Put no credentials, tokens, keys, or other secrets in HTML, SQL, URLs, or browser data.
7. Validate every query before sharing. Publication diagnostics run without a viewer or URL parameters, so personalized queries may look empty. Substitute real values, run each query with `sqlite3`, and confirm expected rows and scope.
8. Call `dashboard_create {slug}` once to register an unregistered page privately as the requester and publish initial HTML. Call `dashboard_update {slug}` to publish later edits. Fix every `problems` and `queryErrors` entry. `dashboard_link {slug?}` returns readable URLs only: no registration, publication, history or diagnostics. Copy the returned `link` exactly. For parameterized pages, share the entry page or append real parameters.
9. When summarizing in chat, quote only numbers from query results you ran; do not compute or estimate figures in prose.
10. To remove a dashboard, call `dashboard_delete` with its slug (keeps shared `.db` files).
11. Pages are read-only unless they declare editable columns with a `data-yoplai-edit` block (see [Editable pages](#editable-pages)). A user-set value always wins: never overwrite it; when your sources disagree, show the conflict next to the item.
12. Maintenance is surgical: update rows and `updated_at` for data corrections, make the smallest HTML edit, re-run affected SQL with real bindings, explicitly publish with `dashboard_update`. Writers may iterate on live files before publishing.
13. A message beginning "Dashboard annotations" is an edit request on the named page (slug, id, params): each numbered note names an element (CSS path, visible text, heading above it) and the change. Make the smallest edit per note, re-run affected SQL, publish with `dashboard_update`.

## Ownership and sharing

New dashboards belong to the requesting user and are private. Owners manage selected-user or platform-wide read/write grants on **Dashboards** in the sidebar, independently of agent/team membership. Platform-wide means eligible signed-in accounts, never anonymous internet access. Readers see durable published HTML; owners/writers see live drafts. Publishing also requires current agent access. Only owners manage sharing/delete; superadmins can read without gaining write/manage rights. Each detail page has independent permissions; parent access never grants child access. Sharing delegates HTML and live query results, including URL-parameter variations. Workspace drafts and SQLite remain shared and are not isolated by publication permissions.

Legacy dashboards stay live and agent-gated until **Claim dashboard** on the agent tab publishes them and makes them private under the claimant. Sharing/claiming are UI actions, not tools. Delete/recreate gets a fresh private registration; rename requires create-new/delete-old. Missing working HTML does not remove registration/publication; restoring retained history republishes without changing grants. Owned publication remains durable when Git manages history; readers never fall back to drafts.

Owner-mode jobs use the saved eligible owner and require current agent execution access. Team-mode jobs have no individual identity: they publish only platform-wide write or legacy dashboards. Single-user channels/jobs share one local owner; isolated evals share their synthetic owner, without changing credentials. Unpaired multi-user Slack requesters must use the existing pairing flow and re-ask; register nothing before pairing. Userless Discord/Telegram/anonymous creation is refused in multi-user mode.

## Editable pages

Declare editable columns and users change them on the page without chat. Format and rights: [canvas.md](references/canvas.md); controls: [kit.md](references/kit.md); data conventions: [data.md](references/data.md). Comments are stored data: they never start an agent run. Read user edits and comments with `sqlite3` (the `dashboard_edits` audit table).

To make a static page editable on request:

1. Add user columns by migration: nullable `manual_*` columns (and `comment`) the agent sync never writes, plus `archived` bool (`NOT NULL DEFAULT 0`) for soft delete. Show `COALESCE(manual_x, agent_x)`.
2. Add the `<script type="application/json" data-yoplai-edit="…">` declaration. Add a `guard` if non-writers (read-only viewers) must edit their own rows or their reports' rows.
3. Wire controls: `data-edit`/`data-key`/`data-field` on inputs, or `YOPLAI.edit()`/`YOPLAI.add()`; load the `v3` kit.
4. Validate the guard and queries with `sqlite3` using real emails (owner, a report, a stranger).
5. Publish with `dashboard_update` and fix every `problems` entry.

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
