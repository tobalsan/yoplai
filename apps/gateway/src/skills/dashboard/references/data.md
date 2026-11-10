# Dashboard data conventions

- Store a derived SQLite database in `data/`, e.g. `data/hr.db` or `data/cs.db`.
- Store ordered, repeatable schema migrations in `data/migrations/`.
- Every mutable table includes `updated_at TEXT NOT NULL` in ISO-8601 form.
- Use stable identifiers and `INSERT ... ON CONFLICT DO UPDATE` when syncing chat/source changes.
- Keep authoritative markdown/source files beside the database and make SQLite disposable and rebuildable.
- Aggregate and filter in SQL. When raw data becomes large, schedule a job that updates compact rollup tables.
- Do not store secrets in the database if a dashboard query could expose them.

Validation pattern:

```sh
sqlite3 -header -column data/app.db "SELECT ... WHERE lower(owner_email)=lower('real@example.com');"
sqlite3 -header -column data/app.db "SELECT ... WHERE id='real-id';"
```

## User columns and edits

On editable pages (see [canvas.md](canvas.md)) keep user values apart from agent values:

- Agent columns (`state`) are written by your sync; user columns (`manual_state`, `manual_pct`, `comment`) are nullable and never written by it. Show `COALESCE(manual_state, state)`. `NULL` means not user-set; clearing a field returns to the agent value. On user-owned tables (a to-do list) the declared column is the value.
- The user value wins. When your sources disagree with it, show the conflict next to the item; never overwrite it.
- Soft delete: declare an `archived` bool column (`NOT NULL DEFAULT 0`) as editable and filter `WHERE NOT archived`. The sync never writes it, so hidden rows stay hidden. There is no hard delete.
- Rebuildable databases: user columns and `dashboard_edits` live in the same file, so a rebuild must upsert only agent-owned columns and never drop/recreate tables holding user columns or `dashboard_edits`.

Every edit and added row is appended to `dashboard_edits` in the edited table's database: `id, at, dashboard_id, actor_user_id, actor_email, actor_name, edit_name, table_name, row_key, field, old_value, new_value`. Values are JSON-encoded; `field` is `*` for an added row (`new_value` = JSON object of the values). Read it with `sqlite3`:

```sh
sqlite3 -header -column data/app.db "SELECT at, actor_email, old_value, new_value FROM dashboard_edits WHERE table_name='actions' AND row_key='7' AND field='manual_state' ORDER BY id DESC LIMIT 1;"
```
