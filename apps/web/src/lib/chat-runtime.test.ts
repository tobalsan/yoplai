// @vitest-environment jsdom
import { createRoot } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import type { FullHistoryMessage } from "../api/types";
import { createChatRuntime } from "./chat-runtime";
import type { SubscriptionCallbacks } from "../api/realtime";

describe("createChatRuntime", () => {
  it.each(["live", "reconnect"])("preserves %s tool parent identity through results", (source) => {
    createRoot((dispose) => {
      let callbacks: SubscriptionCallbacks = {};
      const runtime = createChatRuntime({
        subscribeToSession: (_agentId, _sessionKey, next) => {
          callbacks = next;
          return () => {};
        },
      });
      runtime.subscribe("agent-1", "main");
      if (source === "live") {
        callbacks.onToolCall?.("code-1/1", "deterministic_tool", {}, "code-1");
      } else {
        callbacks.onActiveTurn?.({ userText: null, userTimestamp: 1, startedAt: 1, thinking: "", text: "", toolCalls: [
          { id: "code-1/1", name: "deterministic_tool", arguments: {}, status: "done", parentToolCallId: "code-1" },
        ] });
      }
      callbacks.onToolResult?.("code-1/1", "deterministic_tool", "child result", false, undefined, "code-1");
      expect(runtime.streamingBlocks()).toEqual([
        expect.objectContaining({ type: "tool", id: "code-1/1", parentToolCallId: "code-1", status: "done", body: "child result", result: expect.objectContaining({ parentToolCallId: "code-1" }) }),
      ]);
      dispose();
    });
  });

  it.each(["reconnect", "refresh"])("keeps completed child results on %s without future events", (source) => {
    createRoot((dispose) => {
      let callbacks: SubscriptionCallbacks = {};
      const runtime = createChatRuntime({ subscribeToSession: (_id, _key, next) => {
        callbacks = next;
        return () => {};
      } });
      runtime.subscribe("agent-1", "main");
      if (source === "refresh") {
        callbacks.onToolCall?.("code-1/1", "deterministic_tool", {}, "code-1");
        callbacks.onToolResult?.("code-1/1", "deterministic_tool", "completed child result", false, undefined, "code-1");
      }
      callbacks.onActiveTurn?.({ userText: null, userTimestamp: 1, startedAt: 1, thinking: "", text: "", toolCalls: [
        { id: "code-1/1", name: "deterministic_tool", arguments: {}, status: "done", parentToolCallId: "code-1" },
      ], ...(source === "reconnect" ? { toolResults: [
        { id: "code-1/1", name: "deterministic_tool", content: "completed child result", isError: false, parentToolCallId: "code-1" },
      ] } : {}) });
      expect(runtime.streamingBlocks()).toEqual([
        expect.objectContaining({ id: "code-1/1", parentToolCallId: "code-1", status: "done", body: "completed child result", result: expect.objectContaining({ parentToolCallId: "code-1" }) }),
      ]);
      dispose();
    });
  });

  it("stages supported files and rejects unsupported files", () => {
    createRoot((dispose) => {
      URL.createObjectURL = vi.fn(() => "blob:preview");
      URL.revokeObjectURL = vi.fn();
      const runtime = createChatRuntime();

      runtime.attachFiles([
        new File(["ok"], "note.txt", { type: "text/plain" }),
        new File(["deck"], "deck.pptx", { type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" }),
        new File(["bad"], "archive.zip", { type: "application/zip" }),
      ]);

      expect(runtime.pendingFiles().map((file) => file.name)).toEqual(["note.txt", "deck.pptx"]);
      expect(runtime.uploadError()).toBe("Unsupported file type: archive.zip");

      runtime.clearFiles();
      expect(runtime.pendingFiles()).toHaveLength(0);
      dispose();
    });
  });

  it("loads history and snapshots an active turn", async () => {
    const fetchFullHistory = vi.fn(async () => ({
      messages: [],
      isStreaming: true,
      activeTurn: {
        userText: "hi",
        userTimestamp: 1,
        startedAt: 2,
        thinking: "plan",
        text: "hello",
        toolCalls: [
          {
            id: "tool-1",
            name: "read",
            arguments: { path: "README.md" },
            status: "running" as const,
          },
        ],
      },
    }));
    const subscribeToSession = vi.fn(() => () => {});

    await new Promise<void>((resolve) => {
      createRoot((dispose) => {
        const runtime = createChatRuntime({
          fetchFullHistory,
          getSessionKey: () => "main",
          subscribeToSession,
        });
        runtime.loadHistory({ agentId: "agent-1" }).then(() => {
          expect(runtime.isStreaming()).toBe(true);
          expect(runtime.streamingBlocks()).toEqual([
            { type: "thinking", content: "plan" },
            { type: "text", role: "assistant", content: "hello" },
            {
              type: "tool",
              id: "tool-1",
              toolName: "read",
              args: { path: "README.md" },
              status: "running",
            },
          ]);
          expect(subscribeToSession).toHaveBeenCalledWith(
            "agent-1",
            "main",
            expect.any(Object)
          );
          dispose();
          resolve();
        });
      });
    });
  });

  it("ignores an older history response for the same agent", async () => {
    let resolveFirst:
      | ((value: { messages: FullHistoryMessage[] }) => void)
      | undefined;
    const fetchFullHistory = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<{ messages: FullHistoryMessage[] }>((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockResolvedValueOnce({
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "new" }],
            timestamp: 2,
          },
        ],
      });

    await new Promise<void>((resolve) => {
      createRoot((dispose) => {
        const runtime = createChatRuntime({ fetchFullHistory });
        const firstLoad = runtime.loadHistory({
          agentId: "agent-1",
          sessionKey: "main",
        });
        const secondLoad = runtime.loadHistory({
          agentId: "agent-1",
          sessionKey: "main",
        });

        secondLoad.then(async () => {
          expect(runtime.messages()).toEqual([
            {
              role: "user",
              content: [{ type: "text", text: "new" }],
              timestamp: 2,
            },
          ]);
          resolveFirst?.({
            messages: [
              {
                role: "user",
                content: [{ type: "text", text: "old" }],
                timestamp: 1,
              },
            ],
          });
          await firstLoad;
          expect(runtime.messages()).toEqual([
            {
              role: "user",
              content: [{ type: "text", text: "new" }],
              timestamp: 2,
            },
          ]);
          dispose();
          resolve();
        });
      });
    });
  });

  it("uploads attachments and streams a send", async () => {
    const uploadFiles = vi.fn(async () => [
      {
        path: "/tmp/report.pdf",
        mimeType: "application/pdf",
        filename: "report.pdf",
        size: 12,
      },
    ]);
    const streamMessage = vi.fn(
      (_agentId, _text, _sessionKey, onText, onDone) => {
        onText("hello");
        onDone();
        return () => {};
      }
    );

    await new Promise<void>((resolve) => {
      createRoot((dispose) => {
        const runtime = createChatRuntime({
          getSessionKey: () => "main",
          uploadFiles,
          streamMessage,
        });
        const file = new File(["contents"], "report.pdf", {
          type: "application/pdf",
        });
        runtime.attachFiles([file]);
        runtime
          .send({
            agentId: "agent-1",
            text: "Review this",
            onUserMessage: (text, files) => {
              expect(text).toBe("Review this");
              expect(files?.[0]).toMatchObject({
                type: "file",
                filename: "report.pdf",
                direction: "inbound",
              });
            },
          })
          .then(() => {
            expect(uploadFiles).toHaveBeenCalledWith([file]);
            expect(streamMessage).toHaveBeenCalledWith(
              "agent-1",
              "Review this",
              "main",
              expect.any(Function),
              expect.any(Function),
              expect.any(Function),
              expect.any(Object),
              {
                attachments: [
                  {
                    path: "/tmp/report.pdf",
                    mimeType: "application/pdf",
                    filename: "report.pdf",
                    size: 12,
                  },
                ],
              }
            );
            expect(runtime.pendingFiles()).toHaveLength(0);
            dispose();
            resolve();
          });
      });
    });
  });
});
