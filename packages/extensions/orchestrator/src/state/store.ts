import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const PAYLOAD_PREVIEW_BYTES = 4096;
// New event logs are written under ".yoplai/codex"; ".aihub/codex" is recognized so runs
// logged before the rename can still be read back.
const PROJECT_LOCAL_LOG_DIRS = [path.join(".yoplai", "codex"), path.join(".aihub", "codex")];

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((item) => item.name === column);
}

function encodeRunPath(runId: string): string {
  return Buffer.from(runId, "utf8").toString("base64url");
}

function timestampPrefix(runId: string, createdAt: string): string {
  const lastSegment = runId.split(":").at(-1);
  const numeric = lastSegment && /^\d+$/.test(lastSegment) ? Number(lastSegment) : NaN;
  const date = Number.isFinite(numeric) ? new Date(numeric) : new Date(createdAt);
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function toPayloadJson(payload: unknown): string {
  return JSON.stringify(payload) ?? "null";
}

function payloadPreview(payloadJson: string): string {
  if (Buffer.byteLength(payloadJson, "utf8") <= PAYLOAD_PREVIEW_BYTES) return payloadJson;
  return `${payloadJson.slice(0, PAYLOAD_PREVIEW_BYTES)}...`;
}

function isWithinRoot(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export class StateStore {
  private db: Database.Database;
  private readonly rootDir: string | undefined;
  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.rootDir = file === ":memory:" ? undefined : path.dirname(file);
    this.db = new Database(file);
  }
  bootstrap(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS runs (run_id TEXT PRIMARY KEY, project_id TEXT, issue_id TEXT, identifier TEXT, workspace TEXT, profile_json TEXT, workflow_path TEXT, workflow_sha TEXT, pid INTEGER, started_at TEXT, finished_at TEXT, outcome TEXT, exit_code INTEGER, process_alive INTEGER DEFAULT 1, worker_id TEXT);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, run_id TEXT, type TEXT, payload TEXT, created_at TEXT, log_path TEXT, log_offset INTEGER, log_line INTEGER, payload_preview TEXT);
CREATE TABLE IF NOT EXISTS claims (project_id TEXT, issue_id TEXT, run_id TEXT, claimed_at TEXT, released_at TEXT);
CREATE TABLE IF NOT EXISTS heartbeats (daemon_id TEXT PRIMARY KEY, pid INTEGER, last_tick TEXT, version TEXT);`);
    for (const [table, column, type] of [["runs", "project_id", "TEXT"], ["runs", "worker_id", "TEXT"], ["events", "project_id", "TEXT"], ["claims", "project_id", "TEXT"], ["events", "log_path", "TEXT"], ["events", "log_offset", "INTEGER"], ["events", "log_line", "INTEGER"], ["events", "payload_preview", "TEXT"]] as const) {
      if (!hasColumn(this.db, table, column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS events_run_id_id_idx ON events(run_id, id);`);
  }
  insertRun(run: Record<string, unknown>): void { this.db.prepare(`INSERT OR REPLACE INTO runs (run_id, project_id, issue_id, identifier, workspace, profile_json, workflow_path, workflow_sha, pid, started_at, process_alive) VALUES (@runId,@projectId,@issueId,@identifier,@workspace,@profileJson,@workflowPath,@workflowSha,@pid,@startedAt,1)`).run({ projectId: "default", ...run }); }
  setWorkerId(runId: string, workerId: string | undefined): void { if (workerId) this.db.prepare(`UPDATE runs SET worker_id=? WHERE run_id=?`).run(workerId, runId); }
  setRunPid(runId: string, pid: number | undefined): void { if (pid && pid > 0) this.db.prepare(`UPDATE runs SET pid=? WHERE run_id=?`).run(pid, runId); }
  finishRun(runId: string, outcome: string, exitCode?: number): void { this.db.prepare(`UPDATE runs SET finished_at=?, outcome=?, exit_code=?, process_alive=0 WHERE run_id=?`).run(new Date().toISOString(), outcome, exitCode ?? null, runId); }
  appendEvent(runId: string, type: string, payload: unknown, projectId?: string): void {
    const createdAt = new Date().toISOString();
    const payloadJson = toPayloadJson(payload);
    const preview = payloadPreview(payloadJson);
    const log = this.appendJsonlEvent({ runId, projectId, type, payload, createdAt });
    if (log) {
      this.db.prepare(`INSERT INTO events (project_id,run_id,type,payload,created_at,log_path,log_offset,log_line,payload_preview) VALUES (?,?,?,?,?,?,?,?,?)`).run(projectId ?? null, runId, type, null, createdAt, log.relativePath, log.offset, log.line, preview);
      return;
    }
    this.db.prepare(`INSERT INTO events (project_id,run_id,type,payload,created_at,payload_preview) VALUES (?,?,?,?,?,?)`).run(projectId ?? null, runId, type, payloadJson, createdAt, preview);
  }
  listRecent(limit = 50, projectId?: string, offset = 0): unknown[] { return projectId ? this.db.prepare(`SELECT * FROM runs WHERE project_id=? AND (outcome IS NULL OR outcome != 'park_barrier') ORDER BY started_at DESC LIMIT ? OFFSET ?`).all(projectId, limit, offset) : this.db.prepare(`SELECT * FROM runs WHERE (outcome IS NULL OR outcome != 'park_barrier') ORDER BY started_at DESC LIMIT ? OFFSET ?`).all(limit, offset); }
  countRecent(projectId?: string): number { const row = (projectId ? this.db.prepare(`SELECT COUNT(*) AS count FROM runs WHERE project_id=? AND (outcome IS NULL OR outcome != 'park_barrier')`).get(projectId) : this.db.prepare(`SELECT COUNT(*) AS count FROM runs WHERE (outcome IS NULL OR outcome != 'park_barrier')`).get()) as { count: number }; return row.count; }
  getRun(id: string, projectId?: string): Record<string, unknown> | undefined { return projectId ? this.db.prepare(`SELECT * FROM runs WHERE project_id=? AND (run_id=? OR issue_id=? OR identifier=?) ORDER BY started_at DESC LIMIT 1`).get(projectId, id, id, id) as Record<string, unknown> | undefined : this.db.prepare(`SELECT * FROM runs WHERE run_id=? OR issue_id=? OR identifier=? ORDER BY started_at DESC LIMIT 1`).get(id, id, id) as Record<string, unknown> | undefined; }
  getOpenRunByIssue(issueId: string, projectId?: string): Record<string, unknown> | undefined { return projectId ? this.db.prepare(`SELECT * FROM runs WHERE project_id=? AND issue_id=? AND finished_at IS NULL ORDER BY started_at DESC LIMIT 1`).get(projectId, issueId) as Record<string, unknown> | undefined : this.db.prepare(`SELECT * FROM runs WHERE issue_id=? AND finished_at IS NULL ORDER BY started_at DESC LIMIT 1`).get(issueId) as Record<string, unknown> | undefined; }
  countRunsByIssue(issueId: string, projectId?: string): number { const row = (projectId ? this.db.prepare(`SELECT COUNT(*) AS count FROM runs WHERE project_id=? AND issue_id=? AND (outcome IS NULL OR outcome != 'park_barrier')`).get(projectId, issueId) : this.db.prepare(`SELECT COUNT(*) AS count FROM runs WHERE issue_id=? AND (outcome IS NULL OR outcome != 'park_barrier')`).get(issueId)) as { count: number }; return row.count; }
  countConsecutiveCompletedRuns(issueId: string, projectId?: string): number { const q = projectId ? `WITH last_other AS (SELECT COALESCE(MAX(started_at),'') AS ts FROM runs WHERE project_id=? AND issue_id=? AND finished_at IS NOT NULL AND outcome!='completed') SELECT COUNT(*) AS cnt FROM runs WHERE project_id=? AND issue_id=? AND finished_at IS NOT NULL AND outcome='completed' AND started_at>(SELECT ts FROM last_other)` : `WITH last_other AS (SELECT COALESCE(MAX(started_at),'') AS ts FROM runs WHERE issue_id=? AND finished_at IS NOT NULL AND outcome!='completed') SELECT COUNT(*) AS cnt FROM runs WHERE issue_id=? AND finished_at IS NOT NULL AND outcome='completed' AND started_at>(SELECT ts FROM last_other)`; const row = (projectId ? this.db.prepare(q).get(projectId, issueId, projectId, issueId) : this.db.prepare(q).get(issueId, issueId)) as { cnt: number }; return row.cnt; }
  recordParkBarrier(issueId: string, projectId = "default"): void { const ts = new Date().toISOString(); this.db.prepare(`INSERT INTO runs (run_id, project_id, issue_id, started_at, finished_at, outcome, process_alive) VALUES (?,?,?,?,?, 'park_barrier', 0)`).run(`park-barrier:${projectId}:${issueId}:${ts}`, projectId, issueId, ts, ts); }
  listOpenRuns(projectId?: string): Record<string, unknown>[] { return (projectId ? this.db.prepare(`SELECT * FROM runs WHERE project_id=? AND finished_at IS NULL ORDER BY started_at ASC`).all(projectId) : this.db.prepare(`SELECT * FROM runs WHERE finished_at IS NULL ORDER BY started_at ASC`).all()) as Record<string, unknown>[]; }
  listOpenRunsByProject(projectId: string): Record<string, unknown>[] { return this.listOpenRuns(projectId); }
  listEvents(runId: string, since = 0): unknown[] {
    const rows = this.db.prepare(`SELECT * FROM events WHERE run_id=? AND id>? ORDER BY id ASC`).all(runId, since) as Array<Record<string, unknown>>;
    return rows.map((row) => this.hydrateEvent(row));
  }
  deleteRunLogs(runId: string): boolean {
    const rows = this.db.prepare(`SELECT DISTINCT log_path FROM events WHERE run_id=? AND log_path IS NOT NULL`).all(runId) as Array<{ log_path?: string }>;
    let removed = false;
    for (const row of rows) {
      const resolved = this.resolveLogPath(runId, row.log_path);
      if (!resolved) continue;
      try { fs.unlinkSync(resolved); removed = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    return removed;
  }
  markOrphaned(): number { return this.db.prepare(`UPDATE runs SET finished_at=?, outcome='orphaned' WHERE finished_at IS NULL AND process_alive=0`).run(new Date().toISOString()).changes; }
  markOpenRunsInterrupted(outcome = "interrupted_gateway_restart"): number { return this.db.prepare(`UPDATE runs SET finished_at=?, outcome=?, process_alive=0 WHERE finished_at IS NULL`).run(new Date().toISOString(), outcome).changes; }
  markActiveProcessStopped(): void { this.db.prepare(`UPDATE runs SET process_alive=0 WHERE finished_at IS NULL`).run(); }
  claim(issueId: string, runId: string, projectId = "default"): void { this.db.prepare(`INSERT INTO claims (project_id, issue_id, run_id, claimed_at) VALUES (?,?,?,?)`).run(projectId, issueId, runId, new Date().toISOString()); }
  release(issueId: string, projectId?: string): void {
    if (projectId) {
      this.db.prepare(`UPDATE claims SET released_at=? WHERE project_id=? AND issue_id=? AND released_at IS NULL`).run(new Date().toISOString(), projectId, issueId);
      return;
    }
    this.db.prepare(`UPDATE claims SET released_at=? WHERE issue_id=? AND released_at IS NULL`).run(new Date().toISOString(), issueId);
  }
  heartbeat(id = "default"): void { this.db.prepare(`INSERT INTO heartbeats (daemon_id,pid,last_tick,version) VALUES (?,?,?,?) ON CONFLICT(daemon_id) DO UPDATE SET last_tick=excluded.last_tick,pid=excluded.pid`).run(id, process.pid, new Date().toISOString(), "0.1.0"); }
  close(): void { this.db.close(); }

  private appendJsonlEvent(input: { runId: string; projectId?: string; type: string; payload: unknown; createdAt: string }): { relativePath: string; offset: number; line: number } | undefined {
    const projectRoot = this.projectRootForRun(input.runId);
    if (!projectRoot) return undefined;
    const relativePath = path.join(".yoplai", "codex", `${timestampPrefix(input.runId, input.createdAt)}-${encodeRunPath(input.runId)}.jsonl`);
    const absolutePath = path.join(projectRoot, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    const offset = fs.existsSync(absolutePath) ? fs.statSync(absolutePath).size : 0;
    const row = this.db.prepare(`SELECT COALESCE(MAX(CAST(log_line AS INTEGER)), 0) + 1 AS line FROM events WHERE run_id=?`).get(input.runId) as { line: number };
    const line = row.line;
    const record = { project_id: input.projectId ?? null, run_id: input.runId, type: input.type, created_at: input.createdAt, payload: input.payload };
    fs.appendFileSync(absolutePath, `${JSON.stringify(record)}\n`, "utf8");
    return { relativePath, offset, line };
  }

  private hydrateEvent(row: Record<string, unknown>): Record<string, unknown> {
    if (typeof row.payload === "string") return row;
    const payload = this.readJsonlPayload(row) ?? row.payload_preview;
    return { ...row, payload };
  }

  private readJsonlPayload(row: Record<string, unknown>): string | undefined {
    if (!this.rootDir || typeof row.log_path !== "string" || (typeof row.log_offset !== "string" && typeof row.log_offset !== "number")) return undefined;
    const absolutePath = this.resolveLogPath(String(row.run_id ?? ""), row.log_path);
    if (!absolutePath) return undefined;
    try {
      const fd = fs.openSync(absolutePath, "r");
      try {
        const chunks: Buffer[] = [];
        const buffer = Buffer.alloc(1024);
        let position = Number(row.log_offset);
        while (true) {
          const bytes = fs.readSync(fd, buffer, 0, buffer.length, position);
          if (bytes <= 0) break;
          const newline = buffer.subarray(0, bytes).indexOf(10);
          if (newline >= 0) {
            chunks.push(Buffer.from(buffer.subarray(0, newline)));
            break;
          }
          chunks.push(Buffer.from(buffer.subarray(0, bytes)));
          position += bytes;
        }
        const line = Buffer.concat(chunks).toString("utf8");
        if (!line) return undefined;
        const record = JSON.parse(line) as { payload?: unknown };
        return toPayloadJson(record.payload);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return undefined;
    }
  }

  private projectRootForRun(runId: string): string | undefined {
    const row = this.db.prepare(`SELECT workflow_path FROM runs WHERE run_id=? LIMIT 1`).get(runId) as { workflow_path?: unknown } | undefined;
    if (typeof row?.workflow_path !== "string" || !row.workflow_path) return undefined;
    return path.dirname(path.resolve(row.workflow_path));
  }

  private resolveLogPath(runId: string, logPath: unknown): string | undefined {
    if (typeof logPath !== "string" || path.isAbsolute(logPath)) return undefined;
    // Rows written before the rename still point at the legacy ".aihub/codex" project-local dir.
    const isProjectLocalLog = PROJECT_LOCAL_LOG_DIRS.some((dir) => logPath === dir || logPath.startsWith(`${dir}${path.sep}`));
    const projectRoot = isProjectLocalLog && runId ? this.projectRootForRun(runId) : undefined;
    if (projectRoot) {
      const projectPath = path.resolve(projectRoot, logPath);
      if (isWithinRoot(projectRoot, projectPath)) return projectPath;
    }
    if (!this.rootDir) return undefined;
    const statePath = path.resolve(this.rootDir, logPath);
    if (!isWithinRoot(this.rootDir, statePath)) return undefined;
    return statePath;
  }
}
