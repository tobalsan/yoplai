import fs from "node:fs/promises";
import path from "node:path";
import type {
  ContentBlock,
  FileAttachment,
  FullHistoryMessage,
  LeadSession,
  RunAgentResult,
} from "@yoplai/shared";
import { getProjectsContext } from "../context.js";
import {
  historyPath,
  transcriptDir,
  updateLeadSessionInProject,
} from "./store.js";

type HistoryEntry = {
  type: "history";
  agentId: string;
  sessionId: string;
  timestamp: number;
  role: "user" | "assistant" | "system" | "toolResult";
  content?: ContentBlock[];
};

export type LeadTranscript = {
  messages: FullHistoryMessage[];
};

export async function readLeadTranscript(
  projectDir: string,
  session: LeadSession
): Promise<LeadTranscript> {
  const file = historyPath(projectDir, session.transcriptRef);
  let raw = "";
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const messages: FullHistoryMessage[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as HistoryEntry;
      if (entry.type !== "history") continue;
      if (entry.role !== "user" && entry.role !== "assistant") continue;
      messages.push({
        role: entry.role,
        content: entry.content ?? [],
        timestamp: entry.timestamp,
      });
    } catch {
      // Ignore malformed transcript lines so one bad write does not hide history.
    }
  }
  return { messages };
}

export async function leadTranscriptHasUserMessage(
  projectDir: string,
  session: LeadSession
): Promise<boolean> {
  const transcript = await readLeadTranscript(projectDir, session);
  return transcript.messages.some((message) => message.role === "user");
}

export async function sendLeadSessionMessage(args: {
  projectDir: string;
  session: LeadSession;
  content: string;
  files?: FileAttachment[];
}): Promise<{
  session: LeadSession;
  result: RunAgentResult;
}> {
  const now = Date.now();
  const ctx = getProjectsContext();
  await ensureTranscriptDir(args.projectDir, args.session);
  await appendHistoryEntry(args.projectDir, args.session, {
    type: "history",
    agentId: args.session.agentId,
    sessionId: args.session.transcriptRef,
    timestamp: now,
    role: "user",
    content: [
      { type: "text", text: args.content },
      ...(args.files ?? []).map((file) => ({
        type: "file" as const,
        fileId: file.path,
        filename: file.filename ?? path.basename(file.path),
        mimeType: file.mimeType,
        size: file.size ?? 0,
        direction: "inbound" as const,
      })),
    ],
  });

  const result = await ctx.runAgent({
    agentId: args.session.agentId,
    message: args.content,
    attachments: args.files,
    sessionKey: args.session.transcriptRef,
    onEvent: (event) => {
      if (event.type === "error") {
        void appendLogEntry(args.projectDir, args.session, event);
      }
    },
  });

  const assistantText = result.payloads
    .map((payload) => payload.text)
    .filter(
      (text): text is string => typeof text === "string" && text.length > 0
    )
    .join("\n\n");
  if (assistantText) {
    await appendHistoryEntry(args.projectDir, args.session, {
      type: "history",
      agentId: args.session.agentId,
      sessionId: args.session.transcriptRef,
      timestamp: Date.now(),
      role: "assistant",
      content: [{ type: "text", text: assistantText }],
    });
  }

  const updated: LeadSession = {
    ...args.session,
    updatedAt: new Date().toISOString(),
  };
  const persisted =
    (await updateLeadSessionInProject(
      args.projectDir,
      args.session.id,
      (current) => ({
        ...current,
        agentId: args.session.agentId,
        updatedAt: updated.updatedAt,
      })
    )) ?? updated;
  return { session: persisted, result };
}

async function ensureTranscriptDir(
  projectDir: string,
  session: LeadSession
): Promise<void> {
  await fs.mkdir(transcriptDir(projectDir, session.transcriptRef), {
    recursive: true,
  });
}

async function appendHistoryEntry(
  projectDir: string,
  session: LeadSession,
  entry: HistoryEntry
): Promise<void> {
  await ensureTranscriptDir(projectDir, session);
  await fs.appendFile(
    historyPath(projectDir, session.transcriptRef),
    `${JSON.stringify(entry)}\n`,
    "utf8"
  );
}

async function appendLogEntry(
  projectDir: string,
  session: LeadSession,
  event: unknown
): Promise<void> {
  await ensureTranscriptDir(projectDir, session);
  await fs.appendFile(
    path.join(transcriptDir(projectDir, session.transcriptRef), "logs.jsonl"),
    `${JSON.stringify(event)}\n`,
    "utf8"
  );
}
