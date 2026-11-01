import { describe, expect, it } from "vitest";
import type { ModelRoutingRow } from "@yoplai/shared";
import { selectPool, type PoolSnapshots } from "./pool.js";

const row: ModelRoutingRow = {
  id: "work", definition: "Work", examples: ["Do work"], pool: "either",
  claude: { provider: "anthropic", model: "claude-sonnet-4-5", effort: "high" },
  chatgpt: { provider: "openai", model: "gpt-4o-mini", effort: "low" },
};
const known: PoolSnapshots = {
  claude: { status: "known", exhausted: false, pace: 0.5 },
  chatgpt: { status: "known", exhausted: false, pace: 0.8 },
};

describe("routing pool selection", () => {
  it("uses the lower weekly pace when neither pool has an exhausted 5h window", () => {
    expect(selectPool(row, known)).toEqual({ pool: "claude", reason: "pace" });
  });

  it("leaves exhausted pools out of the pick, including when both are exhausted", () => {
    expect(selectPool(row, { ...known, claude: { status: "known", exhausted: true, pace: 0.1 } }))
      .toEqual({ pool: "chatgpt", reason: "5h-exhausted" });
    expect(selectPool(row, { ...known, chatgpt: { status: "known", exhausted: true, pace: 0.1 } }))
      .toEqual({ pool: "claude", reason: "5h-exhausted" });
    expect(selectPool(row, {
      claude: { status: "known", exhausted: true, pace: 0.5 },
      chatgpt: { status: "known", exhausted: true, pace: 0.8 },
    })).toEqual({ reason: "both-5h-exhausted" });
  });

  it.each([
    ["prefer_claude", 1.15, 0.1, "claude", "preference"],
    ["prefer_claude", 1.16, 0.1, "chatgpt", "pace"],
    ["prefer_chatgpt", 0.1, 1.15, "chatgpt", "preference"],
    ["prefer_chatgpt", 0.1, 1.16, "claude", "pace"],
  ] as const)("honors %s at paces %s/%s", (pool, claudePace, chatgptPace, expectedPool, reason) => {
    expect(selectPool({ ...row, pool }, {
      claude: { status: "known", exhausted: false, pace: claudePace },
      chatgpt: { status: "known", exhausted: false, pace: chatgptPace },
    })).toEqual({ pool: expectedPool, reason });
  });

  it("uses the configured pace threshold rather than a fixed threshold", () => {
    expect(selectPool({ ...row, pool: "prefer_claude" }, {
      ...known, claude: { status: "known", exhausted: false, pace: 1.2 },
    }, 1.25)).toEqual({ pool: "claude", reason: "preference" });
  });

  it.each([
    ["either", { reason: "quota-unknown" }],
    ["prefer_claude", { pool: "claude", reason: "quota-unknown" }],
    ["prefer_chatgpt", { pool: "chatgpt", reason: "quota-unknown" }],
  ] as const)("does not make quota switches for %s when a snapshot is unknown", (pool, expected) => {
    expect(selectPool({ ...row, pool }, {
      claude: { status: "known", exhausted: true, pace: 2 },
      chatgpt: { status: "unknown" },
    })).toEqual(expected);
  });

  it("records stale quota and does not switch away from the configured preference", () => {
    expect(selectPool({ ...row, pool: "prefer_chatgpt" }, {
      claude: { status: "unknown", reason: "stale" },
      chatgpt: { status: "known", exhausted: true, pace: 2 },
    })).toEqual({ pool: "chatgpt", reason: "quota-stale" });
    expect(selectPool(row, {
      claude: { status: "unknown", reason: "stale" },
      chatgpt: known.chatgpt,
    })).toEqual({ reason: "quota-stale" });
  });

  it("makes no either pick without two usable weekly paces", () => {
    expect(selectPool(row, {
      claude: { status: "known", exhausted: false },
      chatgpt: known.chatgpt,
    })).toEqual({ reason: "quota-unknown" });
    expect(selectPool(row, {
      claude: known.claude,
      chatgpt: { status: "known", exhausted: false },
    })).toEqual({ reason: "quota-unknown" });
  });

  it("uses the only configured pick without a quota-based switch", () => {
    expect(selectPool({ pool: "prefer_chatgpt", claude: row.claude }, {
      claude: { status: "known", exhausted: true, pace: 2 },
      chatgpt: known.chatgpt,
    })).toEqual({ pool: "claude", reason: "single-pick" });
    expect(selectPool({ pool: "either", chatgpt: row.chatgpt }, {
      claude: { status: "unknown" }, chatgpt: { status: "unknown" },
    })).toEqual({ pool: "chatgpt", reason: "single-pick" });
  });
});
