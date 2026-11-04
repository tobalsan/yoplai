import { z } from "zod";
import { classifyQuotaWindow, type QuotaParseResult } from "@yoplai/shared";

export type UsageValidationIssue = { path: (string | number)[]; code: string };
type UsageParseResult = QuotaParseResult & { issues?: UsageValidationIssue[] };

function invalidPayload(error: z.ZodError): UsageParseResult {
  return {
    ok: false,
    error: "invalid_payload",
    issues: error.issues.slice(0, 20).map(({ path, code }) => ({
      path: path
        .filter((part): part is string | number => typeof part !== "symbol")
        .slice(0, 8),
      code,
    })),
  };
}

const percent = z.number().finite().min(0).max(100);
const claudeWindow = z.object({
  utilization: percent,
  resets_at: z
    .string()
    .datetime({ offset: true })
    .refine((value) => Date.parse(value) >= 0),
});
const claudeUsage = z
  .object({
    five_hour: claudeWindow.nullish(),
    seven_day: claudeWindow.nullish(),
  })
  .refine((usage) => usage.five_hour || usage.seven_day);

export function parseClaudeUsage(payload: unknown): UsageParseResult {
  const parsed = claudeUsage.safeParse(payload);
  if (!parsed.success) return invalidPayload(parsed.error);
  return {
    ok: true,
    windows: [
      ...(parsed.data.five_hour
        ? [
            {
              kind: "five-hour" as const,
              usedPercent: parsed.data.five_hour.utilization,
              resetAt: Date.parse(parsed.data.five_hour.resets_at) / 1000,
              windowSeconds: 18000,
            },
          ]
        : []),
      ...(parsed.data.seven_day
        ? [
            {
              kind: "weekly" as const,
              usedPercent: parsed.data.seven_day.utilization,
              resetAt: Date.parse(parsed.data.seven_day.resets_at) / 1000,
              windowSeconds: 604800,
            },
          ]
        : []),
    ],
  };
}

const whamWindow = z.object({
  used_percent: percent,
  limit_window_seconds: z.number().finite().positive(),
  reset_at: z.number().finite().nonnegative(),
});
const whamUsage = z.object({
  plan_type: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
  rate_limit: z.object({
    primary_window: whamWindow.nullable(),
    secondary_window: whamWindow.nullable(),
  }),
});

export function parseWhamUsage(payload: unknown): UsageParseResult {
  const parsed = whamUsage.safeParse(payload);
  if (!parsed.success) return invalidPayload(parsed.error);
  const { primary_window, secondary_window } = parsed.data.rate_limit;
  return {
    ok: true,
    planLabel: parsed.data.plan_type,
    windows: [primary_window, secondary_window].flatMap((window) =>
      window
        ? [
            {
              kind: classifyQuotaWindow(window.limit_window_seconds),
              usedPercent: window.used_percent,
              resetAt: window.reset_at,
              windowSeconds: window.limit_window_seconds,
            },
          ]
        : []
    ),
  };
}
