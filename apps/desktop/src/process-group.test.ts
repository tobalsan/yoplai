import { describe, expect, it } from "vitest";
import { stopGroup } from "./process-group.js";

describe("stopGroup", () => {
  it("sends SIGTERM to the group and stops when it exits", async () => {
    const calls: Array<[number, string]> = [];
    let alive = true;
    const result = await stopGroup(123, {
      kill: (pid, signal) => {
        calls.push([pid, signal]);
        alive = false;
      },
      isGroupAlive: () => alive,
      pollMs: 1,
    });
    expect(result).toBe("terminated");
    expect(calls).toEqual([[-123, "SIGTERM"]]);
  });

  it("sends SIGKILL when the group survives the grace period", async () => {
    const calls: Array<[number, string]> = [];
    const result = await stopGroup(123, {
      kill: (pid, signal) => void calls.push([pid, signal]),
      isGroupAlive: () => true,
      graceMs: 10,
      pollMs: 1,
    });
    expect(result).toBe("killed");
    expect(calls).toEqual([
      [-123, "SIGTERM"],
      [-123, "SIGKILL"],
    ]);
  });
});
