import { expect, it } from "vitest";
import type { QuotaSnapshot } from "@yoplai/shared";
import { pace } from "./policy.js";
const known: QuotaSnapshot = {
  provider: "anthropic",
  accountRef: "local",
  status: "known",
  windows: [],
  stale: false,
  updatedAt: 1000,
};
it.each([
  [0, 10, 2],
  [30240, 10, 2],
  [302400, 50, 1],
  [604799, 100, 1.000001653441226],
])(
  "calculates weekly pace at elapsed %s seconds",
  (elapsed, usedPercent, expected) => {
    const snapshot = {
      ...known,
      updatedAt: 1000 + elapsed,
      windows: [
        {
          kind: "weekly" as const,
          usedPercent,
          resetAt: 605800,
          windowSeconds: 604800,
        },
      ],
    };
    expect(pace(snapshot, "weekly", 1000 + elapsed)).toBeCloseTo(expected, 8);
  }
);

import { fiveHourState } from "./policy.js";
it.each([
  [100, undefined, "exhausted"],
  [99, "rejected", "exhausted"],
  [2, "limited", "exhausted"],
  [99, "unknown", "ok"],
  [50, "allowed", "ok"],
] as const)(
  "classifies five-hour usage %s and status %s",
  (usedPercent, status, expected) => {
    expect(
      fiveHourState(
        {
          ...known,
          windows: [
            {
              kind: "five-hour",
              usedPercent,
              resetAt: 20000,
              windowSeconds: 18000,
              status,
            },
          ],
        },
        1000
      )
    ).toBe(expected);
  }
);

it.each([
  ["missing", { ...known, status: "unknown" as const }, 1000],
  ["stale", { ...known, stale: true }, 1000],
  [
    "errored",
    { ...known, status: "unknown" as const, errorKind: "timeout" },
    1000,
  ],
  ["at reset", known, 20000],
  ["after reset", known, 20001],
])("returns unknown for both helpers when %s", (_name, snapshot, now) => {
  const withWindows = {
    ...snapshot,
    updatedAt: now,
    windows: [
      {
        kind: "five-hour" as const,
        usedPercent: 20,
        resetAt: 20000,
        windowSeconds: 18000,
      },
      {
        kind: "weekly" as const,
        usedPercent: 50,
        resetAt: 604800,
        windowSeconds: 604800,
      },
    ],
  };
  expect(fiveHourState(withWindows, now)).toBe("unknown");
  expect(pace(withWindows, "weekly", now)).toBe("unknown");
});
it("rechecks age when a caller retains a formerly fresh snapshot", () => {
  const snapshot = {
    ...known,
    windows: [
      {
        kind: "weekly" as const,
        usedPercent: 50,
        resetAt: 605800,
        windowSeconds: 604800,
      },
    ],
  };
  expect(fiveHourState(snapshot, 2201)).toBe("unknown");
  expect(pace(snapshot, "weekly", 2201)).toBe("unknown");
});

it("keeps Pro routable without a five-hour window and ignores unrelated windows", () => {
  const snapshot: QuotaSnapshot = {
    ...known,
    windows: [
      {
        kind: "weekly",
        usedPercent: 21,
        resetAt: 605800,
        windowSeconds: 604800,
      },
      { kind: "other", usedPercent: 100, resetAt: 500, windowSeconds: 3600 },
    ],
  };
  expect(fiveHourState(snapshot, 1000)).toBe("absent");
  expect(pace(snapshot, "weekly", 1000)).toBeCloseTo(4.2, 8);
});
it.each([
  [19999, "ok", 10],
  [20000, "unknown", "unknown"],
  [20001, "unknown", "unknown"],
] as const)(
  "handles the reset boundary at %s with a fresh observation",
  (now, state, expectedPace) => {
    const snapshot: QuotaSnapshot = {
      ...known,
      updatedAt: now,
      windows: [
        {
          kind: "five-hour",
          usedPercent: 20,
          resetAt: 20000,
          windowSeconds: 18000,
        },
        {
          kind: "weekly",
          usedPercent: 50,
          resetAt: 604800,
          windowSeconds: 604800,
        },
      ],
    };
    expect(fiveHourState(snapshot, now)).toBe(state);
    expect(pace(snapshot, "weekly", now)).toBe(expectedPace);
  }
);
it("makes even an absent five-hour window unknown after the weekly reset", () => {
  const snapshot: QuotaSnapshot = {
    ...known,
    updatedAt: 20000,
    windows: [
      {
        kind: "weekly",
        usedPercent: 50,
        resetAt: 20000,
        windowSeconds: 604800,
      },
    ],
  };
  expect(fiveHourState(snapshot, 20000)).toBe("unknown");
  expect(pace(snapshot, "weekly", 20000)).toBe("unknown");
});
