/**
 * Test doubles for the Mattermost extension: an in-memory Mattermost REST API
 * behind a `fetch` function, a scriptable WebSocket, and an ExtensionContext.
 * Plain TypeScript (no vitest import) so it compiles with the package.
 */
import type {
  DeliverySink,
  ExtensionContext,
  GatewayConfig,
  RunAgentParams,
  RunAgentResult,
} from "@yoplai/shared";
import type { MattermostPost } from "./client.js";
import type { SocketLike } from "./websocket.js";

export const BOT = { id: "botuser00000000000000000001", username: "yoplai" };
export const ALICE = { id: "alice0000000000000000000001", username: "alice" };
export const CHANNEL = "chan00000000000000000000001";
export const OTHER_CHANNEL = "chan00000000000000000000002";
export const DM_CHANNEL = "dmchan000000000000000000001";

export type RecordedRequest = {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
};

type Reply = {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
};

/** An in-memory Mattermost: posts, users, channels, and every request made. */
export class FakeMattermost {
  readonly requests: RecordedRequest[] = [];
  readonly posts = new Map<string, MattermostPost>();
  readonly users = new Map<string, { id: string; username: string }>([
    [BOT.id, BOT],
    [ALICE.id, ALICE],
  ]);
  readonly channels = new Map<
    string,
    {
      id: string;
      type: string;
      name: string;
      display_name: string;
      header?: string;
    }
  >([
    [
      CHANNEL,
      {
        id: CHANNEL,
        type: "O",
        name: "yoplai-test",
        display_name: "Yoplai test",
        header: "Testing",
      },
    ],
    [
      OTHER_CHANNEL,
      {
        id: OTHER_CHANNEL,
        type: "O",
        name: "general",
        display_name: "General",
      },
    ],
    [
      DM_CHANNEL,
      {
        id: DM_CHANNEL,
        type: "D",
        name: `${BOT.id}__${ALICE.id}`,
        display_name: "",
      },
    ],
  ]);
  /** Queue of forced replies, consumed before the normal routes. */
  readonly overrides: Array<{
    match: (method: string, path: string) => boolean;
    reply: Reply;
  }> = [];
  private nextId = 1;

  newId(prefix = "post"): string {
    const n = String(this.nextId++);
    return (prefix + "0".repeat(26)).slice(0, 26 - n.length) + n;
  }

  addPost(
    post: Partial<MattermostPost> & {
      channel_id: string;
      user_id: string;
      message: string;
    }
  ): MattermostPost {
    const full: MattermostPost = {
      id: post.id ?? this.newId("seed"),
      create_at: post.create_at ?? Date.now(),
      root_id: post.root_id ?? "",
      type: "",
      props: {},
      ...post,
    };
    this.posts.set(full.id, full);
    return full;
  }

  /** Posts created through the API (the bot's own), in order. */
  created(): MattermostPost[] {
    return this.requests
      .filter((r) => r.method === "POST" && r.path === "/posts")
      .map((r) => r.body as MattermostPost);
  }

  readonly fetch = async (
    input: string,
    init?: RequestInit
  ): Promise<Response> => {
    const url = new URL(input);
    const path = url.pathname.replace(/^\/api\/v4/, "") + url.search;
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(
        ([k, v]) => [k.toLowerCase(), v]
      )
    );
    let body: unknown = init?.body;
    if (typeof body === "string") body = JSON.parse(body);
    this.requests.push({ method, path, headers, body });

