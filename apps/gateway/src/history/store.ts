import fs from "node:fs/promises";
import path from "node:path";
import type {
  AgentContext,
  FullHistoryMessage,
  SimpleHistoryMessage,
  ContentBlock,
  ModelUsage,
  FileAttachment,
  FileBlock,
} from "@yoplai/shared";
import { sanitizeForStorage } from "@yoplai/shared";
import type { HistoryEvent } from "../sdk/types.js";
import { CONFIG_DIR } from "../config/index.js";
import { getUserHistoryDir } from "@yoplai/extension-multi-user/isolation";
import { getSessionCreatedAt } from "../sessions/store.js";
import { resolveSessionDataFile } from "../sessions/files.js";
import { getMediaFileMetadata } from "../media/metadata.js";

const resolvedHistoryFileCache = new Map<string, string>();

function getResolvedHistoryFileCacheKey(
  agentId: string,
  sessionId: string,
  userId?: string
): string {
  return `${userId ?? ""}:${agentId}:${sessionId}`;
}

export function invalidateResolvedHistoryFile(
  agentId: string,
  sessionId: string,
  userId?: string
): void {
  resolvedHistoryFileCache.delete(
    getResolvedHistoryFileCacheKey(agentId, sessionId, userId)
  );
}

/**
 * Resolve history file path with timestamp prefix support.
 * - For existing files: checks known timestamped path, then scans for any timestamped file, then legacy
 * - For new files: always creates timestamped filename (uses createdAt or defaults to now)
 */
async function resolveHistoryFile(
  agentId: string,
  sessionId: string,
  userId?: string
): Promise<string> {
  const cacheKey = getResolvedHistoryFileCacheKey(agentId, sessionId, userId);
  const cached = resolvedHistoryFileCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const historyDir = getHistoryDir(userId);
  const createdAt = await getSessionCreatedAt(sessionId, userId);
  const resolved = (await resolveSessionDataFile({
    dir: historyDir,
    agentId,
    sessionId,
    createdAt,
    createIfMissing: true,
  })) as string;
  resolvedHistoryFileCache.set(cacheKey, resolved);
  return resolved;
}

// JSONL entry format for canonical history
type UserHistoryEntry = {
  type: "history";
  agentId: string;
  sessionId: string;
  timestamp: number;
  role: "user";
  content: ContentBlock[];
};

type SystemHistoryEntry = {
  type: "history";
  agentId: string;
  sessionId: string;
  timestamp: number;
  role: "system";
  content: ContentBlock[];
  context?: AgentContext;
};

type AssistantHistoryEntry = {
  type: "history";
  agentId: string;
  sessionId: string;
  timestamp: number;
  role: "assistant";
  content: ContentBlock[];
  meta?: {
    provider?: string;
    model?: string;
    api?: string;
    usage?: ModelUsage;
    stopReason?: string;
  };
};

type ToolResultHistoryEntry = {
  type: "history";
  agentId: string;
  sessionId: string;
  timestamp: number;
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: ContentBlock[];
  isError: boolean;
  details?: { diff?: string };
};

type HistoryEntry =
  | SystemHistoryEntry
  | UserHistoryEntry
  | AssistantHistoryEntry
  | ToolResultHistoryEntry;

function orderMessagesByTimestamp<T extends { timestamp: number }>(
  messages: T[]
): T[] {
  return messages
    .map((message, index) => ({ message, index }))
    .sort((a, b) => {
      const diff = a.message.timestamp - b.message.timestamp;
      return diff === 0 ? a.index - b.index : diff;
    })
    .map((entry) => entry.message);
}

// Meta entry for session-level metadata (e.g., thinkingLevel changes)
type MetaEntry = {
  type: "meta";
  key: string;
  value: unknown;
  timestamp: number;
};

/**
 * Append a raw history entry to the canonical store
 */
async function appendRawEntry(
  agentId: string,
  sessionId: string,
  entry: Record<string, unknown>,
  userId?: string
): Promise<void> {
  const file = await resolveHistoryFile(agentId, sessionId, userId);
  const line =
    JSON.stringify(
      sanitizeForStorage({ type: "history", agentId, sessionId, ...entry })
    ) + "\n";
  await fs.appendFile(file, line, "utf-8");
}

/**
 * Append a meta entry to the session's JSONL file
 * Format: {"type":"meta","key":"thinkingLevel","value":"medium","timestamp":...}
 */
