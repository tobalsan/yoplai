import { describe, expect, it, vi } from "vitest";
import { createSlackProgressDisplay } from "./progress.js";

describe("Slack progress display", () => {
  it("posts once, heartbeats, and leaves one terminal update", async () => {
    vi.useFakeTimers();
    try {
      const client = {
        chat: {
          postMessage: vi.fn().mockResolvedValue({ ts: "progress-ts" }),
          update: vi.fn().mockResolvedValue({}),
        },
      };
      const display = createSlackProgressDisplay({
        client: client as never,
        channel: "C1",
        threadTs: "1.0",
        logPrefix: "[test]",
      });
      await display.publish();
      await vi.advanceTimersByTimeAsync(30_000);
      await display.finish("completed");

      expect(client.chat.postMessage).toHaveBeenCalledOnce();
      expect(client.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ thread_ts: "1.0", text: "Working on it…" })
      );
      expect(client.chat.update).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ text: "Still working…" })
      );
      expect(client.chat.update).toHaveBeenLastCalledWith(
        expect.objectContaining({ text: "Completed." })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not expose raw milestone content", async () => {
    const client = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ts: "progress-ts" }),
        update: vi.fn().mockResolvedValue({}),
      },
    };
    const display = createSlackProgressDisplay({
      client: client as never,
      channel: "C1",
      threadTs: "1.0",
      logPrefix: "[test]",
    });
    await display.publish();
    display.milestone("secret=should-not-appear");
    await Promise.resolve();
    expect(client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Progress updated." })
    );
  });

  it("retries a failed terminal update without affecting the run", async () => {
    vi.useFakeTimers();
    try {
      const client = {
        chat: {
          postMessage: vi.fn().mockResolvedValue({ ts: "progress-ts" }),
          update: vi
            .fn()
            .mockRejectedValueOnce(new Error("rate_limited"))
            .mockResolvedValue({}),
        },
      };
      const display = createSlackProgressDisplay({
        client: client as never,
        channel: "C1",
        threadTs: "1.0",
        logPrefix: "[test]",
      });
      await display.publish();
      await display.finish("failed");
      await vi.advanceTimersByTimeAsync(1_000);

      expect(client.chat.update).toHaveBeenCalledTimes(2);
      expect(client.chat.update).toHaveBeenLastCalledWith(
        expect.objectContaining({ text: "Failed." })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries an initial post and keeps a single progress message", async () => {
    vi.useFakeTimers();
    try {
      const client = {
        chat: {
          postMessage: vi.fn().mockRejectedValueOnce(new Error("rate_limited")).mockResolvedValue({ ts: "progress-ts" }),
          update: vi.fn().mockResolvedValue({}),
        },
      };
      const display = createSlackProgressDisplay({ client: client as never, channel: "C1", threadTs: "1.0", logPrefix: "[test]" });
      await display.publish();
      await vi.advanceTimersByTimeAsync(1_000);
      await display.finish("completed");
      expect(client.chat.postMessage).toHaveBeenCalledTimes(2);
      expect(client.chat.update).toHaveBeenLastCalledWith(expect.objectContaining({ text: "Completed." }));
    } finally { vi.useRealTimers(); }
  });

  it("applies a terminal state after a delayed initial post", async () => {
    vi.useFakeTimers();
    try {
      const client = { chat: { postMessage: vi.fn().mockRejectedValueOnce(new Error("temporary")).mockResolvedValue({ ts: "progress-ts" }), update: vi.fn().mockResolvedValue({}) } };
      const display = createSlackProgressDisplay({ client: client as never, channel: "C1", threadTs: "1.0", logPrefix: "[test]" });
      await display.publish();
      await display.finish("interrupted");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(client.chat.update).toHaveBeenLastCalledWith(expect.objectContaining({ text: "Interrupted." }));
    } finally { vi.useRealTimers(); }
  });

  it("sends the terminal state after an in-flight update", async () => {
    let resolveUpdate: (() => void) | undefined;
    const client = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ts: "progress-ts" }),
        update: vi
          .fn()
          .mockImplementationOnce(
            () => new Promise<void>((resolve) => { resolveUpdate = resolve; })
          )
          .mockResolvedValue({}),
      },
    };
    const display = createSlackProgressDisplay({
      client: client as never,
      channel: "C1",
      threadTs: "1.0",
      logPrefix: "[test]",
    });
    await display.publish();
    display.milestone("Checking files");
    const terminal = display.finish("completed");
    resolveUpdate?.();
    await terminal;
    await Promise.resolve();

    expect(client.chat.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: "Completed." })
    );
  });
});
