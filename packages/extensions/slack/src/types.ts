export type SlackWebClient = {
  auth?: {
    test(params?: Record<string, unknown>): Promise<{
      user_id?: string;
      bot_id?: string;
    }>;
  };
  users?: {
    info(params: { user: string }): Promise<{
      user?: {
        profile?: {
          display_name?: string;
          real_name?: string;
        };
        real_name?: string;
        name?: string;
      };
    }>;
    list(params: { limit?: number; cursor?: string }): Promise<{
      members?: Array<{
        id?: string;
        name?: string;
        real_name?: string;
        deleted?: boolean;
        is_bot?: boolean;
        profile?: { display_name?: string; real_name?: string };
      }>;
      response_metadata?: { next_cursor?: string };
    }>;
  };
  chat: {
    postMessage(params: {
      channel: string;
      text: string;
      mrkdwn?: boolean;
      thread_ts?: string;
      unfurl_links?: boolean;
      unfurl_media?: boolean;
    }): Promise<{ channel?: string; ts?: string }>;
    update(params: {
      channel: string;
      ts: string;
      text: string;
      mrkdwn?: boolean;
    }): Promise<unknown>;
    delete(params: { channel: string; ts: string }): Promise<unknown>;
    postEphemeral(params: {
      channel: string;
      user: string;
      text: string;
      mrkdwn?: boolean;
      thread_ts?: string;
    }): Promise<unknown>;
  };
  files?: {
    uploadV2(params: {
      channel_id: string;
      thread_ts?: string;
      file: Buffer | Uint8Array;
      filename: string;
      title?: string;
    }): Promise<unknown>;
  };
  conversations: {
    info(params: { channel: string }): Promise<{
      channel?: { name?: string; topic?: { value?: string } };
    }>;
    list(params: {
      limit?: number;
      cursor?: string;
      exclude_archived?: boolean;
      types?: string;
    }): Promise<{
      channels?: Array<{ id?: string; name?: string }>;
      response_metadata?: { next_cursor?: string };
    }>;
    history(params: {
      channel: string;
      latest?: string;
      inclusive?: boolean;
      limit?: number;
    }): Promise<{
      messages?: Array<{
        user?: string;
        username?: string;
        text?: string;
        ts?: string;
        thread_ts?: string;
        reply_count?: number;
        bot_id?: string;
      }>;
    }>;
  };
  reactions: {
    add(params: {
      channel: string;
      timestamp: string;
      name: string;
    }): Promise<unknown>;
    remove(params: {
      channel: string;
      timestamp: string;
      name: string;
    }): Promise<unknown>;
  };
};

export type SlackThreadPolicy = "always" | "never" | "follow";