export async function appendSessionMeta(
  agentId: string,
  sessionId: string,
  key: string,
  value: unknown,
  userId?: string
): Promise<void> {
  const file = await resolveHistoryFile(agentId, sessionId, userId);
  const entry: MetaEntry = { type: "meta", key, value, timestamp: Date.now() };
  const line = JSON.stringify(sanitizeForStorage(entry)) + "\n";
  await fs.appendFile(file, line, "utf-8");
}

/**
 * Turn buffer for accumulating history events into messages
 * Buffers everything synchronously, then flushes to disk in correct order
 */
export type TurnBuffer = {
  userText: string | null;
  userTimestamp: number;
  userAttachments: FileAttachment[];
  userFlushed: boolean;
  systemContext?: {
    rendered: string;
    context: AgentContext;
    timestamp: number;
  };
  thinkingText: string;
  assistantText: string;
  assistantContent: ContentBlock[];
  fileBlocks: FileBlock[];
  toolCalls: Array<{
    id: string;
    name: string;
    args: unknown;
    status: "running" | "done" | "error";
  }>;
  toolResults: Array<{
    id: string;
    name: string;
    content: string;
    isError: boolean;
    details?: { diff?: string };
    timestamp: number;
  }>;
  meta?: {
    provider?: string;
    model?: string;
    api?: string;
    usage?: ModelUsage;
    stopReason?: string;
  };
  startTimestamp: number;
  assistantStarted: boolean;
};

export function createTurnBuffer(): TurnBuffer {
  return {
    userText: null,
    userTimestamp: Date.now(),
    userAttachments: [],
    userFlushed: false,
    systemContext: undefined,
    thinkingText: "",
    assistantText: "",
    assistantContent: [],
    fileBlocks: [],
    toolCalls: [],
    toolResults: [],
    startTimestamp: Date.now(),
    assistantStarted: false,
  };
}

/**
 * Flush turn buffer to history store in correct order:
 * 1. User message
 * 2. Assistant message (thinking, tool calls, text)
 * 3. Tool results
 */
export async function flushTurnBuffer(
  agentId: string,
  sessionId: string,
  buffer: TurnBuffer,
  userId?: string
): Promise<void> {
  if (buffer.systemContext) {
    await appendRawEntry(
      agentId,
      sessionId,
      {
        role: "system",
        content: [{ type: "text", text: buffer.systemContext.rendered }],
        context: buffer.systemContext.context,
        timestamp: buffer.systemContext.timestamp,
      },
      userId
    );
  }
  // 1. User message (skip if already eagerly flushed)
  if (buffer.userText && !buffer.userFlushed) {
    const userContent = await buildUserContent(
      buffer.userText,
      buffer.userAttachments
    );
    await appendRawEntry(
      agentId,
      sessionId,
      {
        role: "user",
        content: userContent,
        timestamp: buffer.userTimestamp,
      },
      userId
    );
    buffer.userFlushed = true;
  }

  // 2. Assistant message
  const content: ContentBlock[] = buffer.assistantContent.length
    ? buffer.assistantContent
    : [];
  if (content.length === 0) {
    if (buffer.thinkingText) {
      content.push({ type: "thinking", thinking: buffer.thinkingText });
    }
    if (buffer.assistantText) {
      content.push({ type: "text", text: buffer.assistantText });
    }
    content.push(...buffer.fileBlocks);
    for (const tc of buffer.toolCalls) {
      content.push({
        type: "toolCall",
        id: tc.id,
        name: tc.name,
        arguments: tc.args,
      });
    }
  }

  if (content.length > 0) {
    await appendRawEntry(
      agentId,
      sessionId,
      {
        role: "assistant",
        content,
        meta: buffer.meta,
        timestamp: buffer.startTimestamp,
      },
      userId
    );
  }

  // 3. Tool results (after assistant message)
  for (const tr of buffer.toolResults) {
    await appendRawEntry(
      agentId,
      sessionId,
      {
        role: "toolResult",
        toolCallId: tr.id,
        toolName: tr.name,
        content: [{ type: "text", text: tr.content }],
        isError: tr.isError,
        details: tr.details,
        timestamp: tr.timestamp,
      },
      userId
    );
  }
}

/**
 * Eagerly persist the user message from a turn buffer so it appears in
 * history immediately (before the agent run finishes). Sets `userFlushed`
 * so `flushTurnBuffer` won't duplicate it.
 */
