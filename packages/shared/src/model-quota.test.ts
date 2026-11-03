import { describe, expect, it } from "vitest";
import { parseClaudeQuotaHeaders } from "./model-quota.js";

describe("Claude quota headers", () => {
  it("normalizes the live probe fractions and excludes unrelated headers", () => {
    expect(
      parseClaudeQuotaHeaders({
        "anthropic-ratelimit-unified-5h-utilization": "0.66",
        "anthropic-ratelimit-unified-5h-reset": "1793559600",
        "anthropic-ratelimit-unified-5h-status": "allowed",
        "anthropic-ratelimit-unified-7d-utilization": "0.49",
        "anthropic-ratelimit-unified-7d-reset": "1793685600",
        "anthropic-ratelimit-unified-7d-status": "allowed",
        authorization: "secret",
      })
    ).toEqual({
      ok: true,
      windows: [
        {
          kind: "five-hour",
          usedPercent: 66,
          resetAt: 1793559600,
          windowSeconds: 18000,
          status: "allowed",
        },
        {
          kind: "weekly",
          usedPercent: 49,
          resetAt: 1793685600,
          windowSeconds: 604800,
          status: "allowed",
        },
      ],
    });
  });
});

it.each<Record<string, string>>([{}, { authorization: "secret" }])(
  "ignores responses without quota windows",
  (headers) => {
    expect(parseClaudeQuotaHeaders(headers)).toEqual({ ok: true, windows: [] });
  }
);
it.each(["", "-0.1", "1.1", "NaN", "Infinity", "abc"])(
  "rejects malformed utilization %s",
  (value) => {
    expect(
      parseClaudeQuotaHeaders({
        "anthropic-ratelimit-unified-5h-utilization": value,
        "anthropic-ratelimit-unified-5h-reset": "1793559600",
      })
    ).toEqual({ ok: false, error: "invalid_payload" });
  }
);
it("rejects a partial window instead of guessing", () => {
  expect(
    parseClaudeQuotaHeaders({
      "anthropic-ratelimit-unified-5h-status": "limited",
    })
  ).toEqual({ ok: false, error: "invalid_payload" });
});
it("normalizes unknown status without retaining its raw value", () => {
  expect(
    parseClaudeQuotaHeaders({
      "anthropic-ratelimit-unified-5h-utilization": "0.2",
      "anthropic-ratelimit-unified-5h-reset": "1793559600",
      "anthropic-ratelimit-unified-5h-status": "secret",
    })
  ).toEqual({
    ok: true,
    windows: [
      {
        kind: "five-hour",
        usedPercent: 20,
        resetAt: 1793559600,
        windowSeconds: 18000,
        status: "unknown",
      },
    ],
  });
});

import { classifyQuotaWindow } from "./model-quota.js";
it.each([
  [16200, "five-hour"],
  [19800, "five-hour"],
  [16199, "other"],
  [19801, "other"],
  [544320, "weekly"],
  [665280, "weekly"],
  [544319, "other"],
  [665281, "other"],
  [3600, "other"],
] as const)("classifies %s seconds by length", (seconds, kind) => {
  expect(classifyQuotaWindow(seconds)).toBe(kind);
});

import {
  ContainerRunnerProtocolEventSchema,
  HistoryEventSchema,
} from "./types.js";
it("accepts sanitized quota frames outside history and rejects secret-bearing extras", () => {
  const frame = {
    type: "quota",
    provider: "anthropic",
    windows: [
      {
        kind: "five-hour",
        usedPercent: 66,
        resetAt: 1793559600,
        windowSeconds: 18000,
      },
    ],
    observedAt: 1793550000,
  };
  expect(ContainerRunnerProtocolEventSchema.safeParse(frame).success).toBe(
    true
  );
  expect(HistoryEventSchema.safeParse(frame).success).toBe(false);
  expect(
    ContainerRunnerProtocolEventSchema.safeParse({
      ...frame,
      headers: { authorization: "secret" },
    }).success
  ).toBe(false);
  expect(
    ContainerRunnerProtocolEventSchema.safeParse({
      ...frame,
      windows: [{ ...frame.windows[0], headers: { authorization: "secret" } }],
    }).success
  ).toBe(false);
});
it("reads HTTP quota names case-insensitively", () => {
  expect(
    parseClaudeQuotaHeaders({
      "Anthropic-Ratelimit-Unified-5h-Utilization": "0.66",
      "Anthropic-Ratelimit-Unified-5h-Reset": "1793559600",
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
});
