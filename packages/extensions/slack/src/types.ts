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
  token?: string;
  files?: {
    uploadV2(params: {
      channel_id: string;
      thread_ts?: string;
      file: Buffer | Uint8Array;
      filename: string;
      title?: string;
    }): Promise<unknown>;
    info(params: { file: string }): Promise<{
      file?: {
        id?: string;
        title?: string;
        permalink?: string;
        url_private?: string;
        url_private_download?: string;
      };
    }>;
    list?(params: {
      types?: string;
      channel?: string;
      count?: number;
      page?: number;
    }): Promise<{
      files?: Array<{
        id?: string;
        title?: string;
        permalink?: string;
        created?: number;
        updated?: number;
      }>;
      paging?: { page?: number; pages?: number };
    }>;
  };
  canvases?: {
    create(params: {
      title?: string;
      document_content?: { type: "markdown"; markdown: string };
      channel_id?: string;
    }): Promise<{ canvas_id?: string }>;
    edit(params: {
      canvas_id: string;
      changes: [
        {
          operation:
            | "insert_after"
            | "insert_before"
            | "insert_at_start"
            | "insert_at_end"
            | "replace"
            | "delete";
          section_id?: string;
          document_content?: { type: "markdown"; markdown: string };
        },
        ...Array<{
          operation:
            | "insert_after"
            | "insert_before"
            | "insert_at_start"
            | "insert_at_end"
            | "replace"
            | "delete";
          section_id?: string;
          document_content?: { type: "markdown"; markdown: string };
        }>,
      ];
    }): Promise<unknown>;
    delete(params: { canvas_id: string }): Promise<unknown>;
    sections: {
      lookup(params: {
        canvas_id: string;
        criteria: {
          section_types?: [
            "h1" | "h2" | "h3" | "any_header",
            ...Array<"h1" | "h2" | "h3" | "any_header">,
          ];
          contains_text?: string;
        };
      }): Promise<{ sections?: Array<{ id?: string }> }>;
    };
    access: {
      set(params: {
        canvas_id: string;
        access_level: "read" | "write";
        channel_ids?: string[];
        user_ids?: string[];
      }): Promise<unknown>;
    };
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
      oldest?: string;
      inclusive?: boolean;
      cursor?: string;
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
      has_more?: boolean;
      response_metadata?: { next_cursor?: string };
    }>;
    replies(params: {
      channel: string;
      ts: string;
      latest?: string;
      oldest?: string;
      inclusive?: boolean;
      cursor?: string;
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
      has_more?: boolean;
      response_metadata?: { next_cursor?: string };
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
