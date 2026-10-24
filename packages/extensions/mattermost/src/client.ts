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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class MattermostRestClient {
  readonly baseUrl: string;

  constructor(
    url: string,
    private readonly token: string,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
    private readonly retryDelayMs = 500
  ) {
    this.baseUrl = normalizeBaseUrl(url);
  }

  private async send(
    method: string,
    path: string,
    body?: unknown
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
      const response = await this.fetchImpl(`${this.baseUrl}/api/v4${path}`, {
        method,
        headers,
        body: payload,
      });
      if (response.ok) return response;
      if (RETRYABLE_STATUS.has(response.status) && attempt < MAX_ATTEMPTS) {
        // Mattermost's rate limiter says when the bucket refills.
        const reset = Number(response.headers.get("x-ratelimit-reset"));
        const wait =
          Number.isFinite(reset) && reset > 0
            ? Math.min(reset * 1000, 10_000)
            : this.retryDelayMs * attempt;
        await sleep(wait);
        continue;
      }
      let serverId: string | undefined;
      let serverMessage: string | undefined;
      try {
        const error = (await response.json()) as {
          id?: string;
          message?: string;
        };
        serverId = error.id;
        serverMessage = error.message;
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
    body?: unknown
  ): Promise<T> {
    const response = await this.send(method, path, body);
    return (await response.json()) as T;
  }

  getMe(): Promise<MattermostUser> {
    return this.json("GET", "/users/me");
  }

  getUser(userId: string): Promise<MattermostUser> {
    return this.json("GET", `/users/${encodeURIComponent(userId)}`);
  }

  getUserByUsername(username: string): Promise<MattermostUser> {
    return this.json(
      "GET",
      `/users/username/${encodeURIComponent(username.replace(/^@/, ""))}`
    );
  }

  getChannel(channelId: string): Promise<MattermostChannel> {
    return this.json("GET", `/channels/${encodeURIComponent(channelId)}`);
  }

  getPost(postId: string): Promise<MattermostPost> {
    return this.json("GET", `/posts/${encodeURIComponent(postId)}`);
  }

  createPost(input: CreatePostInput): Promise<MattermostPost> {
    return this.json("POST", "/posts", input);
  }

  /** Posts created or changed in a channel since `since` (epoch ms), oldest first. */
  async getChannelPostsSince(
    channelId: string,
    since: number
  ): Promise<MattermostPost[]> {
    const list = await this.json<{
      order: string[];
      posts: Record<string, MattermostPost>;
    }>(
      "GET",
      `/channels/${encodeURIComponent(channelId)}/posts?since=${Math.floor(since)}`
    );
    return Object.values(list.posts ?? {}).sort(
      (a, b) => a.create_at - b.create_at
    );
  }

  /** Open (or reuse) the direct-message channel between the bot and a user. */
  createDirectChannel(
    botUserId: string,
    userId: string
  ): Promise<MattermostChannel> {
    return this.json("POST", "/channels/direct", [botUserId, userId]);
  }

  async sendTyping(
    botUserId: string,
    channelId: string,
    parentId?: string
  ): Promise<void> {
    await this.send("POST", `/users/${encodeURIComponent(botUserId)}/typing`, {
      channel_id: channelId,
      ...(parentId ? { parent_id: parentId } : {}),
    });
  }

  async addReaction(
    botUserId: string,
    postId: string,
    emojiName: string
  ): Promise<void> {
    await this.send("POST", "/reactions", {
      user_id: botUserId,
      post_id: postId,
      emoji_name: emojiName,
    });
  }

  async removeReaction(
    botUserId: string,
    postId: string,
    emojiName: string
  ): Promise<void> {
    await this.send(
      "DELETE",
      `/users/${encodeURIComponent(botUserId)}/posts/${encodeURIComponent(postId)}/reactions/${encodeURIComponent(emojiName)}`
    );
  }

  /** Upload one file to a channel; the returned id is then attached to a post. */
  async uploadFile(
    channelId: string,
    data: Uint8Array,
    filename: string,
    mimeType?: string
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
      form
    );
    const info = result.file_infos?.[0];
    if (!info) throw new Error("Mattermost did not return the uploaded file.");
    return info;
  }

  async downloadFile(fileId: string): Promise<Uint8Array> {
    const response = await this.send(
      "GET",
      `/files/${encodeURIComponent(fileId)}`
    );
    return new Uint8Array(await response.arrayBuffer());
  }
}
