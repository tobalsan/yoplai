import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { parseSessionFileName, readPersistedOwner } from "../history/sessions.js";
import { readRoutingAttempt } from "./attempt.js";
import { RouteLockSchema } from "./session-router.js";
import type { RoutingReportSession } from "./report.js";

async function directoryEntries(dir: string) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** Reads structure only; message content and non-routing metadata are discarded per line. */
export async function readRoutingSessions(
  dataDir: string,
  configuredAgentIds: string[]
): Promise<RoutingReportSession[]> {
  const histories = [{ owner: "single-user", dir: path.join(dataDir, "history") }];
  const usersDir = path.join(dataDir, "sessions", "users");
  for (const user of await directoryEntries(usersDir)) {
    if (user.isDirectory()) histories.push({ owner: user.name, dir: path.join(usersDir, user.name, "history") });
  }
  const sessions: RoutingReportSession[] = [];
  for (const { owner, dir } of histories) {
    for (const file of await directoryEntries(dir)) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
      const session: RoutingReportSession = {
        owner, agent: "", session: "", entries: [], attempts: [], locks: [], lockCount: 0, invalidLineCount: 0,
      };
      let persisted: ReturnType<typeof readPersistedOwner> = null;
      const lines = createInterface({ input: createReadStream(path.join(dir, file.name)), crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line.trim()) continue;
        let entry: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(line);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            session.invalidLineCount++;
            continue;
          }
          entry = parsed as Record<string, unknown>;
        } catch {
          session.invalidLineCount++;
          continue;
        }
        if (!persisted && entry.type === "history") persisted = readPersistedOwner(line);
        if (entry.type === "meta" && entry.key === "modelRouteAttempt") {
          const attempt = readRoutingAttempt(entry);
          if (attempt) session.attempts.push(attempt);
          else session.invalidLineCount++;
        } else if (entry.type === "meta" && entry.key === "modelRoute") {
          session.lockCount++;
          const lock = RouteLockSchema.safeParse(entry.value);
          if (lock.success) {
            session.lock = lock.data;
            session.locks!.push(lock.data);
          } else session.invalidLineCount++;
        } else if (entry.type === "history" && (entry.role === "user" || entry.role === "assistant")) {
          if (typeof entry.timestamp !== "number" || !Number.isFinite(new Date(entry.timestamp).getTime())) {
            session.invalidLineCount++;
            continue;
          }
          const projected: RoutingReportSession["entries"][number] = { role: entry.role, timestamp: entry.timestamp };
          if (entry.role === "assistant" && entry.meta && typeof entry.meta === "object") {
            const meta = entry.meta as Record<string, unknown>;
            if (typeof meta.provider === "string") projected.provider = meta.provider;
            if (typeof meta.model === "string") projected.model = meta.model;
          }
          session.entries.push(projected);
        }
      }
      const identity = parseSessionFileName(file.name, configuredAgentIds, persisted);
      if (!identity) continue;
      session.agent = identity.agentId;
      session.session = identity.sessionId;
      sessions.push(session);
    }
  }
  return sessions;
}
