import { DEFAULT_MAIN_KEY, type AgentConfig } from "@yoplai/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleTelegramMessage,
  processMessage,
  type TelegramMessageData,
} from "./message.js";
import { setTelegramContext, clearTelegramContext } from "../context.js";
import { renderMarkdown } from "../utils/render.js";

function makeData(
  overrides: Partial<TelegramMessageData> = {}
): TelegramMessageData {
  return {
    chatId: 123,
    chatType: "private",
    text: "hello",
    userId: 42,
    senderName: "alice",
    isBot: false,
    ...overrides,
  };
}

const agent = { id: "main" } as AgentConfig;

// Allowlist that admits the default `makeData` sender (user 42) in chat 123.
const allowAll = { allowedUsers: [42], allowedChats: [123] };

describe("processMessage", () => {
  it("replies to a DM from an allowed user in an allowed chat", () => {
    expect(processMessage(makeData(), allowAll)).toEqual({ shouldReply: true });
  });

  it("ignores the bot's own messages", () => {
    expect(processMessage(makeData({ isBot: true }), allowAll)).toMatchObject({
      shouldReply: false,
      reason: "author_is_bot",
    });
  });

  it("ignores group messages that do not address the bot", () => {
    expect(
      processMessage(
        makeData({ chatType: "group", isAddressed: false }),
        allowAll
      )
    ).toMatchObject({
      shouldReply: false,
      reason: "not_addressed",
    });
  });

  it("replies to a group message that addresses the bot", () => {
    expect(
      processMessage(
        makeData({ chatType: "supergroup", isAddressed: true }),
        allowAll
      )
    ).toEqual({ shouldReply: true });
  });

  it("ignores empty messages", () => {
    expect(processMessage(makeData({ text: "   " }), allowAll)).toMatchObject({
      shouldReply: false,
      reason: "empty_message",
    });
  });

  it("replies to a media-only message with no caption", () => {
    expect(
      processMessage(
        makeData({ text: "", media: [{ fileId: "f1", kind: "photo" }] }),
        allowAll
      )
    ).toEqual({ shouldReply: true });
  });

  describe("allowlist enforcement", () => {
    it("denies a user who is not on the user allowlist", () => {
      expect(
        processMessage(makeData({ userId: 7 }), allowAll)
      ).toMatchObject({ shouldReply: false, reason: "user_not_allowed" });
    });

    it("denies an allowed user in a chat that is not allowed", () => {
      expect(
        processMessage(makeData({ chatId: 999 }), allowAll)
      ).toMatchObject({ shouldReply: false, reason: "chat_not_allowed" });
    });

    it("matches the user by @username", () => {
      expect(
        processMessage(makeData({ userId: undefined, username: "alice" }), {
          allowedUsers: ["alice"],
          allowedChats: [123],
        })
      ).toEqual({ shouldReply: true });
    });

    it("fails closed when no allowlist is configured", () => {
      expect(processMessage(makeData())).toMatchObject({
        shouldReply: false,
        reason: "user_not_allowed",
      });
    });

    it("fails closed when only the user allowlist is configured", () => {
      expect(
        processMessage(makeData(), { allowedUsers: [42] })
      ).toMatchObject({ shouldReply: false, reason: "chat_not_allowed" });
    });
  });
});

