import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { fork } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentConfig } from "@yoplai/shared";
import { dashboardDirectory } from "./index.js";

export const DASHBOARD_QUERY_ROW_LIMIT = 5_000;
export const DASHBOARD_QUERY_TIMEOUT_MS = 2_000;
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

function attributes(source: string): Map<string, string> {
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

export async function resolveDashboardDatabase(
  agent: AgentConfig,
  database: string
): Promise<string> {
  const root = path.dirname(dashboardDirectory(agent));
  if (!database || path.isAbsolute(database))
    throw new Error(
      "Database path must be relative to the agent data directory"
    );
  const realRoot = await fs.realpath(root);
  const realDatabase = await fs.realpath(path.resolve(root, database));
  const relative = path.relative(realRoot, realDatabase);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Database path escapes the agent data directory");
  }
  return realDatabase;
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
          trustedRoot,
          rootStat.dev,
          rootStat.ino,
          snapshotParent,
          snapshotParentStat.dev,
          snapshotParentStat.ino,
          snapshotDirectory,
          snapshotStat.dev,
          snapshotStat.ino,
          database,
          sql,
          bindings,
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

function spawnDashboardQuery(
  root: string,
  rootDev: number,
  rootIno: number,
  snapshotParent: string,
  snapshotParentDev: number,
  snapshotParentIno: number,
  snapshotDirectory: string,
  snapshotDev: number,
  snapshotIno: number,
  database: string,
  sql: string,
  bindings: Record<string, string | null>,
  timeoutMs: number
): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const sourceWorker = fileURLToPath(
      new URL("./sql-worker.ts", import.meta.url)
    );
    const workerPath = existsSync(sourceWorker)
      ? sourceWorker
      : fileURLToPath(new URL("./sql-worker.js", import.meta.url));
    const child = fork(workerPath, [], {
      execArgv: existsSync(sourceWorker) ? ["--import", "tsx"] : [],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    let finishing = false;
    let resultRows: unknown[] | undefined;
    let resultError: Error | undefined;
    const finish = (error?: Error, rows?: unknown[]) => {
      if (finishing) return;
      finishing = true;
      clearTimeout(timer);
      resultError = error;
      resultRows = rows;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(
      () => finish(new Error(`Query timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      clearTimeout(timer);
      if (!finishing) {
        resultError = new Error(
          `Query worker exited before completing (code ${code ?? "unknown"})`
        );
      }
      if (resultError) reject(resultError);
      else resolve(resultRows ?? []);
    });
    child.on("message", (message: { rows?: unknown[]; error?: string }) => {
      if (message.error) finish(new Error(message.error));
      else finish(undefined, message.rows);
    });
    child.send({
      root,
      rootDev,
      rootIno,
      snapshotParent,
      snapshotParentDev,
      snapshotParentIno,
      snapshotDirectory,
      snapshotDev,
      snapshotIno,
      database,
      sql,
      bindings,
      rowLimit: DASHBOARD_QUERY_ROW_LIMIT,
      resultByteLimit: DASHBOARD_RESULT_BYTE_LIMIT,
    });
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
      const database = await resolveDashboardDatabase(agent, query.database);
      const root = await fs.realpath(path.dirname(dashboardDirectory(agent)));
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