export async function flushUserMessage(
  agentId: string,
  sessionId: string,
  buffer: TurnBuffer,
  userId?: string
): Promise<void> {
  if (!buffer.userText || buffer.userFlushed) return;
  const content = await buildUserContent(
    buffer.userText,
    buffer.userAttachments
  );
  await appendRawEntry(
    agentId,
    sessionId,
    {
      role: "user",
      content,
      timestamp: buffer.userTimestamp,
    },
    userId
  );
  buffer.userFlushed = true;
}

function appendAssistantText(buffer: TurnBuffer, text: string): void {
  const last = buffer.assistantContent.at(-1);
  if (last?.type === "text") {
    last.text += text;
    return;
  }
  buffer.assistantContent.push({ type: "text", text });
}

function appendAssistantThinking(buffer: TurnBuffer, text: string): void {
  const last = buffer.assistantContent.at(-1);
  if (last?.type === "thinking") {
    last.thinking += text;
    return;
  }
  buffer.assistantContent.push({ type: "thinking", thinking: text });
}

/**
 * Accumulate a history event into the turn buffer (sync, no I/O)
 */
export function bufferHistoryEvent(
  buffer: TurnBuffer,
  event: HistoryEvent
): void {
  switch (event.type) {
    case "system_context":
      buffer.systemContext = {
        rendered: event.rendered,
        context: event.context,
        timestamp: event.timestamp,
      };
      break;
    case "user":
      buffer.userText = event.text;
      buffer.userTimestamp = event.timestamp;
      buffer.userAttachments = event.attachments ?? [];
      break;
    case "assistant_text":
      if (!buffer.assistantStarted) {
        buffer.assistantStarted = true;
        buffer.startTimestamp = event.timestamp;
      }
      buffer.assistantText += event.text;
      appendAssistantText(buffer, event.text);
      break;
    case "assistant_thinking":
      if (!buffer.assistantStarted) {
        buffer.assistantStarted = true;
        buffer.startTimestamp = event.timestamp;
      }
      buffer.thinkingText += event.text;
      appendAssistantThinking(buffer, event.text);
      break;
    case "assistant_file":
      if (!buffer.assistantStarted) {
        buffer.assistantStarted = true;
        buffer.startTimestamp = event.timestamp;
      }
      buffer.fileBlocks.push({
        type: "file",
        fileId: event.fileId,
        filename: event.filename,
        mimeType: event.mimeType,
        size: event.size,
        direction: event.direction,
      });
      buffer.assistantContent.push({
        type: "file",
        fileId: event.fileId,
        filename: event.filename,
        mimeType: event.mimeType,
        size: event.size,
        direction: event.direction,
      });
      break;
    case "tool_call":
      if (!buffer.assistantStarted) {
        buffer.assistantStarted = true;
        buffer.startTimestamp = event.timestamp;
      }
      buffer.toolCalls.push({
        id: event.id,
        name: event.name,
        args: event.args,
        status: "running",
      });
      buffer.assistantContent.push({
        type: "toolCall",
        id: event.id,
        name: event.name,
        arguments: event.args,
      });
      break;
    case "tool_result":
      if (!buffer.assistantStarted) {
        buffer.assistantStarted = true;
        buffer.startTimestamp = event.timestamp;
      }
      {
        const matching = buffer.toolCalls.find(
          (tc) => tc.id === event.id || (!tc.id && tc.name === event.name)
        );
        if (matching) {
          matching.status = event.isError ? "error" : "done";
        }
      }
      buffer.toolResults.push({
        id: event.id,
        name: event.name,
        content: event.content,
        isError: event.isError,
        details: event.details,
        timestamp: event.timestamp,
      });
      break;
    case "turn_end":
      break;
    case "meta":
      if (!buffer.assistantStarted) {
        buffer.assistantStarted = true;
        buffer.startTimestamp = event.timestamp;
      }
      buffer.meta = {
        provider: event.provider,
        model: event.model,
        api: event.api,
        usage: event.usage,
        stopReason: event.stopReason,
      };
      break;
  }
}

async function buildUserContent(
  text: string,
  attachments: FileAttachment[]
): Promise<ContentBlock[]> {
  const content: ContentBlock[] = [];
  if (text) {
    content.push({ type: "text", text });
  }
  content.push(...(await buildInboundFileBlocks(attachments)));
  return content;
}

