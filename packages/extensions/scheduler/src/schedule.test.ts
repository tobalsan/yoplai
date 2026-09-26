import { describe, it, expect } from "vitest";
import { computeNextRunAtMs } from "./schedule.js";

function iso(ms: number | undefined): string {
  if (ms === undefined) throw new Error("Expected a next run");
  return new Date(ms).toISOString();
}

describe("computeNextRunAtMs", () => {
  it("computes next cron run in UTC", () => {
    const next = computeNextRunAtMs(
      { cron: "0 9 * * *", tz: "UTC" },
      new Date("2024-06-15T08:00:00Z").getTime()
    );

    expect(iso(next)).toBe("2024-06-15T09:00:00.000Z");
  });

  it("schedules next day when today's cron time has passed", () => {
    const next = computeNextRunAtMs(
      { cron: "0 9 * * *", tz: "UTC" },
      new Date("2024-06-15T10:00:00Z").getTime()
    );

    expect(iso(next)).toBe("2024-06-16T09:00:00.000Z");
  });

  it("uses timezone", () => {
    const next = computeNextRunAtMs(
      { cron: "0 9 * * *", tz: "America/New_York" },
      new Date("2024-01-15T00:00:00Z").getTime()
    );

    expect(iso(next)).toBe("2024-01-15T14:00:00.000Z");
  });

  it("keeps a missed one-shot due until it fires, then has no next run", () => {
    const schedule = { runAt: "2024-06-15T09:00:00.000Z" };
    expect(
      computeNextRunAtMs(schedule, Date.parse("2024-06-15T08:00:00Z"))
    ).toBe(Date.parse(schedule.runAt));
    expect(
      computeNextRunAtMs(schedule, Date.parse("2024-06-16T08:00:00Z"))
    ).toBe(Date.parse(schedule.runAt));
    expect(
      computeNextRunAtMs(schedule, Date.parse("2024-06-16T08:00:00Z"), true)
    ).toBeUndefined();
  });
});
