import { z } from "zod";
import { ThinkLevelSchema } from "@yoplai/shared";
import type { AgentConfig, ModelRoutingConfig, ModelRoutingPick, RequiredModelConfig, ThinkLevel } from "@yoplai/shared";
import { appendSessionMetaIfAbsent, readSessionMeta } from "../history/store.js";
import { logInfo } from "../logging.js";
import { createRoutingClassifier } from "./classifier.js";
import { selectPool, type Pool, type PoolSnapshots } from "./pool.js";

type RoutingContext = {
  agent: AgentConfig;
  config?: ModelRoutingConfig;
  sdk: string;
  sessionId: string;
  sessionOwnerId?: string;
  message: string;
  source?: string;
  sender?: unknown;
  background?: boolean;
  model?: RequiredModelConfig;
  signal?: AbortSignal;
};

export type SessionRoutingDependencies = {
  classifier?: ReturnType<typeof createRoutingClassifier>;
  readQuota?: (context: { agent: AgentConfig; sessionOwnerId?: string; now: number }) => Promise<PoolSnapshots>;
};

const RouteLockSchema = z.object({
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
type RouteLock = z.infer<typeof RouteLockSchema>;

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
  const report = (reason: string, lock?: RouteLock) => logInfo("[model-routing] decision", {
    agentId: context.agent.id, sessionId: context.sessionId, mode: config.mode,
    kind: lock?.kind, category: lock?.category, score: lock?.score,
    tableVersion: lock?.tableVersion ?? config.version, pool: lock?.pool, reason, latencyMs: Date.now() - started,
  });
  try {
    const stored = await readSessionMeta(context.agent.id, context.sessionId, "modelRoute", context.sessionOwnerId);
    if (stored !== undefined) return applyLock(context, RouteLockSchema.parse(stored));
    phase = "classifier";
    const classifier = deps.classifier ?? createRoutingClassifier(config);
    const input = { agentId: context.agent.id, text: context.message, signal: context.signal };
    const predicate = await classifier.checkWorkRequest(input);
    if (predicate.status !== "ok") { report(predicate.reason); return { deferQueue: true }; }
    if (!predicate.isWorkRequest) { report("no"); return { deferQueue: true }; }
    const category = await classifier.classifyCategory({ ...input, categories: context.agent.modelRouting?.categories });
    if (category.status !== "ok") { report(category.reason); return { deferQueue: true }; }
    const row = config.table.find((row) => row.id === category.category);
    if (!row) { report("category-unavailable"); return { deferQueue: true }; }
    let pick: ModelRoutingPick | undefined;
    let pool: Pool | undefined;
    let reason = `score<${config.thresholds.score}`;
    if (category.score >= config.thresholds.score) {
      phase = "quota";
      const quota = await deps.readQuota?.({ agent: context.agent, sessionOwnerId: context.sessionOwnerId, now: Date.now() })
        ?? { claude: { status: "unknown" }, chatgpt: { status: "unknown" } };
      const selection = selectPool(row, quota, config.thresholds.pace);
      reason = selection.reason;
      if (reason === "both-5h-exhausted") { report(reason); return { deferQueue: true }; }
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
    const winner = written ? lock : RouteLockSchema.parse(await readSessionMeta(context.agent.id, context.sessionId, "modelRoute", context.sessionOwnerId));
    report(winner.reason, winner);
    return applyLock(context, winner);
  } catch {
    report(`${phase}-unavailable`);
    return { deferQueue: true };
  }
}
