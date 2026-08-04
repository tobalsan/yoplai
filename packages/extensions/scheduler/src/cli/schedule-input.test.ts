import { InvalidArgumentError } from "commander";
import { describe, expect, it } from "vitest";
import {
  buildScheduleFromOpts,
  defaultJobName,
  formatDeliver,
  jobKind,
  parseDeliverFlag,
  renderJobsTable,
} from "./schedule-input.js";

describe("buildScheduleFromOpts", () => {
  it("builds cron schedule", () => {
    expect(buildScheduleFromOpts({ cron: "0 8 * * *", tz: "UTC" })).toEqual({
      cron: "0 8 * * *",
      tz: "UTC",
    });
  });

  it("attaches startAt", () => {
    expect(
      buildScheduleFromOpts({
        cron: "*/30 * * * *",
        tz: "Europe/Paris",
        startAt: "2026-05-11T09:00:00Z",
      })
    ).toEqual({
      cron: "*/30 * * * *",
      tz: "Europe/Paris",
      startAt: "2026-05-11T09:00:00.000Z",
    });
  });

  it("requires cron and timezone", () => {
    expect(() => buildScheduleFromOpts({ tz: "UTC" })).toThrow(/--cron/);
    expect(() => buildScheduleFromOpts({ cron: "* * * * *" })).toThrow(/--tz/);
  });
});

describe("defaultJobName", () => {
  it("derives cron name", () => {
    expect(defaultJobName("ops", { cron: "0 8 * * *", tz: "UTC" })).toBe(
      "ops-0-8-*-*-*"
    );
  });
});

describe("jobKind", () => {
  it("is agent for message-only payloads", () => {
    expect(jobKind({ message: "go" })).toBe("agent");
  });

  it("is script for noAgent payloads", () => {
    expect(jobKind({ script: "rotate.sh", noAgent: true })).toBe("script");
  });

  it("is gated for script + message payloads", () => {
    expect(jobKind({ script: "gate.sh", message: "go" })).toBe("gated");
  });
});

describe("parseDeliverFlag", () => {
  it("parses a channel target", () => {
    expect(parseDeliverFlag("slack:channel:C0123")).toEqual([
      { target: "slack", channel: "C0123" },
    ]);
  });

  it("parses a user target", () => {
    expect(parseDeliverFlag("telegram:user:12345")).toEqual([
      { target: "telegram", user: "12345" },
    ]);
  });

  it("accumulates onto the previous array (repeatable flag)", () => {
    const first = parseDeliverFlag("slack:channel:C0123");
    expect(parseDeliverFlag("telegram:user:12345", first)).toEqual([
      { target: "slack", channel: "C0123" },
      { target: "telegram", user: "12345" },
    ]);
  });

  it("rejects a value missing a segment", () => {
    expect(() => parseDeliverFlag("slack:channel")).toThrow(
      /Invalid --deliver "slack:channel"/
    );
  });

  it("rejects a value with an empty target", () => {
    expect(() => parseDeliverFlag(":channel:C0123")).toThrow(/Invalid --deliver/);
  });

  it("rejects a value with an empty destination", () => {
    expect(() => parseDeliverFlag("slack:channel:")).toThrow(/Invalid --deliver/);
  });

  it("rejects a value whose second segment is neither channel nor user", () => {
    expect(() => parseDeliverFlag("slack:room:C0123")).toThrow(
      /second segment must be "channel" or "user"/
    );
  });

  // Commander only turns a parseArg rejection into a usage error + exit 1 for
  // InvalidArgumentError; anything else escapes program.parse() and the CLI
  // exits 0 with the job never created.
  it("rejects with commander's InvalidArgumentError so the CLI exits non-zero", () => {
    expect(() => parseDeliverFlag("slack-only")).toThrow(InvalidArgumentError);
    expect(() => parseDeliverFlag("slack:room:C0123")).toThrow(
      InvalidArgumentError
    );
  });
});

describe("formatDeliver", () => {
  it("is empty for no deliver list", () => {
    expect(formatDeliver(undefined)).toBe("");
    expect(formatDeliver([])).toBe("");
  });

  it("renders target:value entries", () => {
    expect(
      formatDeliver([
        { target: "slack", channel: "C0123" },
        { target: "telegram", user: "12345" },
      ])
    ).toBe("slack:C0123, telegram:12345");
  });
});

describe("renderJobsTable", () => {
  it("renders the header and a row", () => {
    const out = renderJobsTable([
      {
        id: "abc",
        name: "Morning",
        agentId: "ops",
        enabled: true,
        schedule: { cron: "0 8 * * *", tz: "UTC" },
        payload: { message: "go" },
        state: { nextRunAtMs: Date.UTC(2026, 4, 11, 9, 0, 0), lastStatus: "ok" },
      },
    ]);
    expect(out).toContain(
      "| id | name | agent | kind | schedule | next-run | last-status | running-for |"
    );
    expect(out).toContain("abc");
    expect(out).toContain("agent");
    expect(out).toContain("0 8 * * * UTC");
    expect(out).toContain("2026-05-11T09:00:00.000Z");
    expect(out).toContain("ok");
  });

  it("renders a deliver column with target:value entries, empty when absent", () => {
    const out = renderJobsTable([
      {
        id: "abc",
        name: "Morning",
        agentId: "ops",
        enabled: true,
        schedule: { cron: "0 8 * * *", tz: "UTC" },
        payload: { message: "go" },
        deliver: [{ target: "slack", channel: "C0123" }],
      },
      {
        id: "def",
        name: "Evening",
        agentId: "ops",
        enabled: true,
        schedule: { cron: "0 20 * * *", tz: "UTC" },
        payload: { message: "go" },
      },
    ]);
    const rows = out.split("\n");
    expect(rows[0]).toContain("deliver");
    expect(rows.find((row) => row.startsWith("| abc"))).toContain("slack:C0123");
    expect(rows.find((row) => row.startsWith("| def"))).not.toContain("slack:C0123");
  });

  it("renders script and gated kinds", () => {
    const out = renderJobsTable([
      {
        id: "s1",
        name: "Rotate",
        agentId: "ops",
        enabled: true,
        schedule: { cron: "*/5 * * * *", tz: "UTC" },
        payload: { script: "rotate.sh", noAgent: true },
      },
      {
        id: "g1",
        name: "Gate",
        agentId: "ops",
        enabled: true,
        schedule: { cron: "*/5 * * * *", tz: "UTC" },
        payload: { script: "gate.sh", message: "check" },
      },
    ]);
    const rows = out.split("\n");
    expect(rows.find((row) => row.startsWith("| s1"))).toContain("| script |");
    expect(rows.find((row) => row.startsWith("| g1"))).toContain("| gated |");
  });
});
