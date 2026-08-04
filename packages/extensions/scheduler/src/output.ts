import fs from "node:fs/promises";
import path from "node:path";
import type { DeliveryOutcome } from "./deliver.js";

export type CronRunOutputInput = {
  workspaceDir: string;
  jobId: string;
  agentId: string;
  /** Absent for script-only and silent-tick runs, which never open a session. */
  sessionId?: string;
  model?: { provider: string; model: string };
  runType: "cron" | "heartbeat";
  name: string;
  /** Absent for script-only runs, which have no prompt. */
  prompt?: string;
  schedule?: string;
  firedAt: Date;
  finishedAt: Date;
  status: "ok" | "error";
  /** `ok` | `ok (silent tick)` | `woke agent` | `script failed (exit N)` | `error`. */
  statusLabel?: string;
  exitCode?: number;
  durationMs: number;
  response?: string;
  /** Script stdout of a gate that woke the agent. */
  gateOutput?: string;
  error?: unknown;
  /** Per-target runtime delivery outcomes; failures are warnings, not run failures. */
  delivery?: DeliveryOutcome[];
  resultStatus?: "ok" | "warn" | "error";
};

export async function writeCronRunOutput(
  input: CronRunOutputInput
): Promise<string> {
  const dir = path.join(input.workspaceDir, "cron", "output", input.jobId);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${formatFileTimestamp(input.firedAt)}.md`);
  await fs.writeFile(filePath, renderCronRunOutput(input), "utf8");
  return filePath;
}

export function renderCronRunOutput(input: CronRunOutputInput): string {
  const title = input.runType === "heartbeat" ? "Heartbeat" : `Cron Job: ${input.name}`;
  const lines = [
    "---",
    `job_id: ${yamlString(input.jobId)}`,
    `agent_id: ${yamlString(input.agentId)}`,
  ];
  if (input.sessionId) lines.push(`session_id: ${yamlString(input.sessionId)}`);
  lines.push(
    `run_type: ${input.runType}`,
    `fired_at: ${input.firedAt.toISOString()}`,
    `finished_at: ${input.finishedAt.toISOString()}`,
    `status: ${input.status}`,
    `duration_ms: ${input.durationMs}`
  );
  if (input.statusLabel) {
    lines.push(`status_label: ${yamlString(input.statusLabel)}`);
  }
  if (input.exitCode !== undefined) lines.push(`exit_code: ${input.exitCode}`);
  if (input.schedule) lines.push(`schedule: ${yamlString(input.schedule)}`);
  if (input.model) {
    lines.push("model:");
    lines.push(`  provider: ${yamlString(input.model.provider)}`);
    lines.push(`  name: ${yamlString(input.model.model)}`);
  }
  if (input.resultStatus) lines.push(`result_status: ${input.resultStatus}`);
  lines.push("---", "", `# ${title}`, "");
  lines.push(`**Job ID:** ${input.jobId}`);
  lines.push(`**Run Time:** ${formatDisplayTimestamp(input.firedAt)}`);
  if (input.schedule) lines.push(`**Schedule:** ${input.schedule}`);
  if (input.model) {
    lines.push(`**Model:** ${input.model.provider}/${input.model.model}`);
  }
  if (input.statusLabel) lines.push(`**Status:** ${input.statusLabel}`);
  lines.push("");
  if (input.prompt !== undefined) {
    lines.push("## Prompt", "", input.prompt, "");
  }
  if (input.gateOutput !== undefined) {
    lines.push("## Gate Output", "", input.gateOutput.trim() || "[no output]", "");
  }
  if (input.status === "ok") {
    lines.push("## Response", "", input.response?.trim() || "[no response]");
  } else {
    lines.push("## Error", "", "```txt", formatError(input.error), "```");
  }
  if (input.delivery?.length) {
    lines.push("", "## Delivery", "");
    for (const outcome of input.delivery) {
      lines.push(`- ${formatDeliveryOutcome(outcome)}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function formatDeliveryOutcome(outcome: DeliveryOutcome): string {
  return outcome.ok
    ? `${outcome.target}: delivered`
    : `${outcome.target}: warning: ${outcome.error}`;
}

export function latestAssistantText(payloads: Array<{ text?: string }>): string {
  for (let i = payloads.length - 1; i >= 0; i--) {
    const text = payloads[i]?.text?.trim();
    if (text) return text;
  }
  return "";
}

export function formatScheduleForOutput(schedule: {
  cron: string;
  tz: string;
  startAt?: string;
}): string {
  const base = `${schedule.cron} ${schedule.tz}`;
  return schedule.startAt ? `${base} @ ${schedule.startAt}` : base;
}

function formatFileTimestamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", "_").replace(/:/g, "-");
}

function formatDisplayTimestamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}