async function buildInboundFileBlocks(
  attachments: FileAttachment[]
): Promise<FileBlock[]> {
  const blocks = await Promise.all(
    attachments.map(async (attachment) => {
      const fileId = getAttachmentFileId(attachment.path);
      const metadata = fileId ? await getMediaFileMetadata(fileId) : null;
      return {
        type: "file" as const,
        fileId: metadata?.fileId ?? fileId ?? attachment.path,
        filename:
          metadata?.filename ??
          attachment.filename ??
          path.basename(attachment.path),
        mimeType: metadata?.mimeType ?? attachment.mimeType,
        size: metadata?.size ?? 0,
        direction: "inbound" as const,
      };
    })
  );
  return blocks;
}

function getAttachmentFileId(filePath: string): string | null {
  const basename = path.basename(filePath);
  const ext = path.extname(basename);
  return ext ? basename.slice(0, -ext.length) : basename || null;
}

/**
 * Load simple history (text only) from canonical store
 */
export async function getSimpleHistory(
  agentId: string,
  sessionId: string,
  userId?: string
): Promise<SimpleHistoryMessage[]> {
  const file = await resolveHistoryFile(agentId, sessionId, userId);
  const messages: SimpleHistoryMessage[] = [];

  try {
    const content = await fs.readFile(file, "utf-8");
    const lines = content.trim().split("\n");

    for (const line of lines) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as HistoryEntry;
        if (entry.type !== "history") continue;

        if (entry.role === "user" || entry.role === "assistant") {
          const text = entry.content
            .filter(
              (c): c is { type: "text"; text: string } => c.type === "text"
            )
            .map((c) => c.text)
            .join("\n");
          const files = entry.content.filter(
            (c): c is FileBlock => c.type === "file"
          );
          if (text || files.length > 0) {
            messages.push({
              role: entry.role,
              content: text,
              files: files.length > 0 ? files : undefined,
              timestamp: entry.timestamp,
            });
          }
        }
      } catch (err) {
        // Expected: malformed JSON lines in history file
        console.warn("[history] Skipping malformed line in simple history", {
          agentId,
          sessionId,
          error: String(err),
        });
      }
    }
  } catch (err) {
    // Expected: history file may not exist yet for new sessions
    console.warn("[history] Could not read simple history file", {
      agentId,
      sessionId,
      error: String(err),
    });
  }

  return orderMessagesByTimestamp(messages);
}

/**
 * Load full history from canonical store
 */
export async function getFullHistory(
  agentId: string,
  sessionId: string,
  userId?: string
): Promise<FullHistoryMessage[]> {
  const file = await resolveHistoryFile(agentId, sessionId, userId);
  const messages: FullHistoryMessage[] = [];

  try {
    const content = await fs.readFile(file, "utf-8");
    const lines = content.trim().split("\n");

    for (const line of lines) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as HistoryEntry;
        if (entry.type !== "history") continue;

        if (entry.role === "system") {
          messages.push({
            role: "system",
            content: entry.content,
            timestamp: entry.timestamp,
            context: entry.context,
          });
        } else if (entry.role === "user") {
          messages.push({
            role: "user",
            content: entry.content,
            timestamp: entry.timestamp,
          });
        } else if (entry.role === "assistant") {
          messages.push({
            role: "assistant",
            content: entry.content,
            timestamp: entry.timestamp,
            meta: entry.meta,
          });
        } else if (entry.role === "toolResult") {
          messages.push({
            role: "toolResult",
            toolCallId: entry.toolCallId,
            toolName: entry.toolName,
            content: entry.content,
            isError: entry.isError,
            details: entry.details,
            timestamp: entry.timestamp,
          });
        }
      } catch (err) {
        // Expected: malformed JSON lines in history file
        console.warn("[history] Skipping malformed line in full history", {
          agentId,
          sessionId,
          error: String(err),
        });
      }
    }
  } catch (err) {
    // Expected: history file may not exist yet for new sessions
    console.warn("[history] Could not read full history file", {
      agentId,
      sessionId,
      error: String(err),
    });
  }

  return orderMessagesByTimestamp(messages);
}

