import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";

const [wikiPath, dbPath, migrationPath] = process.argv.slice(2);
if (!wikiPath || !dbPath || !migrationPath) {
  console.error(
    "usage: node wiki-to-cs-db.mjs <wiki.md> <cs.db> <migration.sql>"
  );
  process.exit(1);
}
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const blocks = readFileSync(wikiPath, "utf8")
  .split(/^# Client: /m)
  .slice(1);
const now = new Date().toISOString();
const statements = [readFileSync(migrationPath, "utf8"), "BEGIN;"];
let nextId = 1;
for (const block of blocks) {
  const lines = block.trim().split("\n");
  const name = lines.shift().trim();
  const fields = Object.fromEntries(
    lines.filter(Boolean).map((line) => {
      const index = line.indexOf(":");
      return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
    })
  );
  const required = [
    "id",
    "owner_email",
    "segment",
    "health",
    "arr",
    "renewal_date",
    "summary",
  ];
  if (required.some((key) => !fields[key]))
    throw new Error(`Missing required field for ${name}`);
  statements.push(
    `INSERT INTO clients VALUES (${[fields.id, name, fields.owner_email, fields.segment, fields.health, Number(fields.arr), fields.renewal_date, fields.summary, now].map(quote).join(",")});`
  );
  for (const item of (fields.integrations || "")
    .split(";")
    .map((v) => v.trim())
    .filter(Boolean)) {
    const [integration, status] = item.split("|");
    statements.push(
      `INSERT INTO integrations VALUES (${nextId++},${quote(fields.id)},${quote(integration)},${quote(status)},${quote(now)});`
    );
  }
  for (const item of (fields.tickets || "")
    .split(";")
    .map((v) => v.trim())
    .filter(Boolean)) {
    const [id, subject, priority, status, opened] = item.split("|");
    statements.push(
      `INSERT INTO tickets VALUES (${[id, fields.id, subject, priority, status, opened, now].map(quote).join(",")});`
    );
  }
  for (const item of (fields.themes || "")
    .split(";")
    .map((v) => v.trim())
    .filter(Boolean)) {
    const [week, theme, mentions] = item.split("|");
    statements.push(
      `INSERT INTO weekly_themes VALUES (${nextId++},${quote(fields.id)},${quote(week)},${quote(theme)},${Number(mentions)},${quote(now)});`
    );
  }
  for (const item of (fields.metrics || "")
    .split(";")
    .map((v) => v.trim())
    .filter(Boolean)) {
    const [quarter, active, adoption, tickets, csat] = item.split("|");
    statements.push(
      `INSERT INTO quarterly_metrics VALUES (${nextId++},${quote(fields.id)},${quote(quarter)},${Number(active)},${Number(adoption)},${Number(tickets)},${Number(csat)},${quote(now)});`
    );
  }
}
statements.push("COMMIT;");
if (existsSync(dbPath)) unlinkSync(dbPath);
const result = spawnSync("sqlite3", [dbPath], {
  input: statements.join("\n"),
  encoding: "utf8",
});
if (result.status !== 0) {
  console.error(result.stderr || "sqlite3 failed");
  process.exit(result.status ?? 1);
}
console.log(`Rebuilt ${dbPath} from ${blocks.length} clients`);
