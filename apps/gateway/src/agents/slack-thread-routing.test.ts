import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileAttachment, SlackComponentConfig } from "@yoplai/shared";
import type { SdkAdapter, SdkRunParams } from "../sdk/types.js";
import { writeTestV3Config } from "../test-utils/v3-config.js";

const slack = vi.hoisted(() => ({
  messages: [] as Array<
    (args: {
      message: Record<string, unknown>;
      client: unknown;
    }) => Promise<void>
  >,
  postMessage: vi.fn(),
  client: {} as Record<string, unknown>,
}));
const run = vi.hoisted(() => vi.fn<SdkAdapter["run"]>());
vi.mock("../sdk/registry.js", () => ({
  getDefaultSdkId: () => "pi",
  getSdkAdapter: () => ({
    id: "pi",
    displayName: "Test",
    capabilities: {
      queueWhileStreaming: false,
      interrupt: false,
      toolEvents: true,
      fullHistory: true,
    },
    run,
  }),
}));
vi.mock("../maintenance/session-auto-title.js", () => ({
  maybeAutoTitleSession: vi.fn(),
}));
vi.mock(
  "../../../../packages/extensions/slack/node_modules/@slack/bolt/dist/index.js",
  () => ({
    SocketModeReceiver: class {},
    App: class {
      client = slack.client;
      message(handler: (typeof slack.messages)[number]) {
        slack.messages.push(handler);
      }
      event() {}
      command() {}
      async start() {}
      async stop() {}
    },
  })
);

