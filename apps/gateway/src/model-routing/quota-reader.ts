import { resolveLoginIdentity } from "../model-quota/identity.js";
import { QUOTA_MAX_AGE_SECONDS } from "../model-quota/constants.js";
import { fiveHourState, pace } from "../model-quota/policy.js";
import { modelQuotaStore, readQuotaCredential } from "../model-quota/runtime.js";
import type { Pool, QuotaSnapshot } from "./pool.js";

export type QuotaFacts = {
  ageSeconds: number | null;
  fiveHour: "ok" | "exhausted" | "absent" | "unknown";
  pace: number | null;
};
export type RoutingQuota = Record<Pool, QuotaSnapshot & { telemetry?: QuotaFacts }>;

/** Local host observations only: never refresh tokens, poll, or contact providers. */
export async function readRoutingQuota({ now }: { now: number }): Promise<RoutingQuota> {
  const nowSeconds = now / 1000;
  const read = (provider: string): RoutingQuota[Pool] => {
    const telemetry: QuotaFacts = { ageSeconds: null, fiveHour: "unknown", pace: null };
    const identity = resolveLoginIdentity(provider, readQuotaCredential(provider));
    if (!identity) return { status: "unknown", telemetry };
    const snapshot = modelQuotaStore.get(identity);
    if (!snapshot || snapshot.updatedAt === undefined) return { status: "unknown", telemetry };
    telemetry.ageSeconds = nowSeconds - snapshot.updatedAt;
    if (telemetry.ageSeconds > QUOTA_MAX_AGE_SECONDS
      || snapshot.windows.some((window) => window.kind !== "other" && nowSeconds >= window.resetAt)) {
      return { status: "unknown", reason: "stale", telemetry };
    }
    telemetry.fiveHour = fiveHourState(snapshot, nowSeconds);
    const weeklyPace = pace(snapshot, "weekly", nowSeconds);
    telemetry.pace = weeklyPace === "unknown" ? null : weeklyPace;
    return telemetry.fiveHour === "unknown" ? { status: "unknown", telemetry } : {
      status: "known", exhausted: telemetry.fiveHour === "exhausted",
      ...(weeklyPace === "unknown" ? {} : { pace: weeklyPace }), telemetry,
    };
  };
  return { claude: read("anthropic"), chatgpt: read("openai-codex") };
}
