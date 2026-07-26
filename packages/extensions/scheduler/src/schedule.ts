import { CronExpressionParser } from "cron-parser";
import type { Schedule } from "@yoplai/shared";

export function computeNextRunAtMs(schedule: Schedule, nowMs: number): number {
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
  const base = `${schedule.cron} ${schedule.tz}`;
  return schedule.startAt ? `${base} @ ${schedule.startAt}` : base;
}
