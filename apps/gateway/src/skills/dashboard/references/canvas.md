# Canvas file contract

- Dashboard files are single HTML documents at `data/dashboards/<slug>.html`.
- `data-db` is a path relative to the workspace root, such as `data/app.db`. Keep databases under `data/`; sandboxed agents can only read databases there.
- Live query:

```html
<script type="application/sql" data-name="items" data-db="data/app.db">
  SELECT * FROM items WHERE lower(owner_email) = lower(:viewer_email)
</script>
```

- Page code goes in one `<script type="module">`; classic inline scripts share the browser's global scope and break on names like `top`. Module scripts run after the SQL results are injected.
- Query results are injected before page scripts as `YOPLAI.data.items`.
- `YOPLAI.viewer` contains `email` and `name`; `YOPLAI.params` contains URL query parameters.
- `YOPLAI.link("client.html", { id: row.id })` makes a safe same-agent drill-down URL. It throws on a slug that exists nowhere. A link to an existing page the viewer can't open renders disabled ("Not shared with you") and the page keeps running. `YOPLAI.canLink(slug)` is true only when the viewer can open the target: use it to hide links that should disappear, such as nav menu items.
- Any dashboard that is meaningless without URL arguments must declare them in its head: `<meta name="yoplai:params" content="id">` (comma-separated for multiple required arguments, e.g. `content="id,quarter"`). The agent's Dashboards tab shows these pages as non-clickable children of every dashboard linking to them via `YOPLAI.link`; unreachable pages appear under "Needs parameters". Do not declare optional arguments, such as OKR owner/period filters with defaults.
- Call `dashboard_create({ slug: "client.html" })` once to privately register/publish as the requester. Registered slugs cannot be taken over. Call `dashboard_update` to publish edits. Both return the absolute `link`, SQL diagnostics (`queryErrors`) and static checks (`problems`). `dashboard_link({ slug? })` returns readable links only; it never registers, publishes, diagnoses or records history.
- A page may have 20 queries. Each has a two-second, 5,000-row, 5MB result limit. Keep queries read-only and bounded.

Publication diagnostics execute SQL with `:viewer_email`, `:viewer_name`, and URL params set to null. Before sharing, replace placeholders with quoted real values and run the queries through `sqlite3`.

Owners/writers see live working HTML; read-only viewers see durable published HTML and metadata. SQL remains live. Manage selected-user/platform-wide read/write grants from **Dashboards**, without requiring agent membership; publishing requires agent execution access. Legacy pages stay agent-gated/live until claimed privately. Drill-down pages have independent grants; the Dashboards tab omits targets the viewer cannot open. Never share internal agent-token preview URLs or reveal pages the requester cannot access.

## Editable pages

Declare editable columns in one or more blocks (max 20 per page, 100KB each):

```html
<script type="application/json" data-yoplai-edit="actions">
{
  "db": "data/app.db",
  "table": "actions",
  "key": "id",
  "updatedAt": "updated_at",
  "fields": {
    "manual_done": { "type": "bool", "nullable": true },
    "manual_pct": { "type": "int", "min": 0, "max": 100, "nullable": true },
    "manual_state": { "type": "enum", "values": ["todo", "doing", "done"], "nullable": true },
    "comment": { "type": "text", "max": 500, "nullable": true },
    "archived": { "type": "bool" }
  },
  "guard": "SELECT 1 FROM actions WHERE id = :key AND lower(owner_email) = lower(:viewer_email)",
  "create": true
}
</script>
<input type="checkbox" data-edit="actions" data-key="7" data-field="manual_done" />
```

- `db` follows the `data-db` rule; `table`, `key` (one column) and field names match `^[A-Za-z_]\w*$`. `updatedAt` (optional) is set to the edit time.
- Field types: `bool`, `int` (`min`/`max`), `text` (`max`, default 2000), `enum` (`values`); `nullable: true` lets users clear the value (clearing returns to the agent value; an empty text is stored as `NULL`).
- `guard` (optional): one read-only SELECT with `:key`, `:viewer_email`, `:viewer_name`; it returns a row when the viewer may edit that row. Use the same predicate the page query uses to show the row. It never sees URL parameters.
- `create: true` allows `YOPLAI.add`; `key` must be the table's `INTEGER PRIMARY KEY`.
- The server uses only the declaration in the served HTML, never the request.

Rights: the owner and write-share users edit any row of a declared table. Read-only viewers edit only rows the guard returns; with no guard they are refused. Adding rows is for writers only. A platform admin impersonating a user is read-only (no edit token, `YOPLAI.canWrite` false). Legacy pages must be claimed before they accept edits.

Runtime calls (both reject with the server's message, e.g. "Row not found"):

- `await YOPLAI.edit({ edit, key, field, value })` → `{ value, at }`
- `await YOPLAI.add({ edit, values })` → `{ key, values, at }` (writers only; `values` are the persisted declared fields, defaults included)
- `YOPLAI.canWrite`: viewer is owner/writer (show add buttons). `YOPLAI.canEdit`: an edit token exists (false under impersonation).

Calls go to the page's own `/d/` endpoints with a token valid about 8 hours; after expiry the page shows "Reload to keep editing". Every edit and add is logged in `dashboard_edits` (see [data.md](data.md)). Lint reports malformed declarations, `data-edit` naming an undeclared edit, and edit pages that do not load the `v3` kit.
