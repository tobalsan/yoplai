import { vi } from "vitest";

export type MockSlackApp = {
  config: Record<string, unknown>;
  client: {
    slackApiUrl?: string;
    auth: { test: ReturnType<typeof vi.fn> };
    chat: {
      postMessage: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
      postEphemeral: ReturnType<typeof vi.fn>;
    };
    files: {
      uploadV2: ReturnType<typeof vi.fn>;
    };
    conversations: {
      info: ReturnType<typeof vi.fn>;
      history: ReturnType<typeof vi.fn>;
    };
    reactions: {
      add: ReturnType<typeof vi.fn>;
      remove: ReturnType<typeof vi.fn>;
    };
  };
  message: ReturnType<typeof vi.fn>;
  event: ReturnType<typeof vi.fn>;
  command: ReturnType<typeof vi.fn>;
  init: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
};

type SlackMessageCallback = (args: {
  message: Record<string, unknown>;
  body?: Record<string, unknown>;
  client: MockSlackApp["client"];
}) => Promise<void>;

export function getMessageHandler(app: MockSlackApp): SlackMessageCallback {
  return app.message.mock.calls[0]?.[0] as SlackMessageCallback;
}


export function fakeSlackBolt(apps: MockSlackApp[], receivers: Array<Record<string, unknown>> = []) {
  return {
  SocketModeReceiver: vi.fn((config: Record<string, unknown>) => {
    const receiver = { config };
    receivers.push(receiver);
    return receiver;
  }),
  App: vi.fn((config: Record<string, unknown>) => {
    const app: MockSlackApp = {
      config,
      client: {
        auth: {
          test: vi.fn().mockResolvedValue({ user_id: "Ubot", bot_id: "Bbot" }),
        },
        chat: {
          postMessage: vi.fn().mockResolvedValue({ ts: "reply-ts" }),
          update: vi.fn().mockResolvedValue({}),
          delete: vi.fn().mockResolvedValue({}),
          postEphemeral: vi.fn().mockResolvedValue({}),
        },
        files: {
          uploadV2: vi.fn().mockResolvedValue({}),
        },
        conversations: {
          info: vi.fn().mockResolvedValue({ channel: { name: "general" } }),
          history: vi.fn().mockResolvedValue({ messages: [] }),
        },
        reactions: {
          add: vi.fn().mockResolvedValue({}),
          remove: vi.fn().mockResolvedValue({}),
        },
      },
      message: vi.fn(),
      event: vi.fn(),
      command: vi.fn(),
      init: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    apps.push(app);
    return app;
  }),
  };
}