    const override = this.overrides.findIndex((o) => o.match(method, path));
    if (override >= 0) {
      const [{ reply }] = this.overrides.splice(override, 1);
      return json(reply.body ?? {}, reply.status ?? 200, reply.headers);
    }
    if (headers.authorization !== `Bearer ${TOKEN}`) {
      return json(
        {
          id: "api.context.session_expired.app_error",
          message: "Invalid or expired session",
        },
        401
      );
    }
    return this.route(method, path, body);
  };

  private route(method: string, path: string, body: unknown): Response {
    let m: RegExpMatchArray | null;
    if (method === "GET" && path === "/users/me") return json(BOT);
    if (method === "GET" && (m = path.match(/^\/users\/username\/([^/]+)$/))) {
      const user = [...this.users.values()].find(
        (u) => u.username === decodeURIComponent(m![1])
      );
      return user ? json(user) : json({ message: "not found" }, 404);
    }
    if (method === "GET" && (m = path.match(/^\/users\/([^/]+)$/))) {
      const user = this.users.get(m[1]);
      return user ? json(user) : json({ message: "not found" }, 404);
    }
    if (method === "POST" && /^\/users\/[^/]+\/typing$/.test(path))
      return json({ status: "OK" });
    if (
      method === "GET" &&
      (m = path.match(/^\/channels\/([^/?]+)\/posts\?since=(\d+)$/))
    ) {
      const since = Number(m[2]);
      const posts = Object.fromEntries(
        [...this.posts.values()]
          .filter(
            (p) =>
              p.channel_id === m![1] && (p.update_at ?? p.create_at) >= since
          )
          .map((p) => [p.id, p])
      );
      return json({ order: Object.keys(posts), posts });
    }
    if (method === "GET" && (m = path.match(/^\/channels\/([^/]+)$/))) {
      const channel = this.channels.get(m[1]);
      return channel ? json(channel) : json({ message: "not found" }, 404);
    }
    if (method === "POST" && path === "/channels/direct") {
      return json(
        { id: DM_CHANNEL, type: "D", name: "dm", display_name: "" },
        201
      );
    }
    if (method === "GET" && (m = path.match(/^\/posts\/([^/]+)$/))) {
      const post = this.posts.get(m[1]);
      return post ? json(post) : json({ message: "not found" }, 404);
    }
    if (method === "POST" && path === "/posts") {
      const input = body as MattermostPost;
      const post = this.addPost({
        ...input,
        id: this.newId("post"),
        user_id: BOT.id,
        props: { from_bot: "true" },
      });
      return json(post, 201);
    }
    if (method === "POST" && path === "/reactions") return json(body, 201);
    if (
      method === "DELETE" &&
      /^\/users\/[^/]+\/posts\/[^/]+\/reactions\/[^/]+$/.test(path)
    )
      return json({ status: "OK" });
    if (method === "POST" && path === "/files") {
      return json(
        { file_infos: [{ id: this.newId("file"), name: "out.txt" }] },
        201
      );
    }
    if (method === "GET" && /^\/files\/[^/]+$/.test(path)) {
      return new Response(new Uint8Array([104, 105]), { status: 200 });
    }
    return json({ message: `unhandled ${method} ${path}` }, 404);
  }
}

export const TOKEN = "test-token-never-log-me";

function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

// `never[]` so the typed listeners of SocketLike (code: number, err: Error…) fit.
type Listener = (...args: never[]) => void;

/** A WebSocket the test drives: open it, push events, drop it. */
export class FakeSocket implements SocketLike {
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Listener[]>();
  closed = false;
  terminated = false;

  constructor(
    readonly url: string,
    readonly headers: Record<string, string>
  ) {}

  on(event: string, listener: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  private fire(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      (listener as (...values: unknown[]) => void)(...args);
    }
  }

  open(): void {
    this.fire("open");
  }

  hello(connectionId: string, seq = 0): void {
    this.message({
      event: "hello",
      data: { connection_id: connectionId, server_version: "12.0.0" },
      seq,
    });
  }

  message(payload: unknown): void {
    this.fire("message", Buffer.from(JSON.stringify(payload)));
  }

  posted(
    post: MattermostPost,
    seq: number,
    extra: Record<string, unknown> = {}
  ): void {
    this.message({
      event: "posted",
      seq,
      data: {
        post: JSON.stringify(post),
        channel_type: "O",
        channel_display_name: "Yoplai test",
        sender_name: "@alice",
        ...extra,
      },
      broadcast: { channel_id: post.channel_id },
    });
  }

  drop(): void {
    this.fire("close", 1006);
  }

