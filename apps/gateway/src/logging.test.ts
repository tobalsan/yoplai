import { describe, expect, it, vi } from "vitest";
import { logError, logInfo } from "./logging.js";

describe("logError", () => {
  it("always emits one JSON line for circular and non-string values", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const error = Object.assign(new Error("failed\nrequest"), {
      status: 502n,
      endpoint: circular,
      details: () => "details",
    });
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    logError("tool failed", error, { circular });

    expect(consoleError).toHaveBeenCalledOnce();
    const line = consoleError.mock.calls[0]?.[0] as string;
    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toMatchObject({
      level: "error",
      msg: "tool failed",
      status: "502",
      details: '"() => \\"details\\""',
      message: "failed\nrequest",
    });
  });

  it("redacts sensitive error details and command output", () => {
    const canary = "canary-private-value";
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    logError("tool failed", new Error(`Authorization: Bearer ${canary}`), {
      output: `curl https://files.example.test/report?X-Amz-Signature=${canary}`,
    });

    expect(String(consoleError.mock.calls[0]?.[0])).not.toContain(canary);
  });
});

describe("logInfo", () => {
  it("emits one JSON line with level info, msg, and spread fields", () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

    logInfo("[container] stderr", { agentId: "abc", message: "some output" });

    expect(consoleLog).toHaveBeenCalledOnce();
    const line = consoleLog.mock.calls[0]?.[0] as string;
    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toEqual({
      level: "info",
      msg: "[container] stderr",
      agentId: "abc",
      message: "some output",
    });
  });
});
