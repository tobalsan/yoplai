import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

import type {
  DashboardEditRequest as Request,
  DashboardEditResponse as Response,
} from "./sql-protocol.js";

const BUSY_TIMEOUT_MS = 3_000;

class Refusal extends Error {
  constructor(readonly status: 400 | 403 | 404, message: string) {
    super(message);
  }
}

const quote = (name: string) => `"${name}"`;

process.on("message", (request: Request) => {
  let database: Database.Database | undefined;
  let response: Response;
  try {
    const name = enterDatabaseDirectory(request);
    confinedFiles(name);
    const before = openFiles();
    database = new Database(path.join(process.cwd(), name), { fileMustExist: true });
    database.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    const db = database;
    db.exec("BEGIN IMMEDIATE");
    try {
      // SQLite opens by path, which the agent could swap during the open. Check
      // the files SQLite actually holds open, before writing and again before
      // committing (once its journal is open too).
      assertSqliteFilesConfined(name, before);
      const result = request.op === "edit" ? edit(db, request) : add(db, request);
      assertSqliteFilesConfined(name, before);
      db.exec("COMMIT");
      response = { ok: true, ...result };
    } finally {
      if (db.inTransaction) db.exec("ROLLBACK");
    }
  } catch (error) {
    response = failure(error);
  } finally {
    try {
      database?.close();
    } catch {
      // Process exit also releases database resources.
    }
  }
  process.send?.(response);
});

const identity = (stat: { dev: number; ino: number }) => `${stat.dev}:${stat.ino}`;
const SIDECARS = ["-journal", "-wal", "-shm"];

/**
 * Makes the database's directory this process's working directory, verified
 * link by link: the root must be the directory the gateway checked, and each
 * step down must have the previous directory as its parent, so no symlink
 * (or later swap) can lead outside. Names are then resolved from that
 * kernel-held directory, not from a path the agent could swap.
 */
function enterDatabaseDirectory(request: Request): string {
  process.chdir(fs.realpathSync(request.root));
  if (identity(fs.statSync(".")) !== `${request.rootDev}:${request.rootIno}`)
    throw new Error("Agent data directory changed before the edit");
  const parts = path.normalize(request.database).split(path.sep);
  const name = parts.pop()!;
  for (const part of parts) {
    if (!part || part === "." || part === "..")
      throw new Error("Database path escapes the agent data directory");
    const parent = identity(fs.statSync("."));
    process.chdir(part);
    if (identity(fs.statSync("..")) !== parent)
      throw new Error("Database path escapes the agent data directory");
  }
  return name;
}

/**
 * Identities of the database and its existing sidecars, read from the
 * verified working directory without following symlinks.
 */
