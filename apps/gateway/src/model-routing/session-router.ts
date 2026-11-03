import { z } from "zod";
import { ThinkLevelSchema } from "@yoplai/shared";
import type { AgentConfig, ModelRoutingConfig, ModelRoutingPick, RequiredModelConfig, ThinkLevel } from "@yoplai/shared";
import { appendSessionMeta, appendSessionMetaIfAbsent, readSessionMeta } from "../history/store.js";
import { logInfo, logWarn } from "../logging.js";
import { buildRoutingAttempt, readRoutingAttempt, type RoutingAttempt } from "./attempt.js";
import { createRoutingClassifier, type WorkRequestResult, type CategoryResult } from "./classifier.js";
import { readRoutingQuota, type RoutingQuota, type QuotaFacts } from "./quota-reader.js";
import { selectPool, type Pool } from "./pool.js";

type RoutingContext = {
  agent: AgentConfig;
  config?: ModelRoutingConfig;
  sdk: string;
  sessionId: string;
  sessionOwnerId?: string;
  message: string;
  userMessageAt?: number;
  onTraceMetadata?: (metadata: Record<string, string | number>) => void;
  source?: string;
  sender?: unknown;
  background?: boolean;
  model?: RequiredModelConfig;
  signal?: AbortSignal;
};

export type SessionRoutingDependencies = {
  classifier?: ReturnType<typeof createRoutingClassifier>;
  readQuota?: (context: { agent: AgentConfig; sessionOwnerId?: string; now: number }) => Promise<RoutingQuota>;
};

export const RouteLockSchema = z.object({
  version: z.literal(1),
  kind: z.enum(["routed", "usual"]),
  mode: z.enum(["enforce", "shadow"]),
  provider: z.string().min(1),
  model: z.string().min(1),
  effort: ThinkLevelSchema.optional(),
  category: z.string().min(1),
  score: z.number().min(0).max(1),
  tableVersion: z.string().min(1),
  pool: z.enum(["claude", "chatgpt"]).optional(),
  reason: z.string().min(1),
  decidedAt: z.string().datetime(),
});
export type RouteLock = z.infer<typeof RouteLockSchema>;

type RoutingDecision = { model?: RequiredModelConfig; effort?: ThinkLevel; suppressFallback?: boolean; deferQueue?: boolean };
const chatSources = new Set(["web", "slack", "discord", "telegram", "mattermost", "irc"]);

function eligible(context: RoutingContext): boolean {
  return (context.config?.mode === "enforce" || context.config?.mode === "shadow")
    && context.agent.modelRouting?.enabled === true && context.sdk === "pi"
    && chatSources.has(context.source ?? "") && context.sender === undefined
    && !context.background && !context.model && !!context.message.trim()
    && !/^(compact:|scheduler|dream:)/.test(context.sessionId);
}

function applyLock(context: RoutingContext, lock: RouteLock): RoutingDecision {
  if (context.config?.mode !== "enforce" || lock.mode !== "enforce") return {};
  const override = lock.kind === "routed" || lock.provider !== context.agent.model.provider || lock.model !== context.agent.model.model;
  return { suppressFallback: true, effort: lock.effort,
    ...(override ? { model: { provider: lock.provider, model: lock.model } } : {}) };
}

/** Only called when another turn actually joins; idle turns need no extra read. */
export async function shouldDeferRouting(context: RoutingContext): Promise<boolean> {
  if (!eligible(context)) return false;
  try {
    return await readSessionMeta(context.agent.id, context.sessionId, "modelRoute", context.sessionOwnerId) === undefined;
  } catch {
    return true;
  }
}

