import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderCronRunOutput, writeCronRunOutput } from "./output.js";

describe("cron output", () => {
  let tmpDir: string | undefined;

  afterEach(async () => {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("renders hybrid frontmatter and markdown sections", () => {
    const content = renderCronRunOutput({
      workspaceDir: "/tmp/agent",
      jobId: "morning-digest",
      agentId: "devagent",
      sessionId: "scheduler:morning-digest:1",
      model: { provider: "anthropic", model: "claude-sonnet-4" },
      runType: "cron",
      name: "Morning digest",
      prompt: "Summarize overnight events.",
      schedule: "0 8 * * * Europe/Paris",
      firedAt: new Date("2026-05-19T07:00:00Z"),
      finishedAt: new Date("2026-05-19T07:00:14Z"),
      status: "ok",
      durationMs: 14000,
      response: "Done.",
    });

    expect(content).toContain("---\njob_id: \"morning-digest\"");
    expect(content).toContain("run_type: cron");
    expect(content).toContain("model:\n  provider: \"anthropic\"\n  name: \"claude-sonnet-4\"");
    expect(content).toContain("# Cron Job: Morning digest");
    expect(content).toContain("**Model:** anthropic/claude-sonnet-4");
    expect(content).toContain("## Prompt\n\nSummarize overnight events.");
    expect(content).toContain("## Response\n\nDone.");
    expect(content).not.toContain("**Status:**");
  });

  const base = {
    workspaceDir: "/tmp/agent",
    jobId: "rotate",
    agentId: "devagent",
    runType: "cron" as const,
    name: "Rotate token",
    schedule: "*/5 * * * * UTC",
    firedAt: new Date("2026-05-19T07:00:00Z"),
    finishedAt: new Date("2026-05-19T07:00:02Z"),
    durationMs: 2000,
  };

  it("renders a script-only run with no session and no prompt", () => {
    const content = renderCronRunOutput({
      ...base,
      status: "ok",
      statusLabel: "ok",
      response: "rotated\n",
    });

    expect(content).not.toContain("session_id:");
    expect(content).not.toContain("## Prompt");
    expect(content).toContain('status_label: "ok"');
    expect(content).toContain("**Status:** ok");
    expect(content).toContain("## Response\n\nrotated");
  });

  it("renders a silent tick", () => {
    const content = renderCronRunOutput({
      ...base,
      prompt: "Check the inbox.",
      status: "ok",
      statusLabel: "ok (silent tick)",
      response: "silent tick",
    });

    expect(content).toContain('status_label: "ok (silent tick)"');
    expect(content).toContain("**Status:** ok (silent tick)");
    expect(content).toContain("## Response\n\nsilent tick");
  });

  it("renders a woke-agent run with gate output before the response", () => {
    const content = renderCronRunOutput({
      ...base,
      sessionId: "scheduler:rotate:1",
      prompt: "Check the inbox.",
      status: "ok",
      statusLabel: "woke agent",
      gateOutput: '{"wakeAgent":true,"context":{"count":2}}\n',
      response: "Two new rows.",
    });

    expect(content).toContain("**Status:** woke agent");
    expect(content.indexOf("## Gate Output")).toBeLessThan(
      content.indexOf("## Response")
    );
    expect(content).toContain('## Gate Output\n\n{"wakeAgent":true');
    expect(content).toContain("## Response\n\nTwo new rows.");
  });

  it("renders a script failure with its exit code", () => {
    const content = renderCronRunOutput({
      ...base,
      status: "error",
      statusLabel: "script failed (exit 3)",
      exitCode: 3,
      error: new Error("script failed (exit 3)\nstderr:\nboom\nstdout:\n"),
    });

    expect(content).toContain('status_label: "script failed (exit 3)"');
    expect(content).toContain("exit_code: 3");
    expect(content).toContain("**Status:** script failed (exit 3)");
    expect(content).toContain("## Error");
    expect(content).toContain("boom");
  });

  it("renders per-target delivery outcomes as notes", () => {
    const content = renderCronRunOutput({
      ...base,
      status: "ok",
      statusLabel: "ok",
      response: "rotated",
      delivery: [
        { target: "slack", ok: true },
        { target: "irc", ok: false, error: 'no delivery sink registered for "irc"' },
      ],
    });

    expect(content).toContain(
      '## Delivery\n\n- slack: delivered\n- irc: warning: no delivery sink registered for "irc"'
    );
    expect(content.indexOf("## Response")).toBeLessThan(
      content.indexOf("## Delivery")
    );
  });

  it("omits the delivery section when nothing was delivered", () => {
    const content = renderCronRunOutput({
      ...base,
      status: "ok",
      statusLabel: "ok",
      response: "rotated",
      delivery: [],
    });

    expect(content).not.toContain("## Delivery");
  });

  it("writes timestamped output file", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-scheduler-output-"));

    const filePath = await writeCronRunOutput({
      workspaceDir: tmpDir,
      jobId: "job-1",
      agentId: "devagent",
      sessionId: "session-1",
      runType: "cron",
      name: "Job One",
      prompt: "Ping",
      schedule: "* * * * * UTC",
      firedAt: new Date("2026-05-19T07:00:00Z"),
      finishedAt: new Date("2026-05-19T07:00:01Z"),
      status: "error",
      durationMs: 1000,
      error: new Error("boom"),
    });

    expect(filePath).toBe(path.join(tmpDir, "cron/output/job-1/2026-05-19_07-00-00.md"));
    const content = await fs.readFile(filePath, "utf8");
    expect(content).toContain("## Error");
    expect(content).toContain("boom");
  });
});
