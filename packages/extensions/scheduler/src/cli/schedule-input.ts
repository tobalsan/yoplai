import { InvalidArgumentError } from "commander";
import type { DeliverTarget, Schedule, ScheduleJob } from "@yoplai/shared";
import { formatSchedule } from "../schedule.js";

export type ScheduleInputOpts = {
  cron?: string;
  tz?: string;
  startAt?: string;
};

// Parses one `--deliver <target>:<channel|user>:<value>` flag occurrence, e.g.
// "slack:channel:C0123" or "telegram:user:12345". Matches commander's collect
// pattern: called once per occurrence with the array built so far. Rejections
// must be InvalidArgumentError — commander rethrows anything else out of
// `parse()`, where the gateway's uncaughtException handler swallows it and the
// CLI exits 0 as if the job had been created.
export function parseDeliverFlag(
  value: string,
  previous: DeliverTarget[] = []
): DeliverTarget[] {
  const usage = 'Use <target>:<channel|user>:<value>, e.g. slack:channel:C0123.';
  const firstColon = value.indexOf(":");
  const secondColon = firstColon === -1 ? -1 : value.indexOf(":", firstColon + 1);
  if (
    firstColon <= 0 ||
    secondColon === -1 ||
    secondColon === firstColon + 1 ||
    secondColon === value.length - 1
  ) {
    throw new InvalidArgumentError(`Invalid --deliver "${value}". ${usage}`);
  }
  const target = value.slice(0, firstColon);
  const kind = value.slice(firstColon + 1, secondColon);
  const destValue = value.slice(secondColon + 1);
  if (kind !== "channel" && kind !== "user") {
    throw new InvalidArgumentError(`Invalid --deliver "${value}": second segment must be "channel" or "user". ${usage}`);
  }
  return [...previous, { target, [kind]: destValue } as DeliverTarget];
}

export function formatDeliver(deliver?: DeliverTarget[]): string {
  if (!deliver?.length) return "";
  return deliver.map((entry) => `${entry.target}:${entry.channel ?? entry.user}`).join(", ");
}

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

export type JobKind = "agent" | "script" | "gated";

export function jobKind(payload: ScheduleJob["payload"]): JobKind {
  if (payload.script && payload.noAgent) return "script";
  if (payload.script && payload.message) return "gated";
  return "agent";
}

export function renderJobsTable(jobs: JobWithState[]): string {
  const headers = [
    "id",
    "name",
    "agent",
    "kind",
    "schedule",
    "next-run",
    "last-status",
    "running-for",
    "deliver",
  ];
  const formatCell = (value: unknown) =>
    String(value ?? "")
      .replace(/\r?\n/g, " ")
      .replace(/\|/g, "\\|");

  const rows = jobs.map((job) => [
    job.id,
    job.name,
    job.agentId,
    jobKind(job.payload),
    formatSchedule(job.schedule),
    job.state?.nextRunAtMs
      ? new Date(job.state.nextRunAtMs).toISOString()
      : "",
    job.state?.lastStatus ?? "",
    job.state?.runningForMs != null ? formatDuration(job.state.runningForMs) : "",
    formatDeliver(job.deliver),
  ]);

  const headerRow = `| ${headers.join(" | ")} |`;
  const separator = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${row.map(formatCell).join(" | ")} |`).join("\n");
  return [headerRow, separator, body].filter(Boolean).join("\n");
}