describe("handleTelegramMessage", () => {
  afterEach(() => clearTelegramContext());

  it("dispatches a DM to the main session and replies", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      payloads: [{ text: "hi back" }],
      meta: { durationMs: 1, sessionId: "s1" },
    });
    setTelegramContext({ runAgent } as never);
    const send = vi.fn().mockResolvedValue(undefined);

    await handleTelegramMessage(
      makeData(),
      { agent, logPrefix: "[t]" },
      send,
      {},
      allowAll
    );

    expect(runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        message: "hello",
        sessionKey: DEFAULT_MAIN_KEY,
        source: "telegram",
      })
    );
    expect(send).toHaveBeenCalledWith(
      "hi back",
      expect.objectContaining({ parseMode: "HTML" })
    );
  });

  it("downloads media and passes attachments plus the caption to the agent", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      payloads: [{ text: "got it" }],
      meta: { durationMs: 1, sessionId: "s1" },
    });
    setTelegramContext({ runAgent } as never);
    const send = vi.fn().mockResolvedValue(undefined);
    const attachment = { path: "/tmp/x.png", mimeType: "image/png" };
    const collectAttachments = vi.fn().mockResolvedValue([attachment]);

    await handleTelegramMessage(
      makeData({
        text: "look at this",
        media: [{ fileId: "f1", kind: "photo" }],
      }),
      { agent, logPrefix: "[t]" },
      send,
      { collectAttachments },
      allowAll
    );

    expect(collectAttachments).toHaveBeenCalledWith([
      { fileId: "f1", kind: "photo" },
    ]);
    expect(runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "look at this",
        attachments: [attachment],
      })
    );
  });

  it("runs a media-only message with the attachment and empty text", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      payloads: [{ text: "seen" }],
      meta: { durationMs: 1, sessionId: "s1" },
    });
    setTelegramContext({ runAgent } as never);
    const send = vi.fn().mockResolvedValue(undefined);
    const attachment = { path: "/tmp/x.pdf", mimeType: "application/pdf" };
    const collectAttachments = vi.fn().mockResolvedValue([attachment]);

    await handleTelegramMessage(
      makeData({ text: "", media: [{ fileId: "f1", kind: "document" }] }),
      { agent, logPrefix: "[t]" },
      send,
      { collectAttachments },
      allowAll
    );

    expect(runAgent).toHaveBeenCalledWith(
      expect.objectContaining({ message: "", attachments: [attachment] })
    );
  });

  it("does not run the agent when media-only download yields nothing", async () => {
    const runAgent = vi.fn();
    setTelegramContext({ runAgent } as never);
    const send = vi.fn().mockResolvedValue(undefined);
    const collectAttachments = vi.fn().mockResolvedValue([]);

    await handleTelegramMessage(
      makeData({ text: "", media: [{ fileId: "f1", kind: "photo" }] }),
      { agent, logPrefix: "[t]" },
      send,
      { collectAttachments },
      allowAll
    );

    expect(runAgent).not.toHaveBeenCalled();
  });

  it("surfaces a friendly error when media download throws", async () => {
    const runAgent = vi.fn();
    setTelegramContext({ runAgent } as never);
    const send = vi.fn().mockResolvedValue(undefined);
    const collectAttachments = vi.fn().mockRejectedValue(new Error("boom"));

    await handleTelegramMessage(
      makeData({ text: "hi", media: [{ fileId: "f1", kind: "photo" }] }),
      { agent, logPrefix: "[t]" },
      send,
      { collectAttachments },
      allowAll
    );

    expect(runAgent).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      "Sorry, I couldn't download the attached media. Please try again."
    );
  });

  it("threads overflow chunks as replies to the previous chunk", async () => {
    const long = "word ".repeat(2000).trim(); // > 4096 chars -> multiple chunks
    const runAgent = vi.fn().mockResolvedValue({
      payloads: [{ text: long }],
      meta: { durationMs: 1, sessionId: "s1" },
    });
    setTelegramContext({ runAgent } as never);
    // Each send returns an incrementing message id.
    let nextId = 100;
    const send = vi.fn().mockImplementation(async () => nextId++);

    await handleTelegramMessage(
      makeData(),
      { agent, logPrefix: "[t]" },
      send,
      {},
      allowAll
    );

    expect(send.mock.calls.length).toBeGreaterThan(1);
    // First chunk is not a reply.
    expect(send.mock.calls[0][1]).toMatchObject({
      parseMode: "HTML",
      replyToMessageId: undefined,
    });
    // Subsequent chunks reply to the id returned by the previous send.
    for (let i = 1; i < send.mock.calls.length; i++) {
      expect(send.mock.calls[i][1].replyToMessageId).toBe(99 + i);
    }
  });

  it("does not reply when the run is queued", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      payloads: [{ text: "ignored" }],
      meta: { durationMs: 1, sessionId: "s1", queued: true },
    });
    setTelegramContext({ runAgent } as never);
    const send = vi.fn().mockResolvedValue(undefined);

    await handleTelegramMessage(
      makeData(),
      { agent, logPrefix: "[t]" },
      send,
      {},
      allowAll
    );

    expect(send).not.toHaveBeenCalled();
  });

  describe("streaming previews", () => {
    // A runAgent mock that replays `deltas` through onEvent (with a small async
    // gap so the coalescer's serialized surface chain settles between edits),
    // then resolves with the final payload text.
    function streamingRunAgent(deltas: string[], finalText: string) {
      return vi.fn().mockImplementation(async (params) => {
        for (const d of deltas) {
          params.onEvent?.({ type: "text", data: d });
          // Yield so queued preview sends/edits run between deltas.
          await Promise.resolve();
        }
        return {
          payloads: [{ text: finalText }],
          meta: { durationMs: 1, sessionId: "s1" },
        };
      });
    }

    it("sends one live message then edits it as breakpoints arrive", async () => {
      // Three sentences -> at least the first new send + later edits, far fewer
      // than the number of deltas.
      const deltas = [
        "The quick brown fox jumps. ",
        "Over the lazy dog every day. ",
        "And then it finally rests here.\n",
      ];
      const runAgent = streamingRunAgent(deltas, "final clean text");
      setTelegramContext({ runAgent } as never);

      let nextId = 500;
      const send = vi.fn().mockImplementation(async () => nextId++);
      const editMessage = vi.fn().mockResolvedValue(undefined);

      await handleTelegramMessage(
        makeData(),
        { agent, logPrefix: "[t]" },
        send,
        { editMessage },
        allowAll
      );

      // First live snapshot is a brand-new plain-text message (no parse mode).
      expect(send).toHaveBeenCalled();
      expect(send.mock.calls[0][1]).toBeUndefined();
      // Subsequent previews edit that same message id.
      expect(editMessage).toHaveBeenCalled();
      expect(editMessage.mock.calls[0][0]).toBe(500);

      // The very last edit promotes the preview to the final HTML render.
      const lastEdit = editMessage.mock.calls[editMessage.mock.calls.length - 1];
      expect(lastEdit[0]).toBe(500);
      expect(lastEdit[1]).toBe(renderMarkdown("final clean text"));
      expect(lastEdit[2]).toMatchObject({ parseMode: "HTML" });
    });

    it("edits far fewer times than there are deltas (coalescing)", async () => {
      // Twenty tiny word deltas across a few sentences.
      const deltas = [
        "Alpha ", "beta ", "gamma ", "delta epsilon zeta. ",
        "Eta ", "theta ", "iota ", "kappa lambda mu nu. ",
        "Xi ", "omicron ", "pi rho sigma tau upsilon.\n",
      ];
      const runAgent = streamingRunAgent(deltas, "rendered final");
      setTelegramContext({ runAgent } as never);
      const send = vi.fn().mockResolvedValue(700);
      const editMessage = vi.fn().mockResolvedValue(undefined);

      await handleTelegramMessage(
        makeData(),
        { agent, logPrefix: "[t]" },
        send,
        { editMessage },
        allowAll
      );

      const writes = send.mock.calls.length + editMessage.mock.calls.length;
      expect(writes).toBeLessThan(deltas.length);
    });

    it("the final message is the clean rendered version via the renderer", async () => {
      const runAgent = streamingRunAgent(
        ["Streaming **partial** preview text here. "],
        "Final **bold** answer"
      );
      setTelegramContext({ runAgent } as never);
      const send = vi.fn().mockResolvedValue(800);
      const editMessage = vi.fn().mockResolvedValue(undefined);

      await handleTelegramMessage(
        makeData(),
        { agent, logPrefix: "[t]" },
        send,
        { editMessage },
        allowAll
      );

      const lastEdit =
        editMessage.mock.calls[editMessage.mock.calls.length - 1];
      // Final render goes through renderMarkdown and carries HTML parse mode.
      expect(lastEdit[1]).toBe(renderMarkdown("Final **bold** answer"));
      expect(lastEdit[1]).toContain("<b>bold</b>");
      expect(lastEdit[2]).toMatchObject({ parseMode: "HTML" });
    });

    it("falls back to a fresh rendered send when no edit hook is wired", async () => {
      const runAgent = streamingRunAgent(
        ["some streamed text that never surfaces live. "],
        "plain final"
      );
      setTelegramContext({ runAgent } as never);
      const send = vi.fn().mockResolvedValue(undefined);

      await handleTelegramMessage(
        makeData(),
        { agent, logPrefix: "[t]" },
        send,
        {}, // no editMessage hook
        allowAll
      );

      // Without streaming, the only write is the final rendered reply.
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith(
        renderMarkdown("plain final"),
        expect.objectContaining({ parseMode: "HTML" })
      );
    });

    it("continues the turn when a preview edit fails", async () => {
      const runAgent = streamingRunAgent(
        [
          "First full sentence is here. ",
          "Second full sentence follows after.\n",
        ],
        "final answer"
      );
      setTelegramContext({ runAgent } as never);
      const send = vi.fn().mockResolvedValue(900);
      // Every edit rejects (e.g. transient 429) — streaming must degrade, not throw.
      const editMessage = vi.fn().mockRejectedValue(new Error("rate limited"));

      await handleTelegramMessage(
        makeData(),
        { agent, logPrefix: "[t]" },
        send,
        { editMessage },
        allowAll
      );

      // The first preview was sent; after the edit failure streaming is
      // disabled, so the final clean render is delivered as a fresh send.
      expect(send.mock.calls.length).toBeGreaterThanOrEqual(2);
      const finalSend = send.mock.calls[send.mock.calls.length - 1];
      expect(finalSend[0]).toBe(renderMarkdown("final answer"));
      expect(finalSend[1]).toMatchObject({ parseMode: "HTML" });
    });
  });

  describe("opt-in tool-call visibility", () => {
    // A runAgent mock that fires the given tool events through onEvent, then
    // resolves with a final reply payload.
    function toolEventRunAgent(
      events: Array<Record<string, unknown>>,
      finalText = "done"
    ) {
      return vi.fn().mockImplementation(async (params) => {
        for (const e of events) {
          params.onEvent?.(e);
          await Promise.resolve();
        }
        return {
          payloads: [{ text: finalText }],
          meta: { durationMs: 1, sessionId: "s1" },
        };
      });
    }

    const toolEvents = [
      {
        type: "tool_call",
        id: "1",
        name: "search_files",
        arguments: { path: "a.ts" },
      },
      {
        type: "tool_result",
        id: "1",
        name: "search_files",
        content: "ok",
        isError: false,
      },
    ];

    it("surfaces one-line tool-call notes only when enabled", async () => {
      const runAgent = toolEventRunAgent(toolEvents, "the reply");
      setTelegramContext({ runAgent } as never);
      const send = vi.fn().mockResolvedValue(1);

      await handleTelegramMessage(
        makeData(),
        { agent, logPrefix: "[t]" },
        send,
        {},
        allowAll,
        { showToolCalls: true }
      );

      const noteSends = send.mock.calls.filter(
        ([text]) => typeof text === "string" && text.includes("search_files")
      );
      expect(noteSends.length).toBeGreaterThan(0);
      // Notes are plain text (no parse mode).
      for (const call of noteSends) expect(call[1]).toBeUndefined();
      // Both the call and its result are surfaced as one-line notes.
      const combined = noteSends.map(([t]) => t).join("\n");
      expect(combined).toContain("\uD83D\uDD27 search_files (a.ts)");
      expect(combined).toContain("\u2713 search_files");
    });

    it("is OFF by default \u2014 no tool-call output, only the reply", async () => {
      const runAgent = toolEventRunAgent(toolEvents, "just the reply");
      setTelegramContext({ runAgent } as never);
      const send = vi.fn().mockResolvedValue(1);

      // No options arg at all: visibility must default to off.
      await handleTelegramMessage(
        makeData(),
        { agent, logPrefix: "[t]" },
        send,
        {},
        allowAll
      );

      // No note ever mentions a tool name.
      const anyNote = send.mock.calls.some(
        ([text]) => typeof text === "string" && text.includes("search_files")
      );
      expect(anyNote).toBe(false);
      // The agent's reply is still delivered.
      const reply = send.mock.calls.find(
        ([text]) =>
          typeof text === "string" && text.includes("just the reply")
      );
      expect(reply).toBeDefined();
    });

    it("explicit showToolCalls: false behaves like the default (off)", async () => {
      const runAgent = toolEventRunAgent(toolEvents, "reply");
      setTelegramContext({ runAgent } as never);
      const send = vi.fn().mockResolvedValue(1);

      await handleTelegramMessage(
        makeData(),
        { agent, logPrefix: "[t]" },
        send,
        {},
        allowAll,
        { showToolCalls: false }
      );

      const anyNote = send.mock.calls.some(
        ([text]) => typeof text === "string" && text.includes("search_files")
      );
      expect(anyNote).toBe(false);
    });

    it("coalesces a burst of tool calls into far fewer note messages", async () => {
      const burst = Array.from({ length: 12 }, (_, i) => ({
        type: "tool_call" as const,
        id: String(i),
        name: `tool_${i}`,
        arguments: {},
      }));
      const runAgent = toolEventRunAgent(burst, "reply");
      setTelegramContext({ runAgent } as never);
      const send = vi.fn().mockResolvedValue(1);

      await handleTelegramMessage(
        makeData(),
        { agent, logPrefix: "[t]" },
        send,
        {},
        allowAll,
        { showToolCalls: true }
      );

      const noteSends = send.mock.calls.filter(
        ([text]) => typeof text === "string" && text.includes("\uD83D\uDD27 tool_")
      );
      // Twelve tool calls must not produce twelve messages.
      expect(noteSends.length).toBeLessThan(burst.length);
      // Every tool call still appears somewhere across the batched notes.
      const combined = noteSends.map(([t]) => t).join("\n");
      for (let i = 0; i < burst.length; i++) {
        expect(combined).toContain(`\uD83D\uDD27 tool_${i}`);
      }
    });
  });

  it("sends an error message when the run throws", async () => {
    const runAgent = vi.fn().mockRejectedValue(new Error("boom"));
    setTelegramContext({ runAgent } as never);
    const send = vi.fn().mockResolvedValue(undefined);

    await handleTelegramMessage(
      makeData(),
      { agent, logPrefix: "[t]" },
      send,
      {},
      allowAll
    );

    expect(send).toHaveBeenCalledWith(
      "Sorry, I encountered an error processing your message."
    );
  });

  it("ignores an unauthorized user without running the agent", async () => {
    const runAgent = vi.fn();
    setTelegramContext({ runAgent } as never);
    const send = vi.fn();

    await handleTelegramMessage(
      makeData({ userId: 7 }),
      { agent, logPrefix: "[t]" },
      send,
      {},
      allowAll
    );

    expect(runAgent).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("ignores unaddressed group messages without running the agent", async () => {
    const runAgent = vi.fn();
    setTelegramContext({ runAgent } as never);
    const send = vi.fn();

    await handleTelegramMessage(
      makeData({ chatType: "supergroup", isAddressed: false }),
      { agent, logPrefix: "[t]" },
      send,
      {},
      allowAll
    );

    expect(runAgent).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("dispatches an addressed group message to the shared per-chat session", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      payloads: [{ text: "group reply" }],
      meta: { durationMs: 1, sessionId: "s1" },
    });
    setTelegramContext({ runAgent } as never);
    const send = vi.fn().mockResolvedValue(undefined);

    await handleTelegramMessage(
      makeData({ chatId: -100200, chatType: "supergroup", isAddressed: true }),
      { agent, logPrefix: "[t]" },
      send,
      {},
      { allowedUsers: [42], allowedChats: [-100200] }
    );

    expect(runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        sessionKey: "telegram:-100200",
        source: "telegram",
      })
    );
    expect(send).toHaveBeenCalledWith(
      "group reply",
      expect.objectContaining({ parseMode: "HTML" })
    );
  });

  it("keeps DMs isolated on the main session", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      payloads: [{ text: "dm reply" }],
      meta: { durationMs: 1, sessionId: "s1" },
    });
    setTelegramContext({ runAgent } as never);
    const send = vi.fn().mockResolvedValue(undefined);

    await handleTelegramMessage(
      makeData({ chatId: 777 }),
      { agent, logPrefix: "[t]" },
      send,
      {},
      { allowedUsers: [42], allowedChats: [777] }
    );

    expect(runAgent).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: DEFAULT_MAIN_KEY })
    );
  });

  it("starts typing when the turn begins and re-triggers after each send", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      payloads: [{ text: "part one" }, { text: "part two" }],
      meta: { durationMs: 1, sessionId: "s1" },
    });
    setTelegramContext({ runAgent } as never);
    const send = vi.fn().mockResolvedValue(undefined);
    const sendTyping = vi.fn().mockResolvedValue(undefined);

    await handleTelegramMessage(
      makeData(),
      { agent, logPrefix: "[t]" },
      send,
      { sendTyping },
      allowAll
    );

    // 1 initial start + 1 poke per delivered message.
    expect(sendTyping).toHaveBeenCalledTimes(3);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("stops typing on a queued run without leaking the keep-alive loop", async () => {
    vi.useFakeTimers();
    try {
      const runAgent = vi.fn().mockResolvedValue({
        payloads: [{ text: "ignored" }],
        meta: { durationMs: 1, sessionId: "s1", queued: true },
      });
      setTelegramContext({ runAgent } as never);
      const send = vi.fn().mockResolvedValue(undefined);
      const sendTyping = vi.fn().mockResolvedValue(undefined);

      await handleTelegramMessage(
        makeData(),
        { agent, logPrefix: "[t]" },
        send,
        { sendTyping },
        allowAll
      );

      const callsAfterTurn = sendTyping.mock.calls.length;
      vi.advanceTimersByTime(10000);
      expect(sendTyping).toHaveBeenCalledTimes(callsAfterTurn);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops typing when the run throws", async () => {
    vi.useFakeTimers();
    try {
      const runAgent = vi.fn().mockRejectedValue(new Error("boom"));
      setTelegramContext({ runAgent } as never);
      const send = vi.fn().mockResolvedValue(undefined);
      const sendTyping = vi.fn().mockResolvedValue(undefined);

      await handleTelegramMessage(
        makeData(),
        { agent, logPrefix: "[t]" },
        send,
        { sendTyping },
        allowAll
      );

      const callsAfterError = sendTyping.mock.calls.length;
      vi.advanceTimersByTime(10000);
      // Loop stopped in finally: no further refreshes after the error.
      expect(sendTyping).toHaveBeenCalledTimes(callsAfterError);
    } finally {
      vi.useRealTimers();
    }
  });

  describe("reset commands", () => {
    function resetContext() {
      const runAgent = vi.fn();
      const clearSessionEntry = vi.fn().mockResolvedValue({
        sessionId: "old-session",
        updatedAt: 1,
        createdAt: 1,
      });
      const deleteSession = vi.fn();
      const invalidateHistoryCache = vi.fn().mockResolvedValue(undefined);
      setTelegramContext({
        runAgent,
        clearSessionEntry,
        deleteSession,
        invalidateHistoryCache,
      } as never);
      return {
        runAgent,
        clearSessionEntry,
        deleteSession,
        invalidateHistoryCache,
      };
    }

    it("clears the DM session and confirms without running the agent", async () => {
      const ctx = resetContext();
      const send = vi.fn().mockResolvedValue(undefined);

      await handleTelegramMessage(
        makeData({ text: "/new" }),
        { agent, logPrefix: "[t]" },
        send,
        {},
        allowAll
      );

      expect(ctx.clearSessionEntry).toHaveBeenCalledWith(
        "main",
        DEFAULT_MAIN_KEY
      );
      expect(ctx.deleteSession).toHaveBeenCalledWith("main", "old-session");
      expect(ctx.invalidateHistoryCache).toHaveBeenCalledWith(
        "main",
        "old-session"
      );
      expect(ctx.runAgent).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledWith("Context cleared, new session started.");
    });

    it("clears the shared group session for a /new in a group chat", async () => {
      const ctx = resetContext();
      const send = vi.fn().mockResolvedValue(undefined);

      await handleTelegramMessage(
        makeData({
          chatId: -100200,
          chatType: "supergroup",
          isAddressed: true,
          text: "/new@my_bot",
        }),
        { agent, logPrefix: "[t]" },
        send,
        {},
        { allowedUsers: [42], allowedChats: [-100200] }
      );

      expect(ctx.clearSessionEntry).toHaveBeenCalledWith(
        "main",
        "telegram:-100200"
      );
      expect(ctx.runAgent).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledWith("Context cleared, new session started.");
    });

    it("treats /reset as a reset command", async () => {
      const ctx = resetContext();
      const send = vi.fn().mockResolvedValue(undefined);

      await handleTelegramMessage(
        makeData({ text: "/reset" }),
        { agent, logPrefix: "[t]" },
        send,
        {},
        allowAll
      );

      expect(ctx.clearSessionEntry).toHaveBeenCalled();
      expect(ctx.runAgent).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledWith("Context cleared, new session started.");
    });

    it("still confirms when there is no existing session to clear", async () => {
      const ctx = resetContext();
      ctx.clearSessionEntry.mockResolvedValue(undefined);
      const send = vi.fn().mockResolvedValue(undefined);

      await handleTelegramMessage(
        makeData({ text: "/new" }),
        { agent, logPrefix: "[t]" },
        send,
        {},
        allowAll
      );

      expect(ctx.deleteSession).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledWith("Context cleared, new session started.");
    });

    it("surfaces a friendly error when clearing the session fails", async () => {
      const ctx = resetContext();
      ctx.clearSessionEntry.mockRejectedValue(new Error("boom"));
      const send = vi.fn().mockResolvedValue(undefined);

      await handleTelegramMessage(
        makeData({ text: "/new" }),
        { agent, logPrefix: "[t]" },
        send,
        {},
        allowAll
      );

      expect(send).toHaveBeenCalledWith(
        "Sorry, I couldn't start a new session. Please try again."
      );
      expect(ctx.runAgent).not.toHaveBeenCalled();
    });

    it("does not treat a message that merely starts with new as a reset", async () => {
      const runAgent = vi.fn().mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: { durationMs: 1, sessionId: "s1" },
      });
      const clearSessionEntry = vi.fn();
      setTelegramContext({ runAgent, clearSessionEntry } as never);
      const send = vi.fn().mockResolvedValue(undefined);

      await handleTelegramMessage(
        makeData({ text: "/news please" }),
        { agent, logPrefix: "[t]" },
        send,
        {},
        allowAll
      );

      expect(clearSessionEntry).not.toHaveBeenCalled();
      expect(runAgent).toHaveBeenCalledWith(
        expect.objectContaining({ message: "/news please" })
      );
    });
  });
});