/** All failures leave the ordinary chat path available; never run an unrecorded pick. */
export async function routeSession(context: RoutingContext, deps: SessionRoutingDependencies = {}): Promise<RoutingDecision> {
  if (!eligible(context)) return {};
  const config = context.config!;
  const started = Date.now();
  let phase = "lock-read";
  let stepStarted = started;
  let reachedClassifier = false;
  let predicate: WorkRequestResult | undefined;
  let category: CategoryResult | undefined;
  let selectedLock: RouteLock | undefined;
  let result: RoutingDecision = { deferQueue: true };
  let decision: RoutingAttempt["decision"] = "none";
  let noLockReason: RoutingAttempt["noLockReason"] = "predicate-unavailable";
  let poolReason: RoutingAttempt["poolReason"];
  let quotaFacts: Record<Pool, QuotaFacts> | undefined;
  let pool: Pool | undefined;
  let pick: ModelRoutingPick | undefined;
  let seq = 1;
  const report = (reason: string, lock?: RouteLock) => logInfo("[model-routing] decision", {
    agentId: context.agent.id, sessionId: context.sessionId, mode: config.mode,
    kind: lock?.kind, category: lock?.category, score: lock?.score,
    tableVersion: lock?.tableVersion ?? config.version, pool: lock?.pool, reason, latencyMs: Date.now() - started,
  });
  try {
    const stored = await readSessionMeta(context.agent.id, context.sessionId, "modelRoute", context.sessionOwnerId);
    if (stored !== undefined) {
      selectedLock = RouteLockSchema.parse(stored);
      result = applyLock(context, selectedLock);
      return result;
    }
    // Informational only: an earlier non-awaited append may still be pending.
    try {
      const previous = readRoutingAttempt({ type: "meta", key: "modelRouteAttempt", value:
        await readSessionMeta(context.agent.id, context.sessionId, "modelRouteAttempt", context.sessionOwnerId) });
      seq = (previous?.seq ?? 0) + 1;
    } catch { /* Missing telemetry never changes the routing decision. */ }
    phase = "classifier";
    reachedClassifier = true;
    stepStarted = Date.now();
    const classifier = deps.classifier ?? createRoutingClassifier(config);
    const input = { agentId: context.agent.id, text: context.message, signal: context.signal };
    predicate = await classifier.checkWorkRequest(input);
    if (predicate.status !== "ok") { noLockReason = "predicate-unavailable"; report(predicate.reason); return result; }
    if (!predicate.isWorkRequest) { noLockReason = "predicate-no"; report("no"); return result; }
    stepStarted = Date.now();
    category = await classifier.classifyCategory({ ...input, categories: context.agent.modelRouting?.categories });
    if (category.status !== "ok") { noLockReason = "classify-unavailable"; report(category.reason); return result; }
    const categoryId = category.category;
    const row = config.table.find((row) => row.id === categoryId);
    if (!row) { noLockReason = "category-not-in-table"; report("category-unavailable"); return result; }
    let reason = `score<${config.thresholds.score}`;
    if (category.score >= config.thresholds.score) {
      phase = "quota";
      const quota = await (deps.readQuota ?? readRoutingQuota)({ agent: context.agent, sessionOwnerId: context.sessionOwnerId, now: Date.now() });
      const selection = selectPool(row, quota, config.thresholds.pace);
      reason = selection.reason;
      poolReason = selection.reason as RoutingAttempt["poolReason"];
      const facts = (value: RoutingQuota[Pool]): QuotaFacts => value.telemetry ?? {
        ageSeconds: null, fiveHour: value.status === "known" ? (value.exhausted ? "exhausted" : "ok") : "unknown",
        pace: value.status === "known" ? value.pace ?? null : null,
      };
      quotaFacts = { claude: facts(quota.claude), chatgpt: facts(quota.chatgpt) };
      if (reason === "both-5h-exhausted") { noLockReason = "both-5h-exhausted"; report(reason); return result; }
      pool = selection.pool;
      pick = pool ? row[pool] : undefined;
    }
    const lock: RouteLock = {
      version: 1, kind: pick ? "routed" : "usual", mode: config.mode as RouteLock["mode"],
      ...(pick ?? { provider: context.agent.model.provider!, model: context.agent.model.model }),
      category: category.category, score: category.score, tableVersion: config.version,
      ...(pool ? { pool } : {}), reason, decidedAt: new Date().toISOString(),
    };
    phase = "lock-write";
    const written = await appendSessionMetaIfAbsent(context.agent.id, context.sessionId, "modelRoute", lock, context.sessionOwnerId);
    if (written) {
      decision = lock.kind;
      selectedLock = lock;
    } else {
      noLockReason = "lock-lost";
      selectedLock = RouteLockSchema.parse(await readSessionMeta(context.agent.id, context.sessionId, "modelRoute", context.sessionOwnerId));
    }
    report(selectedLock.reason, selectedLock);
    result = applyLock(context, selectedLock);
    return result;
  } catch {
    if (phase === "classifier") {
      if (predicate?.status === "ok" && predicate.isWorkRequest) {
        category = { status: "unavailable", reason: "provider_error", latencyMs: Date.now() - stepStarted, orders: [null, null] };
        noLockReason = "classify-unavailable";
      } else {
        predicate = { status: "unavailable", reason: "provider_error", latencyMs: Date.now() - stepStarted };
        noLockReason = "predicate-unavailable";
      }
    } else if (phase === "quota") noLockReason = "quota-read-failed";
    else if (phase === "lock-write" && noLockReason !== "lock-lost") noLockReason = "lock-write-failed";
    report(`${phase}-unavailable`);
    return result;
  } finally {
    const actual = result.model ?? context.agent.model;
    if (reachedClassifier && predicate) {
      try {
        const attempt = buildRoutingAttempt({ at: started, mode: config.mode as "shadow" | "enforce", tableVersion: config.version,
          threshold: config.thresholds.score, seq, userMessageAt: context.userMessageAt ?? started, predicate, classify: category,
          decision, noLockReason: decision === "none" ? noLockReason : undefined,
          poolReason, quota: quotaFacts, pool, proposed: pick ? `${pick.provider}/${pick.model}` : undefined, effort: pick?.effort,
          actual: `${actual.provider}/${actual.model}`, totalMs: Date.now() - started });
        void appendSessionMeta(context.agent.id, context.sessionId, "modelRouteAttempt", attempt, context.sessionOwnerId)
          .catch(() => logWarn("[model-routing] telemetry write failed"));
      } catch { logWarn("[model-routing] telemetry write failed"); }
    }
    try {
      context.onTraceMetadata?.({ routingMode: config.mode, routingTableVersion: selectedLock?.tableVersion ?? config.version,
        routingState: selectedLock ? (selectedLock.kind === "routed" ? "locked-routed" : "locked-usual") : "unrouted",
        routingActual: `${actual.provider}/${actual.model}`,
        ...(selectedLock ? { routingProposed: `${selectedLock.provider}/${selectedLock.model}`, routingCategory: selectedLock.category,
          routingScore: selectedLock.score, ...(selectedLock.kind === "routed" && selectedLock.pool ? { routingPool: selectedLock.pool } : {}) } : {}),
      });
    } catch { logWarn("[model-routing] trace metadata failed"); }
  }
}
