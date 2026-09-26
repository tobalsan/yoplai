import { CronExpressionParser } from "cron-parser";
import type { Schedule } from "@yoplai/shared";

export function computeNextRunAtMs(
  schedule: Schedule,
  nowMs: number,
  fired = false
): number | undefined {
  if (schedule.runAt !== undefined) {
    return fired ? undefined : Date.parse(schedule.runAt);
  }
  const currentDate = schedule.startAt
    ? new Date(Math.max(nowMs, Date.parse(schedule.startAt)))
    : new Date(nowMs);
  const expression = CronExpressionParser.parse(schedule.cron, {
    currentDate,
    tz: schedule.tz,
  });
  return expression.next().toDate().getTime();
}

export function formatSchedule(schedule: Schedule): string {
  if (schedule.runAt !== undefined) return `once ${schedule.runAt}`;
  const base = `${schedule.cron} ${schedule.tz}`;
  return schedule.startAt ? `${base} @ ${schedule.startAt}` : base;
}

export function parseRunAtInput(value: string, nowMs = Date.now()): string {
  const relative = /^in\s+(\d+)\s*(m|h)$/i.exec(value.trim());
  if (relative) {
    const amount = Number(relative[1]);
    const multiplier = relative[2]!.toLowerCase() === "h" ? 3_600_000 : 60_000;
    const at = nowMs + amount * multiplier;
    if (amount > 0 && Number.isFinite(at)) return new Date(at).toISOString();
  }
  if (/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    const at = Date.parse(value);
    if (Number.isFinite(at)) return new Date(at).toISOString();
  }
  throw new Error(
    `Invalid runAt "${value}". Use ISO 8601 with timezone, or "in 30m"/"in 2h".`
  );
}
