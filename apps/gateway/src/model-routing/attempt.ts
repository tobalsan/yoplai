import { z } from "zod";
import { ThinkLevelSchema } from "@yoplai/shared";
import type { WorkRequestResult, CategoryResult } from "./classifier.js";
import type { QuotaFacts } from "./quota-reader.js";

const reason = z.enum(["no_key", "timeout", "aborted", "refusal", "malformed", "provider_error"]);
const latency = z.number().finite().nonnegative();
const timestamp = z.number().finite().min(-8_640_000_000_000_000).max(8_640_000_000_000_000);
const order = z.object({ ms: latency, completed: z.boolean() }).strict().nullable();
const predicate = z.discriminatedUnion("result", [
  z.object({ result: z.enum(["yes", "no"]), probability: z.number().min(0).max(1), latencyMs: latency }).strict(),
  z.object({ result: z.literal("unavailable"), reason, latencyMs: latency }).strict(),
]);
const classify = z.discriminatedUnion("result", [
  z.object({ result: z.literal("ok"), category: z.string().min(1), score: z.number().min(0).max(1), latencyMs: latency, orders: z.tuple([order, order]) }).strict(),
  z.object({ result: z.literal("unavailable"), reason, latencyMs: latency, orders: z.tuple([order, order]) }).strict(),
]);
const quota = z.object({ ageSeconds: z.number().finite().nullable(), fiveHour: z.enum(["ok", "exhausted", "absent", "unknown"]), pace: z.number().finite().nullable() }).strict();
const noLockReason = z.enum(["predicate-no", "predicate-unavailable", "classify-unavailable", "category-not-in-table", "quota-read-failed", "both-5h-exhausted", "lock-write-failed", "lock-lost"]);

export const RoutingAttemptSchema = z.object({
  v: z.literal(1), at: timestamp, mode: z.enum(["shadow", "enforce"]), tableVersion: z.string().min(1),
  threshold: z.number().min(0).max(1), seq: z.number().int().positive(), userMessageAt: timestamp,
  predicate, classify: classify.optional(), decision: z.enum(["routed", "usual", "none"]), noLockReason: noLockReason.optional(),
  poolReason: z.enum(["single-pick", "preference", "pace", "5h-exhausted", "quota-unknown", "quota-stale", "both-5h-exhausted"]).optional(),
  quota: z.object({ claude: quota, chatgpt: quota }).strict().optional(), pool: z.enum(["claude", "chatgpt"]).optional(),
  proposed: z.string().min(1).optional(), effort: ThinkLevelSchema.optional(), actual: z.string().min(1), totalMs: latency,
}).strict().superRefine((attempt, ctx) => {
  if ((attempt.decision === "none") !== (attempt.noLockReason !== undefined)) ctx.addIssue({ code: "custom", message: "No-lock attempts require a reason" });
  if ((attempt.predicate.result === "yes") !== (attempt.classify !== undefined)) ctx.addIssue({ code: "custom", message: "Classification follows a yes predicate" });
  if (attempt.poolReason !== undefined && attempt.quota === undefined) ctx.addIssue({ code: "custom", message: "Pool selection requires quota facts" });
});
export type RoutingAttempt = z.infer<typeof RoutingAttemptSchema>;

/** Only allowlisted facts cross from router state into canonical history. */
export function buildRoutingAttempt(input: {
  at: number; mode: "shadow" | "enforce"; tableVersion: string; threshold: number; seq: number; userMessageAt: number;
  predicate: WorkRequestResult; classify?: CategoryResult; decision: RoutingAttempt["decision"]; noLockReason?: RoutingAttempt["noLockReason"];
  poolReason?: RoutingAttempt["poolReason"]; quota?: Record<"claude" | "chatgpt", QuotaFacts>;
  pool?: RoutingAttempt["pool"]; proposed?: string; effort?: RoutingAttempt["effort"]; actual: string; totalMs: number;
}): RoutingAttempt {
  const p = input.predicate;
  const c = input.classify;
  const facts = (q: QuotaFacts) => ({ ageSeconds: q.ageSeconds, fiveHour: q.fiveHour, pace: q.pace });
  return RoutingAttemptSchema.parse({
    v: 1, at: input.at, mode: input.mode, tableVersion: input.tableVersion, threshold: input.threshold, seq: input.seq, userMessageAt: input.userMessageAt,
    predicate: p.status === "ok" ? { result: p.isWorkRequest ? "yes" : "no", probability: p.probability, latencyMs: p.latencyMs }
      : { result: "unavailable", reason: p.reason, latencyMs: p.latencyMs },
    ...(c ? { classify: c.status === "ok" ? { result: "ok", category: c.category, score: c.score, latencyMs: c.latencyMs,
      orders: c.orders.map((value) => value === null ? null : { ms: value.ms, completed: value.completed }) }
      : { result: "unavailable", reason: c.reason, latencyMs: c.latencyMs,
        orders: c.orders.map((value) => value === null ? null : { ms: value.ms, completed: value.completed }) } } : {}),
    decision: input.decision, ...(input.noLockReason ? { noLockReason: input.noLockReason } : {}),
    ...(input.poolReason ? { poolReason: input.poolReason } : {}),
    ...(input.quota ? { quota: { claude: facts(input.quota.claude), chatgpt: facts(input.quota.chatgpt) } } : {}),
    ...(input.pool ? { pool: input.pool } : {}), ...(input.proposed ? { proposed: input.proposed } : {}),
    ...(input.effort ? { effort: input.effort } : {}), actual: input.actual, totalMs: input.totalMs,
  });
}

export function readRoutingAttempt(entry: unknown): RoutingAttempt | undefined {
  if (!entry || typeof entry !== "object" || !("type" in entry) || entry.type !== "meta"
    || !("key" in entry) || entry.key !== "modelRouteAttempt" || !("value" in entry)) return undefined;
  const parsed = RoutingAttemptSchema.safeParse(entry.value);
  return parsed.success ? parsed.data : undefined;
}
