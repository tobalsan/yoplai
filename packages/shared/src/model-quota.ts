import { z } from "zod";

export type LoginIdentity = { provider: string; accountRef: string };
export type QuotaSource = "headers" | "usage-endpoint" | "wham-usage";
export const QuotaWindowSchema = z
  .object({
    kind: z.enum(["five-hour", "weekly", "other"]),
    usedPercent: z.number().finite().min(0).max(100),
    resetAt: z.number().finite().nonnegative(),
    windowSeconds: z.number().finite().positive(),
    status: z.enum(["allowed", "rejected", "limited", "unknown"]).optional(),
  })
  .strict();
export type QuotaWindow = z.infer<typeof QuotaWindowSchema>;
export type QuotaParseResult =
  | { ok: true; windows: QuotaWindow[]; planLabel?: string }
  | { ok: false; error: "invalid_payload" };
export type QuotaSnapshot = LoginIdentity & {
  status: "known" | "unknown";
  windows: QuotaWindow[];
  source?: QuotaSource;
  updatedAt?: number;
  stale: boolean;
  errorKind?: string;
  planLabel?: string;
};

export function parseClaudeQuotaHeaders(
  headers: Record<string, string>
): QuotaParseResult {
  const readHeader = (name: string): string | undefined => {
    const key = Object.keys(headers).find((key) => key.toLowerCase() === name);
    return key === undefined ? undefined : headers[key];
  };
  const windows: QuotaWindow[] = [];
  for (const [name, kind, seconds] of [
    ["5h", "five-hour", 18000],
    ["7d", "weekly", 604800],
  ] as const) {
    const prefix = `anthropic-ratelimit-unified-${name}-`;
    const status = readHeader(`${prefix}status`);
    const utilization = readHeader(`${prefix}utilization`);
    const reset = readHeader(`${prefix}reset`);
    if (
      utilization === undefined &&
      reset === undefined &&
      status === undefined
    )
      continue;
    if (!utilization?.trim() || !reset?.trim())
      return { ok: false, error: "invalid_payload" };
    windows.push({
      kind,
      windowSeconds: seconds,
      usedPercent: Number(utilization) * 100,
      resetAt: Number(reset),
      ...(status
        ? {
            status:
              status === "allowed" ||
              status === "rejected" ||
              status === "limited"
                ? status
                : "unknown",
          }
        : {}),
    });
  }
  if (!z.array(QuotaWindowSchema).safeParse(windows).success)
    return { ok: false, error: "invalid_payload" };
  return { ok: true, windows };
}

export function classifyQuotaWindow(
  windowSeconds: number
): QuotaWindow["kind"] {
  if (windowSeconds >= 16200 && windowSeconds <= 19800) return "five-hour";
  if (windowSeconds >= 544320 && windowSeconds <= 665280) return "weekly";
  return "other";
}
