import { z } from "zod";
import { day, invalidInput, parseDate, SessionHistoryArgsSchema } from "./arguments.js";
import type {
  Extension,
  ExtensionAgentToolContext,
  FullHistoryMessage,
} from "@yoplai/shared";
import {
  condense,
  matchSnippet,
  messageToolCalls,
  searchableText,
} from "../history/condense.js";
import { CONFIG_DIR, getAgents } from "../config/index.js";
import { ChatProjectStore, isSafeChatProjectId } from "../chat-projects/store.js";
import {
  listAgentSessionSummaries,
  listAllSessionSummaries,
  readSessionProjectId,
  type SessionSummary,
} from "../history/sessions.js";
import { getFullHistory } from "../history/store.js";
import { readToolLabels } from "../maintenance/tool-labels.js";

const CURRENT_SESSION_NOTE =
  "[current session — earlier messages compacted from your context; these are the originals]";
const DEFAULT_LIST_LIMIT = 10;
const DEFAULT_SEARCH_LIMIT = 15;

type Args = z.infer<typeof SessionHistoryArgsSchema>;

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

type Scope = { agentId: string; userId?: string; current?: string; projectId: string | null };

/** Own-agent sessions plus, in a chat project, every agent's sessions tagged with that same project. */
async function scopedSessions(scope: Scope): Promise<SessionSummary[]> {
  if (!scope.projectId) return listAgentSessionSummaries(scope.agentId, scope.userId);
  const ids = [...new Set([scope.agentId, ...getAgents().map((a) => a.id)])];
  const all = await listAllSessionSummaries(scope.userId, ids);
  return all.filter(
    (s) => s.agentId === scope.agentId || s.projectId === scope.projectId
  );
}

function isCurrent(s: SessionSummary, scope: Scope): boolean {
  return s.sessionId === scope.current && s.agentId === scope.agentId;
}

/** Bare id for own-agent sessions; `agent/id` for other agents' project sessions. */
function sessionRef(s: SessionSummary, scope: Scope): string {
  return s.agentId === scope.agentId ? s.sessionId : `${s.agentId}/${s.sessionId}`;
}

function matchesRef(s: SessionSummary, ref: string, scope: Scope): boolean {
  return sessionRef(s, scope) === ref;
}

async function listSessions(args: Args, scope: Scope): Promise<string> {
  const since = parseDate(args.since, "since");
  const until = parseDate(args.until, "until");
  const limit = args.limit ?? DEFAULT_LIST_LIMIT;
  const offset = args.cursor ? Number.parseInt(args.cursor, 10) || 0 : 0;
  const all = (await scopedSessions(scope)).filter(
    (s) =>
      (since === undefined || s.lastActivity >= since) &&
      (until === undefined || s.lastActivity <= until)
  );
  const page = all.slice(offset, offset + limit);
  if (page.length === 0) return "no sessions";
  const lines = page.map((s) => {
    const mark = isCurrent(s, scope) ? "  ★ CURRENT SESSION" : "";
    const first = oneLine(s.title || s.firstUserMessage, 80);
    return `${sessionRef(s, scope)} · ${day(s.lastActivity)} · ${s.messageCount} msgs · ${first}${mark}`;
  });
  if (offset + limit < all.length) {
    lines.push(`more: list cursor=${offset + limit}`);
  }
  return lines.join("\n");
}

function messageMatches(
  message: FullHistoryMessage,
  query: string,
  args: Args,
  since: number | undefined,
  until: number | undefined
): string | null {
  if (message.role === "toolResult") return null;
  if (args.role ? message.role !== args.role : message.role === "system") {
    return null;
  }
  if (since !== undefined && message.timestamp < since) return null;
  if (until !== undefined && message.timestamp > until) return null;
  if (args.tool && !messageToolCalls(message).some((c) => c.name === args.tool)) {
    return null;
  }
  return matchSnippet(searchableText(message), query);
}

async function searchSessions(args: Args, scope: Scope): Promise<string> {
  if (!args.query) throw invalidInput("search requires `query`");
  const since = parseDate(args.since, "since");
  const until = parseDate(args.until, "until");
  const limit = args.limit ?? DEFAULT_SEARCH_LIMIT;
  const sessions = (await scopedSessions(scope)).filter(
    (s) =>
      (!args.session || matchesRef(s, args.session, scope)) &&
      (since === undefined || s.lastActivity >= since) &&
      (until === undefined || s.createdAt <= until || s.createdAt === 0)
  );
  const out: string[] = [];
  let hits = 0;
  for (const session of sessions) {
    if (hits >= limit) break;
    const entries = await getFullHistory(
      session.agentId,
      session.sessionId,
      scope.userId
    );
    const lines: string[] = [];
    for (let i = entries.length - 1; i >= 0 && hits < limit; i--) {
      const snippet = messageMatches(entries[i], args.query, args, since, until);
      if (snippet === null) continue;
      const role = entries[i].role === "assistant" ? "asst" : entries[i].role;
      lines.push(`  #${i} ${role} ${day(entries[i].timestamp)}  ${snippet}`);
      hits++;
    }
    if (lines.length === 0) continue;
    const current = isCurrent(session, scope);
    out.push(`session ${sessionRef(session, scope)}${current ? " ★ CURRENT SESSION" : ""}`);
    if (current) out.push(CURRENT_SESSION_NOTE);
    out.push(...lines.reverse());
  }
  if (out.length === 0) return "no matches";
  if (hits >= limit) out.push(`more: results capped at limit=${limit}; narrow the query or raise limit`);
  return out.join("\n");
}

