import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  AgentContext,
  ContentBlock,
  FullHistoryMessage,
  ModelMeta,
} from "@yoplai/shared";
import { sanitizeForStorage } from "@yoplai/shared";
import { CONFIG_DIR, getAgent } from "../config/index.js";
import type { ExtensionRuntime } from "../extensions/runtime.js";
import { getFullSessionHistory, runAgent } from "./runner.js";
import { appendCanonicalCompaction } from "../history/store.js";
import { getSessionCreatedAt } from "../sessions/store.js";
import { resolveSessionDataFile } from "../sessions/files.js";
import { isStreaming } from "./sessions.js";
import { activateCompaction } from "./compaction-activation.js";
import { getDefaultSdkId } from "../sdk/registry.js";

const RECENT_COMPACT_MESSAGES = 16;
const COMPACT_SUMMARY_PREFIX = "[COMPACTED CONTEXT SUMMARY]";
// Pi requires `usage` on assistant messages (isContextOverflow reads usage.input).
// Zeroed so stale pre-compaction token counts don't re-trigger compaction.
const ZERO_PI_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

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

function activeCompactionContext(messages: FullHistoryMessage[]): FullHistoryMessage[] {
  const previous = [...messages].reverse().find((message) => message.role === "system" && message.compaction);
  if (previous?.role !== "system" || !previous.compaction) return messages;
  const retainedFrom = previous.compaction.retainedFrom ?? previous.timestamp;
  return [previous, ...messages.filter((message) => message.role !== "system" && message.timestamp >= retainedFrom)];
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
  sessionId: string,
  userId?: string
): Promise<string> {
  const agent = getAgent(agentId);
  const dir = userId
    ? path.join(CONFIG_DIR, "sessions", "users", userId, "sessions")
    : path.join(CONFIG_DIR, "sessions");
  if (agent?.sandbox?.enabled) {
    return path.join(dir, agentId, `${sessionId}.jsonl`);
  }
  const createdAt = await getSessionCreatedAt(sessionId, userId);
  return (await resolveSessionDataFile({
    dir,
    agentId,
    sessionId,
    createdAt,
    createIfMissing: true,
  })) as string;
}

// Canonical file blocks hold only a fileId; Pi providers would send them as
// dataless images (Anthropic 400s). Seed Pi with a text reference instead.
function toPiContent(content: ContentBlock[]): ContentBlock[] {
  return content.map((block) =>
    block.type === "file"
      ? {
          type: "text",
          text: `[Attached ${block.mimeType.startsWith("image/") ? "image" : "file"}: ${block.filename} (${block.mimeType}) — content not retained after compaction]`,
        }
      : block
  );
}

async function writeRuntimeFile(file: string, content: string): Promise<void> {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, content, "utf-8");
    await fs.rename(temporary, file);
  } catch (error) {
    try {
      await fs.unlink(temporary);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
    }
    throw error;
  }
}

async function seedPiSession(params: {
  agentId: string;
  sessionId: string;
  summary: string;
  recentMessages: FullHistoryMessage[];
  userId?: string;
}): Promise<() => Promise<void>> {
  const agent = getAgent(params.agentId);
  if (!agent) throw new Error("Agent not found");
  const file = await resolvePiSessionFile(params.agentId, params.sessionId, params.userId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  let original: string | undefined;
  try {
    original = await fs.readFile(file, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const now = new Date().toISOString();
  let parentId: string | null = null;
  const lines: string[] = [];

  const push = (entry: Record<string, unknown>) => {
    const id = eventId();
    lines.push(
      JSON.stringify(
        sanitizeForStorage({ id, parentId, timestamp: now, ...entry })
      )
    );
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
        content: toPiContent(message.content),
        ...(message.role === "assistant"
          ? { ...compactAssistantMeta(message.meta), usage: ZERO_PI_USAGE }
          : {}),
        timestamp: message.timestamp,
      },
    });
  }

  await writeRuntimeFile(file, lines.join("\n") + "\n");
  return async () => {
    if (original === undefined) {
      await fs.unlink(file);
    } else {
      await writeRuntimeFile(file, original);
    }
  };
}

type CompactResult = { sessionId: string; summary: string; keptMessages: number };

// Single-flight in-flight compactions, keyed by (userId, agentId, sessionId). Concurrent
// callers for the same identity share one promise so the history read, summarization,
// durable summary append, and runtime activation run once instead of racing.
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
  const agent = getAgent(params.agentId);
  if (!agent || (agent.sdk ?? getDefaultSdkId()) !== "pi") {
    throw new Error("Web compaction is supported only for Pi sessions");
  }
  if (isStreaming(params.agentId, params.sessionId)) {
    throw new Error("Cannot compact a session while a turn is running");
  }
  const messages = await getFullSessionHistory(
    params.agentId,
    params.sessionId,
    params.userId
  );
  if (messages.length === 0) {
    return { sessionId: params.sessionId, summary: "", keptMessages: 0 };
  }

  const latest = messages.at(-1);
  if (latest?.role === "system" && latest.compaction) {
    return { sessionId: params.sessionId, summary: textFromBlocks(latest).replace(COMPACT_SUMMARY_PREFIX, "").trim(), keptMessages: recentConversationMessages(messages).length };
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Compaction summary timed out"));
    }, 120_000);
  });
  const summaryResult = await Promise.race([
    runAgent({
      agentId: params.agentId,
      sessionId: `compact:${params.sessionId}:${crypto.randomUUID()}`,
      message: buildSummaryPrompt(activeCompactionContext(messages)),
      userId: params.userId,
      extensionRuntime: params.extensionRuntime,
      context: params.context,
      source: "web",
      signal: controller.signal,
    }),
    timeout,
  ]).finally(() => clearTimeout(timer));
  const summary = summaryResult.payloads
    .map((payload) => payload.text)
    .filter((text): text is string => Boolean(text?.trim()))
    .join("\n")
    .trim();
  if (!summary) {
    throw new Error("Compaction produced an empty summary");
  }

  const recentMessages = recentConversationMessages(messages);
  await activateCompaction(params.agentId, params.sessionId, params.userId, async () => {
    if (isStreaming(params.agentId, params.sessionId)) {
      throw new Error("Session changed during compaction; retry when the turn finishes");
    }
    const current = await getFullSessionHistory(params.agentId, params.sessionId, params.userId);
    if (JSON.stringify(current) !== JSON.stringify(messages)) {
      throw new Error("Session changed during compaction; retry with the new history");
    }
    const rollback = await seedPiSession({ ...params, summary, recentMessages });
    try {
      await appendCanonicalCompaction({
        ...params,
        summary,
        recentMessages,
        id: crypto.randomUUID(),
        coveredThrough: messages.reduce((max, message) => Math.max(max, message.timestamp), 0),
      });
    } catch (error) {
      await rollback();
      throw error;
    }
  });

  return {
    sessionId: params.sessionId,
    summary,
    keptMessages: recentMessages.length,
  };
}
