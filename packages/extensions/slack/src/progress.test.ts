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

  it("cancels a pending publish retry and posts nothing when finished before an initial post succeeds", async () => {
    vi.useFakeTimers();
    try {
      const client = { chat: { postMessage: vi.fn().mockRejectedValueOnce(new Error("temporary")).mockResolvedValue({ ts: "progress-ts" }), update: vi.fn().mockResolvedValue({}) } };
      const display = createSlackProgressDisplay({ client: client as never, channel: "C1", threadTs: "1.0", logPrefix: "[test]" });
      await display.publish();
      await display.finish("interrupted");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(client.chat.postMessage).toHaveBeenCalledOnce();
      expect(client.chat.update).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("posts nothing when the run finishes before the publish delay elapses", async () => {
    vi.useFakeTimers();
    try {
      const client = {
        chat: {
          postMessage: vi.fn().mockResolvedValue({ ts: "progress-ts" }),
          update: vi.fn().mockResolvedValue({}),
        },
      };
      const store = { add: vi.fn(), remove: vi.fn(), touch: vi.fn() };
      const display = createSlackProgressDisplay({
        client: client as never,
        channel: "C1",
        threadTs: "1.0",
        logPrefix: "[test]",
        store: store as never,
      });
      display.start();
      await display.finish("completed");
      await vi.advanceTimersByTimeAsync(30_000);

      expect(client.chat.postMessage).not.toHaveBeenCalled();
      expect(client.chat.update).not.toHaveBeenCalled();
      expect(store.add).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes only after the publish delay elapses, then behaves normally", async () => {
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
      display.start();
      expect(client.chat.postMessage).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(30_000);

      expect(client.chat.postMessage).toHaveBeenCalledOnce();
      expect(client.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ thread_ts: "1.0", text: "Working on it…" })
      );

      await vi.advanceTimersByTimeAsync(30_000);
      expect(client.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({ text: "Still working…" })
      );
      await display.finish("completed");
      expect(client.chat.update).toHaveBeenLastCalledWith(
        expect.objectContaining({ text: "Completed." })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes immediately with the safe milestone text when a milestone lands before the delay", async () => {
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
      display.start();
      display.milestone("Investigating invoice mismatch");
      await Promise.resolve();
      await Promise.resolve();

      expect(client.chat.postMessage).toHaveBeenCalledOnce();
      expect(client.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          thread_ts: "1.0",
          text: "Investigating invoice mismatch…",
        })
      );

      // The cancelled start() timer must not trigger a second post.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(client.chat.postMessage).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("omits thread_ts entirely when no threadTs is provided", async () => {
    const client = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ts: "progress-ts" }),
        update: vi.fn().mockResolvedValue({}),
      },
    };
    const display = createSlackProgressDisplay({
      client: client as never,
      channel: "C1",
      logPrefix: "[test]",
    });
    await display.publish();

    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.not.objectContaining({ thread_ts: expect.anything() })
    );
  });

  it("shares one postMessage/store.add between two rapid milestone() calls", async () => {
    const store = {
      add: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
      touch: vi.fn().mockResolvedValue(undefined),
    };
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
      store: store as never,
    });
    // Both calls happen before the first postMessage promise can settle.
    display.milestone("Investigating invoice mismatch");
    display.milestone("Running tests on reconciliation");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(client.chat.postMessage).toHaveBeenCalledOnce();
    expect(store.add).toHaveBeenCalledOnce();
  });

  it("finishes correctly when finish() runs while the initial publish is still in flight", async () => {
    let resolvePost: ((value: { ts: string }) => void) | undefined;
    const store = {
      add: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
      touch: vi.fn().mockResolvedValue(undefined),
    };
    const client = {
      chat: {
        postMessage: vi
          .fn()
          .mockImplementation(
            () => new Promise<{ ts: string }>((resolve) => { resolvePost = resolve; })
          ),
        update: vi.fn().mockResolvedValue({}),
      },
    };
    const display = createSlackProgressDisplay({
      client: client as never,
      channel: "C1",
      threadTs: "1.0",
      logPrefix: "[test]",
      store: store as never,
    });
    const publishPromise = display.publish();
    const finishPromise = display.finish("completed");
    resolvePost?.({ ts: "progress-ts" });
    const [, shown] = await Promise.all([publishPromise, finishPromise]);

    expect(shown).toBe(true);
    expect(client.chat.postMessage).toHaveBeenCalledOnce();
    expect(client.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({ ts: "progress-ts", text: "Completed." })
    );
    // Never edited with a non-terminal "Working on it…" bubble left dangling.
    expect(client.chat.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: "Working on it…" })
    );
    expect(store.add).toHaveBeenCalledOnce();
    expect(store.remove).toHaveBeenCalledWith("progress-ts");
  });

  it("does not heartbeat immediately after a delayed publish, only after a full interval of silence", async () => {
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
      display.start();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(client.chat.postMessage).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(1_000);
      expect(client.chat.update).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(29_000);
      expect(client.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({ text: "Still working…" })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves finish() false when nothing was ever posted, true when it terminal-edits", async () => {
    const client = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ts: "progress-ts" }),
        update: vi.fn().mockResolvedValue({}),
      },
    };
    const neverPublished = createSlackProgressDisplay({
      client: client as never,
      channel: "C1",
      threadTs: "1.0",
      logPrefix: "[test]",
    });
    await expect(neverPublished.finish("waiting")).resolves.toBe(false);

    const published = createSlackProgressDisplay({
      client: client as never,
      channel: "C1",
      threadTs: "1.0",
      logPrefix: "[test]",
    });
    await published.publish();
    await expect(published.finish("completed")).resolves.toBe(true);
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
