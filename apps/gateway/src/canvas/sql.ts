import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { fork } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentConfig } from "@yoplai/shared";
import { dashboardDatabasePath } from "./dashboard-files.js";
import type {
  DashboardEditRequest,
  DashboardEditResponse,
  DashboardQueryRequest,
} from "./sql-protocol.js";
import { isInsideRoot } from "../util/paths.js";

export const DASHBOARD_QUERY_ROW_LIMIT = 5_000;
export const DASHBOARD_QUERY_TIMEOUT_MS = 2_000;
export const DASHBOARD_EDIT_TIMEOUT_MS = 5_000;
export const DASHBOARD_QUERY_LIMIT = 20;
export const DASHBOARD_SQL_BYTE_LIMIT = 100_000;
export const DASHBOARD_RESULT_BYTE_LIMIT = 5 * 1024 * 1024;
export const DASHBOARD_WORKER_LIMIT = 4;
export const DASHBOARD_WORKER_QUEUE_LIMIT = 16;
export const DASHBOARD_WORKER_QUEUE_WAIT_MS = 1_000;

let activeWorkers = 0;
const workerWaiters: Array<{
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}> = [];

export type DashboardQuery = { name: string; database: string; sql: string };
export type DashboardQueryError = { name: string; error: string };

export function attributes(source: string): Map<string, string> {
  return new Map(
    [...source.matchAll(/([\w-]+)\s*=\s*(["'])(.*?)\2/gs)].map((match) => [
      match[1].toLowerCase(),
      match[3],
    ])
  );
}

export function parseDashboardQueries(html: string): DashboardQuery[] {
  const queries: DashboardQuery[] = [];
  for (const match of html.matchAll(
    /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi
  )) {
    const attrs = attributes(match[1]);
    if (attrs.get("type")?.toLowerCase() !== "application/sql") continue;
    const name = attrs.get("data-name")?.trim();
    const database = attrs.get("data-db")?.trim();
    if (!name || !/^[A-Za-z_$][\w$]*$/.test(name)) {
      throw new Error("SQL query data-name must be a JavaScript identifier");
    }
    if (["__proto__", "prototype", "constructor"].includes(name)) {
      throw new Error(`Unsafe SQL query name: ${name}`);
    }
    if (!database) throw new Error(`SQL query ${name} is missing data-db`);
    if (queries.some((query) => query.name === name)) {
      throw new Error(`Duplicate SQL query name: ${name}`);
    }
    const sql = match[2].trim();
    if (Buffer.byteLength(sql) > DASHBOARD_SQL_BYTE_LIMIT) {
      throw new Error(`SQL query ${name} exceeds the 100KB limit`);
    }
    queries.push({ name, database, sql });
    if (queries.length > DASHBOARD_QUERY_LIMIT) {
      throw new Error(
        `Dashboard exceeds the ${DASHBOARD_QUERY_LIMIT} query limit`
      );
    }
  }
  return queries;
}

export type DashboardEditField =
  | { type: "bool"; nullable: boolean }
  | { type: "int"; min?: number; max?: number; nullable: boolean }
  | { type: "text"; max: number; nullable: boolean }
  | { type: "enum"; values: string[]; nullable: boolean };

export type DashboardEdit = {
  name: string;
  database: string;
  table: string;
  key: string;
  updatedAt?: string;
  fields: Record<string, DashboardEditField>;
  guard?: string;
  create: boolean;
};

export const DASHBOARD_TEXT_EDIT_MAX = 2000;
const SQL_IDENTIFIER = /^[A-Za-z_]\w*$/;

/** Parses `<script type="application/json" data-yoplai-edit="name">` blocks. */
export function parseDashboardEdits(html: string): DashboardEdit[] {
  const edits: DashboardEdit[] = [];
  for (const match of html.matchAll(
    /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi
  )) {
    const attrs = attributes(match[1]);
    if (!attrs.has("data-yoplai-edit")) continue;
    const name = attrs.get("data-yoplai-edit")!.trim();
    if (!/^[A-Za-z_][\w-]*$/.test(name)) {
      throw new Error(
        "data-yoplai-edit needs a name made of letters, digits, _ or -"
      );
    }
    if (edits.some((edit) => edit.name === name)) {
      throw new Error(`Duplicate edit declaration: ${name}`);
    }
    if (Buffer.byteLength(match[2]) > DASHBOARD_SQL_BYTE_LIMIT) {
      throw new Error(`Edit ${name} exceeds the 100KB limit`);
    }
    edits.push(parseEdit(name, match[2]));
    if (edits.length > DASHBOARD_QUERY_LIMIT) {
      throw new Error(
        `Dashboard exceeds the ${DASHBOARD_QUERY_LIMIT} edit declaration limit`
      );
    }
  }
  return edits;
}

function parseEdit(name: string, source: string): DashboardEdit {
  const fail = (reason: string): never => {
    throw new Error(`Edit ${name}: ${reason}`);
  };
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(source) as Record<string, unknown>;
  } catch (error) {
    return fail(`invalid JSON (${(error as Error).message})`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return fail("invalid JSON (expected an object)");
  }
  const identifier = (key: string, value: unknown): string => {
    if (typeof value !== "string" || !SQL_IDENTIFIER.test(value)) {
      fail(`${key} must be a column or table name (letters, digits, _)`);
    }
    return value as string;
  };
  if (typeof raw.db !== "string" || !raw.db.trim()) {
    fail("db must name the database, e.g. data/app.db");
  }
  const table = identifier("table", raw.table);
  const key = identifier("key", raw.key);
  const updatedAt =
    raw.updatedAt === undefined ? undefined : identifier("updatedAt", raw.updatedAt);
  if (raw.create !== undefined && typeof raw.create !== "boolean") {
    fail("create must be true or false");
  }
  if (
    raw.guard !== undefined &&
    (typeof raw.guard !== "string" || !raw.guard.trim())
  ) {
    fail("guard must be a SELECT statement");
  }
  if (
    !raw.fields ||
    typeof raw.fields !== "object" ||
    Array.isArray(raw.fields) ||
    !Object.keys(raw.fields).length
  ) {
    fail("fields must map at least one column to its type");
  }
  const fields: Record<string, DashboardEditField> = {};
  for (const [column, spec] of Object.entries(
    raw.fields as Record<string, Record<string, unknown>>
  )) {
    if (!SQL_IDENTIFIER.test(column) || column === "__proto__") {
      fail(`field name ${column} must be a column name (letters, digits, _)`);
    }
    if (column === key) fail(`the key column ${key} cannot be an editable field`);
    if (column === updatedAt) {
      fail(`the updatedAt column ${column} cannot be an editable field`);
    }
    fields[column] = parseField(column, spec, fail);
  }
  return {
    name,
    database: (raw.db as string).trim(),
    table,
    key,
    ...(updatedAt ? { updatedAt } : {}),
    fields,
    ...(raw.guard ? { guard: (raw.guard as string).trim() } : {}),
    create: raw.create === true,
  };
}

function parseField(
  column: string,
  spec: Record<string, unknown>,
  fail: (reason: string) => never
): DashboardEditField {
  if (!spec || typeof spec !== "object") fail(`field ${column} needs a type`);
  if (spec.nullable !== undefined && typeof spec.nullable !== "boolean") {
    fail(`field ${column}: nullable must be true or false`);
  }
  const nullable = spec.nullable === true;
  const number = (option: "min" | "max") => {
    const value = spec[option];
    if (value !== undefined && !Number.isSafeInteger(value)) {
      fail(`field ${column}: ${option} must be an integer`);
    }
    return value as number | undefined;
  };
  switch (spec.type) {
    case "bool":
      return { type: "bool", nullable };
    case "int": {
      const min = number("min");
      const max = number("max");
      return {
        type: "int",
        ...(min !== undefined ? { min } : {}),
        ...(max !== undefined ? { max } : {}),
        nullable,
      };
    }
    case "text": {
      const max = number("max") ?? DASHBOARD_TEXT_EDIT_MAX;
      if (max < 1) fail(`field ${column}: max must be at least 1`);
      return { type: "text", max, nullable };
    }
    case "enum": {
      const values = spec.values;
      if (
        !Array.isArray(values) ||
        !values.length ||
        values.some((value) => typeof value !== "string")
      ) {
        fail(`field ${column} needs values, a list of allowed strings`);
      }
      return { type: "enum", values: values as string[], nullable };
    }
    default:
      return fail(`field ${column} has unknown type ${String(spec.type)} (use bool, int, text or enum)`);
  }
}

export async function resolveDashboardDatabase(
  agent: AgentConfig,
  database: string
): Promise<{ root: string; database: string }> {
  const location = dashboardDatabasePath(agent, database);
  const realRoot = await fs.realpath(location.root);
  const realDatabase = await fs.realpath(location.path);
  if (!isInsideRoot(realRoot, realDatabase)) {
    throw new Error("Database path escapes the agent workspace");
  }
  return { root: realRoot, database: realDatabase };
}

export function runDashboardQuery(
  root: string,
  database: string,
  sql: string,
  bindings: Record<string, string | null>,
  timeoutMs = DASHBOARD_QUERY_TIMEOUT_MS
): Promise<unknown[]> {
  return acquireWorker().then(async () => {
    try {
      const trustedRoot = await fs.realpath(root);
      const rootStat = await fs.stat(trustedRoot);
      const snapshotParent = await fs.realpath(path.dirname(trustedRoot));
      const snapshotParentStat = await fs.stat(snapshotParent);
      const snapshotDirectory = await fs.mkdtemp(
        path.join(snapshotParent, ".yoplai-sql-")
      );
      await fs.chmod(snapshotDirectory, 0o700);
      const snapshotStat = await fs.stat(snapshotDirectory);
      try {
        return await spawnDashboardQuery(
          {
            root: trustedRoot,
            rootDev: rootStat.dev,
            rootIno: rootStat.ino,
            snapshotParent,
            snapshotParentDev: snapshotParentStat.dev,
            snapshotParentIno: snapshotParentStat.ino,
            snapshotDirectory,
            snapshotDev: snapshotStat.dev,
            snapshotIno: snapshotStat.ino,
            database,
            sql,
            bindings,
            rowLimit: DASHBOARD_QUERY_ROW_LIMIT,
            resultByteLimit: DASHBOARD_RESULT_BYTE_LIMIT,
          },
          timeoutMs
        );
      } finally {
        await removeSnapshotDirectory(
          snapshotDirectory,
          snapshotStat.dev,
          snapshotStat.ino
        );
      }
    } finally {
      releaseWorker();
    }
  });
}

async function spawnDashboardQuery(
  request: DashboardQueryRequest,
  timeoutMs: number
): Promise<unknown[]> {
  const message = (await forkDashboardWorker("sql-worker", request, timeoutMs, "Query")) as {
    rows?: unknown[];
    error?: string;
  };
  if (message.error) throw new Error(message.error);
  return message.rows ?? [];
}

/**
 * Runs one page edit or add in a forked worker that writes the real database.
 * Shares the query worker pool; its deadline outlasts the worker's 3s busy
 * timeout so a briefly locked database fails cleanly instead of being killed.
 */
export function runDashboardEditWorker(
  request: DashboardEditRequest,
  timeoutMs = DASHBOARD_EDIT_TIMEOUT_MS
): Promise<DashboardEditResponse> {
  return acquireWorker().then(async () => {
    try {
      return (await forkDashboardWorker("edit-worker", request, timeoutMs, "Edit")) as DashboardEditResponse;
    } finally {
      releaseWorker();
    }
  });
}

function forkDashboardWorker(
  name: "sql-worker" | "edit-worker",
  request: DashboardQueryRequest | DashboardEditRequest,
  timeoutMs: number,
  label: string
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const sourceWorker = fileURLToPath(
      new URL(`./${name}.ts`, import.meta.url)
    );
    const workerPath = existsSync(sourceWorker)
      ? sourceWorker
      : fileURLToPath(new URL(`./${name}.js`, import.meta.url));
    const child = fork(workerPath, [], {
      execArgv: existsSync(sourceWorker) ? ["--import", "tsx"] : [],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    let finishing = false;
    let result: unknown;
    let resultError: Error | undefined;
    const finish = (error?: Error, message?: unknown) => {
      if (finishing) return;
      finishing = true;
      clearTimeout(timer);
      resultError = error;
      result = message;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(
      () => finish(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      clearTimeout(timer);
      if (!finishing) {
        resultError = new Error(
          `${label} worker exited before completing (code ${code ?? "unknown"})`
        );
      }
      if (resultError) reject(resultError);
      else resolve(result);
    });
    child.on("message", (message: unknown) => finish(undefined, message));
    child.send(request);
  });
}

async function removeSnapshotDirectory(
  directory: string,
  dev: number,
  ino: number
): Promise<void> {
  try {
    const current = await fs.lstat(directory);
    if (current.isDirectory() && current.dev === dev && current.ino === ino) {
      await fs.rm(directory, { recursive: true, force: true });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function acquireWorker(): Promise<void> {
  if (activeWorkers < DASHBOARD_WORKER_LIMIT) {
    activeWorkers += 1;
    return Promise.resolve();
  }
  if (workerWaiters.length >= DASHBOARD_WORKER_QUEUE_LIMIT) {
    return Promise.reject(new Error("Dashboard query worker queue is full"));
  }
  return new Promise((resolve, reject) => {
    const waiter = {
      resolve,
      reject,
      timer: setTimeout(() => {
        const index = workerWaiters.indexOf(waiter);
        if (index >= 0) workerWaiters.splice(index, 1);
        reject(new Error("Dashboard query worker queue timed out"));
      }, DASHBOARD_WORKER_QUEUE_WAIT_MS),
    };
    workerWaiters.push(waiter);
  });
}

function releaseWorker(): void {
  const waiter = workerWaiters.shift();
  if (waiter) {
    clearTimeout(waiter.timer);
    waiter.resolve();
  } else {
    activeWorkers -= 1;
  }
}

export async function executeDashboardQueries(
  agent: AgentConfig,
  html: string,
  bindings: Record<string, string | null>
): Promise<{ data: Record<string, unknown[]>; errors: DashboardQueryError[] }> {
  const data: Record<string, unknown[]> = Object.create(null);
  const errors: DashboardQueryError[] = [];
  let queries: DashboardQuery[];
  try {
    queries = parseDashboardQueries(html);
  } catch (error) {
    return {
      data,
      errors: [
        {
          name: "dashboard",
          error: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
  for (const query of queries) {
    try {
      const { root, database } = await resolveDashboardDatabase(
        agent,
        query.database
      );
      const queryBindings = { ...bindings };
      for (const match of query.sql.matchAll(/[:@$]([A-Za-z_]\w*)/g)) {
        queryBindings[match[1]] ??= null;
      }
      data[query.name] = await runDashboardQuery(
        root,
        path.relative(root, database),
        query.sql,
        queryBindings
      );
    } catch (error) {
      errors.push({
        name: query.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { data, errors };
}