  fail(message: string): void {
    this.fire("error", new Error(message));
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  terminate(): void {
    this.terminated = true;
    this.fire("close", 1006);
  }
}

export class FakeSocketFactory {
  readonly sockets: FakeSocket[] = [];

  readonly create = (
    url: string,
    headers: Record<string, string>
  ): FakeSocket => {
    const socket = new FakeSocket(url, headers);
    this.sockets.push(socket);
    return socket;
  };

  last(): FakeSocket {
    const socket = this.sockets.at(-1);
    if (!socket) throw new Error("no socket created");
    return socket;
  }
}

export type FakeRun = (
  params: RunAgentParams
) => Promise<RunAgentResult> | RunAgentResult;

/** An ExtensionContext whose runAgent is scripted by the test. */
export function buildFakeContext(options: {
  config: GatewayConfig;
  dataDir: string;
  run?: FakeRun;
  sessions?: Set<string>;
}): ExtensionContext & {
  runs: RunAgentParams[];
  sinks: Map<string, DeliverySink>;
  media: Map<string, Uint8Array>;
} {
  const runs: RunAgentParams[] = [];
  const sinks = new Map<string, DeliverySink>();
  const sessions = options.sessions ?? new Set<string>();
  const media = new Map<string, Uint8Array>();
  let sessionCounter = 0;
  const run: FakeRun =
    options.run ??
    (() => ({
      payloads: [{ text: "agent-ok" }],
      meta: { durationMs: 1, sessionId: "s" },
    }));

  return {
    runs,
    sinks,
    media,
    getConfig: () => options.config,
    getDataDir: () => options.dataDir,
    reloadConfig: () => undefined,
    getAgent: (id: string) =>
      options.config.agents.find((agent) => agent.id === id),
    getAgents: () => options.config.agents,
    isAgentActive: () => true,
    isAgentStreaming: () => false,
    resolveWorkspaceDir: () => options.dataDir,
    runAgent: async (params: RunAgentParams) => {
      runs.push(params);
      return run(params);
    },
    getSubagentTemplates: () => [],
    resolveSessionId: async () => undefined,
    getSessionEntry: async () => undefined,
    hasSession: async (_agentId: string, sessionId: string) =>
      sessions.has(sessionId),
    resetSession: async () => {},
    ensureSession: async (_agentId: string, sessionKey: string) => {
      const sessionId = `session-${++sessionCounter}-${sessionKey}`;
      sessions.add(sessionId);
      return { sessionId, updatedAt: Date.now() };
    },
    clearSessionEntry: async (_agentId: string, sessionKey: string) => ({
      sessionId: `cleared-${sessionKey}`,
      updatedAt: 0,
    }),
    restoreSessionUpdatedAt: () => undefined,
    deleteSession: () => undefined,
    invalidateHistoryCache: async () => undefined,
    getSessionHistory: async () => [],
    saveMediaFile: async (
      data: Uint8Array | ArrayBuffer,
      mimeType: string,
      filename?: string
    ) => {
      const path = `/media/${filename ?? "file"}`;
      media.set(path, new Uint8Array(data as ArrayBuffer));
      return { path, mimeType, filename };
    },
    readMediaFile: async (fileId: string) => ({
      data: new Uint8Array([1, 2, 3]),
      filename: `${fileId}.txt`,
      mimeType: "text/plain",
      size: 3,
    }),
    registerDeliverySink: (id: string, sink: DeliverySink) => {
      sinks.set(id, sink);
      return () => {
        sinks.delete(id);
      };
    },
    getDeliverySink: (id: string) => sinks.get(id),
    subscribe: () => () => undefined,
    emit: () => undefined,
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  } as unknown as ExtensionContext & {
    runs: RunAgentParams[];
    sinks: Map<string, DeliverySink>;
    media: Map<string, Uint8Array>;
  };
}

/** Wait until queued promise callbacks (fire-and-forget handlers) settle. */
export async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++)
    await new Promise((resolve) => setImmediate(resolve));
}
