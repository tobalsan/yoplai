import fs from "node:fs/promises";
import path from "node:path";
import type { WebCompletion } from "@yoplai/shared";
import { getUserHistoryDir } from "@yoplai/extension-multi-user/isolation";
import { CONFIG_DIR } from "../config/index.js";
import { getSessionEntry } from "../sessions/index.js";
import { textFromContent, type SearchMessage } from "./session-search.js";
export { textFromContent } from "./session-search.js";

export type SessionSummary = {
  agentId: string;
  sessionId: string;
  createdAt: number;
  lastActivity: number;
  messageCount: number;
  firstUserMessage: string;
  title?: string;
  pinned: number | null;
  archived: number | null;
  projectId: string | null;
  avatar?: string;
  isMain: boolean;
  lastWebCompletion?: WebCompletion;
};

/** Owner persisted in the first canonical history entry of a file, or null (legacy/unreadable). */
export function readPersistedOwner(
  raw: string
): { agentId: string; sessionId: string } | null {
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("{")) continue;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (
        entry.type === "history" &&
        typeof entry.agentId === "string" &&
        typeof entry.sessionId === "string"
      ) {
        return { agentId: entry.agentId, sessionId: entry.sessionId };
      }
    } catch {
      // Ignore malformed history lines.
    }
  }
  return null;
}

/**
 * Split a history filename into agent and session. A persisted owner is used
 * only when it reproduces the filename exactly; otherwise fall back to
 * configured-agent prefix matching (legacy entries).
 */
export function parseSessionFileName(
  file: string,
  agentIds: string[],
  persisted?: { agentId: string; sessionId: string } | null
): { agentId: string; sessionId: string; createdAt: number } | null {
  if (!file.endsWith(".jsonl")) return null;
  const base = file.slice(0, -".jsonl".length);
  const timestampMatch = base.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3}Z)_(.+)$/
  );
  const name = timestampMatch ? timestampMatch[5] : base;
  const createdAt = timestampMatch
    ? Date.parse(
        `${timestampMatch[1]}:${timestampMatch[2]}:${timestampMatch[3]}.${timestampMatch[4]}`
      )
    : 0;
  const createdAtValue = Number.isFinite(createdAt) ? createdAt : 0;
  if (
    persisted &&
    persisted.sessionId &&
    name === `${persisted.agentId}-${persisted.sessionId}`
  ) {
    return { ...persisted, createdAt: createdAtValue };
  }
  const agentId = [...agentIds]
    .sort((a, b) => b.length - a.length)
    .find((id) => name.startsWith(`${id}-`));
  if (!agentId) return null;
  const sessionId = name.slice(agentId.length + 1);
  if (!sessionId) return null;
  return {
    agentId,
    sessionId,
    createdAt: createdAtValue,
  };
}

export function isSafeSessionId(sessionId: string): boolean {
  const hasControlCharacter = [...sessionId].some((char) => {
    const code = char.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
  return (
    sessionId.length > 0 &&
    sessionId.length <= 200 &&
    !sessionId.includes("/") &&
    !sessionId.includes("\\") &&
    !/(^|[._:-])\.\.($|[._:-])/.test(sessionId) &&
    !hasControlCharacter
  );
}

export function sessionIdIsInteractive(sessionId: string): boolean {
  return (
    isSafeSessionId(sessionId) &&
    !/^(scheduler:|scheduler-|bench-|slack:|slack-|webhook:|webhook-|compact:|compact-|default$)/.test(
      sessionId
    )
  );
}

type SessionFileParams = {
  filePath: string;
  agentId: string;
  sessionId: string;
  createdAt: number;
  userId?: string;
};

/** Read canonical history once for both its sidebar summary and searchable text. */
export async function readSessionFile(
  params: SessionFileParams
): Promise<{ summary: SessionSummary; messages: SearchMessage[] } | null> {
  const [raw, stat] = await Promise.all([
    fs.readFile(params.filePath, "utf8"),
    fs.stat(params.filePath),
  ]);
  const messages: SearchMessage[] = [];
  let firstUserMessage = "";
  let title: string | undefined;
  let pinned: number | null = null;
  let archived: number | null = null;
  let projectId: string | null = null;
  let messageCount = 0;
  let lastWebCompletion: WebCompletion | undefined;
  let lastActivity = params.createdAt || stat.birthtimeMs;

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      const timestamp =
        typeof entry.timestamp === "number" ? entry.timestamp : undefined;
      if (entry.type === "meta" && entry.key === "title") {
        title = typeof entry.value === "string" ? entry.value : undefined;
        continue;
      }
      if (entry.type === "meta" && entry.key === "pinned") {
        pinned = typeof entry.value === "number" ? entry.value : null;
        continue;
      }
      if (entry.type === "meta" && entry.key === "archived") {
        archived = typeof entry.value === "number" ? entry.value : null;
        continue;
      }
      if (entry.type === "meta" && entry.key === "project") {
        projectId = typeof entry.value === "string" ? entry.value : null;
        continue;
      }
      if (entry.type === "meta" && entry.key === "lastWebCompletion") {
        const value = entry.value as Partial<WebCompletion> | null;
        if (value && typeof value.id === "string" && value.id.length > 0 && typeof value.endedAt === "number" && Number.isFinite(value.endedAt) && value.endedAt > 0) {
          lastWebCompletion = { id: value.id, endedAt: value.endedAt };
        }
        continue;
      }
      if (entry.type !== "history") continue;
      if (entry.role !== "user" && entry.role !== "assistant") continue;
      const text = textFromContent(entry.content);
      if (!text) continue;
      messages.push({ role: entry.role, content: entry.content });
      if (timestamp) lastActivity = Math.max(lastActivity, timestamp);
      messageCount += 1;
      if (entry.role === "user" && !firstUserMessage) firstUserMessage = text;
    } catch {
      // Ignore malformed history lines.
    }
  }

  if (messageCount === 0) return null;
  const main = await getSessionEntry(params.agentId, "main", params.userId);
  return {
    messages,
    summary: {
      agentId: params.agentId,
      sessionId: params.sessionId,
      createdAt: params.createdAt || stat.birthtimeMs,
      lastActivity,
      messageCount,
      pinned,
      archived,
      projectId,
      firstUserMessage,
      ...(title ? { title } : {}),
      isMain: main?.sessionId === params.sessionId,
      ...(lastWebCompletion ? { lastWebCompletion } : {}),
    },
  };
}

