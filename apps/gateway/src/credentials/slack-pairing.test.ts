import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentConfig, RunAgentParams } from "@yoplai/shared";
import { afterEach, expect, it, vi } from "vitest";
import { resolveCredential } from "./resolver.js";
import { SlackPairingService, setSlackPairingService } from "../../../../packages/extensions/slack/src/pairing.js";
import { createSlackBot } from "@yoplai/extension-slack";

const state = vi.hoisted(() => ({
  runAgent: vi.fn(),
  dataDir: "",
  handler: undefined as ((args: { message: Record<string, unknown>; client: unknown }) => Promise<void>) | undefined,
  client: {
    auth: { test: vi.fn(async () => ({ user_id: "Ubot", team_id: "T1" })) },
    chat: { postMessage: vi.fn(async () => ({ ts: "reply" })), postEphemeral: vi.fn(), update: vi.fn(), delete: vi.fn() },
    reactions: { add: vi.fn(), remove: vi.fn() },
    conversations: { info: vi.fn(async () => ({ channel: { name: "shared" } })), history: vi.fn(async () => ({ messages: [] })) },
  },
}));

vi.mock("../../../../packages/extensions/slack/node_modules/@slack/bolt", () => ({
  SocketModeReceiver: vi.fn(),
  App: vi.fn(() => ({
    client: state.client,
    message: (handler: typeof state.handler) => { state.handler = handler; },
    event: vi.fn(), command: vi.fn(), start: vi.fn(), stop: vi.fn(),
  })),
}));
vi.mock("../../../../packages/extensions/slack/src/context.js", () => ({
  getSlackContext: () => ({
    runAgent: state.runAgent,
    getDataDir: () => state.dataDir,
    getAgent: () => undefined,
    getAgents: () => [],
    subscribe: () => () => {},
  }),
}));

afterEach(() => { setSlackPairingService(undefined); });

it("resolves real pairings to each sender's personal credentials in one thread, with unpaired team fallback", async () => {
  state.dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "slack-credentials-"));
  const service = new SlackPairingService(state.dataDir, "https://yoplai.test");
  setSlackPairingService(service);
  const selected: string[] = [];
  state.runAgent.mockImplementation(async (request: RunAgentParams) => {
    const result = resolveCredential<string>({
      store: { get: (key) => key.scope.type === "team" ? "team" : key.scope.userId === "alice" ? "alice-personal" : "bob-personal" },
      agentId: request.agentId,
      integration: "google",
      requesterUserId: request.userId,
      connectUrl: "https://yoplai.test/connect",
    });
    if (result.connected) selected.push(result.payload);
    return { payloads: [], meta: { durationMs: 1, sessionId: "session" } };
  });
  const agent: AgentConfig = {
    id: "main", name: "Main", workspace: state.dataDir, queueMode: "queue",
    model: { provider: "openai", model: "test" },
  };
  const bot = createSlackBot([agent], {
    token: "dummy-bot", appToken: "dummy-app", channels: { C1: { agent: "main" } },
  });
  const info = vi.fn(async ({ user }: { user: string }) => ({
    ok: true, user: { id: user, profile: { email: user === "UA" ? "alice@test.example" : "bob@test.example" } },
  }));
  const send = async (user: string, ts: string) => state.handler!({
    message: { ts, thread_ts: "1.1", channel: "C1", channel_type: "channel", user, text: "<@Ubot> use Google" },
    client: state.client,
  });
  try {
    await bot?.start();
    await send("UA", "2.1");
    for (const [slackUser, id] of [["UA", "alice"], ["UB", "bob"]]) {
      const link = await service.issue("T1", slackUser, { users: { info } });
      await service.redeem(new URL(link).pathname.split("/").at(-1)!, { id, email: `${id}@test.example` });
    }
    await send("UA", "3.1");
    await send("UB", "4.1");
    await send("UC", "5.1");
    expect(selected).toEqual(["team", "alice-personal", "bob-personal", "team"]);
  } finally {
    await bot?.stop();
    setSlackPairingService(undefined);
    service.close();
    await fs.rm(state.dataDir, { recursive: true, force: true });
  }
});
