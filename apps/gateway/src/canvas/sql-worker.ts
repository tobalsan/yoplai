import Database from "better-sqlite3";
import fs, { constants } from "node:fs";
import path from "node:path";

type Request = {
  root: string;
  rootDev: number;
  rootIno: number;
  snapshotParent: string;
  snapshotParentDev: number;
  snapshotParentIno: number;
  snapshotDirectory: string;
  snapshotDev: number;
  snapshotIno: number;
  database: string;
  sql: string;
  bindings: Record<string, string | null>;
  rowLimit: number;
  resultByteLimit: number;
};

process.on("message", (request: Request) => {
  let database: Database.Database | undefined;
  const tempDirectory = request.snapshotDirectory;
  const handles: number[] = [];
  try {
    const root = fs.realpathSync(request.root);
    const rootHandle = fs.openSync(
      root,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
    handles.push(rootHandle);
    const rootStat = fs.fstatSync(rootHandle);
    if (rootStat.dev !== request.rootDev || rootStat.ino !== request.rootIno)
      throw new Error("Agent data directory changed before query execution");
    const snapshotParent = fs.realpathSync(request.snapshotParent);
    const snapshotParentHandle = fs.openSync(
      snapshotParent,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
    handles.push(snapshotParentHandle);
    const snapshotParentStat = fs.fstatSync(snapshotParentHandle);
    if (
      snapshotParentStat.dev !== request.snapshotParentDev ||
      snapshotParentStat.ino !== request.snapshotParentIno ||
      snapshotParentStat.dev !== rootStat.dev
    ) {
      throw new Error("Query snapshot parent changed before execution");
    }
    assertSnapshotDirectory(request, root);
    const candidate = path.resolve(root, request.database);
    assertConfined(root, candidate);
    const databaseHandle = openAnchored(root, candidate);
    handles.push(databaseHandle);
    const snapshot = path.join(tempDirectory, "snapshot.db");
    linkAnchored(candidate, databaseHandle, snapshot);
    for (const suffix of ["-wal", "-shm"]) {
      try {
        const handle = openAnchored(root, `${candidate}${suffix}`);
        handles.push(handle);
        linkAnchored(`${candidate}${suffix}`, handle, `${snapshot}${suffix}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    assertSnapshotDirectory(request, root);
    database = new Database(snapshot, { readonly: true, fileMustExist: true });
    const statement = database.prepare(request.sql);
    if (!statement.reader)
      throw new Error("Only read-only result queries are allowed");
    const rows: unknown[] = [];
    let resultBytes = 2;
    for (const row of statement.iterate(request.bindings)) {
      resultBytes += Buffer.byteLength(JSON.stringify(row)) + 1;
      if (resultBytes > request.resultByteLimit)
        throw new Error("Query result exceeds the 5MB limit");
      rows.push(row);
      if (rows.length >= request.rowLimit) break;
    }
    process.send?.({ rows });
  } catch (error) {
    process.send?.({
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    try {
      database?.close();
    } catch {
      // Process exit also releases database resources.
    }
    for (const handle of handles.reverse()) {
      try {
        fs.closeSync(handle);
      } catch {
        // Continue closing the remaining anchored handles.
      }
    }
    try {
      const current = fs.lstatSync(tempDirectory);
      if (
        current.isDirectory() &&
        current.dev === request.snapshotDev &&
        current.ino === request.snapshotIno
      ) {
        fs.rmSync(tempDirectory, { recursive: true, force: true });
      }
    } catch {
      // The parent also removes this directory after worker settlement.
    }
  }
});

function openAnchored(root: string, candidate: string): number {
  assertConfined(root, candidate);
  const handle = fs.openSync(
    candidate,
    constants.O_RDONLY | constants.O_NOFOLLOW
  );
  try {
    const opened = fs.fstatSync(handle);
    const named = fs.lstatSync(candidate);
    const realCandidate = fs.realpathSync(candidate);
    assertConfined(root, realCandidate);
    if (
      !opened.isFile() ||
      !named.isFile() ||
      opened.dev !== named.dev ||
      opened.ino !== named.ino
    )
      throw new Error("Database path changed while it was being opened");
    return handle;
  } catch (error) {
    fs.closeSync(handle);
    throw error;
  }
}

function linkAnchored(
  source: string,
  handle: number,
  destination: string
): void {
  fs.linkSync(source, destination);
  const opened = fs.fstatSync(handle);
  const sourceAfter = fs.lstatSync(source);
  const captured = fs.lstatSync(destination);
  if (
    opened.dev !== sourceAfter.dev ||
    opened.ino !== sourceAfter.ino ||
    opened.dev !== captured.dev ||
    opened.ino !== captured.ino
  ) {
    throw new Error("Database path changed while it was being captured");
  }
}

function assertSnapshotDirectory(request: Request, root: string): void {
  const directory = fs.realpathSync(request.snapshotDirectory);
  const parent = fs.realpathSync(request.snapshotParent);
  if (path.dirname(directory) !== parent || isConfined(root, directory)) {
    throw new Error("Query snapshot directory must be outside agent data");
  }
  const stat = fs.lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.dev !== request.snapshotDev ||
    stat.ino !== request.snapshotIno ||
    stat.dev !== request.rootDev
  ) {
    throw new Error("Query snapshot directory changed before execution");
  }
}

function isConfined(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function assertConfined(root: string, candidate: string): void {
  if (!isConfined(root, candidate))
    throw new Error("Database path escapes the agent data directory");
}
