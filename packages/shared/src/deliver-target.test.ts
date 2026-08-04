import { describe, expect, it } from "vitest";
import {
  CreateScheduleRequestSchema,
  DeliverTargetSchema,
  ScheduleJobFileSchema,
  UpdateScheduleRequestSchema,
} from "./types.js";

function reject(target: unknown): string {
  const result = DeliverTargetSchema.safeParse(target);
  expect(result.success).toBe(false);
  return result.success ? "" : result.error.issues[0]?.message ?? "";
}

const job = {
  id: "digest",
  name: "Digest",
  schedule: { cron: "0 8 * * *", tz: "UTC" },
  payload: { message: "Run" },
};

describe("DeliverTargetSchema valid shapes", () => {
  it("accepts a channel destination", () => {
    expect(
      DeliverTargetSchema.parse({ target: "slack", channel: "C0123456789" })
    ).toEqual({ target: "slack", channel: "C0123456789" });
  });

  it("accepts a user destination", () => {
    expect(DeliverTargetSchema.parse({ target: "telegram", user: "12345" })).toEqual({
      target: "telegram",
      user: "12345",
    });
  });
});

describe("DeliverTargetSchema validation matrix", () => {
  it("rejects an empty target", () => {
    expect(reject({ target: "", channel: "ops" })).toBe("deliver.target must not be empty");
  });

  it("rejects a blank target", () => {
    expect(reject({ target: "   ", channel: "ops" })).toBe("deliver.target must not be empty");
  });

  it("rejects a blank channel", () => {
    expect(reject({ target: "slack", channel: " " })).toBe(
      "deliver.channel must not be empty when supplied"
    );
  });

  it("rejects a blank user", () => {
    expect(reject({ target: "telegram", user: " " })).toBe(
      "deliver.user must not be empty when supplied"
    );
  });

  it("rejects neither channel nor user", () => {
    expect(reject({ target: "slack" })).toBe("deliver requires exactly one of channel or user");
  });

  it("rejects both channel and user", () => {
    expect(reject({ target: "slack", channel: "ops", user: "u1" })).toBe(
      "deliver requires exactly one of channel or user"
    );
  });
});

describe("deliver on the job and request schemas", () => {
  it("is optional on a job file", () => {
    expect(ScheduleJobFileSchema.parse(job).deliver).toBeUndefined();
  });

  it("parses a job file deliver list", () => {
    const parsed = ScheduleJobFileSchema.parse({
      ...job,
      deliver: [
        { target: "slack", channel: "C0123456789" },
        { target: "telegram", user: "12345" },
      ],
    });
    expect(parsed.deliver).toHaveLength(2);
  });

  it("rejects an invalid deliver entry on a job file", () => {
    expect(
      ScheduleJobFileSchema.safeParse({ ...job, deliver: [{ target: "slack" }] }).success
    ).toBe(false);
  });

  it("carries deliver through the create and update request schemas", () => {
    const deliver = [{ target: "discord", channel: "998877665544332211" }];
    expect(
      CreateScheduleRequestSchema.parse({
        name: "Digest",
        schedule: job.schedule,
        payload: job.payload,
        deliver,
      }).deliver
    ).toEqual(deliver);
    expect(UpdateScheduleRequestSchema.parse({ deliver }).deliver).toEqual(deliver);
  });
});
