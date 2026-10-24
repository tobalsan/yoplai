/**
 * Minimal Mattermost REST v4 client: only the endpoints the extension uses.
 *
 * Plain `fetch` instead of `@mattermost/client`: Client4 is built for the web
 * app (browser globals, a large typed surface) while the bot needs about a dozen
 * calls. The token travels only in the Authorization header and is never put in
 * an error message, so a failed call can be logged as is.
 */

export type MattermostPost = {
  id: string;
  create_at: number;
  update_at?: number;
  edit_at?: number;
  delete_at?: number;
  user_id: string;
  channel_id: string;
  root_id?: string;
  message: string;
  /** Empty for user posts; system posts carry a type such as `system_join_channel`. */
  type?: string;
  props?: Record<string, unknown>;
  file_ids?: string[];
  metadata?: { files?: MattermostFileInfo[] };
};

export type MattermostFileInfo = {
  id: string;
  name: string;
  extension?: string;
  size?: number;
  mime_type?: string;
};

export type MattermostUser = {
  id: string;
  username: string;
  first_name?: string;
  last_name?: string;
  nickname?: string;
  is_bot?: boolean;
};

export type MattermostChannel = {
  id: string;
  /** O = public, P = private, D = direct message, G = group message. */
  type: "O" | "P" | "D" | "G";
  name: string;
  display_name: string;
  header?: string;
  purpose?: string;
  team_id?: string;
};

export type CreatePostInput = {
  channel_id: string;
  message: string;
  root_id?: string;
  file_ids?: string[];
};

export type FetchLike = (
  input: string,
  init?: RequestInit
) => Promise<Response>;

export class MattermostApiError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly serverId?: string,
    serverMessage?: string
  ) {
    super(
      `Mattermost ${method} ${path} failed with ${status}` +
        (serverMessage ? `: ${serverMessage}` : "")
    );
    this.name = "MattermostApiError";
  }
}

/** Strip trailing slashes and any `/api/v4` suffix an operator may have pasted. */
export function normalizeBaseUrl(url: string): string {
  return url
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/api\/v4$/, "");
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_FILE_TIMEOUT_MS = 120_000;