async function readSession(args: Args, scope: Scope): Promise<string> {
  if (!args.session) throw invalidInput("read requires `session`");
  const target = (await scopedSessions(scope)).find((s) =>
    matchesRef(s, args.session as string, scope)
  );
  if (!target) return `no such session: ${args.session}`;
  const entries = await getFullHistory(target.agentId, target.sessionId, scope.userId);
  const around = args.around;
  const n = args.n ?? 5;
  const text = condense(entries, {
    sessionId: args.session,
    templates: await readToolLabels(),
    from: around !== undefined ? Math.max(0, around - n) : args.from,
    to: around !== undefined ? around + n : args.to,
    role: args.role,
    full: args.full,
  });
  return isCurrent(target, scope) ? `${CURRENT_SESSION_NOTE}\n${text}` : text;
}

/** Current session's project, only if it still exists in this user's store (fail closed). */
async function existingProjectId(
  ctx: Pick<ExtensionAgentToolContext, "agent" | "userId" | "sessionId">
): Promise<string | null> {
  if (!ctx.sessionId) return null;
  const id = await readSessionProjectId(ctx.agent.id, ctx.sessionId, ctx.userId);
  if (!id || !isSafeChatProjectId(id)) return null;
  try {
    return (await new ChatProjectStore(CONFIG_DIR, ctx.userId).get(id)) ? id : null;
  } catch {
    return null;
  }
}

export async function runSessionHistory(
  raw: unknown,
  ctx: Pick<ExtensionAgentToolContext, "agent" | "userId" | "sessionId">
): Promise<string> {
  let args: Args;
  try {
    args = SessionHistoryArgsSchema.parse(raw);
  } catch (error) {
    if (error instanceof z.ZodError) throw invalidInput(error.message);
    throw error;
  }
  const scope: Scope = {
    agentId: ctx.agent.id,
    userId: ctx.userId,
    current: ctx.sessionId,
    projectId: await existingProjectId(ctx),
  };
  if (args.action === "list") return listSessions(args, scope);
  if (args.action === "search") return searchSessions(args, scope);
  return readSession(args, scope);
}

const anchorParameter = { anyOf: [{ type: "number" }, { type: "string" }] };

export const sessionHistoryExtension: Extension = {
  id: "sessionHistory",
  displayName: "Session history",
  description: "Search and read the agent's own past conversations, plus any agent's conversations in the current chat project.",
  factory: true,
  dependencies: [],
  routePrefixes: [],
  configSchema: z.object({}),
  validateConfig: () => ({ valid: true, errors: [] }),
  registerRoutes: () => {},
  async start() {},
  async stop() {},
  capabilities: () => [],
  getAgentTools(_agent, hook) {
    if (hook?.config.sessionHistory?.enabled === false) return [];
    return [
      {
        name: "session_history",
        description:
          "Look up conversation history (read-only). In Durable, list your own Main, search/read across context cuts, and use m_<n> message IDs. In legacy sessions, use numeric #idx anchors. A legacy chat project also includes its agents' sessions under agent/session. action=list: recent conversations. action=search: required case-insensitive substring query (filters: role, since, until, session, limit, and tool in legacy). action=read: required session in legacy. In Durable, session defaults to the current conversation. Condense with from/to or around+n and role. Use full to expand one message. Follow more: lines to continue.",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["list", "search", "read"] },
            query: { type: "string", description: "search: REQUIRED substring to find" },
            session: { type: "string", description: "read: defaults to current in Durable, required in legacy. search: optional session id" },
            role: { type: "string", enum: ["user", "assistant", "system"] },
            tool: { type: "string", description: "search in legacy: only messages calling this tool" },
            since: { type: "string", description: "ISO date lower bound" },
            until: { type: "string", description: "list/search: ISO date upper bound" },
            limit: { type: "number", description: "list default 10, search default 15" },
            cursor: { type: "string", description: "list: continuation cursor" },
            from: { ...anchorParameter, description: "read: first m_<n> ID or numeric #idx, inclusive" },
            to: { ...anchorParameter, description: "read: last m_<n> ID or numeric #idx, inclusive" },
            around: { ...anchorParameter, description: "read: centre m_<n> ID or numeric #idx" },
            n: { type: "number", description: "read: messages each side of around (default 5)" },
            full: { ...anchorParameter, description: "read: expand one m_<n> ID or numeric #idx" },
          },
          required: ["action"],
        },
        execute: (args: unknown, ctx: ExtensionAgentToolContext) =>
          runSessionHistory(args, ctx),
      },
    ];
  },
};