describe("Slack thread routing through gateway persistence", () => {
  let home: string;
  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "slack-gateway-"));
    vi.stubEnv("YOPLAI_HOME", home);
    vi.resetModules();
    slack.messages.length = 0;
    slack.postMessage.mockReset().mockResolvedValue({ ts: "agent-reply" });
    slack.client = {
      auth: { test: async () => ({ team_id: "T1", user_id: "UBOT" }) },
      chat: {
        postMessage: slack.postMessage,
        update: vi.fn(),
        delete: vi.fn(),
        postEphemeral: vi.fn(),
      },
      conversations: {
        info: async () => ({ channel: { name: "test" } }),
        history: async () => ({ messages: [] }),
      },
      reactions: { add: vi.fn(), remove: vi.fn() },
    };
    run.mockReset();
    await writeTestV3Config(home, { agents: [{ id: "connie" }] });
  });
  afterEach(async () => {
    const { stopSlackBots, getSlackPairingService } =
      await import("@yoplai/extension-slack");
    await stopSlackBots();
    getSlackPairingService()?.close();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await fs.rm(home, { recursive: true, force: true });
  });

  it.each([false, true])(
    "delivers a different sender's deferred Slack turn (failure=%s)",
    async (fail) => {
      const { loadConfig, getAgent } = await import("../config/index.js");
      const { createExtensionContext } =
        await import("../extensions/context.js");
      const { startSlackBots } = await import("@yoplai/extension-slack");
      await startSlackBots(createExtensionContext(loadConfig()), {
        agents: [getAgent("connie")!],
        componentConfig: {
          token: "test",
          appToken: "test",
          channels: { C1: { agent: "connie", requireMention: false } },
        },
      });
      let release!: () => void;
      let started!: () => void;
      const running = new Promise<void>((resolve) => {
        started = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      run.mockImplementation(async (params) => {
        if (params.message === "open") {
          started();
          await gate;
          return { text: "reply-open" };
        }
        expect(params.requesterId).toBe("slack:T1:UB");
        if (fail) throw new Error("fixture failure");
        return { text: "reply-follow-up" };
      });
      const handler = slack.messages.at(-1)!;
      const opening = handler({
        message: {
          ts: "8.0",
          user: "UA",
          text: "open",
          channel: "C1",
          channel_type: "channel",
        },
        client: slack.client,
      });
      await running;
      await handler({
        message: {
          ts: "8.1",
          thread_ts: "8.0",
          user: "UB",
          text: "follow-up",
          channel: "C1",
          channel_type: "channel",
        },
        client: slack.client,
      });
      expect(run).toHaveBeenCalledOnce();
      release();
      await opening;
      expect(run).toHaveBeenCalledTimes(2);
      expect(slack.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          thread_ts: "8.0",
          text: fail
            ? "Something went wrong, please try again."
            : "reply-follow-up",
        })
      );
      expect(slack.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ thread_ts: "8.0", text: "reply-open" })
      );
    }
  );

  it.each(["alice", undefined])(
    "keeps opener %s's PDF/session across different senders, restart, reset, and missing history",
    async (opener) => {
      const { loadConfig, getAgent } = await import("../config/index.js");
      const { createExtensionContext } =
        await import("../extensions/context.js");
      const {
        startSlackBots,
        stopSlackBots,
        SlackPairingService,
        createSlackThreadSessionBindingStore,
      } = await import("@yoplai/extension-slack");
      const { setSlackPairingService } =
        await import("../../../../packages/extensions/slack/src/pairing.js");
      const { getFullHistory } = await import("../history/store.js");
      const { buildDocumentAttachmentContext } =
        await import("../sdk/attachments.js");
      const { getMediaFileMetadata, resolveMediaFilePath } =
        await import("../media/metadata.js");
      const { getUserHistoryDir } =
        await import("@yoplai/extension-multi-user/isolation");
      const config = loadConfig();
      const ctx = createExtensionContext(config);
      const pairing = new SlackPairingService(home, "http://localhost:4000");
      vi.spyOn(pairing, "resolve").mockImplementation((_workspace, sender) =>
        sender === "UOPEN" ? opener : sender === "UBOB" ? "bob" : undefined
      );
      setSlackPairingService(pairing);
      const componentConfig: SlackComponentConfig = {
        token: "test",
        appToken: "test",
        channels: { C1: { agent: "connie", threadUnlock: true } },
      };
      const start = () =>
        startSlackBots(ctx, { agents: [getAgent("connie")!], componentConfig });
      await start();
      const pdf = await fs.readFile(
        new URL("../media/__fixtures__/text-layer.pdf", import.meta.url)
      );
      const fetchFile = vi.fn(async () => new Response(pdf));
      vi.stubGlobal("fetch", fetchFile);
      const turns: Array<{
        id: string;
        owner: string | null | undefined;
        requester: string | undefined;
        history: string;
      }> = [];
      run.mockImplementation(async (params: SdkRunParams) => {
        const history = await getFullHistory(
          params.agentId,
          params.sessionId,
          params.sessionOwnerId ?? undefined
        );
        const priorFiles: FileAttachment[] = await Promise.all(
          history
            .flatMap((message) =>
              message.content.filter((block) => block.type === "file")
            )
            .map(async (block) => {
              const metadata = await getMediaFileMetadata(block.fileId);
              return {
                path: await resolveMediaFilePath(metadata!),
                mimeType: block.mimeType,
                filename: block.filename,
              };
            })
        );
        const documents = await buildDocumentAttachmentContext(priorFiles);
        turns.push({
          id: params.sessionId,
          owner: params.sessionOwnerId,
          requester: params.userId,
          history: JSON.stringify(history) + documents,
        });
        return { text: "remembered" };
      });
      const send = (
        ts: string,
        user: string,
        text: string,
        root?: string,
        files?: unknown[]
      ) =>
        slack.messages.at(-1)!({
          message: {
            ts,
            user,
            text,
            thread_ts: root,
            files,
            channel: "C1",
            channel_type: "channel",
          },
          client: slack.client,
        });
      await send("1.0", "UOPEN", "<@UBOT> read this PDF", undefined, [
        {
          id: "F1",
          name: "source.pdf",
          mimetype: "application/pdf",
          size: pdf.length,
          url_private_download: "https://slack.test/source.pdf",
        },
      ]);
      await send("1.1", "UOPEN", "same sender", "1.0");
      await send("1.2", "UBOB", "what did the file say?", "1.0");
      await send("1.3", "UUNPAIRED", "and this detail?", "1.0");
      expect(turns.map((turn) => turn.id)).toEqual(Array(4).fill(turns[0].id));
      expect(turns.map((turn) => turn.owner)).toEqual(
        Array(4).fill(opener ?? null)
      );
      expect(turns.map((turn) => turn.requester)).toEqual([
        opener,
        opener,
        "bob",
        undefined,
      ]);
      expect(turns[2].history).toContain("source.pdf");
      expect(turns[2].history).toContain("Attached document text:");
      expect(turns[2].history).not.toContain("Content: not extracted");
      expect(fetchFile).toHaveBeenCalledOnce();
      await stopSlackBots();
      await start();
      await send("1.4", "UBOB", "<@UBOT> after restart", "1.0");
      expect(turns.at(-1)?.id).toBe(turns[0].id);
      await send("2.0", "UOPEN", "<@UBOT> unrelated request");
      expect(turns.at(-1)?.id).not.toBe(turns[0].id);
      await send("1.5", "UBOB", "!stop", "1.0");
      await send("1.6", "UBOB", "!new", "1.0");
      const store = createSlackThreadSessionBindingStore(home);
      expect(store.getBinding("C1", "1.0", "connie")).toBeUndefined();
      expect(await ctx.hasSession("connie", turns[0].id, opener)).toBe(false);
      await send("1.7", "UBOB", "<@UBOT> fresh start", "1.0");
      const rebound = store.getBinding("C1", "1.0", "connie")!;
      expect(rebound).toMatchObject({ owner: "bob", source: "inbound" });
      expect(rebound.sessionId).not.toBe(turns[0].id);
      await stopSlackBots();
      const historyDir = getUserHistoryDir("bob", home);
      const filenames = await fs.readdir(historyDir);
      const missing = filenames.find((name) =>
        name.includes(rebound.sessionId)
      )!;
      await fs.unlink(path.join(historyDir, missing));
      vi.resetModules(); // Drop gateway/store caches as a process restart would.
      const freshPersistence = await import("../sessions/persistence.js");
      expect(
        await freshPersistence.hasSession("connie", rebound.sessionId, "bob")
      ).toBe(false);
      const freshContext = await import("../extensions/context.js");
      const freshConfig = await import("../config/index.js");
      const freshSlack = await import("@yoplai/extension-slack");
      const freshPairing =
        await import("../../../../packages/extensions/slack/src/pairing.js");
      freshPairing.setSlackPairingService(pairing);
      await freshSlack.startSlackBots(
        freshContext.createExtensionContext(freshConfig.loadConfig()),
        { agents: [freshConfig.getAgent("connie")!], componentConfig }
      );
      await send("1.8", "UUNPAIRED", "<@UBOT> recover missing session", "1.0");
      const recovered = store.getBinding("C1", "1.0", "connie")!;
      expect(recovered.owner).toBe("bob");
      expect(recovered.sessionId).not.toBe(rebound.sessionId);
      expect(turns.at(-1)).toMatchObject({
        id: recovered.sessionId,
        owner: "bob",
        requester: undefined,
      });
      store.close();
    }
  );
});