export async function summarizeSessionFile(
  params: SessionFileParams
): Promise<SessionSummary | null> {
  return (await readSessionFile(params))?.summary ?? null;
}

/** Current project of one session read from disk without writing; null when untagged or missing. */
export async function readSessionProjectId(
  agentId: string,
  sessionId: string,
  userId?: string
): Promise<string | null> {
  const dir = getUserHistoryDir(userId, CONFIG_DIR);
  let files: string[] = [];
  try {
    files = await fs.readdir(dir);
  } catch {
    return null;
  }
  for (const file of files) {
    const parsed = parseSessionFileName(file, [agentId]);
    if (parsed?.sessionId !== sessionId) continue;
    const raw = await fs.readFile(path.join(dir, file), "utf8").catch(() => "");
    const owner = readPersistedOwner(raw);
    if (owner && (owner.agentId !== agentId || owner.sessionId !== sessionId)) continue;
    let projectId: string | null = null;
    for (const line of raw.split(/\r?\n/)) {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (entry.type === "meta" && entry.key === "project") {
          projectId = typeof entry.value === "string" ? entry.value : null;
        }
      } catch {
        // Ignore malformed history lines, as session summaries do.
      }
    }
    return projectId;
  }
  return null;
}

/**
 * Interactive sessions for one user, newest activity first. Excludes CLI/subagent run histories.
 * Owners come from persisted history entries (so removed agents resolve); `fallbackAgentIds`
 * parse legacy files. `onlyAgentIds` restricts the result to those owners.
 */
async function listSessionSummaries(
  userId: string | undefined,
  fallbackAgentIds: string[],
  onlyAgentIds?: string[]
): Promise<SessionSummary[]> {
  const dir = getUserHistoryDir(userId, CONFIG_DIR);
  let files: string[] = [];
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }
  const items = await Promise.all(
    files.map(async (file) => {
      if (!file.endsWith(".jsonl")) return null;
      const raw = await fs.readFile(path.join(dir, file), "utf8").catch(() => "");
      const parsed = parseSessionFileName(file, fallbackAgentIds, readPersistedOwner(raw));
      if (
        !parsed ||
        (onlyAgentIds && !onlyAgentIds.includes(parsed.agentId)) ||
        !sessionIdIsInteractive(parsed.sessionId) ||
        /^(cli|subagent)[:-]/.test(parsed.sessionId)
      ) {
        return null;
      }
      return summarizeSessionFile({
        filePath: path.join(dir, file),
        ...parsed,
        userId,
      });
    })
  );
  return items
    .filter((item): item is SessionSummary => item !== null)
    .sort((a, b) => b.lastActivity - a.lastActivity);
}

/** Interactive sessions of the given agent(s) for one user. */
export async function listAgentSessionSummaries(
  agentId: string | string[],
  userId?: string
): Promise<SessionSummary[]> {
  const ids = Array.isArray(agentId) ? agentId : [agentId];
  return listSessionSummaries(userId, ids, ids);
}

/** Interactive sessions of every owner, including removed agents; `configuredAgentIds` parse legacy files. */
export async function listAllSessionSummaries(
  userId: string | undefined,
  configuredAgentIds: string[]
): Promise<SessionSummary[]> {
  return listSessionSummaries(userId, configuredAgentIds);
}
