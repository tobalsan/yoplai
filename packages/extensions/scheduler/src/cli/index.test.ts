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
      payload: { message: "run check", noAgent: false, quietOutput: false },
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
      noAgent: false,
      quietOutput: false,
    });
    expect(body.schedule).toEqual({ cron: "0 9 * * *", tz: "UTC" });
  });

  it("builds a script-only payload with --script --no-agent", () => {
    const body = buildCreateBody("ops", {
      script: "rotate.sh",
      agent: false,
      cron: "0 9 * * *",
      tz: "UTC",
    });
    expect(body.payload).toEqual({
      script: "rotate.sh",
      noAgent: true,
      quietOutput: false,
    });
  });

  it("builds a script-only payload with --quiet-output", () => {
    const body = buildCreateBody("ops", {
      script: "rotate.sh",
      agent: false,
      quietOutput: true,
      cron: "0 9 * * *",
      tz: "UTC",
    });
    expect(body.payload).toEqual({
      script: "rotate.sh",
      noAgent: true,
      quietOutput: true,
    });
  });

  it("builds a gated payload with --script and -m", () => {
    const body = buildCreateBody("ops", {
      script: "gate.sh",
      message: "check for changes",
      cron: "*/5 * * * *",
      tz: "UTC",
    });
    expect(body.payload).toEqual({
      script: "gate.sh",
      message: "check for changes",
      noAgent: false,
      quietOutput: false,
    });
  });

  it("rejects --no-agent without --script", () => {
    expect(() =>
      buildCreateBody("ops", { agent: false, cron: "0 9 * * *", tz: "UTC" })
    ).toThrow(/--no-agent requires --script/);
  });

  it("rejects --no-agent together with -m", () => {
    expect(() =>
      buildCreateBody("ops", {
        script: "rotate.sh",
        agent: false,
        message: "hi",
        cron: "0 9 * * *",
        tz: "UTC",
      })
    ).toThrow(/--no-agent jobs cannot also set/);
  });

  it("rejects --script without -m or --no-agent", () => {
    expect(() =>
      buildCreateBody("ops", { script: "gate.sh", cron: "0 9 * * *", tz: "UTC" })
    ).toThrow(/--script requires -m/);
  });

  it("rejects when neither --script nor -m is given", () => {
    expect(() =>
      buildCreateBody("ops", { cron: "0 9 * * *", tz: "UTC" })
    ).toThrow(/Message required/);
  });

  it("rejects --quiet-output without --script", () => {
    expect(() =>
      buildCreateBody("ops", {
        message: "hi",
        quietOutput: true,
        cron: "0 9 * * *",
        tz: "UTC",
      })
    ).toThrow(/--quiet-output requires --script/);
  });

  it("includes deliver when --deliver is given", () => {
    const body = buildCreateBody("ops", {
      message: "run check",
      cron: "0 * * * *",
      tz: "UTC",
      deliver: [{ target: "slack", channel: "C0123" }],
    });
    expect(body.deliver).toEqual([{ target: "slack", channel: "C0123" }]);
  });

  it("omits deliver when --deliver is not given", () => {
    const body = buildCreateBody("ops", {
      message: "run check",
      cron: "0 * * * *",
      tz: "UTC",
    });
    expect(body.deliver).toBeUndefined();
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
      payload: {
        message: "new",
        sessionId: "agent:x:main",
        noAgent: false,
        quietOutput: false,
      },
    });
  });

  it("rejects --session without -m (server replaces payload)", () => {
    expect(() => buildUpdateBody({ session: "x" })).toThrow(/Message required/);
  });

  it("renames", () => {
    expect(buildUpdateBody({ name: "renamed" })).toEqual({ name: "renamed" });
  });

  it("builds a script-only payload when --no-agent is explicitly passed", () => {
    const body = buildUpdateBody(
      { script: "rotate.sh", agent: false },
      /* noAgentExplicit */ true
    );
    expect(body).toEqual({
      payload: { script: "rotate.sh", noAgent: true, quietOutput: false },
    });
  });

  it("builds a gated payload with --script and -m", () => {
    const body = buildUpdateBody({ script: "gate.sh", message: "check" });
    expect(body).toEqual({
      payload: {
        script: "gate.sh",
        message: "check",
        noAgent: false,
        quietOutput: false,
      },
    });
  });

  it("keeps the job's script when only -m is given", () => {
    const body = buildUpdateBody({ message: "Digest v2" }, false, {
      script: "bin/gate.sh",
      message: "Digest",
    });
    expect(body).toEqual({
      payload: {
        script: "bin/gate.sh",
        message: "Digest v2",
        noAgent: false,
        quietOutput: false,
      },
    });
  });

  it("toggles --quiet-output on an existing script-only job", () => {
    const body = buildUpdateBody({ quietOutput: true }, false, {
      script: "bin/rotate.sh",
      noAgent: true,
    });
    expect(body).toEqual({
      payload: { script: "bin/rotate.sh", noAgent: true, quietOutput: true },
    });
  });

  it("drops the inherited message when --no-agent is passed", () => {
    const body = buildUpdateBody({ agent: false }, true, {
      script: "bin/gate.sh",
      message: "Digest",
    });
    expect(body).toEqual({
      payload: { script: "bin/gate.sh", noAgent: true, quietOutput: false },
    });
  });

  it("leaves payload untouched when no payload flag is given", () => {
    expect(buildUpdateBody({ enable: true })).toEqual({ enabled: true });
  });

  it("does not treat commander's default --no-agent value as explicit", () => {
    // opts.agent defaults to true via commander even when --no-agent was
    // never passed; without the explicit flag this must not rebuild payload.
    expect(buildUpdateBody({ enable: true, agent: true })).toEqual({
      enabled: true,
    });
  });

  it("rejects --no-agent without --script", () => {
    expect(() => buildUpdateBody({ agent: false }, true)).toThrow(
      /--no-agent requires --script/
    );
  });

  it("rejects --script without -m or --no-agent", () => {
    expect(() => buildUpdateBody({ script: "gate.sh" })).toThrow(
      /--script requires -m/
    );
  });

  it("rejects --quiet-output without --script", () => {
    expect(() =>
      buildUpdateBody({ message: "hi", quietOutput: true })
    ).toThrow(/--quiet-output requires --script/);
  });

  it("replaces deliver when --deliver is given", () => {
    expect(
      buildUpdateBody({
        deliver: [{ target: "telegram", user: "12345" }],
      })
    ).toEqual({ deliver: [{ target: "telegram", user: "12345" }] });
  });

  it("clears deliver with --clear-deliver", () => {
    expect(buildUpdateBody({ clearDeliver: true })).toEqual({ deliver: [] });
  });

  it("leaves deliver untouched when neither flag is given", () => {
    expect(buildUpdateBody({ enable: true })).toEqual({ enabled: true });
  });

  it("rejects --deliver together with --clear-deliver", () => {
    expect(() =>
      buildUpdateBody({
        deliver: [{ target: "slack", channel: "C0123" }],
        clearDeliver: true,
      })
    ).toThrow(/--deliver or --clear-deliver, not both/);
  });
});

