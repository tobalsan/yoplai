import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCreateBody, buildUpdateBody, registerSchedulerCommands } from "./index.js";

const originalApiUrl = process.env.YOPLAI_API_URL;

afterEach(() => {
  if (originalApiUrl === undefined) delete process.env.YOPLAI_API_URL;
  else process.env.YOPLAI_API_URL = originalApiUrl;
  vi.restoreAllMocks();
});

describe("buildCreateBody", () => {
  it("defaults the name from agent + schedule", () => {
    const body = buildCreateBody("ops", {
      message: "run check",
      cron: "0 * * * *",
      tz: "UTC",
    });
    expect(body).toEqual({
      name: "ops-0-*-*-*-*",
      agentId: "ops",
      schedule: { cron: "0 * * * *", tz: "UTC" },
      payload: { message: "run check" },
    });
  });

  it("uses provided --name", () => {
    const body = buildCreateBody("ops", {
      message: "run check",
      cron: "0 * * * *",
      tz: "UTC",
      name: "Hourly Check",
    });
    expect(body.name).toBe("Hourly Check");
  });

  it("passes through model override", () => {
    const body = buildCreateBody("ops", {
      message: "run check",
      cron: "0 9 * * *",
      tz: "UTC",
      provider: "anthropic",
      model: "claude-sonnet-4",
    });

    expect(body.model).toEqual({ provider: "anthropic", model: "claude-sonnet-4" });
  });

  it("rejects partial model override", () => {
    expect(() =>
      buildCreateBody("ops", {
        message: "run check",
        cron: "0 9 * * *",
        tz: "UTC",
        provider: "anthropic",
      })
    ).toThrow(/Both --provider and --model/);
  });

  it("passes through --session", () => {
    const body = buildCreateBody("ops", {
      message: "run check",
      cron: "0 9 * * *",
      tz: "UTC",
      session: "agent:ops:main",
    });
    expect(body.payload).toEqual({
      message: "run check",
      sessionId: "agent:ops:main",
    });
    expect(body.schedule).toEqual({ cron: "0 9 * * *", tz: "UTC" });
  });
});

describe("buildUpdateBody", () => {
  it("maps --enable / --disable", () => {
    expect(buildUpdateBody({ enable: true })).toEqual({ enabled: true });
    expect(buildUpdateBody({ disable: true })).toEqual({ enabled: false });
  });

  it("rejects --enable + --disable together", () => {
    expect(() => buildUpdateBody({ enable: true, disable: true })).toThrow(
      /not both/
    );
  });

  it("rebuilds schedule when --cron is given", () => {
    expect(buildUpdateBody({ cron: "*/30 * * * *", tz: "UTC" })).toEqual({
      schedule: { cron: "*/30 * * * *", tz: "UTC" },
    });
  });

  it("rejects partial schedule update", () => {
    expect(() => buildUpdateBody({ tz: "UTC" })).toThrow(/--cron/);
  });

  it("maps model override", () => {
    expect(buildUpdateBody({ provider: "openai", model: "gpt-5" })).toEqual({
      model: { provider: "openai", model: "gpt-5" },
    });
  });

  it("rejects partial model update", () => {
    expect(() => buildUpdateBody({ model: "gpt-5" })).toThrow(
      /Both --provider and --model/
    );
  });

  it("rejects empty patch", () => {
    expect(() => buildUpdateBody({})).toThrow(/Nothing to update/);
  });

  it("builds payload from -m and --session", () => {
    expect(
      buildUpdateBody({ message: "new", session: "agent:x:main" })
    ).toEqual({
      payload: { message: "new", sessionId: "agent:x:main" },
    });
  });

  it("rejects --session without -m (server replaces payload)", () => {
    expect(() => buildUpdateBody({ session: "x" })).toThrow(/-m <message>/);
  });

  it("renames", () => {
    expect(buildUpdateBody({ name: "renamed" })).toEqual({ name: "renamed" });
  });
});

describe("scheduler run command", () => {
  it("posts to the manual run endpoint and prints the output path", async () => {
    process.env.YOPLAI_API_URL = "http://localhost:4521";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "ok",
          firedAt: "2026-06-03T00:00:00.000Z",
          finishedAt: "2026-06-03T00:00:01.000Z",
          sessionId: "session-1",
          outputPath: "/tmp/alpha/cron/output/job-1/run.md",
          job: { id: "job-1", agentId: "alpha" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    program.exitOverride();
    registerSchedulerCommands(program);

    await program.parseAsync(["node", "scheduler", "run", "alpha", "job-1"]);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:4521/api/schedules/alpha/job-1/run",
      expect.objectContaining({ method: "POST" })
    );
    expect(log).toHaveBeenNthCalledWith(1, "Ran schedule alpha/job-1: ok");
    expect(log).toHaveBeenNthCalledWith(
      2,
      "Output: /tmp/alpha/cron/output/job-1/run.md"
    );
  });

  it("prints failed run output path before exiting non-zero", async () => {
    process.env.YOPLAI_API_URL = "http://localhost:4521";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "agent failed",
          result: {
            status: "error",
            outputPath: "/tmp/alpha/cron/output/job-1/failed.md",
          },
        }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      )
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const program = new Command();
    program.exitOverride();
    registerSchedulerCommands(program);

    await expect(
      program.parseAsync(["node", "scheduler", "run", "alpha", "job-1"])
    ).rejects.toThrow("exit 1");

    expect(error).toHaveBeenNthCalledWith(1, "agent failed");
    expect(error).toHaveBeenNthCalledWith(
      2,
      "Output: /tmp/alpha/cron/output/job-1/failed.md"
    );
  });
});
