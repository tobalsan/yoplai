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

  it("shows descriptive safe milestones without exposing raw detail", async () => {
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
      display.milestone("Investigating invoice mismatch");
      await Promise.resolve();
      expect(client.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({ text: "Investigating invoice mismatch…" })
      );
      await vi.advanceTimersByTimeAsync(1_000);
      display.milestone("  Running   tests on reconciliation.  ");
      await Promise.resolve();
      expect(client.chat.update).toHaveBeenLastCalledWith(
        expect.objectContaining({ text: "Running tests on reconciliation…" })
      );
      await vi.advanceTimersByTimeAsync(1_000);
      display.milestone("Read /Users/alice/.ssh/id_ed25519 secret=should-not-appear");
      await Promise.resolve();
      expect(client.chat.update).toHaveBeenLastCalledWith(
        expect.objectContaining({ text: "Checking progress…" })
      );
      expect(client.chat.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("id_ed25519") })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["Checking https://example.com?token=abc", "Checking progress…"],
    ["Testing API_KEY=should-not-appear", "Running tests…"],
    ["Reviewing `tool({ secret: true })`", "Reviewing changes…"],
    ["Inspecting files\nsensitive detail", "Checking progress…"],
    [`Building ${"x".repeat(101)}`, "Implementing changes…"],
  ])("falls back for unsafe milestone %s", async (label, expected) => {
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
    display.milestone(label);
    await Promise.resolve();
    expect(client.chat.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: expected })
    );
  });

  it("heartbeats 30 seconds after a milestone instead of waiting for the original interval", async () => {
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
      await vi.advanceTimersByTimeAsync(1_000);
      display.milestone("Checking files");
      await vi.advanceTimersByTimeAsync(30_000);

      expect(client.chat.update).toHaveBeenLastCalledWith(
        expect.objectContaining({ text: "Still working…" })
      );
    } finally {
      vi.useRealTimers();
    }
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
