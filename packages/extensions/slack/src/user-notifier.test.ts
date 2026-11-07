import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentConfigSchema, GatewayConfigSchema, type ExtensionContext } from "@yoplai/shared";
import { clearSlackClientCache, createSlackUserNotifier } from "./agent-tools.js";
import { clearActiveBots, registerActiveBot } from "./bot-registry.js";
import { clearSlackContext, setSlackContext } from "./context.js";
import { setSlackPairingService, SlackPairingService } from "./pairing.js";
import { ProactiveDmNoteStore } from "./proactive-dm-notes.js";
import type { SlackBot } from "./bot.js";

const agent = AgentConfigSchema.parse({ id: "atlas", name: "Atlas", workspace: "/tmp/atlas", model: { provider: "test", model: "test" } });
const config = GatewayConfigSchema.parse({ version: 3, agents: [], extensions: {} });

describe("Slack owner notifier", () => {
  let home: string;
  let pairing: SlackPairingService;
  let ctx: ExtensionContext;
  const postMessage = vi.fn();
  const client = () => ({
    auth: { test: async () => ({ team_id: "TATLAS" }) },
    users: { info: async ({ user }: { user: string }) => ({ ok: true, user: { id: user, profile: { email: "owner@example.test" } } }) },
    chat: { postMessage },
  });

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "slack-notifier-"));
    pairing = new SlackPairingService(home, "https://app.example.test");
    setSlackPairingService(pairing);
    ctx = { getConfig: () => config, getDataDir: () => home, logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } } as unknown as ExtensionContext;
    setSlackContext(ctx);
    postMessage.mockResolvedValue({ ts: "1.1", channel: "DOWNER" });
    registerActiveBot(agent.id, { agentId: agent.id, app: { client: client() } } as unknown as SlackBot);
  });

  afterEach(async () => {
    pairing.close();
    setSlackPairingService(undefined);
    clearActiveBots();
    clearSlackClientCache();
    clearSlackContext();
    vi.restoreAllMocks();
    postMessage.mockReset();
    await fs.rm(home, { recursive: true, force: true });
  });

  async function pair(workspace: string, slackUser: string) {
    const link = await pairing.issue(workspace, slackUser, client());
    await pairing.redeem(link.split("/").at(-1)!, { id: "owner", email: "owner@example.test" });
  }

  it("DMs the paired owner in the bot workspace and records the proactive note", async () => {
    await pair("TATLAS", "UOWNER");
    const text = "Digest is paused: reconnect Invented Mail, then resume the job.";
    await expect(createSlackUserNotifier(ctx)({ agent, userId: "owner", text })).resolves.toBe("sent");
    expect(postMessage.mock.calls).toEqual([[expect.objectContaining({ channel: "UOWNER", text, mrkdwn: true })]]);
    const notes = new ProactiveDmNoteStore(home);
    try { expect(notes.takeNotes("atlas", "UOWNER", "DOWNER")).toEqual([{ text, createdAt: expect.any(Number) }]); }
    finally { notes.close(); }
  });

  it("DMs only the newest pairing in the bot workspace", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    await pair("TATLAS", "UOLDER");
    vi.spyOn(Date, "now").mockReturnValue(1_001_000);
    await pair("TATLAS", "UNEWEST");
    vi.spyOn(Date, "now").mockReturnValue(1_002_000);
    await pair("TOTHER", "UWRONG");
    await expect(createSlackUserNotifier(ctx)({ agent, userId: "owner", text: "Paused" })).resolves.toBe("sent");
    expect(postMessage.mock.calls).toEqual([[expect.objectContaining({ channel: "UNEWEST" })]]);
  });

  it.each(["different workspace", "no pairing service", "no client", "no pairing"])("does not send when the owner is unreachable: %s", async (reason) => {
    if (reason !== "no pairing") await pair("TOTHER", "UOWNER");
    if (reason === "no pairing service") setSlackPairingService(undefined);
    if (reason === "no client") clearActiveBots();
    await expect(createSlackUserNotifier(ctx)({ agent, userId: "owner", text: "Paused" })).resolves.toBe("unavailable");
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("propagates a Slack send failure", async () => {
    await pair("TATLAS", "UOWNER");
    postMessage.mockRejectedValueOnce(new Error("Slack unavailable"));
    await expect(createSlackUserNotifier(ctx)({ agent, userId: "owner", text: "Paused" })).rejects.toThrow("Slack unavailable");
  });

  it("sends through the verified workspace client if the bot is replaced during lookup", async () => {
    await pair("TATLAS", "UOWNER");
    const otherPost = vi.fn().mockResolvedValue({ ts: "2.2" });
    const verifiedClient = { ...client(), auth: { test: async () => {
      registerActiveBot(agent.id, { agentId: agent.id, app: { client: {
        ...client(), auth: { test: async () => ({ team_id: "TOTHER" }) }, chat: { postMessage: otherPost },
      } } } as unknown as SlackBot);
      return { team_id: "TATLAS" };
    } } };
    registerActiveBot(agent.id, { agentId: agent.id, app: { client: verifiedClient } } as unknown as SlackBot);
    await expect(createSlackUserNotifier(ctx)({ agent, userId: "owner", text: "Paused" })).resolves.toBe("sent");
    expect(postMessage.mock.calls).toEqual([[expect.objectContaining({ channel: "UOWNER" })]]);
    expect(otherPost).not.toHaveBeenCalled();
  });
});
