import { expect, it } from "vitest";
import { parseClaudeUsage } from "./parsers.js";

it.each([null, undefined])(
  "keeps weekly usage when the five-hour window is %s",
  (five_hour) => {
    expect(
      parseClaudeUsage({
        five_hour,
        seven_day: { utilization: 50, resets_at: "2026-11-03T06:00:00Z" },
      })
    ).toEqual({
      ok: true,
      windows: [
        {
          kind: "weekly",
          usedPercent: 50,
          resetAt: 1793685600,
          windowSeconds: 604800,
        },
      ],
    });
  }
);

it.each([null, undefined])(
  "keeps five-hour usage when the weekly window is %s",
  (seven_day) => {
    expect(
      parseClaudeUsage({
        five_hour: { utilization: 66, resets_at: "2026-11-01T19:00:00Z" },
        seven_day,
      })
    ).toEqual({
      ok: true,
      windows: [
        {
          kind: "five-hour",
          usedPercent: 66,
          resetAt: 1793559600,
          windowSeconds: 18000,
        },
      ],
    });
  }
);

it("normalizes endpoint percentages from the Claude probe without spend or model limits", () => {
  expect(
    parseClaudeUsage({
      five_hour: { utilization: 66, resets_at: "2026-11-01T19:00:00.000Z" },
      seven_day: { utilization: 50, resets_at: "2026-11-03T06:00:00.000Z" },
      seven_day_opus: null,
      limits: [{ utilization: 2 }],
      extra_usage: { secret: "ignored" },
    })
  ).toEqual({
    ok: true,
    windows: [
      {
        kind: "five-hour",
        usedPercent: 66,
        resetAt: 1793559600,
        windowSeconds: 18000,
      },
      {
        kind: "weekly",
        usedPercent: 50,
        resetAt: 1793685600,
        windowSeconds: 604800,
      },
    ],
  });
});

import { parseWhamUsage } from "./parsers.js";
it.each([
  [
    "prolite",
    { used_percent: 21, limit_window_seconds: 604800, reset_at: 1793904558 },
    null,
    [
      {
        kind: "weekly",
        usedPercent: 21,
        windowSeconds: 604800,
        resetAt: 1793904558,
      },
    ],
  ],
  [
    "plus",
    { used_percent: 10, limit_window_seconds: 18000, reset_at: 1793559600 },
    { used_percent: 50, limit_window_seconds: 604800, reset_at: 1793685600 },
    [
      {
        kind: "five-hour",
        usedPercent: 10,
        windowSeconds: 18000,
        resetAt: 1793559600,
      },
      {
        kind: "weekly",
        usedPercent: 50,
        windowSeconds: 604800,
        resetAt: 1793685600,
      },
    ],
  ],
  [
    "plus",
    { used_percent: 50, limit_window_seconds: 604800, reset_at: 1793685600 },
    { used_percent: 10, limit_window_seconds: 18000, reset_at: 1793559600 },
    [
      {
        kind: "weekly",
        usedPercent: 50,
        windowSeconds: 604800,
        resetAt: 1793685600,
      },
      {
        kind: "five-hour",
        usedPercent: 10,
        windowSeconds: 18000,
        resetAt: 1793559600,
      },
    ],
  ],
  [
    "future",
    null,
    { used_percent: 10, limit_window_seconds: 3600, reset_at: 1793559600 },
    [
      {
        kind: "other",
        usedPercent: 10,
        windowSeconds: 3600,
        resetAt: 1793559600,
      },
    ],
  ],
])(
  "normalizes %s by duration rather than plan or primary position",
  (plan, primary, secondary, windows) => {
    expect(
      parseWhamUsage({
        plan_type: plan,
        rate_limit: { primary_window: primary, secondary_window: secondary },
        additional_rate_limits: [{ secret: "ignored" }],
      })
    ).toEqual({ ok: true, windows, planLabel: plan });
  }
);

it.each([
  null,
  {},
  { five_hour: null, seven_day: null },
  { five_hour: null },
  { seven_day: null },
  {
    five_hour: { utilization: 66, resets_at: null },
    seven_day: { utilization: 50, resets_at: "2026-11-03T06:00:00Z" },
  },
  {
    five_hour: { utilization: 101, resets_at: "2026-11-01T19:00:00Z" },
    seven_day: { utilization: 50, resets_at: "2026-11-03T06:00:00Z" },
  },
  {
    five_hour: { utilization: 66, resets_at: "garbage" },
    seven_day: { utilization: 50, resets_at: "2026-11-03T06:00:00Z" },
  },
  {
    five_hour: { utilization: 66, resets_at: "1969-01-01T00:00:00Z" },
    seven_day: { utilization: 50, resets_at: "2026-11-03T06:00:00Z" },
  },
])(
  "rejects an invalid Claude payload rather than returning partial windows",
  (payload) => {
    expect(parseClaudeUsage(payload)).toMatchObject({
      ok: false,
      error: "invalid_payload",
    });
  }
);
it.each([
  null,
  {},
  { plan_type: "plus", rate_limit: { primary_window: null } },
  {
    plan_type: "Bearer secret",
    rate_limit: { primary_window: null, secondary_window: null },
  },
  ...[-1, 101, Infinity, NaN, "21"].map((used_percent) => ({
    plan_type: "plus",
    rate_limit: {
      primary_window: {
        used_percent,
        limit_window_seconds: 18000,
        reset_at: 1793559600,
      },
      secondary_window: null,
    },
  })),
  ...[0, -1, Infinity, undefined].map((limit_window_seconds) => ({
    plan_type: "plus",
    rate_limit: {
      primary_window: {
        used_percent: 21,
        limit_window_seconds,
        reset_at: 1793559600,
      },
      secondary_window: null,
    },
  })),
  ...[-1, Infinity, undefined].map((reset_at) => ({
    plan_type: "plus",
    rate_limit: {
      primary_window: {
        used_percent: 21,
        limit_window_seconds: 18000,
        reset_at,
      },
      secondary_window: null,
    },
  })),
])("rejects malformed Wham payloads", (payload) => {
  expect(parseWhamUsage(payload)).toMatchObject({
    ok: false,
    error: "invalid_payload",
  });
});
