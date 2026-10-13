import * as childProcess from "node:child_process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { stopThenKill } from "./shutdown.js";
vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.clearAllMocks();
});
afterEach(() => vi.useRealTimers());
it.each(["failure", "timeout"])(
  "coalesces stop requests and kills after stop %s",
  async (mode) => {
    vi.mocked(childProcess.execFile).mockImplementation(
      (_file, args, _options, callback) => {
        if (typeof callback === "function") {
          if (args?.[0] === "stop") {
            if (mode === "failure") callback(new Error("stop failed"), "", "");
          } else callback(null, args?.[0] === "inspect" ? "false" : "", "");
        }
        return {} as never;
      }
    );
    const first = stopThenKill(`coalesced-${mode}`);
    expect(stopThenKill(`coalesced-${mode}`)).toBe(first);
    await vi.advanceTimersByTimeAsync(10_000);
    await first;
    expect(
      vi.mocked(childProcess.execFile).mock.calls.map((call) => call[1]?.[0])
    ).toEqual(["stop", "kill", "inspect"]);
  }
);
it("verifies an already absent container after failed stop and kill", async () => {
  vi.mocked(childProcess.execFile).mockImplementation(
    (_file, _args, _options, callback) => {
      if (typeof callback === "function")
        callback(new Error("No such container: absent"), "", "");
      return {} as never;
    }
  );
  await expect(stopThenKill("absent")).resolves.toBeUndefined();
});
it("rejects unverified shutdown within 15 seconds when all docker commands hang", async () => {
  vi.mocked(childProcess.execFile).mockReturnValue({} as never);
  const result = expect(stopThenKill("hanging")).rejects.toThrow(
    "not confirmed stopped within 15s"
  );
  await vi.advanceTimersByTimeAsync(15_000);
  await result;
});
it("rejects kill failure when inspection confirms container is still running", async () => {
  vi.mocked(childProcess.execFile).mockImplementation(
    (_file, args, _options, callback) => {
      if (typeof callback === "function")
        callback(
          args?.[0] === "inspect" ? null : new Error("failed"),
          "true",
          ""
        );
      return {} as never;
    }
  );
  const result = expect(stopThenKill("running")).rejects.toThrow(
    "enforcement failed"
  );
  await vi.advanceTimersByTimeAsync(15_000);
  await result;
});
