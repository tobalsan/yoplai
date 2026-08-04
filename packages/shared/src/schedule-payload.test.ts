import { describe, expect, it } from "vitest";
import { SchedulePayloadSchema } from "./types.js";

function reject(payload: unknown): string {
  const result = SchedulePayloadSchema.safeParse(payload);
  expect(result.success).toBe(false);
  return result.success ? "" : result.error.issues[0]?.message ?? "";
}

describe("SchedulePayloadSchema valid shapes", () => {
  it("accepts a message-only agent job", () => {
    const result = SchedulePayloadSchema.parse({ message: "do the thing" });
    expect(result).toMatchObject({ message: "do the thing" });
    expect(result.script).toBeUndefined();
    expect(result.noAgent).toBeUndefined();
    expect(result.quietOutput).toBeUndefined();
  });

  it("accepts a script-only job (script + noAgent)", () => {
    const result = SchedulePayloadSchema.parse({
      script: "scripts/rotate-token.sh",
      noAgent: true,
    });
    expect(result).toMatchObject({
      script: "scripts/rotate-token.sh",
      noAgent: true,
    });
    expect(result.message).toBeUndefined();
  });

  it("accepts a gated agent job (script + message)", () => {
    const result = SchedulePayloadSchema.parse({
      script: "scripts/gate.sh",
      message: "summarize the change",
    });
    expect(result).toMatchObject({
      script: "scripts/gate.sh",
      message: "summarize the change",
    });
    expect(result.noAgent).toBeUndefined();
  });

  it("accepts quietOutput on a script-only job", () => {
    const result = SchedulePayloadSchema.parse({
      script: "scripts/watchdog.sh",
      noAgent: true,
      quietOutput: true,
    });
    expect(result.quietOutput).toBe(true);
  });
});

describe("SchedulePayloadSchema validation matrix", () => {
  it("rejects a blank message", () => {
    expect(reject({ message: "   " })).toBe("payload.message must not be empty");
  });

  it("rejects a blank script", () => {
    expect(reject({ script: "  ", message: "hi" })).toBe("payload.script must not be empty");
  });

  it("rejects noAgent: true without script", () => {
    expect(reject({ noAgent: true })).toBe("payload.noAgent requires payload.script");
  });

  it("rejects noAgent: true with message", () => {
    expect(reject({ noAgent: true, script: "scripts/x.sh", message: "hi" })).toBe(
      "payload.noAgent rejects payload.message"
    );
  });

  it("rejects script without noAgent and without message", () => {
    expect(reject({ script: "scripts/x.sh" })).toBe(
      "payload.script requires payload.message unless noAgent is true"
    );
  });

  it("rejects when neither script nor message is present", () => {
    expect(reject({})).toBe("payload.message is required when payload.script is absent");
  });

  it("rejects quietOutput: true without script", () => {
    expect(reject({ message: "hi", quietOutput: true })).toBe(
      "payload.quietOutput requires payload.script"
    );
  });

  it("rejects an absolute script path", () => {
    expect(reject({ script: "/etc/passwd", noAgent: true })).toBe(
      "payload.script must be a relative path contained in the agent root"
    );
  });

  it("rejects a script path with a .. segment", () => {
    expect(reject({ script: "../escape.sh", noAgent: true })).toBe(
      "payload.script must be a relative path contained in the agent root"
    );
  });
});
