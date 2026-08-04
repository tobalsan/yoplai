import { describe, expect, it, vi } from "vitest";
import type {
  AgentConfig,
  DeliverySink,
  ExtensionContext,
} from "@yoplai/shared";
import {
  DELIVERY_TIMEOUT_MS,
  MAX_DELIVERY_CHARS,
  deliverRunResult,
  deliveryText,
  type DeliveryRun,
} from "./deliver.js";

const agent: AgentConfig = {
  id: "alpha",
  name: "alpha",
  workspace: "/tmp/alpha",
  model: { provider: "test", model: "test" },
  queueMode: "queue",
};

function context(sinks: Record<string, DeliverySink>) {
  const warn = vi.fn();
  const ctx = {
    getDeliverySink: (id: string) => sinks[id],
    logger: { info: vi.fn(), warn, error: vi.fn() },
  } as unknown as ExtensionContext;
  return { ctx, warn };
}

function run(overrides: Partial<DeliveryRun> = {}): DeliveryRun {
  return { jobName: "Digest", status: "ok", ...overrides };
}

describe("deliveryText", () => {
  it("delivers the agent response of a successful run", () => {
    expect(deliveryText(run({ response: "  Two new rows.\n" }))).toBe(
      "Two new rows."
    );
  });

  it("delivers nothing for empty script stdout", () => {
    expect(deliveryText(run({ response: "  \n" }))).toBeUndefined();
    expect(deliveryText(run({}))).toBeUndefined();
  });

  it("delivers nothing for a silent tick", () => {
    expect(
      deliveryText(run({ silentTick: true, response: "silent tick" }))
    ).toBeUndefined();
  });

  it("always delivers an alert naming the job and the error", () => {
    expect(
      deliveryText(
        run({ status: "error", errorMessage: "script failed (exit 3)\nboom" })
      )
    ).toBe('Cron job "Digest" failed:\nscript failed (exit 3)\nboom');
  });

  it("falls back to a generic alert when the error has no message", () => {
    expect(deliveryText(run({ status: "error" }))).toBe(
      'Cron job "Digest" failed:\nScheduler job failed'
    );
  });

  it("truncates an oversized result with a marker", () => {
    const text = deliveryText(run({ response: "x".repeat(10_000) }));

    expect(text).toHaveLength(MAX_DELIVERY_CHARS);
    expect(text!.endsWith("\n[truncated]")).toBe(true);
  });

  it("does not cut an oversized result mid-character", () => {
    const text = deliveryText(run({ response: "🙂".repeat(10_000) }))!;

    expect(text.endsWith("\n[truncated]")).toBe(true);
    expect(/[\uD800-\uDBFF]\n\[truncated\]$/.test(text)).toBe(false);
  });
});

describe("deliverRunResult", () => {
  it("pushes the text to every configured target", async () => {
    const slack = vi.fn(async () => {});
    const telegram = vi.fn(async () => {});
    const { ctx } = context({ slack, telegram });

    const outcomes = await deliverRunResult({
      ctx,
      agent,
      targets: [
        { target: "slack", channel: "C0123" },
        { target: "telegram", user: "12345" },
      ],
      run: run({ response: "Two new rows." }),
    });

    expect(slack).toHaveBeenCalledWith({
      agent,
      destination: { channel: "C0123", user: undefined },
      text: "Two new rows.",
    });
    expect(telegram).toHaveBeenCalledWith({
      agent,
      destination: { channel: undefined, user: "12345" },
      text: "Two new rows.",
    });
    expect(outcomes).toEqual([
      { target: "slack", ok: true },
      { target: "telegram", ok: true },
    ]);
  });

  it("never calls a sink when the run delivers nothing", async () => {
    const slack = vi.fn(async () => {});
    const { ctx } = context({ slack });

    const outcomes = await deliverRunResult({
      ctx,
      agent,
      targets: [{ target: "slack", channel: "C0123" }],
      run: run({ silentTick: true, response: "silent tick" }),
    });

    expect(slack).not.toHaveBeenCalled();
    expect(outcomes).toEqual([]);
  });

  it("records a warning for a target with no registered sink", async () => {
    const { ctx, warn } = context({});

    const outcomes = await deliverRunResult({
      ctx,
      agent,
      targets: [{ target: "irc", channel: "#ops" }],
      run: run({ response: "Done." }),
    });

    expect(outcomes).toEqual([
      {
        target: "irc",
        ok: false,
        error: 'no delivery sink registered for "irc"',
      },
    ]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('no delivery sink registered for "irc"')
    );
  });

  it("keeps delivering to the remaining targets when a sink throws", async () => {
    const slack = vi.fn(async () => {
      throw new Error("missing scope");
    });
    const telegram = vi.fn(async () => {});
    const { ctx, warn } = context({ slack, telegram });

    const outcomes = await deliverRunResult({
      ctx,
      agent,
      targets: [
        { target: "slack", channel: "C0123" },
        { target: "telegram", user: "12345" },
      ],
      run: run({ response: "Done." }),
    });

    expect(telegram).toHaveBeenCalledTimes(1);
    expect(outcomes).toEqual([
      { target: "slack", ok: false, error: "missing scope" },
      { target: "telegram", ok: true },
    ]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Delivery to slack failed: missing scope")
    );
  });

  it("times out a hung sink instead of waiting forever", async () => {
    vi.useFakeTimers();
    try {
      const slack = vi.fn(() => new Promise<void>(() => {}));
      const telegram = vi.fn(async () => {});
      const { ctx, warn } = context({ slack, telegram });

      const pending = deliverRunResult({
        ctx,
        agent,
        targets: [
          { target: "slack", channel: "C0123" },
          { target: "telegram", user: "12345" },
        ],
        run: run({ response: "Done." }),
      });
      await vi.advanceTimersByTimeAsync(DELIVERY_TIMEOUT_MS + 1);

      await expect(pending).resolves.toEqual([
        {
          target: "slack",
          ok: false,
          error: `delivery timed out after ${DELIVERY_TIMEOUT_MS}ms`,
        },
        { target: "telegram", ok: true },
      ]);
      expect(telegram).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Delivery to slack failed: delivery timed out")
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does nothing when the job has no targets", async () => {
    const { ctx } = context({});

    await expect(
      deliverRunResult({ ctx, agent, run: run({ response: "Done." }) })
    ).resolves.toEqual([]);
  });
});
