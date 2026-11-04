import type { NotificationsConfig } from "./types.js";

export type NotifySurface = "discord" | "slack" | "mattermost" | "all" | "both";

export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

export type NotifyOptions = {
  config?: NotificationsConfig;
  channel: string;
  message: string;
  surface?: string;
  mention?: string;
  discordToken?: string;
  slackToken?: string;
  mattermostToken?: string;
  mattermostUrl?: string;
  fetchImpl?: FetchLike;
  adapters?: Partial<NotifyAdapters>;
};

export type NotifyResult = {
  surface: ConcreteSurface;
  ok: boolean;
  channelId: string;
  error?: string;
};

export type NotifySummary = {
  ok: boolean;
  results: NotifyResult[];
};

export type NotifyAdapters = {
  discord: (params: NotifyAdapterParams) => Promise<void>;
  slack: (params: NotifyAdapterParams) => Promise<void>;
  mattermost: (params: NotifyAdapterParams) => Promise<void>;
};

export type NotifyAdapterParams = {
  channelId: string;
  text: string;
  token: string;
  fetchImpl: FetchLike;
  baseUrl?: string;
};

type ConcreteSurface = Exclude<NotifySurface, "all" | "both">;

const VALID_SURFACES = new Set(["discord", "slack", "mattermost", "all", "both"]);

export function isNotifySurface(value: string): value is NotifySurface {
  return VALID_SURFACES.has(value);
}

function withMention(surface: ConcreteSurface, message: string, mention?: string): string {
  if (!mention) return message;
  if (surface === "mattermost") return `@${mention.replace(/^@/, "")} ${message}`;
  return `<@${mention}> ${message}`;
}

async function postDiscord({
  channelId,
  text,
  token,
  fetchImpl,
}: NotifyAdapterParams): Promise<void> {
  const response = await fetchImpl(
    `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`,
    {
      method: "POST",
      headers: {
        authorization: `Bot ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ content: text }),
    }
  );
  if (!response.ok) {
    throw new Error(`Discord API returned ${response.status}`);
  }
}

function getSlackError(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const error = (payload as { error?: unknown }).error;
  return typeof error === "string" ? error : undefined;
}

async function postSlack({
  channelId,
  text,
  token,
  fetchImpl,
}: NotifyAdapterParams): Promise<void> {
  const response = await fetchImpl("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ channel: channelId, text }),
  });
  if (!response.ok) {
    throw new Error(`Slack API returned ${response.status}`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Slack response was not valid JSON");
  }

  if ((payload as { ok?: unknown }).ok !== true) {
    throw new Error(getSlackError(payload) ?? "Slack response missing ok: true");
  }
}

async function postMattermost({
  channelId,
  text,
  token,
  fetchImpl,
  baseUrl,
}: NotifyAdapterParams): Promise<void> {
  const url = baseUrl?.trim().replace(/\/+$/, "").replace(/\/api\/v4$/, "");
  const response = await fetchImpl(`${url}/api/v4/posts`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ channel_id: channelId, message: text }),
  });
  if (!response.ok) {
    const body = (await response.text()).split(token).join("[redacted]").slice(0, 500);
    throw new Error(`Mattermost API returned ${response.status}: ${body}`);
  }
}

function resolveSurfaces(surface: string | undefined): NotifySurface {
  const requested = surface ?? "all";
  if (!isNotifySurface(requested)) {
    throw new Error(`Invalid notify surface "${requested}"`);
  }
  return requested;
}

export async function notify(options: NotifyOptions): Promise<NotifySummary> {
  const requestedSurface = resolveSurfaces(options.surface);
  const channel = options.config?.channels?.[options.channel];
  if (!channel) {
    throw new Error(`Notification channel not configured: ${options.channel}`);
  }

  const surfaces: ConcreteSurface[] =
    requestedSurface === "all" || requestedSurface === "both"
      ? ["discord", "slack", "mattermost"]
      : [requestedSurface];
  const targets = surfaces.filter((surface) => Boolean(channel[surface]));
  if (targets.length === 0) {
    throw new Error(
      `No ${requestedSurface} notification target configured for channel "${options.channel}"`
    );
  }

  const adapters: NotifyAdapters = {
    discord: options.adapters?.discord ?? postDiscord,
    slack: options.adapters?.slack ?? postSlack,
    mattermost: options.adapters?.mattermost ?? postMattermost,
  };
  const fetchImpl = options.fetchImpl ?? fetch;
  const results: NotifyResult[] = [];

  for (const surface of targets) {
    const token = surface === "discord"
      ? options.discordToken
      : surface === "slack" ? options.slackToken : options.mattermostToken;
    const channelId = channel[surface];
    if (!channelId) continue;
    if (!token) {
      results.push({
        surface,
        channelId,
        ok: false,
        error: `Missing ${surface} token`,
      });
      continue;
    }
    if (surface === "mattermost" && !options.mattermostUrl) {
      results.push({ surface, channelId, ok: false, error: "Missing mattermost url" });
      continue;
    }

    try {
      await adapters[surface]({
        channelId,
        token,
        fetchImpl,
        text: withMention(surface, options.message, options.mention),
        ...(surface === "mattermost" ? { baseUrl: options.mattermostUrl } : {}),
      });
      results.push({ surface, channelId, ok: true });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      results.push({
        surface,
        channelId,
        ok: false,
        error: surface === "mattermost" ? error.split(token).join("[redacted]") : error,
      });
    }
  }

  return {
    ok: results.some((result) => result.ok),
    results,
  };
}
