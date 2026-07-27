import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  LeadSessionSchema,
  type LeadSession,
  type GatewayConfig,
} from "@yoplai/shared";
import { getProject } from "../projects/index.js";

const INDEX_FILE = "lead-sessions.json";
const SESSIONS_DIR = "sessions";
const indexMutationQueues = new Map<string, Promise<void>>();

async function serializeIndexMutation<T>(
  projectDir: string,
  mutation: () => Promise<T>
): Promise<T> {
  const key = path.resolve(indexPath(projectDir));
  const previous = indexMutationQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.catch(() => {}).then(() => current);
  indexMutationQueues.set(key, queued);
  await previous.catch(() => {});
  try {
    return await mutation();
  } finally {
    release();
    if (indexMutationQueues.get(key) === queued) {
      indexMutationQueues.delete(key);
    }
  }
}

type ProjectForMigration = {
  id: string;
  absolutePath: string;
  frontmatter?: Record<string, unknown>;
};

export type LeadSessionListOptions = {
  archived?: boolean;
  sliceId?: string;
};

export type LeadSessionResult =
  | { ok: true; data: LeadSession }
  | { ok: false; error: string; status: 400 | 404 | 409 };

export type LeadSessionListResult =
  | { ok: true; data: { items: LeadSession[] } }
  | { ok: false; error: string; status: 404 };

function indexPath(projectDir: string): string {
  return path.join(projectDir, INDEX_FILE);
}

export function transcriptDir(
  projectDir: string,
  transcriptRef: string
): string {
  return path.join(projectDir, SESSIONS_DIR, transcriptRef);
}

export function historyPath(projectDir: string, transcriptRef: string): string {
  return path.join(transcriptDir(projectDir, transcriptRef), "history.jsonl");
}

