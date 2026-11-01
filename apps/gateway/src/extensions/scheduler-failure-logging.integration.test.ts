import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig, ExtensionContext, GatewayConfig, SchedulePayload } from "@yoplai/shared";
import { createExtensionContext } from "./context.js";
import { SchedulerService, clearSchedulerContext, setSchedulerContext } from "../../../../packages/extensions/scheduler/src/service.js";

describe("scheduler structured failures", () => {
  let home: string;
  let scheduler: SchedulerService;

  afterEach(async () => {
    await scheduler?.stop();
    clearSchedulerContext();
    vi.restoreAllMocks();
    if (home) await fs.rm(home, { recursive: true, force: true });
  });

  async function setup(monitoring = true) {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    home = await fs.mkdtemp(path.join(os.tmpdir(), "scheduler-failure-logging-"));
    const alpha: AgentConfig = {
      id: "alpha", name: "Alpha", workspace: path.join(home, "alpha"),
      model: { provider: "test", model: "test" }, queueMode: "queue",
    };
    await fs.mkdir(alpha.workspace, { recursive: true });
    const config: GatewayConfig = {
      version: 3, agents: [alpha], enableCronMonitoring: monitoring,
      extensions: { scheduler: { enabled: true } },
      sessions: { idleMinutes: 360 },
    };
    const ctx: ExtensionContext = {
      ...createExtensionContext(config),
      getConfig: () => config,
      getDataDir: () => home,
      getAgent: (id) => config.agents.find((candidate) => candidate.id === id),
      getAgents: () => config.agents,
      isAgentActive: () => true,
      resolveWorkspaceDir: (candidate) => candidate.workspace,
      runAgent: async () => { throw new Error("Provider unavailable\nprivate diagnostic"); },
    };
    setSchedulerContext(ctx);
    scheduler = new SchedulerService();
    return { errors, alpha, config, ctx };
  }

  async function add(payload: Partial<SchedulePayload>) {
    return scheduler.add("alpha", {
      name: "Digest", schedule: { cron: "0 8 * * *", tz: "UTC" },
      payload: { noAgent: false, quietOutput: false, ...payload },
    });
  }

  it("logs one short script failure while keeping full diagnostics in the run and Markdown", async () => {
    const { errors, alpha } = await setup();
    await fs.writeFile(path.join(alpha.workspace, "fail.sh"), "echo stdout-secret\necho first-stderr >&2\necho last-stderr >&2\nexit 3\n");
    const job = await add({ script: "fail.sh", noAgent: true });
    const result = await scheduler.runNow("alpha", job.id);
    expect(errors.mock.calls).toHaveLength(1);
    expect(errors.mock.calls[0]).toHaveLength(1);
    const line = String(errors.mock.calls[0]![0]);
    expect(line.split("\n")).toHaveLength(1);
    expect(JSON.parse(line)).toMatchObject({
      level: "error", msg: "[scheduler] job failed", jobId: job.id,
      jobName: "Digest", agentId: "alpha", kind: "script", phase: "script",
      exitCode: 3, reason: "exit", stderrTail: "first-stderr\nlast-stderr",
      message: "script failed (exit 3)",
    });
    expect(line).not.toContain("stdout-secret");
    expect(line).not.toContain('"stack"');
    const [run] = await scheduler.listRuns("alpha", job.id);
    expect(JSON.parse(line).runId).toBe(run!.id);
    expect(run!.error).toBe("script failed (exit 3)\nstderr:\nfirst-stderr\nlast-stderr\n\nstdout:\nstdout-secret\n");
    expect(await fs.readFile(result.outputPath!, "utf8")).toContain(run!.error);
  });

  it("uses the rolling last twenty stderr lines for a failed gate after the captured head is full", async () => {
    const { errors, alpha } = await setup();
    await fs.writeFile(path.join(alpha.workspace, "gate.sh"), "head -c 70000 /dev/zero | tr '\\0' h >&2\nprintf '\\n' >&2\nfor n in {1..25}; do echo tail-$n >&2; done\nexit 4\n");
    const job = await add({ script: "gate.sh", message: "Digest" });
    const result = await scheduler.runNow("alpha", job.id);
    expect(errors.mock.calls).toHaveLength(1);
    const line = String(errors.mock.calls[0]![0]);
    expect(line.split("\n")).toHaveLength(1);
    expect(JSON.parse(line)).toMatchObject({
      jobId: job.id, jobName: "Digest", agentId: "alpha", kind: "gated",
      phase: "script", reason: "exit", exitCode: 4,
      stderrTail: "tail-6\ntail-7\ntail-8\ntail-9\ntail-10\ntail-11\ntail-12\ntail-13\ntail-14\ntail-15\ntail-16\ntail-17\ntail-18\ntail-19\ntail-20\ntail-21\ntail-22\ntail-23\ntail-24\ntail-25",
    });
    const [run] = await scheduler.listRuns("alpha", job.id);
    expect(run!.error).toContain("hhhhhhhhhhhhhhhh");
    expect(run!.error).toContain("[output truncated]");
    expect(run!.error).not.toContain("tail-25");
    expect(await fs.readFile(result.outputPath!, "utf8")).toContain(run!.error);
  });

  it("logs an agent failure once with a short message and keeps its full error on disk", async () => {
    const { errors } = await setup();
    const job = await add({ message: "Digest" });
    const result = await scheduler.runNow("alpha", job.id);
    expect(errors.mock.calls).toHaveLength(1);
    expect(errors.mock.calls[0]).toHaveLength(1);
    const line = String(errors.mock.calls[0]![0]);
    expect(line.split("\n")).toHaveLength(1);
    expect(JSON.parse(line)).toMatchObject({
      level: "error", msg: "[scheduler] job failed", jobId: job.id,
      jobName: "Digest", agentId: "alpha", kind: "agent", phase: "agent",
      message: "Provider unavailable",
    });
    expect(line).not.toContain("private diagnostic");
    expect(line).not.toContain('"stack"');
    const [run] = await scheduler.listRuns("alpha", job.id);
    expect(JSON.parse(line).runId).toBe(run!.id);
    expect(run!.error).toBe("Provider unavailable\nprivate diagnostic");
    expect(await fs.readFile(result.outputPath!, "utf8")).toContain(run!.error);
  });

  it("logs an owner refusal without a phase before launching the script", async () => {
    const { errors, alpha } = await setup();
    await fs.mkdir(path.join(alpha.workspace, "cron"));
    await fs.writeFile(path.join(alpha.workspace, "cron", "jobs.json"), JSON.stringify({
      version: 1, jobs: [{ id: "ownerless", name: "Owner script", credentialMode: "owner",
        schedule: { cron: "0 8 * * *", tz: "UTC" }, payload: { script: "unlaunched.sh", noAgent: true } }],
    }));
    const result = await scheduler.runNow("alpha", "ownerless");
    expect(errors.mock.calls).toHaveLength(1);
    expect(errors.mock.calls[0]).toHaveLength(1);
    const line = String(errors.mock.calls[0]![0]);
    expect(line.split("\n")).toHaveLength(1);
    expect(JSON.parse(line)).toMatchObject({
      level: "error", msg: "[scheduler] job failed", jobId: "ownerless",
      jobName: "Owner script", agentId: "alpha", kind: "script",
      message: "Scheduled job owner is missing; assign an owner before running it.",
    });
    expect(JSON.parse(line)).not.toHaveProperty("phase");
    const [run] = await scheduler.listRuns("alpha", "ownerless");
    expect(JSON.parse(line).runId).toBe(run!.id);
    expect(run!.error).toBe("Scheduled job owner is missing; assign an owner before running it.");
    expect(await fs.readFile(result.outputPath!, "utf8")).toContain(run!.error);
  });

  it("logs a missing agent with no phase and returns before writing Markdown", async () => {
    const { errors, alpha, ctx } = await setup();
    const job = await add({ message: "Digest" });
    ctx.getAgent = () => undefined;
    const result = await scheduler.runNow("alpha", job.id);
    expect(errors.mock.calls).toHaveLength(1);
    expect(errors.mock.calls[0]).toHaveLength(1);
    const line = String(errors.mock.calls[0]![0]);
    expect(line.split("\n")).toHaveLength(1);
    expect(JSON.parse(line)).toMatchObject({
      level: "error", msg: "[scheduler] job failed", jobId: job.id,
      jobName: "Digest", agentId: "alpha", kind: "agent", message: "Agent not found",
    });
    expect(JSON.parse(line)).not.toHaveProperty("phase");
    const [run] = await scheduler.listRuns("alpha", job.id);
    expect(JSON.parse(line).runId).toBe(run!.id);
    expect(run!.error).toBe("Agent not found");
    expect(result.outputPath).toBeUndefined();
    await expect(fs.stat(path.join(alpha.workspace, "cron", "output"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("logs an unexpected detached rejection with its known run id and no phase", async () => {
    const { errors, ctx } = await setup();
    const job = await add({ message: "Digest" });
    ctx.runAgent = () => { throw new Error("Host launch failed\nextra diagnostic"); };
    expect((await scheduler.runNowDetached("alpha", job.id)).status).toBe("accepted");
    await vi.waitFor(() => expect(errors.mock.calls).toHaveLength(1));
    expect(errors.mock.calls[0]).toHaveLength(1);
    const line = String(errors.mock.calls[0]![0]);
    expect(line.split("\n")).toHaveLength(1);
    expect(JSON.parse(line)).toMatchObject({
      level: "error", msg: "[scheduler] job failed", jobId: job.id,
      jobName: "Digest", agentId: "alpha", kind: "agent", message: "Host launch failed",
    });
    expect(JSON.parse(line)).not.toHaveProperty("phase");
    expect(line).not.toContain("extra diagnostic");
    const [run] = await scheduler.listRuns("alpha", job.id);
    expect(JSON.parse(line).runId).toBe(run!.id);
  });

  it("logs a script timeout without an exit code while another job completes", async () => {
    const { errors, alpha, ctx } = await setup();
    await fs.writeFile(path.join(alpha.workspace, "hang.sh"), "echo timeout-diagnostic >&2\nsleep 30\n");
    const hanging = await add({ script: "hang.sh", noAgent: true });
    await scheduler.update("alpha", hanging.id, { timeoutMs: 100 });
    ctx.runAgent = async () => ({ payloads: [{ text: "healthy" }], meta: { sessionId: "healthy-session", durationMs: 1 } });
    const healthy = await add({ message: "Healthy" });
    const [result, healthyResult] = await Promise.all([
      scheduler.runNow("alpha", hanging.id), scheduler.runNow("alpha", healthy.id),
    ]);
    expect(healthyResult.status).toBe("ok");
    expect(errors.mock.calls).toHaveLength(1);
    expect(errors.mock.calls[0]).toHaveLength(1);
    const line = String(errors.mock.calls[0]![0]);
    expect(line.split("\n")).toHaveLength(1);
    expect(JSON.parse(line)).toMatchObject({
      level: "error", jobId: hanging.id, jobName: "Digest", agentId: "alpha",
      kind: "script", phase: "script", reason: "timeout", stderrTail: "timeout-diagnostic",
      message: "script exceeded the 100ms timeout and was killed",
    });
    expect(JSON.parse(line)).not.toHaveProperty("exitCode");
    const [run] = await scheduler.listRuns("alpha", hanging.id);
    expect(JSON.parse(line).runId).toBe(run!.id);
    expect(run!.error).toBe("script exceeded the 100ms timeout and was killed\nstderr:\ntimeout-diagnostic\n\nstdout:\n");
    expect(await fs.readFile(result.outputPath!, "utf8")).toContain(run!.error);
  });

  it("keeps full Markdown diagnostics without creating run JSON when monitoring is off", async () => {
    const { errors, alpha } = await setup(false);
    await fs.writeFile(path.join(alpha.workspace, "fail.sh"), "echo complete-stdout\necho complete-stderr >&2\nexit 7\n");
    const job = await add({ script: "fail.sh", noAgent: true });
    const result = await scheduler.runNow("alpha", job.id);
    expect(errors.mock.calls).toHaveLength(1);
    expect(errors.mock.calls[0]).toHaveLength(1);
    const line = String(errors.mock.calls[0]![0]);
    expect(line.split("\n")).toHaveLength(1);
    expect(JSON.parse(line)).toMatchObject({
      level: "error", jobId: job.id, jobName: "Digest", agentId: "alpha",
      kind: "script", phase: "script", reason: "exit", exitCode: 7,
      stderrTail: "complete-stderr", message: "script failed (exit 7)",
    });
    expect(JSON.parse(line)).not.toHaveProperty("runId");
    expect(line).not.toContain("complete-stdout");
    expect(await scheduler.listRuns("alpha", job.id)).toEqual([]);
    await expect(fs.stat(path.join(alpha.workspace, "cron", "runs"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(result.outputPath!, "utf8")).toContain("script failed (exit 7)\nstderr:\ncomplete-stderr\n\nstdout:\ncomplete-stdout\n");
  });

  it("identifies a gated job when its script succeeds and its agent fails", async () => {
    const { errors, alpha } = await setup();
    await fs.writeFile(path.join(alpha.workspace, "gate.sh"), "echo '{\"wakeAgent\":true}'\n");
    const job = await add({ script: "gate.sh", message: "Digest" });
    const result = await scheduler.runNow("alpha", job.id);
    expect(errors.mock.calls).toHaveLength(1);
    expect(errors.mock.calls[0]).toHaveLength(1);
    const line = String(errors.mock.calls[0]![0]);
    expect(line.split("\n")).toHaveLength(1);
    expect(JSON.parse(line)).toMatchObject({
      level: "error", jobId: job.id, jobName: "Digest", agentId: "alpha",
      kind: "gated", phase: "agent", message: "Provider unavailable",
    });
    expect(JSON.parse(line)).not.toHaveProperty("stderrTail");
    const [run] = await scheduler.listRuns("alpha", job.id);
    expect(JSON.parse(line).runId).toBe(run!.id);
    expect(run!.error).toBe("Provider unavailable\nprivate diagnostic");
    expect(await fs.readFile(result.outputPath!, "utf8")).toContain(run!.error);
  });
});
