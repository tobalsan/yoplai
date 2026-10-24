import WebSocket from "ws";

/**
 * Mattermost event stream over `/api/v4/websocket`.
 *
 * The connection is re-opened with an exponential backoff after any drop.
 * Mattermost's own resume protocol is used on reconnect: the client sends back
 * the `connection_id` from the last `hello` and the next expected
 * `sequence_number`, and the server replays the events it still holds. When
 * the server cannot (restart, long outage) it answers with a new
 * `connection_id`; `onReconnect` then reports `resumed: false` so the bot can
 * fetch the posts it missed over REST.
 */

export type MattermostSocketEvent = {
  event: string;
  data?: Record<string, unknown>;
  broadcast?: {
    channel_id?: string;
    user_id?: string;
    team_id?: string;
  };
  seq?: number;
};

/** The subset of a `ws` socket this module needs, so tests can fake it. */
export type SocketLike = {
  on(event: "open", listener: () => void): unknown;
  on(event: "message", listener: (data: unknown) => void): unknown;
  on(event: "close", listener: (code: number) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  send(data: string): void;
  close(): void;
  terminate(): void;
};

export type SocketFactory = (
  url: string,
  headers: Record<string, string>
) => SocketLike;

export type ReconnectInfo = {
  /** True when the server replayed what was missed; false means a gap. */
  resumed: boolean;
  /** When the previous connection dropped (epoch ms). */
  disconnectedAt: number;
};

export type MattermostSocketOptions = {
  baseUrl: string;
  token: string;
  logPrefix: string;
  onEvent: (event: MattermostSocketEvent) => void;
  onReconnect?: (info: ReconnectInfo) => void;
  createSocket?: SocketFactory;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  /** Ping cadence; the connection is dropped after `idleTimeoutMs` of silence. */
  pingIntervalMs?: number;
  idleTimeoutMs?: number;
  random?: () => number;
};

const DEFAULT_INITIAL_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 60_000;
const DEFAULT_PING_INTERVAL_MS = 30_000;
const DEFAULT_IDLE_TIMEOUT_MS = 75_000;

const defaultSocketFactory: SocketFactory = (url, headers) =>
  new WebSocket(url, { headers }) as unknown as SocketLike;

/** Exponential backoff with ±20% jitter so several bots do not reconnect in step. */
export function backoffDelay(
  attempt: number,
  initialMs: number,
  maxMs: number,
  random: () => number = Math.random
): number {
  const base = Math.min(maxMs, initialMs * 2 ** Math.max(0, attempt - 1));
  const jitter = 1 + (random() * 0.4 - 0.2);
  return Math.round(Math.min(maxMs, base * jitter));
}

export function websocketUrl(baseUrl: string): string {
  return baseUrl.replace(/^http/i, "ws") + "/api/v4/websocket";
}

export class MattermostSocket {
  private socket: SocketLike | undefined;
  private stopped = true;
  private attempt = 0;
  private connectionId = "";
  private nextSequence = 0;
  private disconnectedAt: number | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private lastTrafficAt = 0;
  private pingSeq = 1;
  private firstHello:
    | { resolve: () => void; reject: (err: Error) => void }
    | undefined;

  constructor(private readonly options: MattermostSocketOptions) {}

  /** Resolves on the first `hello`; rejects if that first connection fails. */
  start(): Promise<void> {
    this.stopped = false;
    return new Promise((resolve, reject) => {
      this.firstHello = { resolve, reject };
      this.connect();
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.stopPing();
    const socket = this.socket;
    this.socket = undefined;
    try {
      socket?.close();
    } catch {
      // Already closed.
    }
  }

  private connect(): void {
    if (this.stopped) return;
    let url = websocketUrl(this.options.baseUrl);
    if (this.connectionId) {
      url += `?connection_id=${encodeURIComponent(this.connectionId)}&sequence_number=${this.nextSequence}`;
    }
    const factory = this.options.createSocket ?? defaultSocketFactory;
    let socket: SocketLike;
    try {
      socket = factory(url, { Authorization: `Bearer ${this.options.token}` });
    } catch (err) {
      this.handleClose(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    this.socket = socket;
    let closed = false;
    const onGone = (err?: Error) => {
      if (closed) return;
      closed = true;
      if (this.socket === socket) this.socket = undefined;
      this.handleClose(err);
    };

    socket.on("open", () => {
      this.lastTrafficAt = Date.now();
      this.startPing(socket);
    });
    socket.on("message", (raw) => {
      if (this.socket !== socket) return;
      this.lastTrafficAt = Date.now();
      this.handleMessage(raw);
    });
    socket.on("error", (err) => {
      // `ws` reports e.g. "Unexpected server response: 401"; no credentials.
      console.warn(`${this.options.logPrefix} WebSocket error: ${err.message}`);
      onGone(err);
      try {
        socket.terminate();
      } catch {
        // Ignore.
      }
    });
    socket.on("close", () => onGone());
  }

  private handleMessage(raw: unknown): void {
    let message: MattermostSocketEvent & {
      seq_reply?: number;
      status?: string;
    };
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    // Replies to our own pings carry `seq_reply` and no event.
    if (!message.event) return;

    if (message.event === "hello") {
      const connectionId = String(message.data?.connection_id ?? "");
      const isReconnect = this.disconnectedAt !== undefined;
      const resumed =
        isReconnect &&
        connectionId !== "" &&
        connectionId === this.connectionId;
      if (!resumed) this.nextSequence = 0;
      this.connectionId = connectionId;
      this.attempt = 0;
      if (typeof message.seq === "number") this.nextSequence = message.seq + 1;
      if (this.firstHello) {
        this.firstHello.resolve();
        this.firstHello = undefined;
      } else if (isReconnect) {
        console.log(
          `${this.options.logPrefix} Reconnected (${resumed ? "resumed" : "new session, catching up"})`
        );
        this.options.onReconnect?.({
          resumed,
          disconnectedAt: this.disconnectedAt!,
        });
      }
      this.disconnectedAt = undefined;
      return;
    }

    if (typeof message.seq === "number") this.nextSequence = message.seq + 1;
    try {
      this.options.onEvent(message);
    } catch (err) {
      console.error(`${this.options.logPrefix} Event handler failed:`, err);
    }
  }

  private handleClose(err?: Error): void {
    this.stopPing();
    if (this.stopped) return;
    if (this.firstHello) {
      // The first connection must succeed, so a bad url/token fails start().
      const pending = this.firstHello;
      this.firstHello = undefined;
      this.stopped = true;
      pending.reject(
        err ?? new Error("Mattermost WebSocket closed before hello")
      );
      return;
    }
    this.disconnectedAt ??= Date.now();
    this.attempt += 1;
    const delay = backoffDelay(
      this.attempt,
      this.options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS,
      this.options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
      this.options.random
    );
    console.warn(
      `${this.options.logPrefix} WebSocket closed; reconnecting in ${delay}ms (attempt ${this.attempt})`
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }

  private startPing(socket: SocketLike): void {
    this.stopPing();
    const interval = this.options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
    const idleTimeout = this.options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastTrafficAt > idleTimeout) {
        console.warn(
          `${this.options.logPrefix} WebSocket silent too long; reconnecting`
        );
        try {
          socket.terminate();
        } catch {
          // Ignore.
        }
        return;
      }
      try {
        socket.send(JSON.stringify({ action: "ping", seq: this.pingSeq++ }));
      } catch {
        // The close handler takes over.
      }
    }, interval);
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
  }
}
