// @vitest-environment jsdom
import { createRoot } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import type { FullHistoryMessage } from "../api/types";
import { createChatRuntime } from "./chat-runtime";

describe("createChatRuntime", () => {
  it("stages supported files and rejects unsupported files", () => {
    createRoot((dispose) => {
      URL.createObjectURL = vi.fn(() => "blob:preview");
      URL.revokeObjectURL = vi.fn();
      const runtime = createChatRuntime();

      runtime.attachFiles([
        new File(["ok"], "note.txt", { type: "text/plain" }),
        new File(["bad"], "archive.zip", { type: "application/zip" }),
      ]);

      expect(runtime.pendingFiles()).toHaveLength(1);
      expect(runtime.pendingFiles()[0].name).toBe("note.txt");
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