function confinedFiles(name: string): { database: string; allowed: Set<string> } {
  const stat = fs.lstatSync(name);
  if (!stat.isFile()) throw new Error("Database path is not a file");
  const allowed = new Set([identity(stat)]);
  for (const suffix of SIDECARS) {
    try {
      const sidecar = fs.lstatSync(`${name}${suffix}`);
      if (!sidecar.isFile())
        throw new Error("Database sidecar file is not a regular file");
      allowed.add(identity(sidecar));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return { database: identity(stat), allowed };
}

/** Identities of the regular files this process holds open, by descriptor. */
function openFiles(): Map<string, string> {
  const files = new Map<string, string>();
  for (const name of fs.readdirSync("/dev/fd")) {
    try {
      const stat = fs.fstatSync(Number(name));
      if (stat.isFile()) files.set(name, identity(stat));
    } catch {
      // The descriptor used to list /dev/fd is already closed.
    }
  }
  return files;
}

/**
 * Every file SQLite opened (database, journal, WAL, shared memory) must be
 * the confined database or one of its sidecars, by device and inode.
 */
function assertSqliteFilesConfined(name: string, before: Map<string, string>): void {
  const { database, allowed } = confinedFiles(name);
  let sawDatabase = false;
  for (const [descriptor, opened] of openFiles()) {
    if (before.get(descriptor) === opened) continue;
    if (!allowed.has(opened))
      throw new Error("Database path changed while it was being opened");
    if (opened === database) sawDatabase = true;
  }
  if (!sawDatabase)
    throw new Error("Database path changed while it was being opened");
}

function failure(error: unknown): Response {
  if (error instanceof Refusal)
    return { ok: false, status: error.status, error: error.message };
  const { code, message } = error as { code?: string; message?: string };
  if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED")
    return { ok: false, status: 503, error: "The database is busy; try again" };
  // Other SQLite errors (missing column, constraint) are page authoring errors.
  return { ok: false, status: 400, error: message ?? String(error) };
}

function edit(db: Database.Database, request: Extract<Request, { op: "edit" }>) {
  const table = quote(request.table);
  const key = quote(request.key);
  const field = quote(request.field);
  if (request.guard) {
    db.pragma("query_only = ON");
    const guard = db.prepare(request.guard.sql);
    if (!guard.reader)
      throw new Refusal(400, "The edit guard must be a read-only SELECT");
    const allowed = guard.get(request.guard.bindings) !== undefined;
    db.pragma("query_only = OFF");
    if (!allowed) throw new Refusal(403, "You cannot edit this row");
  }
  const rows = db
    .prepare(`SELECT ${field} AS value FROM ${table} WHERE ${key} = ? LIMIT 2`)
    .all(request.keyValue) as Array<{ value: unknown }>;
  if (!rows.length) throw new Refusal(404, "Row not found");
  if (rows.length > 1)
    throw new Refusal(400, `The key column ${request.key} does not identify a single row`);
  const columns = [`${field} = ?`];
  const params: unknown[] = [request.value];
  if (request.updatedAt) {
    columns.push(`${quote(request.updatedAt)} = ?`);
    params.push(request.at);
  }
  db.prepare(`UPDATE ${table} SET ${columns.join(", ")} WHERE ${key} = ?`).run(
    ...params,
    request.keyValue
  );
  audit(db, request, String(request.keyValue), request.field, JSON.stringify(rows[0].value), JSON.stringify(request.value));
  return { value: request.value };
}

function add(db: Database.Database, request: Extract<Request, { op: "add" }>) {
  const columns = db.pragma(`table_info(${quote(request.table)})`) as Array<{
    name: string;
    type: string;
    pk: number;
  }>;
  if (!columns.length) throw new Refusal(400, `no such table: ${request.table}`);
  const keys = columns.filter((column) => column.pk > 0);
  if (
    keys.length !== 1 ||
    keys[0].name !== request.key ||
    keys[0].type.toUpperCase() !== "INTEGER"
  ) {
    throw new Refusal(
      400,
      `To add rows, ${request.key} must be the INTEGER PRIMARY KEY of ${request.table}`
    );
  }
  const names = Object.keys(request.values);
  const params = names.map((name) => request.values[name]);
  if (request.updatedAt) {
    names.push(request.updatedAt);
    params.push(request.at);
  }
  const table = quote(request.table);
  const sql = names.length
    ? `INSERT INTO ${table} (${names.map(quote).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`
    : `INSERT INTO ${table} DEFAULT VALUES`;
  const key = Number(db.prepare(sql).run(...params).lastInsertRowid);
  const values = db
    .prepare(
      `SELECT ${request.fields.map(quote).join(", ")} FROM ${table} WHERE ${quote(request.key)} = ?`
    )
    .get(key) as Record<string, unknown>;
  audit(db, request, String(key), "*", null, JSON.stringify(request.values));
  return { key, values };
}

function audit(
  db: Database.Database,
  request: Request,
  rowKey: string,
  field: string,
  oldValue: string | null,
  newValue: string
): void {
  db.exec(`CREATE TABLE IF NOT EXISTS dashboard_edits (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    dashboard_id TEXT NOT NULL,
    actor_user_id TEXT NOT NULL,
    actor_email TEXT,
    actor_name TEXT,
    edit_name TEXT NOT NULL,
    table_name TEXT NOT NULL,
    row_key TEXT NOT NULL,
    field TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT
  )`);
  db.prepare(
    `INSERT INTO dashboard_edits (at, dashboard_id, actor_user_id, actor_email, actor_name, edit_name, table_name, row_key, field, old_value, new_value)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    request.at,
    request.audit.dashboardId,
    request.audit.userId,
    request.audit.email,
    request.audit.name,
    request.audit.edit,
    request.table,
    rowKey,
    field,
    oldValue,
    newValue
  );
}
