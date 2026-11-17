/** Threadit HTTP client and the JSON shapes the extension reads. */

/** Longest message body the board accepts. */
export const MAX_BODY_CHARS = 19_000;
const REQUEST_TIMEOUT_MS = 30_000;

export type FetchFn = (
  input: string,
  init?: RequestInit
) => Promise<Response>;

export type BoardAccount = { id: number; username: string; account_type: string; email?: string };
export type BoardAttachment = { filename: string };
export type BoardSession = {
  agent: { id: number };
  stop_requested: unknown;
  /** Server-derived: `working`, `stale`, `needs_input`, `error`, `stopping`, and others. */
  state: string;
  /** Id of the newest reply by this agent to the message. */
  reply_id: number | null;
};
export type BoardMessage = {
  id: number;
  thread_id: number;
  author: BoardAccount;
  body: string;
  created_at: string;
  attachments: BoardAttachment[];
  agent_sessions: BoardSession[];
};
export type BoardContext = {
  area: { name: string; description: string | null };
  thread: { title: string };
  target_id: number;
  top_level: BoardMessage[];
  chain: BoardMessage[];
};

/** Server error codes that may appear in logs. Any other code logs as `other`. */
const KNOWN_CODES = new Set([
  "thread_closed",
  "forbidden",
  "not_found",
  "already_finished",
  "unauthorized",
  "validation_error",
  "rate_limited",
  "account_pending",
]);

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: "closed" }
  | { ok: false; kind: "http"; status: number; code: string }
  | { ok: false; kind: "network" }
  | { ok: false; kind: "decode" };

type Failure = Exclude<ApiResult<never>, { ok: true }>;

/** True when the request may have reached the server, so its effect is unknown. */
export function isUncertain(failure: Failure): boolean {
  switch (failure.kind) {
    case "closed":
      return false;
    case "http":
      return failure.status >= 500;
    case "network":
    case "decode":
      return true;
  }
}

/** Short fixed text for logs. It never holds the token or server text. */
export function describeFailure(failure: Failure): string {
  switch (failure.kind) {
    case "closed":
      return "thread closed";
    case "http":
      return `http ${failure.status} ${failure.code}`;
    case "network":
      return "network error";
    case "decode":
      return "unexpected response";
  }
}

function num(value: unknown): number {
  return typeof value === "number" ? value : 0;
}
function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function obj(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}
function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function toAccount(value: unknown): BoardAccount {
  const v = obj(value);
  return {
    id: num(v.id),
    username: str(v.username),
    account_type: str(v.account_type),
    ...(typeof v.email === "string" ? { email: v.email } : {}),
  };
}

export function toSession(value: unknown): BoardSession {
  const v = obj(value);
  return {
    agent: { id: num(obj(v.agent).id) },
    stop_requested: v.stop_requested ?? null,
    state: str(v.state),
    reply_id: typeof v.reply_id === "number" ? v.reply_id : null,
  };
}

export function toMessage(value: unknown): BoardMessage {
  const v = obj(value);
  return {
    id: num(v.id),
    thread_id: num(v.thread_id),
    author: toAccount(v.author),
    body: str(v.body),
    created_at: str(v.created_at),
    attachments: list(v.attachments).map((a) => ({
      filename: str(obj(a).filename),
    })),
    agent_sessions: list(v.agent_sessions).map(toSession),
  };
}

function toContext(value: unknown): BoardContext {
  const v = obj(value);
  const area = obj(v.area);
  return {
    area: {
      name: str(area.name),
      description: typeof area.description === "string" ? area.description : null,
    },
    thread: { title: str(obj(v.thread).title) },
    target_id: num(v.target_id),
    top_level: list(v.top_level).map(toMessage),
    chain: list(v.chain).map(toMessage),
  };
}

/** The session of `agentId` on a message. */
export function sessionOf(
  message: BoardMessage,
  agentId: number
): BoardSession | undefined {
  return message.agent_sessions.find((s) => s.agent.id === agentId);
}