export async function replaceCanonicalHistoryWithCompaction(params: {
  agentId: string;
  sessionId: string;
  summary: string;
  recentMessages: FullHistoryMessage[];
  userId?: string;
}): Promise<void> {
  const file = await resolveHistoryFile(
    params.agentId,
    params.sessionId,
    params.userId
  );
  await fs.mkdir(path.dirname(file), { recursive: true });
  const firstRecentTimestamp = params.recentMessages.reduce(
    (min, message) => Math.min(min, message.timestamp),
    Date.now()
  );
  const entries: HistoryEntry[] = [
    {
      type: "history",
      agentId: params.agentId,
      sessionId: params.sessionId,
      role: "system",
      content: [
        {
          type: "text",
          text: `[COMPACTED CONTEXT SUMMARY]\n${params.summary.trim()}`,
        },
      ],
      timestamp: Math.max(0, firstRecentTimestamp - 1),
    },
  ];

  for (const message of params.recentMessages) {
    if (message.role === "toolResult") continue;
    const entry =
      message.role === "assistant" && message.meta
        ? {
            ...message,
            meta: {
              provider: message.meta.provider,
              model: message.meta.model,
              api: message.meta.api,
              stopReason: message.meta.stopReason,
            },
          }
        : message;
    entries.push({
      type: "history",
      agentId: params.agentId,
      sessionId: params.sessionId,
      ...entry,
    } as HistoryEntry);
  }

  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(
    tmp,
    entries
      .map((entry) => JSON.stringify(sanitizeForStorage(entry)))
      .join("\n") + "\n",
    "utf-8"
  );
  await fs.rename(tmp, file);
}

/**
 * Check if canonical history exists for a session
 */
export async function hasCanonicalHistory(
  agentId: string,
  sessionId: string,
  userId?: string
): Promise<boolean> {
  const file = await resolveHistoryFile(agentId, sessionId, userId);
  try {
    await fs.access(file);
    return true;
  } catch {
    // Intentionally swallowed: access() failure means file doesn't exist, which is an expected condition
    return false;
  }
}

const PI_SESSIONS_DIR = path.join(CONFIG_DIR, "sessions");

/**
 * Resolve Pi session file path (supports both timestamped and legacy formats)
 */
async function resolvePiSessionFile(
  agentId: string,
  sessionId: string,
  userId?: string
): Promise<string | null> {
  const createdAt = await getSessionCreatedAt(sessionId, userId);
  return resolveSessionDataFile({
    dir: PI_SESSIONS_DIR,
    agentId,
    sessionId,
    createdAt,
    createIfMissing: false,
  });
}

/**
 * Backfill canonical history from Pi session file (one-time migration)
 * Returns true if backfill was performed, false if not needed
 */
export async function backfillFromPiSession(
  agentId: string,
  sessionId: string,
  userId?: string
): Promise<boolean> {
  // Skip if canonical already exists or Pi session doesn't exist
  if (await hasCanonicalHistory(agentId, sessionId, userId)) return false;

  const piFile = await resolvePiSessionFile(agentId, sessionId, userId);
  if (!piFile) return false;

  let content: string;
  try {
    content = await fs.readFile(piFile, "utf-8");
  } catch {
    // Expected: Pi session file may not exist during backfill
    console.warn("[history] Pi session file not found during backfill", {
      agentId,
      sessionId,
      piFile,
    });
    return false;
  }

  await ensureHistoryDir(userId);
  const lines = content.trim().split("\n");

  for (const line of lines) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type !== "message") continue;

      const msg = entry.message as Record<string, unknown>;
      if (!msg || !msg.role) continue;

      const timestamp = (msg.timestamp as number) ?? Date.now();
      const rawContent = msg.content as unknown[];

      if (msg.role === "user") {
        const text = extractText(rawContent);
        if (text) {
          await appendRawEntry(
            agentId,
            sessionId,
            {
              role: "user",
              content: [{ type: "text", text }],
              timestamp,
            },
            userId
          );
        }
      } else if (msg.role === "assistant") {
        const blocks = convertPiContent(rawContent);
        if (blocks.length > 0) {
          await appendRawEntry(
            agentId,
            sessionId,
            {
              role: "assistant",
              content: blocks,
              meta: {
                api: msg.api as string | undefined,
                provider: msg.provider as string | undefined,
                model: msg.model as string | undefined,
                usage: msg.usage as ModelUsage | undefined,
                stopReason: msg.stopReason as string | undefined,
              },
              timestamp,
            },
            userId
          );
        }
      } else if (msg.role === "toolResult") {
        const text = extractText(rawContent);
        const details = msg.details as Record<string, unknown> | undefined;
        await appendRawEntry(
          agentId,
          sessionId,
          {
            role: "toolResult",
            toolCallId: msg.toolCallId as string,
            toolName: msg.toolName as string,
            content: [{ type: "text", text: text || "" }],
            isError: (msg.isError as boolean) ?? false,
            details: details?.diff
              ? { diff: details.diff as string }
              : undefined,
            timestamp,
          },
          userId
        );
      }
    } catch (err) {
      // Expected: malformed JSON lines in Pi session file
      console.warn("[history] Skipping malformed line in Pi backfill", {
        agentId,
        sessionId,
        error: String(err),
      });
    }
  }

  return true;
}

