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
