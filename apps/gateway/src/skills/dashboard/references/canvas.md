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
- `YOPLAI.link("client.html", { id: row.id })` makes a safe same-agent drill-down URL.
- Call `dashboard_link({ slug: "client.html" })` to register or refresh the stable public URL. Its result includes the absolute `link`, SQL diagnostics (`queryErrors`), and static checks of the page (`problems`: script syntax errors, global-name collisions, echarts/kit load order, undeclared `YOPLAI.data` names, inline handlers, 0-row queries).
- A page may have 20 queries. Each has a two-second, 5,000-row, 5MB result limit. Keep queries read-only and bounded.

`dashboard_link` executes SQL with `:viewer_email`, `:viewer_name`, and URL params set to null. Before sharing, replace placeholders with quoted real values and run the queries through `sqlite3`.