async function readJsonIndex(projectDir: string): Promise<LeadSession[]> {
  try {
    const raw = await fs.readFile(indexPath(projectDir), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return LeadSessionSchema.array().parse(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function writeJsonIndex(
  projectDir: string,
  sessions: LeadSession[]
): Promise<void> {
  await fs.mkdir(projectDir, { recursive: true });
  const destination = indexPath(projectDir);
  const tmp = path.join(
    projectDir,
    `.${INDEX_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`
  );
  await fs.writeFile(tmp, `${JSON.stringify(sessions, null, 2)}\n`, "utf8");
  await fs.rename(tmp, destination);
}

function getSessionKeys(
  frontmatter?: Record<string, unknown>
): Record<string, string> {
  const raw = frontmatter?.sessionKeys;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(
      (entry): entry is [string, string] =>
        typeof entry[0] === "string" && typeof entry[1] === "string"
    )
  );
}

function projectCreatedAt(frontmatter?: Record<string, unknown>): string {
  const candidates = [
    frontmatter?.created,
    frontmatter?.created_at,
    frontmatter?.createdAt,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return new Date(0).toISOString();
}

async function transcriptUpdatedAt(
  projectDir: string,
  transcriptRef: string,
  fallback: string
): Promise<string> {
  try {
    const stat = await fs.stat(historyPath(projectDir, transcriptRef));
    return stat.mtime.toISOString();
  } catch {
    return fallback;
  }
}

async function migrateLegacySessions(
  project: ProjectForMigration,
  current: LeadSession[]
): Promise<{ sessions: LeadSession[]; changed: boolean }> {
  const sessionKeys = getSessionKeys(project.frontmatter);
  if (Object.keys(sessionKeys).length === 0) {
    return { sessions: current, changed: false };
  }

  const existingIds = new Set(current.map((session) => session.id));
  const createdAt = projectCreatedAt(project.frontmatter);
  const next = [...current];
  let changed = false;

  for (const [agentId, sessionKey] of Object.entries(sessionKeys)) {
    const id = legacyLeadSessionId(project.id, agentId);
    if (existingIds.has(id)) continue;
    next.push({
      id,
      projectId: project.id,
      agentId,
      kind: "lead",
      title: "Main",
      titleLocked: true,
      createdAt,
      updatedAt: await transcriptUpdatedAt(
        project.absolutePath,
        sessionKey,
        createdAt
      ),
      transcriptRef: sessionKey,
    });
    existingIds.add(id);
    changed = true;
  }

  return { sessions: next, changed };
}

export async function readLeadSessionsForProject(
  project: ProjectForMigration
): Promise<LeadSession[]> {
  return serializeIndexMutation(project.absolutePath, async () => {
    const current = await readJsonIndex(project.absolutePath);
    const migrated = await migrateLegacySessions(project, current);
    if (migrated.changed) {
      await writeJsonIndex(project.absolutePath, migrated.sessions);
    }
    return migrated.sessions;
  });
}

export async function writeLeadSessionsForProject(
  projectDir: string,
  sessions: LeadSession[]
): Promise<void> {
  await serializeIndexMutation(projectDir, () =>
    writeJsonIndex(projectDir, sessions)
  );
}

export async function updateLeadSessionInProject(
  projectDir: string,
  id: string,
  updater: (session: LeadSession) => LeadSession | null
): Promise<LeadSession | null> {
  return serializeIndexMutation(projectDir, async () => {
    const sessions = await readJsonIndex(projectDir);
    let updated: LeadSession | null = null;
    const next = sessions.map((session) => {
      if (session.id !== id) return session;
      updated = updater(session);
      return updated ?? session;
    });
    if (!updated) return null;
    await writeJsonIndex(projectDir, next);
    return updated;
  });
}

async function appendLeadSession(
  projectDir: string,
  session: LeadSession
): Promise<void> {
  await serializeIndexMutation(projectDir, async () => {
    const sessions = await readJsonIndex(projectDir);
    await writeJsonIndex(projectDir, [...sessions, session]);
  });
}

async function removeLeadSessionFromProject(
  projectDir: string,
  id: string
): Promise<void> {
  await serializeIndexMutation(projectDir, async () => {
    const sessions = await readJsonIndex(projectDir);
    await writeJsonIndex(
      projectDir,
      sessions.filter((session) => session.id !== id)
    );
  });
}

export async function listLeadSessions(
  config: GatewayConfig,
  projectId: string,
  options: LeadSessionListOptions = {}
): Promise<LeadSessionListResult> {
  const projectResult = await getProject(config, projectId);
  if (!projectResult.ok) {
    return { ok: false, error: projectResult.error, status: 404 };
  }
  const project = projectResult.data;
  const sessions = await readLeadSessionsForProject(project);
  const archived = options.archived ?? false;
  const items = sessions.filter((session) => {
    const archivedMatch = archived ? !!session.archivedAt : !session.archivedAt;
    const sliceMatch =
      options.sliceId === undefined
        ? session.sliceId === undefined
        : session.sliceId === options.sliceId;
    return archivedMatch && sliceMatch;
  });
  items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { ok: true, data: { items } };
}

export async function createLeadSession(
  config: GatewayConfig,
  projectId: string,
  input: { agentId: string; sliceId?: string }
): Promise<LeadSessionResult> {
  const projectResult = await getProject(config, projectId);
  if (!projectResult.ok) {
    return { ok: false, error: projectResult.error, status: 404 };
  }
  const now = new Date().toISOString();
  const transcriptRef = crypto.randomUUID();
  const session: LeadSession = {
    id: `lead:${projectId}:${transcriptRef}`,
    projectId,
    ...(input.sliceId ? { sliceId: input.sliceId } : {}),
    agentId: input.agentId,
    kind: "lead",
    title: "New session",
    titleLocked: false,
    createdAt: now,
    updatedAt: now,
    transcriptRef,
  };
  const project = projectResult.data;
  await readLeadSessionsForProject(project);
  await ensureTranscriptScaffold(project.absolutePath, session);
  await appendLeadSession(project.absolutePath, session);
  return { ok: true, data: session };
}

export async function findLeadSession(
  config: GatewayConfig,
  id: string
): Promise<
  | {
      ok: true;
      projectDir: string;
      sessions: LeadSession[];
      session: LeadSession;
    }
  | { ok: false; error: string; status: 404 }
> {
  const projectId = projectIdFromLeadSessionId(id);
  if (!projectId) {
    return { ok: false, error: "Lead session not found", status: 404 };
  }
  const projectResult = await getProject(config, projectId);
  if (!projectResult.ok) {
    return { ok: false, error: projectResult.error, status: 404 };
  }
  const project = projectResult.data;
  const sessions = await readLeadSessionsForProject(project);
  const session = sessions.find((item) => item.id === id);
  if (!session) {
    return { ok: false, error: "Lead session not found", status: 404 };
  }
  return {
    ok: true,
    projectDir: project.absolutePath,
    sessions,
    session,
  };
}

export async function patchLeadSession(
  config: GatewayConfig,
  id: string,
  input: { title?: string; archived?: boolean }
): Promise<LeadSessionResult> {
  const found = await findLeadSession(config, id);
  if (!found.ok) return found;
  const title = input.title?.trim();
  if (input.title !== undefined && !title) {
    return { ok: false, error: "Title is required", status: 400 };
  }
  const now = new Date().toISOString();
  const updated = await updateLeadSessionInProject(
    found.projectDir,
    id,
    (current) => {
      const next: LeadSession = { ...current, updatedAt: now };
      if (title) {
        next.title = title;
        next.titleLocked = true;
      }
      if (input.archived !== undefined) {
        if (input.archived) next.archivedAt = current.archivedAt ?? now;
        else delete next.archivedAt;
      }
      return next;
    }
  );
  if (!updated) {
    return { ok: false, error: "Lead session not found", status: 404 };
  }
  return { ok: true, data: updated };
}

export async function deleteLeadSession(
  config: GatewayConfig,
  id: string
): Promise<LeadSessionResult> {
  if (isLegacyLeadSessionId(id)) {
    return {
      ok: false,
      error: "Migrated lead sessions cannot be deleted",
      status: 409,
    };
  }
  const found = await findLeadSession(config, id);
  if (!found.ok) return found;
  await fs.rm(transcriptDir(found.projectDir, found.session.transcriptRef), {
    recursive: true,
    force: true,
  });
  await removeEmptySessionsDir(found.projectDir);
  await removeLeadSessionFromProject(found.projectDir, id);
  return { ok: true, data: found.session };
}

async function ensureTranscriptScaffold(
  projectDir: string,
  session: LeadSession
): Promise<void> {
  const dir = transcriptDir(projectDir, session.transcriptRef);
  await fs.mkdir(dir, { recursive: true });
  await Promise.all([
    writeFileIfMissing(path.join(dir, "history.jsonl"), ""),
    writeFileIfMissing(path.join(dir, "logs.jsonl"), ""),
    writeFileIfMissing(
      path.join(dir, "state.json"),
      `${JSON.stringify({ createdAt: session.createdAt }, null, 2)}\n`
    ),
    writeFileIfMissing(
      path.join(dir, "config.json"),
      `${JSON.stringify(
        {
          type: "lead",
          agentId: session.agentId,
          projectId: session.projectId,
          sliceId: session.sliceId,
          createdAt: session.createdAt,
        },
        null,
        2
      )}\n`
    ),
  ]);
}

async function writeFileIfMissing(
  filePath: string,
  content: string
): Promise<void> {
  try {
    await fs.writeFile(filePath, content, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

async function removeEmptySessionsDir(projectDir: string): Promise<void> {
  try {
    const dir = path.join(projectDir, SESSIONS_DIR);
    const remaining = await fs.readdir(dir);
    if (remaining.length === 0) await fs.rmdir(dir);
  } catch {
    // ignore
  }
}

export function legacyLeadSessionId(
  projectId: string,
  agentId: string
): string {
  return `lead:${projectId}:legacy:${agentId}`;
}

export function isLegacyLeadSessionId(id: string): boolean {
  return /^lead:[^:]+:legacy:[^:]+$/.test(id);
}

export function projectIdFromLeadSessionId(id: string): string | null {
  const match = /^lead:([^:]+):/.exec(id);
  return match?.[1] ?? null;
}