/**
 * Read Pi session file directly as FullHistoryMessage[].
 * Used as fallback when canonical history is incomplete (e.g. during streaming).
 */
export async function readPiSessionHistory(
  agentId: string,
  sessionId: string,
  userId?: string
): Promise<FullHistoryMessage[]> {
  const piFile = await resolvePiSessionFile(agentId, sessionId, userId);
  if (!piFile) return [];

  let content: string;
  try {
    content = await fs.readFile(piFile, "utf-8");
  } catch {
    // Expected: Pi session file may not exist
    console.warn("[history] Pi session file not found for history read", {
      agentId,
      sessionId,
      piFile,
    });
    return [];
  }

  const messages: FullHistoryMessage[] = [];
  const lines = content.trim().split("\n");

  for (const line of lines) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type !== "message") continue;

      const msg = entry.message as Record<string, unknown>;
      if (!msg || !msg.role) continue;

      const timestamp = (msg.timestamp as number) ?? Date.now();
      const rawContent = msg.content as unknown[];

      if (msg.role === "user") {
        const text = extractText(rawContent);
        if (text) {
          messages.push({
            role: "user",
            content: [{ type: "text", text }],
            timestamp,
          });
        }
      } else if (msg.role === "assistant") {
        const blocks = convertPiContent(rawContent);
        if (blocks.length > 0) {
          messages.push({
            role: "assistant",
            content: blocks,
            timestamp,
            meta: {
              api: msg.api as string | undefined,
              provider: msg.provider as string | undefined,
              model: msg.model as string | undefined,
              usage: msg.usage as ModelUsage | undefined,
              stopReason: msg.stopReason as string | undefined,
            },
          });
        }
      } else if (msg.role === "toolResult") {
        const text = extractText(rawContent);
        const details = msg.details as Record<string, unknown> | undefined;
        messages.push({
          role: "toolResult",
          toolCallId: msg.toolCallId as string,
          toolName: msg.toolName as string,
          content: [{ type: "text", text: text || "" }],
          isError: (msg.isError as boolean) ?? false,
          details: details?.diff ? { diff: details.diff as string } : undefined,
          timestamp,
        });
      }
    } catch (err) {
      // Expected: malformed JSON lines in Pi session file
      console.warn("[history] Skipping malformed line in Pi history read", {
        agentId,
        sessionId,
        error: String(err),
      });
    }
  }

  return messages;
}

function extractText(content: unknown[]): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is { type: "text"; text: string } => {
      if (!c || typeof c !== "object") return false;
      const obj = c as Record<string, unknown>;
      return obj.type === "text" && typeof obj.text === "string";
    })
    .map((c) => c.text)
    .join("\n");
}

function convertPiContent(content: unknown[]): ContentBlock[] {
  if (!Array.isArray(content)) return [];
  const blocks: ContentBlock[] = [];
  for (const c of content) {
    const block = c as Record<string, unknown>;
    if (block.type === "thinking" && typeof block.thinking === "string") {
      blocks.push({ type: "thinking", thinking: block.thinking });
    } else if (block.type === "text" && typeof block.text === "string") {
      blocks.push({ type: "text", text: block.text });
    } else if (block.type === "toolCall" && typeof block.id === "string") {
      blocks.push({
        type: "toolCall",
        id: block.id,
        name: block.name as string,
        arguments: block.arguments,
      });
    }
  }
  return blocks;
}
function getHistoryDir(userId?: string): string {
  return getUserHistoryDir(userId, CONFIG_DIR);
}

async function ensureHistoryDir(userId?: string) {
  await fs.mkdir(getHistoryDir(userId), { recursive: true });
}