export type MattermostRestOptions = {
  requestTimeoutMs?: number;
  fileTimeoutMs?: number;
};

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class MattermostRestClient {
  readonly baseUrl: string;

  constructor(
    url: string,
    private readonly token: string,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
    private readonly retryDelayMs = 500,
    private readonly options: MattermostRestOptions = {}
  ) {
    this.baseUrl = normalizeBaseUrl(url);
  }

  private async withDeadline<T>(
    method: string,
    path: string,
    caller: AbortSignal | undefined,
    timeoutMs: number,
    run: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const controller = new AbortController();
    const failure = (timeout: boolean): Error => {
      const cancelled = caller?.aborted || !timeout;
      const error = new Error(
        `Mattermost ${method} ${path} ${cancelled ? "cancelled" : "timed out"}`
      );
      error.name = cancelled ? "AbortError" : "TimeoutError";
      return error;
    };
    if (caller?.aborted) throw failure(false);

    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      const abort = (timeout: boolean): void => {
        const error = failure(timeout);
        controller.abort(error);
        reject(error);
      };
      onAbort = () => abort(false);
      timer = setTimeout(() => abort(true), timeoutMs);
      caller?.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([run(controller.signal), aborted]);
    } catch (error) {
      if (caller?.aborted) throw failure(false);
      if (controller.signal.aborted) throw controller.signal.reason;
      if (error instanceof MattermostApiError) throw error;
      throw new Error(`Mattermost ${method} ${path} failed`);
    } finally {
      clearTimeout(timer);
      if (onAbort) caller?.removeEventListener("abort", onAbort);
    }
  }

  private send(
    method: string,
    path: string,
    body?: unknown,
    caller?: AbortSignal
  ): Promise<void> {
    return this.withDeadline(
      method,
      path,
      caller,
      this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      async (signal) => {
        const response = await this.sendWithRetries(method, path, body, signal);
        await response.arrayBuffer();
      }
    );
  }

  private async sendWithRetries(
    method: string,
    path: string,
    body: unknown,
    signal: AbortSignal
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      "X-Requested-With": "XMLHttpRequest",
    };
    let payload: BodyInit | undefined;
    if (body instanceof FormData) {
      payload = body;
    } else if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }

    for (let attempt = 1; ; attempt++) {
      signal.throwIfAborted();
      const response = await this.fetchImpl(`${this.baseUrl}/api/v4${path}`, {
        method,
        headers,
        body: payload,
        signal,
      });
      if (response.ok) return response;
      if (RETRYABLE_STATUS.has(response.status) && attempt < MAX_ATTEMPTS) {
        await response.body?.cancel();
        // Mattermost's rate limiter says when the bucket refills.
        const reset = Number(response.headers.get("x-ratelimit-reset"));
        const wait =
          Number.isFinite(reset) && reset > 0
            ? Math.min(reset * 1000, 10_000)
            : this.retryDelayMs * attempt;
        await sleep(wait, signal);
        continue;
      }
      let serverId: string | undefined;
      let serverMessage: string | undefined;
      try {
        const error = (await response.json()) as {
          id?: string;
          message?: string;
        };
        serverId = error.id?.replaceAll(this.token, "[redacted]");
        serverMessage = error.message?.replaceAll(this.token, "[redacted]");
      } catch {
        // Not every failure has a JSON body (e.g. a proxy error page).
      }
      throw new MattermostApiError(
        response.status,
        method,
        path,
        serverId,
        serverMessage
      );
    }
  }

  private async json<T>(
    method: string,
    path: string,
    body?: unknown,
    caller?: AbortSignal,
    timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  ): Promise<T> {
    return this.withDeadline(
      method,
      path,
      caller,
      timeoutMs,
      async (signal) => {
        const response = await this.sendWithRetries(method, path, body, signal);
        return (await response.json()) as T;
      }
    );
  }

  getMe(signal?: AbortSignal): Promise<MattermostUser> {
    return this.json("GET", "/users/me", undefined, signal);
  }

  getUser(userId: string, signal?: AbortSignal): Promise<MattermostUser> {
    return this.json(
      "GET",
      `/users/${encodeURIComponent(userId)}`,
      undefined,
      signal
    );
  }

  getUserByUsername(
    username: string,
    signal?: AbortSignal
  ): Promise<MattermostUser> {
    return this.json(
      "GET",
      `/users/username/${encodeURIComponent(username.replace(/^@/, ""))}`,
      undefined,
      signal
    );
  }

  getChannel(
    channelId: string,
    signal?: AbortSignal
  ): Promise<MattermostChannel> {
    return this.json(
      "GET",
      `/channels/${encodeURIComponent(channelId)}`,
      undefined,
      signal
    );
  }

  getPost(postId: string, signal?: AbortSignal): Promise<MattermostPost> {
    return this.json(
      "GET",
      `/posts/${encodeURIComponent(postId)}`,
      undefined,
      signal
    );
  }

  createPost(
    input: CreatePostInput,
    signal?: AbortSignal
  ): Promise<MattermostPost> {
    return this.json("POST", "/posts", input, signal);
  }

  /** Posts created or changed in a channel since `since` (epoch ms), oldest first. */
  async getChannelPostsSince(
    channelId: string,
    since: number,
    signal?: AbortSignal
  ): Promise<MattermostPost[]> {
    const list = await this.json<{
      order: string[];
      posts: Record<string, MattermostPost>;
    }>(
      "GET",
      `/channels/${encodeURIComponent(channelId)}/posts?since=${Math.floor(since)}`,
      undefined,
      signal
    );
    return Object.values(list.posts ?? {}).sort(
      (a, b) => a.create_at - b.create_at
    );
  }

  /** Open (or reuse) the direct-message channel between the bot and a user. */
  createDirectChannel(
    botUserId: string,
    userId: string,
    signal?: AbortSignal
  ): Promise<MattermostChannel> {
    return this.json("POST", "/channels/direct", [botUserId, userId], signal);
  }

  async sendTyping(
    botUserId: string,
    channelId: string,
    parentId?: string,
    signal?: AbortSignal
  ): Promise<void> {
    await this.send(
      "POST",
      `/users/${encodeURIComponent(botUserId)}/typing`,
      {
        channel_id: channelId,
        ...(parentId ? { parent_id: parentId } : {}),
      },
      signal
    );
  }

  async addReaction(
    botUserId: string,
    postId: string,
    emojiName: string,
    signal?: AbortSignal
  ): Promise<void> {
    await this.send(
      "POST",
      "/reactions",
      {
        user_id: botUserId,
        post_id: postId,
        emoji_name: emojiName,
      },
      signal
    );
  }

  async removeReaction(
    botUserId: string,
    postId: string,
    emojiName: string,
    signal?: AbortSignal
  ): Promise<void> {
    await this.send(
      "DELETE",
      `/users/${encodeURIComponent(botUserId)}/posts/${encodeURIComponent(postId)}/reactions/${encodeURIComponent(emojiName)}`,
      undefined,
      signal
    );
  }

  /** Upload one file to a channel; the returned id is then attached to a post. */
  async uploadFile(
    channelId: string,
    data: Uint8Array,
    filename: string,
    mimeType?: string,
    signal?: AbortSignal
  ): Promise<MattermostFileInfo> {
    const form = new FormData();
    form.append("channel_id", channelId);
    form.append(
      "files",
      new Blob(
        [new Uint8Array(data)],
        mimeType ? { type: mimeType } : undefined
      ),
      filename
    );
    const result = await this.json<{ file_infos: MattermostFileInfo[] }>(
      "POST",
      "/files",
      form,
      signal,
      this.options.fileTimeoutMs ?? DEFAULT_FILE_TIMEOUT_MS
    );
    const info = result.file_infos?.[0];
    if (!info) throw new Error("Mattermost did not return the uploaded file.");
    return info;
  }

  async downloadFile(
    fileId: string,
    signal?: AbortSignal
  ): Promise<Uint8Array> {
    const path = `/files/${encodeURIComponent(fileId)}`;
    return this.withDeadline(
      "GET",
      path,
      signal,
      this.options.fileTimeoutMs ?? DEFAULT_FILE_TIMEOUT_MS,
      async (signal) => {
        const response = await this.sendWithRetries(
          "GET",
          path,
          undefined,
          signal
        );
        return new Uint8Array(await response.arrayBuffer());
      }
    );
  }
}
