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
