import { z } from "zod";
import { getAgents } from "../config/index.js";
import { condense, oneLine } from "../history/condense.js";
import { parseHistoryJsonl } from "../history/legacy-transcript.js";
import { matchSession } from "../history/session-search.js";
import { listAllSessionFiles } from "../history/sessions.js";
import { readToolLabels } from "../maintenance/tool-labels.js";
import { day, invalidResult, parseDate, SessionHistoryArgsSchema } from "./arguments.js";

const argsSchema = SessionHistoryArgsSchema.extend({ includeArchived: z.boolean().optional() });

export const legacyHistoryTool = {
  name: "legacy_history",
  description: "List, search, or read this user's pre-Durable chats with this agent (read-only). Search matches all query words. Use a legacy session ID to read from the start or a search hit's message ID to read around that message. Follow more: lines to continue.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "search", "read"] },
      query: { type: "string", description: "Search words, all required" },
      session: { type: "string", description: "Legacy session or message ID (required for read, optional search restriction)" },
      since: { type: "string", description: "ISO date lower bound" },
      until: { type: "string", description: "ISO date upper bound" },
      limit: { type: "integer", description: "List default 10, search default 15" },
      cursor: { type: "string", description: "List continuation cursor" },
      includeArchived: { type: "boolean", description: "Include archived sessions (default false)" },
      role: { type: "string", enum: ["user", "assistant", "system"], description: "Read only this role" },
      from: { type: "integer", description: "Read starting at this numeric #idx, inclusive" },
      to: { type: "integer", description: "Read through this numeric #idx, inclusive" },
      around: { type: "integer", description: "Read around this numeric #idx" },
      n: { type: "integer", description: "Read this many messages on each side of around (default 5)" },
      full: { type: "integer", description: "Expand one message by numeric #idx" },
    },
    required: ["action"],
  },
};

type Scope = { agentId: string; userId?: string };
type Args = z.infer<typeof argsSchema>;
type SessionFile = Awaited<ReturnType<typeof listAllSessionFiles>>[number];

function sessionRef(agentId: string, sessionId: string): string {
  return `legacy:${agentId}:${sessionId.replaceAll("%", "%25").replaceAll("#", "%23")}`;
}

