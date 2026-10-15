import fs from "node:fs/promises";
import path from "node:path";
import type { SessionEntry } from "@yoplai/shared";
import { getUserHistoryDir } from "@yoplai/extension-multi-user/isolation";
import { CONFIG_DIR } from "../config/index.js";
import {
  abortSession,
  deleteSession,
  getOrCreateSession,
  isStreaming,
  popPendingMessages,
} from "../agents/sessions.js";
import {
  backfillFromPiSession,
  invalidateResolvedHistoryFile,
} from "../history/store.js";
import { resolveSessionDataFile } from "./files.js";
import {
  clearSessionEntriesById,
  getSessionCreatedAt,
  resolveSessionId,
} from "./store.js";

function sessionDirs(userId?: string): string[] {
  return [
    getUserHistoryDir(userId, CONFIG_DIR),
    userId
      ? path.join(CONFIG_DIR, "sessions", "users", userId, "sessions")
      : path.join(CONFIG_DIR, "sessions"),
  ];
}

function containerSessionFile(
  agentId: string,
  sessionId: string,
  userId?: string
): string {
  return path.join(sessionDirs(userId)[1], agentId, `${sessionId}.jsonl`);
}

export async function hasSession(
  agentId: string,
  sessionId: string,
  userId?: string
): Promise<boolean> {
  if (isStreaming(agentId, sessionId)) return true;
  for (const dir of sessionDirs(userId)) {
    if (
      await resolveSessionDataFile({
        dir,
        agentId,
        sessionId,
        createIfMissing: false,
      })
    )
      return true;
  }
  return fs.access(containerSessionFile(agentId, sessionId, userId)).then(
    () => true,
    () => false
  );
}

export async function ensureSession(
  agentId: string,
  sessionKey: string,
  userId?: string
): Promise<SessionEntry> {
  const resolved = await resolveSessionId({
    agentId,
    sessionKey,
    userId,
    message: "",
  });
  await backfillFromPiSession(agentId, resolved.sessionId, userId);
  const file = await resolveSessionDataFile({
    dir: getUserHistoryDir(userId, CONFIG_DIR),
    agentId,
    sessionId: resolved.sessionId,
    createdAt: resolved.createdAt,
    createIfMissing: true,
  });
  // Allocate backing storage before publishing a binding to overlapping replies.
  const handle = await fs.open(file!, "a");
  await handle.close();
  return {
    sessionId: resolved.sessionId,
    createdAt: resolved.createdAt,
    updatedAt: Date.now(),
  };
}

export async function resetSession(
  agentId: string,
  sessionId: string,
  userId?: string
): Promise<void> {
  const active = getOrCreateSession(agentId, sessionId);
  active.resetting = true;
  try {
    if (active.resolveSettled) {
      abortSession(agentId, sessionId);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          active.settled,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () =>
                reject(
                  new Error(
                    "Session is still stopping; retry !new once the active turn ends."
                  )
                ),
              2000
            );
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
    }
    const createdAt = await getSessionCreatedAt(sessionId, userId);
    for (const dir of sessionDirs(userId)) {
      const file = await resolveSessionDataFile({
        dir,
        agentId,
        sessionId,
        createdAt,
        createIfMissing: false,
      });
      if (file) await fs.rm(file, { force: true });
    }
    await fs.rm(containerSessionFile(agentId, sessionId, userId), {
      force: true,
    });
    await clearSessionEntriesById(agentId, sessionId, userId);
    invalidateResolvedHistoryFile(agentId, sessionId, userId);
    for (const pending of popPendingMessages(agentId, sessionId)) {
      pending.params?.onEvent?.({
        type: "done",
        meta: { durationMs: 0, aborted: true },
      });
    }
    deleteSession(agentId, sessionId);
  } finally {
    active.resetting = false;
  }
}
