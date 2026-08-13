import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getSubagentLogs,
  listSubagentRuns,
  startSubagentRun,
} from "./runtime.js";

let tempDir: string;

const runtimeOptions = () => ({
  dataDir: tempDir,
  emit: () => undefined,
});

async function writeRun(
  runId: string,
  lines: string[],
  progress?: { latestOutput?: string },
  configOverrides: Record<string, unknown> = {},
  stateOverrides: Record<string, unknown> = {}
) {
  const runDir = path.join(tempDir, "sessions", "subagents", "runs", runId);
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(
    path.join(runDir, "config.json"),
    JSON.stringify({
      id: runId,
      label: "Worker",
      cli: "codex",
      cwd: tempDir,
      prompt: "test",
      createdAt: "2026-04-27T00:00:00.000Z",
      archived: false,
      ...configOverrides,
    }),
    "utf8"
  );
  await fs.writeFile(
    path.join(runDir, "state.json"),
    JSON.stringify({
      startedAt: "2026-04-27T00:00:00.000Z",
      status: "done",
      exitCode: 0,
      ...stateOverrides,
    }),
    "utf8"
  );
  if (progress) {
    await fs.writeFile(
      path.join(runDir, "progress.json"),
      JSON.stringify(progress),
      "utf8"
    );
  }
  await fs.writeFile(path.join(runDir, "logs.jsonl"), lines.join("\n"), "utf8");
}

