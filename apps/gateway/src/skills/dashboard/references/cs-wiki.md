# Rebuild CS dashboards from wiki markdown

The sample wiki at `templates/cs/wiki/clients.md` is authoritative. Copy the CS template tree, then rebuild:

```sh
mkdir -p data/dashboards data/migrations data/wiki data/scripts
cp <skill-dir>/templates/cs/dashboards/*.html data/dashboards/
cp <skill-dir>/templates/cs/data/migrations/001_cs.sql data/migrations/
cp <skill-dir>/templates/cs/wiki/clients.md data/wiki/
cp <skill-dir>/templates/cs/scripts/wiki-to-cs-db.mjs data/scripts/
node data/scripts/wiki-to-cs-db.mjs data/wiki/clients.md data/cs.db data/migrations/001_cs.sql
```

The importer recreates the derived DB and loads client metadata, integrations, tickets, weekly themes, and quarterly metrics. Verify with `sqlite3 data/cs.db 'SELECT id,name FROM clients'`. Publish `clients.html`, follow a generated `client.html?id=...` link, then its `qbr.html?id=...&quarter=...` link.
