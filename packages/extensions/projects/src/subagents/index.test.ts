import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { GatewayConfig } from "@yoplai/shared";
import { afterEach, describe, expect, it } from "vitest";
import { getSubagentLogs } from "./index.js";

const tmpRoots: string[] = [];

async function setupLogs(lines: Record<string, unknown>[]): Promise<{
  config: GatewayConfig;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-subagents-"));
  tmpRoots.push(root);
  const projectDir = path.join(root, "PRO-1_empty-exec");
  const sessionDir = path.join(projectDir, "sessions", "worker");
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(
    path.join(sessionDir, "logs.jsonl"),
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    "utf8"
  );
  return {
    config: {
      agents: [],
      sessions: { idleMinutes: 360 },
      projects: { root },
    },
  };
}

afterEach(async () => {
  await Promise.all(
    tmpRoots
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

describe("getSubagentLogs shell diagnostics", () => {
  it("emits warning event for empty exec result payloads", async () => {
    const { config } = await setupLogs([
      {
        type: "tool_execution_start",
        toolCallId: "t1",
        toolName: "exec_command",
        args: { cmd: "yoplai projects start PRO-1 --subagent Worker" },
      },
      {
        type: "tool_execution_end",
        toolCallId: "t1",
        toolName: "exec_command",
        result: { stdout: "", stderr: "", is_error: false },
        isError: false,
      },
    ]);

    const out = await getSubagentLogs(config, "PRO-1", "worker", 0);
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const warning = out.data.events.find((event) => event.type === "warning");
    expect(warning).toBeTruthy();
    expect(warning?.text).toContain(
      "No output captured for shell command: yoplai projects start PRO-1 --subagent Worker"
    );
    expect(warning?.text).toContain(
      "command -v yoplai && yoplai projects --version"
    );
  });

  it("does not emit warning event when stdout is present", async () => {
    const { config } = await setupLogs([
      {
        type: "tool_execution_start",
        toolCallId: "t2",
        toolName: "exec_command",
        args: { cmd: "yoplai projects --version" },
      },
      {
        type: "tool_execution_end",
        toolCallId: "t2",
        toolName: "exec_command",
        result: { stdout: "yoplai projects 1.2.3", stderr: "", is_error: false },
        isError: false,
      },
    ]);

    const out = await getSubagentLogs(config, "PRO-1", "worker", 0);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.events.some((event) => event.type === "warning")).toBe(
      false
    );
  });
});

describe("getSubagentLogs usage snapshots", () => {
  it("returns latest Claude usage and context estimate", async () => {
    const { config } = await setupLogs([
      {
        type: "assistant",
        message: {
          role: "assistant",
          model: "claude-opus-4-6",
          content: [{ type: "text", text: "hi" }],
          usage: {
            input_tokens: 1200,
            cache_read_input_tokens: 5000,
            cache_creation_input_tokens: 800,
            output_tokens: 200,
          },
        },
      },
    ]);

    const out = await getSubagentLogs(config, "PRO-1", "worker", 0);
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    expect(out.data.latestUsage).toEqual({
      input: 1200,
      output: 200,
      cacheRead: 5000,
      cacheWrite: 800,
      totalTokens: 1400,
    });
    expect(out.data.latestContextEstimate).toEqual({
      usedTokens: 7000,
      maxTokens: 200000,
      pct: 4,
      basis: "claude_prompt_tokens",
      available: true,
    });

    const next = await getSubagentLogs(
      config,
      "PRO-1",
      "worker",
      out.data.cursor
    );
    expect(next.ok).toBe(true);
    if (!next.ok) return;

    expect(next.data.events).toEqual([]);
    expect(next.data.latestUsage).toEqual(out.data.latestUsage);
    expect(next.data.latestContextEstimate).toEqual(
      out.data.latestContextEstimate
    );
  });

  it("infers Codex context usage from average input per agent message", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-subagents-"));
    tmpRoots.push(root);
    const projectDir = path.join(root, "PRO-1_empty-exec");
    const sessionDir = path.join(projectDir, "sessions", "worker");
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, "config.json"),
      JSON.stringify({ model: "gpt-5.3-codex" }),
      "utf8"
    );
    await fs.writeFile(
      path.join(sessionDir, "logs.jsonl"),
      [
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "one" },
        }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "two" },
        }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "three" },
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: {
            input_tokens: 9000,
            cached_input_tokens: 1500,
            output_tokens: 120,
            total_tokens: 9120,
          },
        }),
      ].join("\n") + "\n",
      "utf8"
    );

    const out = await getSubagentLogs(
      {
        agents: [],
        sessions: { idleMinutes: 360 },
        projects: { root },
      },
      "PRO-1",
      "worker",
      0
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    expect(out.data.latestUsage).toEqual({
      input: 9000,
      output: 120,
      cacheRead: 1500,
      totalTokens: 9120,
    });
    expect(out.data.latestContextEstimate).toEqual({
      usedTokens: 3000,
      maxTokens: 1000000,
      pct: 0,
      basis: "codex_inferred",
      available: true,
    });
  });

  it("uses the full turn delta when Codex has one agent message", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-subagents-"));
    tmpRoots.push(root);
    const projectDir = path.join(root, "PRO-1_empty-exec");
    const sessionDir = path.join(projectDir, "sessions", "worker");
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, "config.json"),
      JSON.stringify({ model: "gpt-5.3-codex" }),
      "utf8"
    );
    await fs.writeFile(
      path.join(sessionDir, "logs.jsonl"),
      [
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "one" },
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: {
            input_tokens: 42000,
            output_tokens: 200,
            total_tokens: 42200,
          },
        }),
      ].join("\n") + "\n",
      "utf8"
    );

    const out = await getSubagentLogs(
      {
        agents: [],
        sessions: { idleMinutes: 360 },
        projects: { root },
      },
      "PRO-1",
      "worker",
      0
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    expect(out.data.latestContextEstimate).toEqual({
      usedTokens: 42000,
      maxTokens: 1000000,
      pct: 4,
      basis: "codex_inferred",
      available: true,
    });
  });

  it("uses only the latest Codex turn delta across consecutive turns", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-subagents-"));
    tmpRoots.push(root);
    const projectDir = path.join(root, "PRO-1_empty-exec");
    const sessionDir = path.join(projectDir, "sessions", "worker");
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, "config.json"),
      JSON.stringify({ model: "gpt-5.3-codex" }),
      "utf8"
    );
    await fs.writeFile(
      path.join(sessionDir, "logs.jsonl"),
      [
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "one" },
        }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "two" },
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: {
            input_tokens: 10000,
            output_tokens: 100,
            total_tokens: 10100,
          },
        }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "three" },
        }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "four" },
        }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "five" },
        }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "six" },
        }),
        JSON.stringify({
          type: "turn.completed",
          usage: {
            input_tokens: 22000,
            output_tokens: 220,
            total_tokens: 22220,
          },
        }),
      ].join("\n") + "\n",
      "utf8"
    );

    const out = await getSubagentLogs(
      {
        agents: [],
        sessions: { idleMinutes: 360 },
        projects: { root },
      },
      "PRO-1",
      "worker",
      0
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    expect(out.data.latestUsage).toEqual({
      input: 22000,
      output: 220,
      totalTokens: 22220,
    });
    expect(out.data.latestContextEstimate).toEqual({
      usedTokens: 3000,
      maxTokens: 1000000,
      pct: 0,
      basis: "codex_inferred",
      available: true,
    });
  });

  it("falls back to one Codex call when no agent messages were logged", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-subagents-"));
    tmpRoots.push(root);
    const projectDir = path.join(root, "PRO-1_empty-exec");
    const sessionDir = path.join(projectDir, "sessions", "worker");
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, "config.json"),
      JSON.stringify({ model: "gpt-5.3-codex" }),
      "utf8"
    );
    await fs.writeFile(
      path.join(sessionDir, "logs.jsonl"),
      `${JSON.stringify({
        type: "turn.completed",
        usage: {
          input_tokens: 5000,
          output_tokens: 150,
          total_tokens: 5150,
        },
      })}\n`,
      "utf8"
    );

    const out = await getSubagentLogs(
      {
        agents: [],
        sessions: { idleMinutes: 360 },
        projects: { root },
      },
      "PRO-1",
      "worker",
      0
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    expect(out.data.latestContextEstimate).toEqual({
      usedTokens: 5000,
      maxTokens: 1000000,
      pct: 1,
      basis: "codex_inferred",
      available: true,
    });
  });
});