describe("subagent runtime logs", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-subagents-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("hides Codex runtime lifecycle and internal stderr noise", async () => {
    await writeRun("run-1", [
      JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({
        type: "stderr",
        text: "2026-04-27T00:00:00Z WARN codex_features: unknown feature key in config: skills",
      }),
      JSON.stringify({
        type: "stderr",
        text: "2026-04-27T00:00:00Z ERROR codex_core::session: failed to record rollout items",
      }),
      JSON.stringify({
        type: "item.started",
        item: { type: "collab_tool_call", status: "in_progress" },
      }),
      JSON.stringify({
        type: "item.started",
        item: {
          type: "command_execution",
          command: "echo ok",
          status: "in_progress",
        },
      }),
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "command_execution",
          command: "echo ok",
          status: "completed",
          exit_code: 0,
          aggregated_output: "ok",
        },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Done." },
      }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1 } }),
      JSON.stringify({ type: "stderr", text: "actual failure" }),
    ]);

    const logs = await getSubagentLogs(runtimeOptions(), "run-1", 0);

    expect(logs.events.map((event) => event.text)).toEqual([
      JSON.stringify({
        type: "item.started",
        item: {
          type: "command_execution",
          command: "echo ok",
          status: "in_progress",
        },
      }),
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "command_execution",
          command: "echo ok",
          status: "completed",
          exit_code: 0,
          aggregated_output: "ok",
        },
      }),
      "Done.",
      "actual failure",
    ]);
  });

  it("ignores hidden runtime events when deriving latest output", async () => {
    await writeRun(
      "run-1",
      [
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "Useful result." },
        }),
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1 } }),
        JSON.stringify({
          type: "stderr",
          text: "2026-04-27T00:00:00Z WARN codex_core_plugins::manifest: ignored",
        }),
      ],
      {
        latestOutput:
          "2026-04-27T00:00:00Z ERROR codex_core::session: failed to record rollout items",
      }
    );

    const runs = await listSubagentRuns(runtimeOptions());

    expect(runs[0]?.latestOutput).toBe("Useful result.");
  });

  it("filters runs by canonical cwd", async () => {
    const realDir = await fs.mkdtemp(path.join(tempDir, "real-"));
    const linkDir = path.join(tempDir, "link");
    const otherDir = await fs.mkdtemp(path.join(tempDir, "other-"));
    await fs.symlink(realDir, linkDir);
    await writeRun("run-match", [], undefined, { cwd: linkDir });
    await writeRun("run-other", [], undefined, { cwd: otherDir });

    const runs = await listSubagentRuns(runtimeOptions(), { cwd: realDir });

    expect(runs.map((run) => run.id)).toEqual(["run-match"]);
  });

  it("filters cwd with home expansion", async () => {
    const homeRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "yoplai-subagents-home-root-")
    );
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = homeRoot;
    process.env.USERPROFILE = homeRoot;
    const homeDir = await fs.mkdtemp(
      path.join(os.homedir(), ".yoplai-subagents-home-")
    );
    try {
      const cwd = path.join(homeDir, "home-run");
      await fs.mkdir(cwd, { recursive: true });
      await writeRun("run-home", [], undefined, { cwd });
      await writeRun("run-other", [], undefined, { cwd: tempDir });

      const runs = await listSubagentRuns(runtimeOptions(), {
        cwd: `~/${path.relative(os.homedir(), cwd)}`,
      });

      expect(runs.map((run) => run.id)).toEqual(["run-home"]);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
      await fs.rm(homeRoot, { recursive: true, force: true });
    }
  });

  it("reads legacy runs without projectId/sliceId", async () => {
    await writeRun("run-legacy", []);

    const runs = await listSubagentRuns(runtimeOptions());

    expect(runs[0]?.projectId).toBeUndefined();
    expect(runs[0]?.sliceId).toBeUndefined();
  });

  it("surfaces projectId/sliceId when present", async () => {
    await writeRun("run-attributed", [], undefined, {
      projectId: "PRO-238",
      sliceId: "PRO-238-S01",
    });

    const runs = await listSubagentRuns(runtimeOptions());

    expect(runs[0]?.projectId).toBe("PRO-238");
    expect(runs[0]?.sliceId).toBe("PRO-238-S01");
  });

  it("filters runs by projectId and sliceId", async () => {
    await writeRun("run-match", [], undefined, {
      projectId: "PRO-238",
      sliceId: "PRO-238-S01",
    });
    await writeRun("run-other-project", [], undefined, {
      projectId: "PRO-239",
      sliceId: "PRO-239-S01",
    });
    await writeRun("run-other-slice", [], undefined, {
      projectId: "PRO-238",
      sliceId: "PRO-238-S02",
    });

    const runs = await listSubagentRuns(runtimeOptions(), {
      projectId: "PRO-238",
      sliceId: "PRO-238-S01",
    });

    expect(runs.map((run) => run.id)).toEqual(["run-match"]);
  });

  it("reserves labels atomically for concurrent starts", async () => {
    const binDir = await fs.mkdtemp(path.join(tempDir, "bin-"));
    const codexPath = path.join(binDir, "codex");
    await fs.writeFile(codexPath, "#!/bin/sh\nexit 0\n", {
      encoding: "utf8",
      mode: 0o755,
    });
    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;

    try {
      const input = {
        cli: "codex" as const,
        cwd: tempDir,
        prompt: "test",
        label: "Worker",
        parent: { type: "board", id: "main" },
      };
      const results = await Promise.allSettled([
        startSubagentRun(runtimeOptions(), input),
        startSubagentRun(runtimeOptions(), input),
      ]);

      expect(
        results.filter((result) => result.status === "fulfilled")
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === "rejected")
      ).toHaveLength(1);
      expect(
        results.find((result) => result.status === "rejected")
      ).toMatchObject({
        reason: expect.objectContaining({
          message: "Subagent label already exists for parent: Worker",
        }),
      });
      const runs = await listSubagentRuns(runtimeOptions(), {
        parent: input.parent,
        includeArchived: true,
      });
      expect(runs).toHaveLength(1);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("persists projectId/sliceId for new runs", async () => {
    const binDir = await fs.mkdtemp(path.join(tempDir, "bin-"));
    const codexPath = path.join(binDir, "codex");
    await fs.writeFile(codexPath, "#!/bin/sh\nexit 0\n", {
      encoding: "utf8",
      mode: 0o755,
    });
    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;

    try {
      const run = await startSubagentRun(runtimeOptions(), {
        cli: "codex",
        cwd: tempDir,
        prompt: "test",
        label: "Worker",
        projectId: "PRO-238",
        sliceId: "PRO-238-S01",
      });
      expect(run.projectId).toBe("PRO-238");
      expect(run.sliceId).toBe("PRO-238-S01");
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("normalizes Claude JSONL envelopes into displayable events", async () => {
    await writeRun("run-1", [
      JSON.stringify({
        type: "system",
        subtype: "hook_started",
        hook_name: "SessionStart:startup",
      }),
      JSON.stringify({
        type: "rate_limit_event",
        rate_limit_info: { status: "allowed" },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", name: "Read", input: {} }],
        },
      }),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", content: "internal output" }],
        },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Readable assistant text." }],
        },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        result: "Final result.",
      }),
    ]);

    const logs = await getSubagentLogs(runtimeOptions(), "run-1", 0);

    expect(logs.events).toEqual([
      {
        type: "tool_call",
        text: "{}",
        tool: { name: "Read", id: "" },
      },
      {
        type: "tool_output",
        text: "internal output",
        tool: { id: "" },
      },
      { type: "assistant", text: "Readable assistant text." },
      { type: "result", text: "Final result." },
    ]);
  });

  it("hides Pi runtime lifecycle and delta noise", async () => {
    await writeRun("run-1", [
      JSON.stringify({ type: "agent_start" }),
      JSON.stringify({ type: "turn_start" }),
      JSON.stringify({ type: "message_start" }),
      JSON.stringify({ type: "text_start" }),
      JSON.stringify({ type: "text_delta", text: "Hel" }),
      JSON.stringify({ type: "text_delta", text: "lo" }),
      JSON.stringify({ type: "text_end" }),
      JSON.stringify({ type: "thinking_start" }),
      JSON.stringify({ type: "thinking_delta", thinking: "hmm" }),
      JSON.stringify({ type: "thinking_end" }),
      JSON.stringify({ type: "toolcall_start" }),
      JSON.stringify({ type: "toolcall_delta" }),
      JSON.stringify({ type: "toolcall_end" }),
      JSON.stringify({ type: "tool_execution_start" }),
      JSON.stringify({ type: "tool_execution_update" }),
      JSON.stringify({ type: "message_end" }),
      JSON.stringify({ type: "agent_settled" }),
    ]);

    const logs = await getSubagentLogs(runtimeOptions(), "run-1", 0);

    expect(logs.events).toEqual([]);
  });

  it("extracts assistant text from a Pi turn_end message, excluding thinking blocks", async () => {
    await writeRun("run-1", [
      JSON.stringify({
        type: "turn_end",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "internal reasoning" },
            { type: "text", text: "final answer" },
          ],
        },
      }),
    ]);

    const logs = await getSubagentLogs(runtimeOptions(), "run-1", 0);

    expect(logs.events).toEqual([{ type: "assistant", text: "final answer" }]);
  });

  it("ignores a non-assistant Pi turn_end message", async () => {
    await writeRun("run-1", [
      JSON.stringify({
        type: "turn_end",
        message: {
          role: "toolResult",
          content: [{ type: "text", text: "tool output" }],
        },
      }),
    ]);

    const logs = await getSubagentLogs(runtimeOptions(), "run-1", 0);

    expect(logs.events).toEqual([]);
  });

  it("extracts the last assistant message from a Pi agent_end payload", async () => {
    await writeRun("run-1", [
      JSON.stringify({
        type: "agent_end",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "do the thing" }],
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "first answer" }],
          },
          {
            role: "toolResult",
            content: [{ type: "text", text: "tool output" }],
          },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "internal reasoning" },
              { type: "text", text: "last answer" },
            ],
          },
        ],
      }),
    ]);

    const logs = await getSubagentLogs(runtimeOptions(), "run-1", 0);

    expect(logs.events).toEqual([{ type: "assistant", text: "last answer" }]);
  });

  it("uses the real final answer from a Pi turn_end line for latestOutput instead of raw agent_settled JSON", async () => {
    await writeRun("run-1", [
      JSON.stringify({
        type: "turn_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "The real final answer." }],
        },
      }),
      JSON.stringify({ type: "agent_settled" }),
    ]);

    const runs = await listSubagentRuns(runtimeOptions());

    expect(runs[0]?.latestOutput).toBe("The real final answer.");
  });
});