function parseRef(agentId: string, ref: string) {
  const prefix = `legacy:${agentId}:`;
  if (!ref.startsWith(prefix)) return;
  const match = /^([^#]+)(?:#(\d+))?$/.exec(ref.slice(prefix.length));
  if (!match) return;
  const sessionId = match[1].replace(/%25|%23/g, (escape) => escape === "%25" ? "%" : "#");
  const index = match[2] === undefined ? undefined : Number(match[2]);
  if (index !== undefined && !Number.isSafeInteger(index)) return;
  return { sessionId, index };
}

async function ownSessions({ agentId, userId }: Scope): Promise<SessionFile[]> {
  const configuredIds = [...new Set([agentId, ...getAgents().map((agent) => agent.id)])];
  const byId = new Map<string, SessionFile>();
  for (const file of await listAllSessionFiles(userId, configuredIds)) {
    const { summary, filePath } = file;
    if (summary.agentId !== agentId) continue;
    const previous = byId.get(summary.sessionId);
    if (!previous || summary.createdAt > previous.summary.createdAt ||
      (summary.createdAt === previous.summary.createdAt && filePath > previous.filePath)) {
      byId.set(summary.sessionId, file);
    }
  }
  return [...byId.values()].sort((a, b) => b.summary.lastActivity - a.summary.lastActivity);
}

export async function runLegacyHistory(raw: unknown, { agentId, userId }: Scope) {
  const parsed = argsSchema.safeParse(raw);
  if (!parsed.success) return invalidResult(parsed.error.message);
  const args = parsed.data;
  if (args.tool !== undefined) return invalidResult("legacy_history does not support a tool filter");
  const query = args.query?.trim();
  if (args.action === "search" && !query) return invalidResult("search requires `query`");
  if (args.action === "read" && !args.session) return invalidResult("read requires `session`");

  let since: number | undefined;
  let until: number | undefined;
  try {
    if (args.action !== "read") {
      since = parseDate(args.since, "since");
      until = parseDate(args.until, "until");
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "invalid_input") return invalidResult(error.message);
    throw error;
  }

  const ref = args.action === "list" ? undefined : args.session;
  const target = ref === undefined ? undefined : parseRef(agentId, ref);
  const scoped = (await ownSessions({ agentId, userId })).filter(({ summary }) =>
    (args.includeArchived || summary.archived === null) &&
    (ref === undefined || summary.sessionId === target?.sessionId)
  );
  if (args.action === "read") {
    const [file] = scoped;
    return file ? readSession(file, args, target?.index) : `no such session: ${ref}`;
  }
  if (ref !== undefined && scoped.length === 0) return `no such session: ${ref}`;
  const dated = scoped.filter(({ summary }) =>
    (since === undefined || summary.lastActivity >= since) &&
    (until === undefined || (args.action === "list"
      ? summary.lastActivity <= until
      : summary.createdAt === 0 || summary.createdAt <= until))
  );
  return args.action === "search" && query
    ? searchSessions(dated, query, args.limit ?? 15)
    : listSessions(dated, args);
}

function listSessions(sessions: SessionFile[], args: Args) {
  const limit = args.limit ?? 10;
  const offset = Math.max(0, Number.parseInt(args.cursor ?? "", 10) || 0);
  const lines = sessions.slice(offset, offset + limit).map(({ summary }) => {
    const label = oneLine(summary.title || summary.firstUserMessage);
    const title = label.length > 80 ? label.slice(0, 80) + "…" : label;
    return `${sessionRef(summary.agentId, summary.sessionId)} · ${day(summary.lastActivity)} · ${summary.messageCount} msgs · ${title}`;
  });
  if (lines.length === 0) return "no sessions";
  if (offset + limit < sessions.length) lines.push(`more: list cursor=${offset + limit}`);
  return lines.join("\n");
}

function searchSessions(sessions: SessionFile[], query: string, limit: number): string {
  const lines: string[] = [];
  for (const { summary, raw } of sessions) {
    const ref = sessionRef(summary.agentId, summary.sessionId);
    const label = summary.title || summary.firstUserMessage;
    if (matchSession(label, [], query)) {
      lines.push(`${ref} · ${oneLine(label).slice(0, 160)}`);
    } else {
      const { messages } = parseHistoryJsonl(raw);
      const session = matchSession(label, messages, query);
      if (!session) continue;
      const before = lines.length;
      for (let index = messages.length - 1; index >= 0 && lines.length < limit; index--) {
        const message = messages[index];
        const hit = matchSession("", [message], query);
        if (!hit) continue;
        const role = message.role === "assistant" ? "asst" : message.role;
        const timestamp = Number.isFinite(message.timestamp) ? message.timestamp : summary.lastActivity;
        lines.push(`${ref}#${index} ${role} ${day(timestamp)}  ${hit.snippet}`);
      }
      if (lines.length === before) lines.push(`${ref} · ${session.snippet}`);
    }
    if (lines.length === limit) {
      lines.push(`more: results capped at limit=${limit}; narrow the query or raise limit`);
      break;
    }
  }
  return lines.length ? lines.join("\n") : "no matches";
}

async function readSession({ summary, raw }: SessionFile, args: Args, index?: number): Promise<string> {
  const { messages } = parseHistoryJsonl(raw);
  const around = args.around ?? (args.from === undefined && args.to === undefined ? index : undefined);
  const n = args.n ?? 5;
  return condense(messages, {
    sessionId: sessionRef(summary.agentId, summary.sessionId),
    templates: await readToolLabels(),
    from: around === undefined ? args.from : Math.max(0, around - n),
    to: around === undefined ? args.to : around + n,
    role: args.role,
    full: args.full,
  });
}
