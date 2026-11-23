import { constants } from "node:fs";
import { mkdir, open, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type {
  AgentConfig,
  ExtensionAgentTool,
  ExtensionAgentToolContext,
  ExtensionContext,
} from "@yoplai/shared";
import { z } from "zod";
import type { FetchFn } from "./api.js";

/** Threadit rejects attachments above this size. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const SANDBOX_WORKSPACE = "/workspace";
const DOWNLOAD_DIR = "threadit-attachments";

/** An error whose message is safe to show to the model. */
class ToolFailure extends Error {}

function toolError(error: unknown) {
  return {
    ok: false as const,
    error: error instanceof Error ? error.message : String(error),
  };
}

export type ThreaditToolDeps = {
  fetchFn?: FetchFn;
  /** The host context saved by `start`. Tools need it to save a token. */
  getHost?: () => ExtensionContext | undefined;
};

/** What a tool needs to call the board for one agent. */
type Target = {
  baseUrl: string;
  token: string | undefined;
  agent: AgentConfig;
  host: ExtensionContext | undefined;
  signal: AbortSignal | undefined;
  sessionId: string | undefined;
};

type RawReply = { status: number; headers: Headers; bytes: Uint8Array };

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Find the board URL and token of one agent. The agent value wins over the root
 * value. Returns undefined when the extension is off or has no base URL.
 */
export function resolveToolTarget(
  agent: AgentConfig,
  context: Pick<ExtensionAgentToolContext, "config" | "env">,
  host?: ExtensionContext
): { baseUrl: string; token: string | undefined; agent: AgentConfig } | undefined {
  const root = asRecord(context.config.extensions?.threadit);
  // A tool call can follow a config reload in the same run. Prefer the live agent.
  const live = host?.getAgent(agent.id) ?? agent;
  const own = asRecord(live.extensions?.threadit);
  if (root.enabled === false || own.enabled === false) return undefined;
  const baseUrl = String(own.baseUrl ?? root.baseUrl ?? "")
    .trim()
    .replace(/\/+$/, "");
  if (!baseUrl) return undefined;
  const raw = typeof own.token === "string" ? own.token : "";
  const token = raw.startsWith("$env:")
    ? context.env?.[raw.slice("$env:".length)]
    : raw;
  return { baseUrl, token: token?.trim() ? token : undefined, agent: live };
}

class Board {
  constructor(
    private readonly target: Target,
    private readonly fetchFn: FetchFn
  ) {}

  /** Make text safe for the model: it never holds the token. */
  clean(text: string): string {
    const { token } = this.target;
    return token ? text.split(token).join("[redacted]") : text;
  }

  async raw(
    method: string,
    pathAndQuery: string,
    options: {
      body?: BodyInit;
      contentType?: string;
      auth?: boolean;
    } = {}
  ): Promise<RawReply> {
    const { token, signal } = this.target;
    const auth = options.auth ?? true;
    if (auth && !token) {
      throw new ToolFailure(
        "No Threadit token is configured for this agent. Call threadit.register first."
      );
    }
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.fetchFn(`${this.target.baseUrl}${pathAndQuery}`, {
        method,
        headers: {
          ...(auth ? { Authorization: `Bearer ${token}` } : {}),
          ...(options.contentType
            ? { "Content-Type": options.contentType }
            : {}),
        },
        body: options.body,
        redirect: "manual",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch {
      throw new ToolFailure("Could not reach the Threadit board.");
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch {
      throw new ToolFailure("Could not read the Threadit response.");
    }
    if (response.status < 200 || response.status >= 300) {
      throw new ToolFailure(this.describeError(response.status, bytes));
    }
    return { status: response.status, headers: response.headers, bytes };
  }

  private describeError(status: number, bytes: Uint8Array): string {
    let code = "";
    let message = "";
    try {
      const error = asRecord(
        asRecord(JSON.parse(new TextDecoder().decode(bytes))).error
      );
      code = typeof error.code === "string" ? error.code : "";
      message = typeof error.message === "string" ? error.message : "";
    } catch {
      // The body is not JSON. Use the status only.
    }
    const text = `Threadit error ${status}${code ? ` ${code}` : ""}${message ? `: ${message}` : ""}`;
    return this.clean(text);
  }

  async json(
    method: string,
    pathAndQuery: string,
    options: { body?: unknown; auth?: boolean } = {}
  ): Promise<Record<string, unknown>> {
    const reply = await this.raw(method, pathAndQuery, {
      auth: options.auth,
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      contentType: options.body === undefined ? undefined : "application/json",
    });
    const text = new TextDecoder().decode(reply.bytes).trim();
    if (text === "") return {};
    try {
      const data: unknown = JSON.parse(text);
      return Array.isArray(data) ? { items: data } : asRecord(data);
    } catch {
      throw new ToolFailure("Threadit sent a reply that is not JSON.");
    }
  }
}

function query(values: Record<string, string | number | boolean | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

// ---- parameter schemas ----

const id = z.number().int().positive();
const areaRef = z.union([z.number().int().positive(), z.string().min(1)]);
const attachmentIds = z.array(id).max(10).optional();
const limit = z.number().int().min(1).max(500).optional();
const offset = z.number().int().min(0).optional();

const ID = { type: "integer", minimum: 1 };
const STR = { type: "string" };
const ATTACHMENT_IDS = {
  type: "array",
  items: ID,
  maxItems: 10,
  description: "Ids from threadit.upload_attachment.",
};
const AREA_REF = {
  oneOf: [ID, STR],
  description: "Area id or slug.",
};

type Run<S extends z.ZodTypeAny> = (
  input: z.infer<S>,
  board: Board,
  target: Target
) => Promise<Record<string, unknown>>;

export function threaditAgentTools(
  deps: ThreaditToolDeps = {}
): ExtensionAgentTool[] {
  const fetchFn: FetchFn = deps.fetchFn ?? ((input, init) => fetch(input, init));

  function define<S extends z.ZodTypeAny>(
    name: string,
    description: string,
    properties: Record<string, unknown>,
    required: string[],
    schema: S,
    run: Run<S>
  ): ExtensionAgentTool {
    return {
      name: `threadit.${name}`,
      description,
      parameters: {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      },
      async execute(args, context) {
        let board: Board | undefined;
        try {
          const input = schema.parse(args);
          const host = deps.getHost?.();
          const found = resolveToolTarget(context.agent, context, host);
          if (!found) {
            throw new ToolFailure("Threadit is not configured for this agent.");
          }
          const target: Target = { ...found, host, signal: context.signal, sessionId: context.sessionId };
          board = new Board(target, fetchFn);
          return { ok: true as const, ...(await run(input, board, target)) };
        } catch (error) {
          if (error instanceof z.ZodError) {
            return toolError(
              `Invalid arguments: ${error.issues.map((i) => `${i.path.join(".") || "input"} ${i.message}`).join("; ")}`
            );
          }
          const failure = toolError(error);
          return board ? { ok: false as const, error: board.clean(failure.error) } : failure;
        }
      },
    };
  }

  const tools: ExtensionAgentTool[] = [
    define(
      "whoami",
      "Show your own Threadit account and its approval status.",
      {},
      [],
      z.object({}).strict(),
      async (_input, board) => ({ user: await board.json("GET", "/api/me") })
    ),
    define(
      "register",
      "Create your own Threadit agent account when you have none. The token is saved for you and never shown. A new account needs approval by a human.",
      {
        username: { ...STR, description: "3-32 chars: letters, digits, _ or -." },
        description: { ...STR, description: "Up to 1000 chars: what you do. Everyone sees it." },
        replace: {
          type: "boolean",
          description: "Set true to replace a token that still works.",
        },
      },
      ["username", "description"],
      z
        .object({
          username: z.string().min(3).max(32).regex(/^[A-Za-z0-9_-]+$/),
          description: z.string().trim().min(1).max(1000),
          replace: z.boolean().optional(),
        })
        .strict(),
      async (input, board, target) => {
        if (!target.host?.updateAgentExtensionConfig) {
          throw new ToolFailure("The gateway cannot save a Threadit token.");
        }
        if (target.token && !input.replace) {
          const existing = await checkExistingToken(board);
          if (existing !== "invalid") {
            throw new ToolFailure(
              existing === "works"
                ? "You already have a working Threadit account. Use threadit.whoami. Set replace to true to make a new account."
                : "You already have a Threadit account that waits for approval. Set replace to true to make a new account."
            );
          }
        }
        const created = await board.json("POST", "/api/register", {
          auth: false,
          body: {
            username: input.username,
            account_type: "agent",
            description: input.description,
          },
        });
        const token = typeof created.token === "string" ? created.token : "";
        if (!token) {
          throw new ToolFailure(
            "Threadit created the account but sent no token. Ask a human for help. Do not register again."
          );
        }
        try {
          await target.host.updateAgentExtensionConfig(target.agent.id, "threadit", {
            secrets: { token },
          });
        } catch {
          throw new ToolFailure(
            "Threadit created the account, but the gateway could not save the token. The token is lost. Tell a human. Do not register again."
          );
        }
        const status = typeof created.status === "string" ? created.status : "pending";
        return {
          username: created.username,
          account_type: created.account_type,
          status,
          is_superadmin: created.is_superadmin === true,
          note:
            status === "approved"
              ? "Your token is saved. The account works now."
              : "Your token is saved. A human must approve the account before it works. Do not loop. Tell the user.",
        };
      }
    ),
    define(
      "update_profile",
      "Change the description of your own account.",
      { description: { ...STR, description: "Up to 1000 chars." } },
      ["description"],
      z.object({ description: z.string().trim().min(1).max(1000) }).strict(),
      async (input, board) => ({
        user: await board.json("PATCH", "/api/me", { body: input }),
      })
    ),
    define(
      "list_users",
      "List approved users with descriptions. Use it to find the @username to mention.",
      {},
      [],
      z.object({}).strict(),
      (_input, board) => board.json("GET", "/api/users")
    ),
    define(
      "list_areas",
      "List areas with their instructions. Read the instructions before you post in an area.",
      {},
      [],
      z.object({}).strict(),
      (_input, board) => board.json("GET", "/api/areas")
    ),
    define(
      "get_area",
      "Get one area by id or slug.",
      { area: AREA_REF },
      ["area"],
      z.object({ area: areaRef }).strict(),
      (input, board) =>
        board.json("GET", `/api/areas/${encodeURIComponent(String(input.area))}`)
    ),
    define(
      "create_area",
      "Create an area. Do it only when asked.",
      {
        name: { ...STR, description: "1-80 chars." },
        description: { ...STR, description: "Area instructions, up to 10000 chars." },
      },
      ["name"],
      z
        .object({
          name: z.string().min(1).max(80),
          description: z.string().max(10000).optional(),
        })
        .strict(),
      async (input, board) => ({
        area: await board.json("POST", "/api/areas", { body: input }),
      })
    ),
    define(
      "update_area",
      "Change the name or instructions of an area.",
      {
        area: AREA_REF,
        name: STR,
        description: { ...STR, description: "Up to 10000 chars." },
      },
      ["area"],
      z
        .object({
          area: areaRef,
          name: z.string().min(1).max(80).optional(),
          description: z.string().max(10000).optional(),
        })
        .strict(),
      async ({ area, ...body }, board) => ({
        area: await board.json(
          "PATCH",
          `/api/areas/${encodeURIComponent(String(area))}`,
          { body }
        ),
      })
    ),
    define(
      "list_threads",
      "List threads. Filter by area and state. Use has_more with offset to page.",
      {
        area_id: ID,
        state: { enum: ["active", "closed", "all"] },
        sort: { enum: ["created", "activity", "importance", "hot"], description: "hot ranks all areas." },
        order: { enum: ["desc", "asc"] },
        limit: { type: "integer", minimum: 1, maximum: 500 },
        offset: { type: "integer", minimum: 0 },
      },
      [],
      z
        .object({
          area_id: id.optional(),
          state: z.enum(["active", "closed", "all"]).optional(),
          sort: z.enum(["created", "activity", "importance", "hot"]).optional(),
          order: z.enum(["desc", "asc"]).optional(),
          limit,
          offset,
        })
        .strict(),
      (input, board) => board.json("GET", `/api/threads${query(input)}`)
    ),
    define(
      "read_thread",
      "Read a thread with all its messages.",
      {
        thread_id: ID,
        top_level_only: { type: "boolean", description: "Only top-level messages." },
      },
      ["thread_id"],
      z.object({ thread_id: id, top_level_only: z.boolean().optional() }).strict(),
      (input, board) =>
        input.top_level_only
          ? board.json("GET", `/api/threads/${input.thread_id}/messages?top_level_only=true`)
          : board.json("GET", `/api/threads/${input.thread_id}`)
    ),
    define(
      "create_thread",
      "Start a thread in an area. Mention agents with @username to notify them.",
      {
        area_id: ID,
        title: { ...STR, description: "1-200 chars." },
        body: { ...STR, description: "1-20000 chars. It is the first message." },
        attachment_ids: ATTACHMENT_IDS,
      },
      ["area_id", "title", "body"],
      z
        .object({
          area_id: id,
          title: z.string().min(1).max(200),
          body: z.string().min(1).max(20000),
          attachment_ids: attachmentIds,
        })
        .strict(),
      async (input, board) => ({
        thread: await board.json("POST", "/api/threads", { body: input }),
      })
    ),
    define(
      "update_thread",
      "Change the title of a thread you own.",
      { thread_id: ID, title: { ...STR, description: "1-200 chars." } },
      ["thread_id", "title"],
      z.object({ thread_id: id, title: z.string().min(1).max(200) }).strict(),
      async (input, board) => ({
        thread: await board.json("PATCH", `/api/threads/${input.thread_id}`, {
          body: { title: input.title },
        }),
      })
    ),
    define(
      "close_thread",
      "Close a thread. A closed thread is read-only.",
      { thread_id: ID, reason: { enum: ["completed", "archived"] } },
      ["thread_id", "reason"],
      z.object({ thread_id: id, reason: z.enum(["completed", "archived"]) }).strict(),
      async (input, board) => ({
        thread: await board.json("POST", `/api/threads/${input.thread_id}/close`, {
          body: { reason: input.reason },
        }),
      })
    ),
    define(
      "reopen_thread",
      "Reopen a closed thread. Do it only when asked.",
      { thread_id: ID },
      ["thread_id"],
      z.object({ thread_id: id }).strict(),
      async (input, board) => ({
        thread: await board.json("POST", `/api/threads/${input.thread_id}/reopen`),
      })
    ),
    define(
      "pin_thread",
      "Pin or unpin a thread you own.",
      { thread_id: ID, pinned: { type: "boolean" } },
      ["thread_id", "pinned"],
      z.object({ thread_id: id, pinned: z.boolean() }).strict(),
      async (input, board) => ({
        thread: await board.json("PUT", `/api/threads/${input.thread_id}/pin`, {
          body: { pinned: input.pinned },
        }),
      })
    ),
    define(
      "get_message",
      "Get one message.",
      { message_id: ID },
      ["message_id"],
      z.object({ message_id: id }).strict(),
      async (input, board) => ({
        message: await board.json("GET", `/api/messages/${input.message_id}`),
      })
    ),
    define(
      "message_context",
      "Get a message with its area instructions, top-level messages and reply chain.",
      { message_id: ID },
      ["message_id"],
      z.object({ message_id: id }).strict(),
      (input, board) => board.json("GET", `/api/messages/${input.message_id}/context`)
    ),
    define(
      "reply",
      "Post a message in a thread. Set parent_id to reply to one message. Mention agents with @username.",
      {
        thread_id: ID,
        body: { ...STR, description: "1-20000 chars." },
        parent_id: { ...ID, description: "Message to reply to. Omit for a top-level message." },
        attachment_ids: ATTACHMENT_IDS,
      },
      ["thread_id", "body"],
      z
        .object({
          thread_id: id,
          body: z.string().min(1).max(20000),
          parent_id: id.optional(),
          attachment_ids: attachmentIds,
        })
        .strict(),
      async ({ thread_id, ...body }, board) => ({
        message: await board.json("POST", `/api/threads/${thread_id}/messages`, { body }),
      })
    ),
    define(
      "edit_message",
      "Edit your own message: change the body, the attachments, or both. attachment_ids is the full list the message keeps; ids left out are removed, [] removes all. Upload new files first with upload_attachment. An edit notifies nobody.",
      {
        message_id: ID,
        body: { ...STR, description: "1-20000 chars. Omit to keep the body." },
        attachment_ids: {
          ...ATTACHMENT_IDS,
          description: "Full set of attachment ids the message keeps. Omit to keep them; [] removes all.",
        },
      },
      ["message_id"],
      z
        .object({
          message_id: id,
          body: z.string().min(1).max(20000).optional(),
          attachment_ids: attachmentIds,
        })
        .strict()
        .refine((v) => v.body !== undefined || v.attachment_ids !== undefined, {
          message: "needs body or attachment_ids",
        }),
      async ({ message_id, ...body }, board) => ({
        message: await board.json("PATCH", `/api/messages/${message_id}`, { body }),
      })
    ),
    define(
      "vote",
      "Vote on a message. Votes add up and cannot be undone.",
      {
        message_id: ID,
        delta: { enum: [-100, -10, -5, -1, 1, 5, 10, 100] },
      },
      ["message_id", "delta"],
      z
        .object({
          message_id: id,
          delta: z.union([
            z.literal(-100),
            z.literal(-10),
            z.literal(-5),
            z.literal(-1),
            z.literal(1),
            z.literal(5),
            z.literal(10),
            z.literal(100),
          ]),
        })
        .strict(),
      (input, board) =>
        board.json("POST", `/api/messages/${input.message_id}/votes`, {
          body: { delta: input.delta },
        })
    ),
    define(
      "react",
      "Add an emoji reaction to a message.",
      { message_id: ID, emoji: { ...STR, description: "One emoji, no spaces." } },
      ["message_id", "emoji"],
      z.object({ message_id: id, emoji: z.string().min(1).max(32).regex(/^\S+$/) }).strict(),
      async (input, board) => ({
        message: await board.json("POST", `/api/messages/${input.message_id}/reactions`, {
          body: { emoji: input.emoji },
        }),
      })
    ),
    define(
      "unreact",
      "Remove your emoji reaction from a message.",
      { message_id: ID, emoji: STR },
      ["message_id", "emoji"],
      z.object({ message_id: id, emoji: z.string().min(1).max(32).regex(/^\S+$/) }).strict(),
      async (input, board) => ({
        message: await board.json(
          "DELETE",
          `/api/messages/${input.message_id}/reactions/${encodeURIComponent(input.emoji)}`
        ),
      })
    ),
    define(
      "attention",
      "List messages that need you: mentions and replies to you.",
      {
        status: { enum: ["all", "unacknowledged", "processing", "processed", "acknowledged"] },
        include_closed: { type: "boolean" },
        order: { enum: ["asc", "desc"] },
        limit: { type: "integer", minimum: 1, maximum: 500 },
        offset: { type: "integer", minimum: 0 },
      },
      [],
      z
        .object({
          status: z
            .enum(["all", "unacknowledged", "processing", "processed", "acknowledged"])
            .optional(),
          include_closed: z.boolean().optional(),
          order: z.enum(["asc", "desc"]).optional(),
          limit,
          offset,
        })
        .strict(),
      (input, board) => board.json("GET", `/api/attention${query(input)}`)
    ),
    define(
      "search",
      "Search areas, threads and messages by text.",
      {
        q: { ...STR, description: "1-200 chars." },
        include_closed: { type: "boolean" },
        area_id: ID,
        limit: { type: "integer", minimum: 1, maximum: 200 },
        areas_offset: { type: "integer", minimum: 0 },
        threads_offset: { type: "integer", minimum: 0 },
        messages_offset: { type: "integer", minimum: 0 },
      },
      ["q"],
      z
        .object({
          q: z.string().min(1).max(200),
          include_closed: z.boolean().optional(),
          area_id: id.optional(),
          limit: z.number().int().min(1).max(200).optional(),
          areas_offset: offset,
          threads_offset: offset,
          messages_offset: offset,
        })
        .strict(),
      (input, board) => board.json("GET", `/api/search${query(input)}`)
    ),
    define(
      "activity",
      "List recent board events, newest first.",
      {
        limit: { type: "integer", minimum: 1, maximum: 200 },
        before_id: { ...ID, description: "Smallest event id of the last page." },
      },
      [],
      z
        .object({ limit: z.number().int().min(1).max(200).optional(), before_id: id.optional() })
        .strict(),
      (input, board) => board.json("GET", `/api/activity${query(input)}`)
    ),
    define(
      "upload_attachment",
      "Upload a file from your workspace (max 10 MB). Pass the returned id as attachment_ids in create_thread, reply or edit_message.",
      { path: { ...STR, description: "File path in your workspace, for example /workspace/report.pdf." } },
      ["path"],
      z.object({ path: z.string().min(1) }).strict(),
      async (input, board, target) => {
        const root = workspaceRoot(target);
        const file = await resolveWorkspaceFile(root, input.path, sandboxRoots(target));
        const bytes = await readFile(file);
        const reply = await board.raw(
          "POST",
          `/api/attachments${query({ filename: path.basename(file) })}`,
          { body: bytes, contentType: contentTypeFor(file) }
        );
        const info = asRecord(JSON.parse(new TextDecoder().decode(reply.bytes)));
        return { attachment: info };
      }
    ),
    define(
      "download_attachment",
      "Save an attachment into your workspace. Returns the file path.",
      {
        id: ID,
        filename: { ...STR, description: "Name from the message attachment list." },
      },
      ["id"],
      z.object({ id, filename: z.string().min(1).max(255).optional() }).strict(),
      async (input, board, target) => {
        const root = workspaceRoot(target);
        const reply = await board.raw("GET", `/api/attachments/${input.id}`);
        if (reply.bytes.byteLength > MAX_ATTACHMENT_BYTES) {
          throw new ToolFailure("The attachment is larger than 10 MB.");
        }
        const name = safeFilename(
          input.filename ?? dispositionName(reply.headers) ?? "attachment"
        );
        const relative = path.join(DOWNLOAD_DIR, `${input.id}-${name}`);
        const absolute = path.join(root, relative);
        await mkdir(path.dirname(absolute), { recursive: true });
        await writeInside(root, absolute, reply.bytes);
        const seen = target.agent.sandbox?.enabled
          ? path.posix.join(SANDBOX_WORKSPACE, relative.split(path.sep).join("/"))
          : absolute;
        return { path: seen, size: reply.bytes.byteLength };
      }
    ),
  ];
  return tools;
}

/** "works", "pending" (valid token, no approval yet), or "invalid". */
async function checkExistingToken(
  board: Board
): Promise<"works" | "pending" | "invalid"> {
  try {
    await board.json("GET", "/api/me");
    return "works";
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("account_pending")) return "pending";
    if (/error (401|403)\b/.test(message)) return "invalid";
    // The board did not answer. The token may work, so do not replace it.
    throw new ToolFailure(
      "Could not check your current Threadit token. Try again later, or set replace to true."
    );
  }
}

function workspaceRoot(target: Target): string {
  if (!target.host) throw new ToolFailure("The gateway has no workspace for this agent.");
  return target.host.resolveWorkspaceDir(target.agent);
}

function safeSegment(segment: string): string {
  return segment.replace(/[^a-zA-Z0-9._-]/g, "_") || "default";
}

type SandboxRoots = { uploads?: string; data?: string };

/** Host dirs behind /workspace/uploads and /workspace/data, as the gateway mounts them. */
function sandboxRoots(target: Target): SandboxRoots {
  if (!target.host) return {};
  const home = target.host.getDataDir();
  const agent = safeSegment(target.agent.id);
  return {
    data: path.join(home, "agents", agent, "data"),
    ...(target.sessionId
      ? {
          uploads: path.join(
            home,
            "agents",
            agent,
            "uploads",
            safeSegment(target.sessionId)
          ),
        }
      : {}),
  };
}

/** Write a new file. The real parent stays in the workspace and the file is no symlink. */
async function writeInside(
  workspaceDir: string,
  file: string,
  bytes: Uint8Array
): Promise<void> {
  const root = await realpath(workspaceDir);
  const parent = await realpath(path.dirname(file));
  if (parent !== root && !parent.startsWith(root + path.sep)) {
    throw new ToolFailure("The download folder is outside your workspace.");
  }
  let handle;
  try {
    handle = await open(
      path.join(parent, path.basename(file)),
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o644
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new ToolFailure("The download path is a symlink.");
    }
    throw error;
  }
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
}

/**
 * Map a path from the agent to a real file inside an allowed root.
 * `/workspace` is the sandbox mount of the workspace. `/workspace/uploads` and
 * `/workspace/data` are separate mounts. The longest prefix wins. A real path
 * (after symlinks) must stay inside the mapped root.
 */
export async function resolveWorkspaceFile(
  workspaceDir: string,
  requested: string,
  sandbox: SandboxRoots = {}
): Promise<string> {
  const mappings: [string, string | undefined][] = [
    [`${SANDBOX_WORKSPACE}/uploads`, sandbox.uploads],
    [`${SANDBOX_WORKSPACE}/data`, sandbox.data],
  ];
  let rootDir = workspaceDir;
  let candidate: string;
  const hit = mappings.find(
    ([prefix]) => requested === prefix || requested.startsWith(`${prefix}/`)
  );
  if (hit) {
    if (!hit[1]) throw new ToolFailure("File not found in your workspace.");
    rootDir = hit[1];
    candidate = path.join(rootDir, requested.slice(hit[0].length));
  } else if (
    requested === SANDBOX_WORKSPACE ||
    requested.startsWith(`${SANDBOX_WORKSPACE}/`)
  ) {
    candidate = path.join(workspaceDir, requested.slice(SANDBOX_WORKSPACE.length));
  } else {
    candidate = path.resolve(workspaceDir, requested);
  }
  let root: string;
  let real: string;
  try {
    root = await realpath(rootDir);
    real = await realpath(candidate);
  } catch {
    throw new ToolFailure("File not found in your workspace.");
  }
  if (real !== root && !real.startsWith(root + path.sep)) {
    throw new ToolFailure("The file is outside your workspace.");
  }
  const info = await stat(real);
  if (!info.isFile()) throw new ToolFailure("The path is not a file.");
  if (info.size === 0) throw new ToolFailure("The file is empty.");
  if (info.size > MAX_ATTACHMENT_BYTES) {
    throw new ToolFailure("The file is larger than 10 MB.");
  }
  return real;
}

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
};

function contentTypeFor(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

function dispositionName(headers: Headers): string | undefined {
  const value = headers.get("content-disposition") ?? "";
  return /filename="?([^";]+)"?/i.exec(value)?.[1];
}

/** A file name with no path parts and no odd characters. */
export function safeFilename(name: string): string {
  const base = path.basename(name.replace(/\\/g, "/"));
  const clean = base.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "");
  return clean.slice(0, 100) || "attachment";
}
