import type { Schedule, ScheduleJob } from "@yoplai/shared";
import { formatSchedule } from "../schedule.js";

export type ScheduleInputOpts = {
  cron?: string;
  tz?: string;
  startAt?: string;
};

export function buildScheduleFromOpts(opts: ScheduleInputOpts): Schedule {
  if (!opts.cron) {
    throw new Error("Schedule required: pass --cron <expr>.");
  }
  if (!opts.tz) {
    throw new Error("Timezone required: pass --tz <iana>.");
  }
  const schedule: Schedule = { cron: opts.cron, tz: opts.tz };
  if (opts.startAt) {
    const ms = Date.parse(opts.startAt);
    if (Number.isNaN(ms)) {
      throw new Error(`Invalid --start-at "${opts.startAt}". Use ISO 8601.`);
    }
    schedule.startAt = new Date(ms).toISOString();
  }
  return schedule;
}

export function defaultJobName(agentId: string, schedule: Schedule): string {
  return `${agentId}-${schedule.cron.replace(/\s+/g, "-")}`;
}

export type JobWithState = ScheduleJob & {
  state?: {
    nextRunAtMs?: number;
    lastRunAtMs?: number;
    lastStatus?: "ok" | "error";
    lastError?: string;
    runningForMs?: number;
  };
};

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

export function renderJobsTable(jobs: JobWithState[]): string {
  const headers = ["id", "name", "agent", "schedule", "next-run", "last-status", "running-for"];
  const formatCell = (value: unknown) =>
    String(value ?? "")
      .replace(/\r?\n/g, " ")
      .replace(/\|/g, "\\|");

  const rows = jobs.map((job) => [
    job.id,
    job.name,
    job.agentId,
    formatSchedule(job.schedule),
    job.state?.nextRunAtMs
      ? new Date(job.state.nextRunAtMs).toISOString()
      : "",
    job.state?.lastStatus ?? "",
    job.state?.runningForMs != null ? formatDuration(job.state.runningForMs) : "",
  ]);

  const headerRow = `| ${headers.join(" | ")} |`;
  const separator = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${row.map(formatCell).join(" | ")} |`).join("\n");
  return [headerRow, separator, body].filter(Boolean).join("\n");
}