/** True when the session of `agentId` on this message has a stop request. */
export function stopRequestedFor(
  message: BoardMessage,
  agentId: number
): boolean {
  return message.agent_sessions.some(
    (s) => s.agent.id === agentId && s.stop_requested != null
  );
}

export class ThreaditApi {
  readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly token: string,
    private readonly fetchFn: FetchFn = (input, init) => fetch(input, init)
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private async request(
    method: string,
    path: string,
    body?: unknown
  ): Promise<ApiResult<unknown>> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      return { ok: false, kind: "network" };
    }
    let text: string;
    try {
      text = await response.text();
    } catch {
      return { ok: false, kind: "network" };
    }
    if (response.status >= 200 && response.status < 300) {
      if (text.trim() === "") return { ok: true, data: null };
      try {
        return { ok: true, data: JSON.parse(text) as unknown };
      } catch {
        return { ok: false, kind: "decode" };
      }
    }
    let rawCode = "";
    try {
      const code = obj(obj(JSON.parse(text)).error).code;
      rawCode = typeof code === "string" ? code : "";
    } catch {
      rawCode = "";
    }
    const code = KNOWN_CODES.has(rawCode) ? rawCode : "other";
    if (response.status === 409 && code === "thread_closed") {
      return { ok: false, kind: "closed" };
    }
    return { ok: false, kind: "http", status: response.status, code };
  }

  private async get<T>(
    path: string,
    convert: (value: unknown) => T
  ): Promise<ApiResult<T>> {
    const result = await this.request("GET", path);
    return result.ok ? { ok: true, data: convert(result.data) } : result;
  }

  me(): Promise<ApiResult<BoardAccount>> {
    return this.get("/api/me", toAccount);
  }

  users(): Promise<ApiResult<BoardAccount[]>> {
    return this.get("/api/users", (value) => list(obj(value).users).map(toAccount));
  }

  /** One page of attention items, oldest first. */
  attention(
    status: "unacknowledged" | "processing",
    offset: number
  ): Promise<ApiResult<{ items: BoardMessage[]; hasMore: boolean }>> {
    return this.get(
      `/api/attention?status=${status}&order=asc&limit=50&offset=${offset}`,
      (value) => ({
        items: list(obj(value).items).map(toMessage),
        hasMore: obj(value).has_more === true,
      })
    );
  }

  context(messageId: number): Promise<ApiResult<BoardContext>> {
    return this.get(`/api/messages/${messageId}/context`, toContext);
  }

  message(messageId: number): Promise<ApiResult<BoardMessage>> {
    return this.get(`/api/messages/${messageId}`, toMessage);
  }

  async react(messageId: number, emoji: string): Promise<ApiResult<null>> {
    const result = await this.request(
      "POST",
      `/api/messages/${messageId}/reactions`,
      { emoji }
    );
    return result.ok ? { ok: true, data: null } : result;
  }

  /** Post an activity. The response is the own session, which carries `stop_requested`. */
  async activity(
    messageId: number,
    kind: string,
    body: string,
    ephemeral: boolean
  ): Promise<ApiResult<BoardSession>> {
    const result = await this.request(
      "POST",
      `/api/messages/${messageId}/agent-activities`,
      { kind, body, ...(ephemeral ? { ephemeral: true } : {}) }
    );
    return result.ok ? { ok: true, data: toSession(result.data) } : result;
  }

  /** Post a reply. Never retried: a lost response must not post twice. */
  async reply(
    threadId: number,
    parentId: number | null,
    body: string
  ): Promise<ApiResult<null>> {
    const result = await this.request("POST", `/api/threads/${threadId}/messages`, {
      body,
      parent_id: parentId,
    });
    return result.ok ? { ok: true, data: null } : result;
  }
}

/** Split an answer into parts of at most `max` UTF-16 units, preferring line breaks. */
export function splitAnswer(text: string, max: number): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = max;
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    const newline = rest.lastIndexOf("\n", cut - 1);
    const splitAt = newline > cut / 2 ? newline : cut;
    parts.push(rest.slice(0, splitAt).trimEnd());
    rest = rest.slice(splitAt).replace(/^\n+/, "");
  }
  if (rest !== "") parts.push(rest);
  return parts;
}