describe("scheduler update command", () => {
  it("merges the flags onto the job's current payload", async () => {
    process.env.YOPLAI_API_URL = "http://localhost:4521";
    const job = {
      id: "job-1",
      agentId: "ops",
      name: "Digest",
      enabled: true,
      schedule: { cron: "*/5 * * * *", tz: "UTC" },
      payload: { script: "bin/gate.sh", message: "Digest" },
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_url, init) =>
        new Response(JSON.stringify(init?.method === "PATCH" ? job : [job]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    program.exitOverride();
    registerSchedulerCommands(program);

    await program.parseAsync([
      "node",
      "scheduler",
      "update",
      "ops",
      "job-1",
      "-m",
      "Digest v2",
    ]);

    const patch = fetchMock.mock.calls.find(
      ([, init]) => init?.method === "PATCH"
    );
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({
      payload: {
        script: "bin/gate.sh",
        message: "Digest v2",
        noAgent: false,
        quietOutput: false,
      },
    });
  });
});

describe("scheduler add command --deliver", () => {
  it("sends parsed deliver targets to the create endpoint", async () => {
    process.env.YOPLAI_API_URL = "http://localhost:4521";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "job-1",
          agentId: "ops",
          name: "ops-0-*-*-*-*",
          schedule: { cron: "0 * * * *", tz: "UTC" },
          payload: { message: "run check" },
          deliver: [
            { target: "slack", channel: "C0123" },
            { target: "telegram", user: "12345" },
          ],
        }),
        { status: 201, headers: { "Content-Type": "application/json" } }
      )
    );
    vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    program.exitOverride();
    registerSchedulerCommands(program);

    await program.parseAsync([
      "node",
      "scheduler",
      "add",
      "ops",
      "-m",
      "run check",
      "--cron",
      "0 * * * *",
      "--tz",
      "UTC",
      "--deliver",
      "slack:channel:C0123",
      "--deliver",
      "telegram:user:12345",
    ]);

    const create = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(create?.[1]?.body))).toMatchObject({
      deliver: [
        { target: "slack", channel: "C0123" },
        { target: "telegram", user: "12345" },
      ],
    });
  });

  it("throws a clear parse error for a malformed --deliver value", async () => {
    const program = new Command();
    program.exitOverride();
    registerSchedulerCommands(program);

    await expect(
      program.parseAsync([
        "node",
        "scheduler",
        "add",
        "ops",
        "-m",
        "run check",
        "--cron",
        "0 * * * *",
        "--tz",
        "UTC",
        "--deliver",
        "slack-only",
      ])
    ).rejects.toThrow(/Invalid --deliver "slack-only"/);
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
