import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  AgentContext,
  ContentBlock,
  FullHistoryMessage,
  ModelMeta,
} from "@yoplai/shared";
import { CONFIG_DIR, getAgent } from "../config/index.js";
import type { ExtensionRuntime } from "../extensions/runtime.js";
import { getFullSessionHistory, runAgent } from "./runner.js";
import { replaceCanonicalHistoryWithCompaction } from "../history/store.js";
import { getSessionCreatedAt } from "../sessions/store.js";
import { resolveSessionDataFile } from "../sessions/files.js";

const RECENT_COMPACT_MESSAGES = 16;
const COMPACT_SUMMARY_PREFIX = "[COMPACTED CONTEXT SUMMARY]";

function textFromBlocks(message: FullHistoryMessage): string {
  if (message.role === "toolResult") return "";
  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function formatTranscript(messages: FullHistoryMessage[]): string {
  return messages
    .map((message) => {
      const text = textFromBlocks(message);
      if (!text) return "";
      return `${message.role.toUpperCase()}: ${text}`;
    })
    .filter(Boolean)
    .join("\n\n");
}

function recentConversationMessages(
  messages: FullHistoryMessage[]
): FullHistoryMessage[] {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({
      ...message,
      content: message.content.filter(
        (block): block is Exclude<ContentBlock, { type: "toolCall" }> =>
          block.type !== "toolCall"
      ),
    }))
    .filter((message) => message.content.length > 0)
    .slice(-RECENT_COMPACT_MESSAGES);
}

function buildSummaryPrompt(messages: FullHistoryMessage[]): string {
  return `Summarize the conversation below so another run of the same agent can continue without the older raw context.

Preserve:
- user goals, decisions, constraints, and preferences
- important facts, names, IDs, file paths, commands, and unresolved tasks
- any commitments the assistant made

Do not mention that this is a summary unless it is necessary.

Conversation:
${formatTranscript(messages)}`;
}

function eventId(): string {
  return crypto.randomBytes(4).toString("hex");
}

export function compactAssistantMeta(
  meta: ModelMeta | undefined
): Omit<ModelMeta, "usage"> | undefined {
  if (!meta) return undefined;
  const rest = { ...meta };
  delete rest.usage;
  return rest;
}

async function resolvePiSessionFile(
  agentId: string,
  sessionId: string
): Promise<string> {
  const createdAt = await getSessionCreatedAt(sessionId);
  return (await resolveSessionDataFile({
    dir: path.join(CONFIG_DIR, "sessions"),
    agentId,
    sessionId,
    createdAt,
    createIfMissing: true,
  })) as string;
}

async function seedPiSession(params: {
  agentId: string;
  sessionId: string;
  summary: string;
  recentMessages: FullHistoryMessage[];
}): Promise<void> {
  const agent = getAgent(params.agentId);
  if (!agent) return;
  const file = await resolvePiSessionFile(params.agentId, params.sessionId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const now = new Date().toISOString();
  let parentId: string | null = null;
  const lines: string[] = [];

  const push = (entry: Record<string, unknown>) => {
    const id = eventId();
    lines.push(JSON.stringify({ id, parentId, timestamp: now, ...entry }));
    parentId = id;
  };

  push({
    type: "session",
    version: 3,
    id: params.sessionId,
    cwd: "",
  });
  push({
    type: "model_change",
    provider: agent.model.provider,
    modelId: agent.model.model,
  });
  push({
    type: "message",
    message: {
      role: "user",
      content: [
        {
          type: "text",
          text: `${COMPACT_SUMMARY_PREFIX}\n${params.summary.trim()}`,
        },
      ],
      timestamp: Date.now(),
    },
  });

  for (const message of params.recentMessages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    push({
      type: "message",
      message: {
        role: message.role,
        content: message.content,
        ...(message.role === "assistant"
          ? compactAssistantMeta(message.meta)
          : {}),
        timestamp: message.timestamp,
      },
    });
  }

  await fs.writeFile(file, lines.join("\n") + "\n", "utf-8");
}

type CompactResult = { sessionId: string; summary: string; keptMessages: number };

// Single-flight in-flight compactions, keyed by (userId, agentId, sessionId). Concurrent
// callers for the same identity share one promise so the history read, summarization,
// canonical rewrite, and runtime seed run exactly once instead of racing two rewrites.
const inFlightCompactions = new Map<string, Promise<CompactResult>>();

function compactionKey(params: {
  agentId: string;
  sessionId: string;
  userId?: string;
}): string {
  return JSON.stringify([params.userId ?? "", params.agentId, params.sessionId]);
}

export async function compactAgentSession(params: {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  userId?: string;
  extensionRuntime?: ExtensionRuntime;
  context?: AgentContext;
}): Promise<CompactResult> {
  const key = compactionKey(params);
  const existing = inFlightCompactions.get(key);
  if (existing) {
    console.log(
      `[compact] coalesced agentId=${params.agentId} sessionId=${params.sessionId} userId=${params.userId ?? "anon"}`
    );
    return existing;
  }

  console.log(
    `[compact] started agentId=${params.agentId} sessionId=${params.sessionId} userId=${params.userId ?? "anon"}`
  );
  const run = runCompactAgentSession(params).finally(() => {
    inFlightCompactions.delete(key);
  });
  inFlightCompactions.set(key, run);
  return run;
}

async function runCompactAgentSession(params: {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  userId?: string;
  extensionRuntime?: ExtensionRuntime;
  context?: AgentContext;
}): Promise<CompactResult> {
  const messages = await getFullSessionHistory(
    params.agentId,
    params.sessionId,
    params.userId
  );
  if (messages.length === 0) {
    return { sessionId: params.sessionId, summary: "", keptMessages: 0 };
  }

  const summaryResult = await runAgent({
    agentId: params.agentId,
    sessionId: `compact:${params.sessionId}:${crypto.randomUUID()}`,
    message: buildSummaryPrompt(messages),
    userId: params.userId,
    extensionRuntime: params.extensionRuntime,
    context: params.context,
    source: "web",
  });
  const summary = summaryResult.payloads
    .map((payload) => payload.text)
    .filter((text): text is string => Boolean(text?.trim()))
    .join("\n")
    .trim();
  if (!summary) {
    throw new Error("Compaction produced an empty summary");
  }

  const recentMessages = recentConversationMessages(messages);
  await replaceCanonicalHistoryWithCompaction({
    agentId: params.agentId,
    sessionId: params.sessionId,
    userId: params.userId,
    summary,
    recentMessages,
  });
  await seedPiSession({
    agentId: params.agentId,
    sessionId: params.sessionId,
    summary,
    recentMessages,
  });

  return {
    sessionId: params.sessionId,
    summary,
    keptMessages: recentMessages.length,
  };
}
