import type { RoutingAttempt } from "./attempt.js";
import type { RouteLock } from "./session-router.js";

export type RoutingReportEntry = {
  role: "user" | "assistant";
  timestamp: number;
  provider?: string;
  model?: string;
};
export type RoutingReportSession = {
  owner: string;
  agent: string;
  session: string;
  entries: RoutingReportEntry[];
  lock?: RouteLock;
  locks?: RouteLock[];
  lockCount: number;
  attempts: RoutingAttempt[];
  invalidLineCount: number;
};
export type RoutingReportOptions = { since: number; until?: number; agents?: readonly string[] };
type Share = { count: number; denominator: number; share: number | null };
const share = (count: number, denominator: number): Share => ({ count, denominator, share: denominator ? count / denominator : null });

function summarize(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p: number) => sorted.length ? sorted[Math.ceil(p * sorted.length) - 1] : null;
  return { count: sorted.length, p50: rank(0.5), p95: rank(0.95) };
}

type SessionInfo = ReturnType<typeof describeSession>;
function recordedLocks(session: RoutingReportSession): RouteLock[] {
  return session.locks ?? (session.lock ? [session.lock] : []);
}
function describeSession(session: RoutingReportSession) {
  const locks = recordedLocks(session);
  const modes = new Set([...session.attempts.map((attempt) => attempt.mode), ...locks.map((lock) => lock.mode)]);
  const state = modes.size > 1 ? "mixed" : modes.has("shadow") ? "shadow" : "enforced";
  const versions = new Set([...session.attempts.map((attempt) => attempt.tableVersion), ...locks.map((lock) => lock.tableVersion)]);
  const matching = session.lock ? session.attempts.filter((attempt) => {
    const lock = session.lock!;
    return (attempt.decision === "routed" || attempt.decision === "usual") && attempt.mode === lock.mode
      && attempt.tableVersion === lock.tableVersion && attempt.classify?.result === "ok"
      && attempt.classify.category === lock.category && attempt.classify.score === lock.score && attempt.pool === lock.pool;
  }) : [];
  return { session, state, tableVersion: session.lock?.tableVersion ?? session.attempts[0]?.tableVersion,
    spansVersions: versions.size > 1, lockAttempt: matching.length === 1 ? matching[0] : undefined,
    lockAttemptMissing: !!session.lock && matching.length !== 1 };
}

function counts(values: string[]) {
  const result: Record<string, number> = Object.create(null);
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return result;
}
function callMetrics(attempts: RoutingAttempt[]) {
  const classified = attempts.flatMap((attempt) => attempt.classify ? [attempt.classify] : []);
  return {
    predicate: summarize(attempts.map((attempt) => attempt.predicate.latencyMs)),
    category: summarize(classified.map((result) => result.latencyMs)),
    orders: [0, 1].map((index) => {
      const orders = classified.map((result) => result.orders[index]);
      return { ...summarize(orders.flatMap((order) => order?.completed ? [order.ms] : [])),
        incomplete: orders.filter((order) => order && !order.completed).length,
        notStarted: orders.filter((order) => order === null).length, denominator: classified.length };
    }),
    total: summarize(attempts.map((attempt) => attempt.totalMs)),
  };
}

/** A unique timestamp is required; a duplicate never falls back to an ordinal guess. */
export function matchRoutingAttempt(entries: readonly RoutingReportEntry[], attempt: Pick<RoutingAttempt, "userMessageAt">): number | undefined {
  const matching = entries.flatMap((entry, index) => entry.role === "user" && entry.timestamp === attempt.userMessageAt ? [index] : []);
  return matching.length === 1 ? matching[0] : undefined;
}
function compareExecution(session: RoutingReportSession) {
  let compared = 0;
  let mismatches = 0;
  for (const attempt of session.attempts) {
    const index = matchRoutingAttempt(session.entries, attempt);
    if (index === undefined) continue;
    for (let cursor = index + 1; cursor < session.entries.length; cursor++) {
      const entry = session.entries[cursor];
      if (entry.role === "user") break;
      if (entry.provider && entry.model) {
        compared++;
        if (`${entry.provider}/${entry.model}` !== attempt.actual) mismatches++;
        break;
      }
    }
  }
  return { attempts: session.attempts.length, compared, mismatches, notComparable: session.attempts.length - compared };
}

function metrics(sessions: SessionInfo[]) {
  const neverLocked = sessions.filter(({ session }) => !session.lock);
  const usable = sessions.filter((info) => !info.lockAttemptMissing && info.session.attempts.length);
  const scored = usable.flatMap((info) => info.lockAttempt?.classify?.result === "ok"
    ? [{ attempt: info.lockAttempt, score: info.lockAttempt.classify.score }] : []);
  const scores = scored.map((item) => item.score).sort((a, b) => a - b);
  const attempts = sessions.flatMap(({ session }) => session.attempts);
  const firstYes = usable.map(({ session }) => session.attempts.findIndex((attempt) => attempt.predicate.result === "yes"));
  const withYes = firstYes.filter((index) => index >= 0);
  const multiMessage = usable.filter(({ session }) => session.entries.filter((entry) => entry.role === "user").length >= 2);
  const lastClassifications = usable.flatMap(({ session }) => {
    const classification = session.attempts.filter((attempt) => attempt.classify).at(-1)?.classify;
    return classification ? [classification] : [];
  });
  const routed = usable.filter((info) => info.session.lock?.kind === "routed").map((info) => info.lockAttempt!);
  const poolQuota = (pool: "claude" | "chatgpt") => {
    const facts = routed.flatMap((attempt) => attempt.quota ? [attempt.quota[pool]] : []);
    const ages = facts.flatMap((fact) => fact.ageSeconds === null ? [] : [fact.ageSeconds]);
    return { age: { count: ages.length, p50: summarize(ages).p50, p95: summarize(ages).p95, max: ages.length ? ages.reduce((max, age) => Math.max(max, age), -Infinity) : null },
      selectorUnknown: share(facts.filter((fact) => fact.fiveHour === "unknown").length, routed.length),
      knownWithoutWeeklyPace: share(facts.filter((fact) => fact.fiveHour !== "unknown" && fact.pace === null).length, routed.length) };
  };
  const split = (values: string[]) => Object.fromEntries(Object.entries(counts(values)).map(([key, count]) => [key, share(count, routed.length)]));
  const noPool = sessions.filter(({ session }) => session.lock?.kind === "usual" && !session.lock.reason.startsWith("score<"));
  const comparisons = sessions.map(({ session }) => compareExecution(session));
  return { sessionCount: sessions.length, spansTableVersions: share(sessions.filter((info) => info.spansVersions).length, sessions.length),
    latency: callMetrics(attempts),
    integrity: { attempts: attempts.length, compared: comparisons.reduce((sum, comparison) => sum + comparison.compared, 0),
      mismatches: comparisons.reduce((sum, comparison) => sum + comparison.mismatches, 0),
      notComparable: comparisons.reduce((sum, comparison) => sum + comparison.notComparable, 0),
      multipleLocks: share(sessions.filter(({ session }) => session.lockCount > 1).length, sessions.length),
      invalidLines: sessions.reduce((sum, { session }) => sum + session.invalidLineCount, 0) },
    detection: {
      usableSessions: usable.length,
      attemptsUntilYes: { denominator: withYes.length, counts: { "1": withYes.filter((index) => index === 0).length,
        "2": withYes.filter((index) => index === 1).length, "3": withYes.filter((index) => index === 2).length,
        "4+": withYes.filter((index) => index >= 3).length } },
      firstAttempt: share(withYes.filter((index) => index === 0).length, usable.length),
      possibleMisses: share(multiMessage.filter(({ session }) => !session.attempts.some((attempt) => attempt.predicate.result === "yes")).length, multiMessage.length),
      unavailableAttempts: share(attempts.filter((attempt) => attempt.predicate.result === "unavailable").length, attempts.length),
    },
    quota: { denominator: routed.length, pools: { claude: poolQuota("claude"), chatgpt: poolQuota("chatgpt") },
      poolReasons: counts(routed.flatMap((attempt) => attempt.poolReason ? [attempt.poolReason] : [])) },
    wouldBe: { denominator: routed.length, pools: split(routed.flatMap((attempt) => attempt.pool ? [attempt.pool] : [])),
      models: split(routed.flatMap((attempt) => attempt.proposed ? [attempt.proposed] : [])),
      categories: split(routed.flatMap((attempt) => attempt.classify?.result === "ok" ? [attempt.classify.category] : [])),
      changed: share(routed.filter((attempt) => attempt.proposed !== attempt.actual).length, routed.length) },
    score: {
      classifiedWithoutLock: share(neverLocked.filter(({ session }) => session.attempts.some((attempt) => attempt.classify?.result === "ok")).length, neverLocked.length),
      classificationUnavailable: share(lastClassifications.filter((classification) => classification.result === "unavailable").length, lastClassifications.length),
      atOrAbove: share(scored.filter(({ attempt, score }) => score >= attempt.threshold).length, scored.length),
      below: share(scored.filter(({ attempt, score }) => score < attempt.threshold).length, scored.length),
      highScoreNoPool: share(usable.filter((info) => info.session.lock?.kind === "usual" && info.lockAttempt?.classify?.result === "ok"
        && info.lockAttempt.classify.score >= info.lockAttempt.threshold).length, scored.length),
      distribution: { count: scores.length, p50: scores.length ? scores[Math.ceil(0.5 * scores.length) - 1] : null,
        p90: scores.length ? scores[Math.ceil(0.9 * scores.length) - 1] : null, min: scores[0] ?? null },
    },
    outcomes: {
      lockedRouted: share(sessions.filter(({ session }) => session.lock?.kind === "routed").length, sessions.length),
      lockedUsualBelow: share(sessions.filter(({ session }) => session.lock?.kind === "usual" && session.lock.reason.startsWith("score<")).length, sessions.length),
      lockedUsualNoPool: { ...share(noPool.length, sessions.length), reasons: counts(noPool.map(({ session }) => session.lock!.reason)) },
      lockAttemptMissing: share(sessions.filter((info) => info.lockAttemptMissing).length, sessions.length),
      neverLocked: { count: neverLocked.length, denominator: sessions.length,
        reasons: counts(neverLocked.map(({ session }) => session.attempts.at(-1)?.noLockReason ?? "unknown")) },
    },
  };
}

export function buildRoutingReport(sessions: RoutingReportSession[], options: RoutingReportOptions) {
  const population = sessions.filter((session) => {
    const firstUser = session.entries.find((entry) => entry.role === "user");
    return firstUser && firstUser.timestamp >= options.since && (options.until === undefined || firstUser.timestamp < options.until)
      && (!options.agents?.length || options.agents.includes(session.agent)) && (session.lock || session.attempts.length);
  }).map(describeSession);
  const recordTimes = population.flatMap(({ session }) => [...session.attempts.map((attempt) => attempt.at), ...recordedLocks(session).map((lock) => Date.parse(lock.decidedAt))]);
  const first = recordTimes.length ? recordTimes.reduce((min, time) => Math.min(min, time), Infinity) : null;
  const last = recordTimes.length ? recordTimes.reduce((max, time) => Math.max(max, time), -Infinity) : null;
  const days = first !== null && last !== null ? (last - first) / 86_400_000 : null;
  const shadow = population.filter((info) => info.state === "shadow");
  const versions = [...new Set(shadow.flatMap(({ session }) => [...session.attempts.map((attempt) => attempt.tableVersion), ...recordedLocks(session).map((lock) => lock.tableVersion)]))];
  const byVersion = Object.fromEntries(versions.map((version) => [version, {
    ...metrics(shadow.filter((info) => !info.spansVersions && info.tableVersion === version)),
    latency: callMetrics(shadow.flatMap(({ session }) => session.attempts.filter((attempt) => attempt.tableVersion === version))),
  }]));
  return {
    byVersion,
    window: { first, last, days, shadow: shadow.length, enforced: population.filter((info) => info.state === "enforced").length,
      mixed: population.filter((info) => info.state === "mixed").length, underSevenDays: days !== null && days < 7 },
    percentileMethod: "nearest rank: index ceil(p * n) - 1",
    total: metrics(shadow),
    sessions: population.map(({ session, state, tableVersion, lockAttempt, spansVersions }) => {
      const last = session.attempts.at(-1);
      const classification = last?.classify;
      return { owner: session.owner, agent: session.agent, session: session.session, tableVersion, state,
        routingState: session.lock ? `locked-${session.lock.kind}` : "unrouted", spansTableVersions: spansVersions,
        integrityMismatches: compareExecution(session).mismatches,
        proposed: lockAttempt?.proposed ?? (session.lock ? `${session.lock.provider}/${session.lock.model}` : last?.proposed),
        actual: (lockAttempt ?? last)?.actual,
        category: session.lock?.category ?? (classification?.result === "ok" ? classification.category : undefined),
        score: session.lock?.score ?? (classification?.result === "ok" ? classification.score : undefined),
        pool: session.lock?.pool ?? last?.pool };
    }),
  };
}

type RoutingReport = ReturnType<typeof buildRoutingReport>;
function fraction(value: Share): string {
  return `${value.count}/${value.denominator} (${value.share === null ? "no data" : `${(value.share * 100).toFixed(2)}%`})`;
}
function distribution(value: ReturnType<typeof summarize>): string {
  return `n=${value.count}, p50=${value.p50 ?? "no data"}, p95=${value.p95 ?? "no data"}`;
}
function renderMetrics(data: ReturnType<typeof metrics>): string[] {
  const lines = [
    "## Outcomes", "",
    `- Locked routed: ${fraction(data.outcomes.lockedRouted)}`,
    `- Locked usual below threshold: ${fraction(data.outcomes.lockedUsualBelow)}`,
    `- Locked usual at/above threshold without pool: ${fraction(data.outcomes.lockedUsualNoPool)}`,
    ...Object.entries(data.outcomes.lockedUsualNoPool.reasons).map(([reason, count]) => `  - ${reason}: ${fraction(share(count, data.sessionCount))}`),
    `- Lock attempt missing: ${fraction(data.outcomes.lockAttemptMissing)}`,
    `- Never locked: ${fraction(share(data.outcomes.neverLocked.count, data.outcomes.neverLocked.denominator))}`,
    ...Object.entries(data.outcomes.neverLocked.reasons).map(([reason, count]) => `  - ${reason}: ${fraction(share(count, data.outcomes.neverLocked.count))}`),
    "", "## Real-request detection (prefix-only proxies)", "",
    `- Usable sessions: ${data.detection.usableSessions}/${data.sessionCount}`,
    ...Object.entries(data.detection.attemptsUntilYes.counts).map(([bucket, count]) => `- Attempts until first yes (${bucket}): ${fraction(share(count, data.detection.attemptsUntilYes.denominator))}`),
    `- Detected at first attempt: ${fraction(data.detection.firstAttempt)}`,
    `- Possible misses (at least two human messages, no yes): ${fraction(data.detection.possibleMisses)}`,
    `- Predicate unavailable attempts: ${fraction(data.detection.unavailableAttempts)}`,
    "", "## Score", "",
    `- At/above recorded threshold: ${fraction(data.score.atOrAbove)}`,
    `- Below recorded threshold: ${fraction(data.score.below)}`,
    `- High-score usual without pool (subset of at/above): ${fraction(data.score.highScoreNoPool)}`,
    `- Score distribution: n=${data.score.distribution.count}, p50=${data.score.distribution.p50 ?? "no data"}, p90=${data.score.distribution.p90 ?? "no data"}, min=${data.score.distribution.min ?? "no data"}`,
    `- Classified successfully without lock: ${fraction(data.score.classifiedWithoutLock)}`,
    `- Last classification unavailable: ${fraction(data.score.classificationUnavailable)}`,
    "", "## Latency", "",
    `- Predicate ms: ${distribution(data.latency.predicate)}`,
    `- Category wall ms: ${distribution(data.latency.category)}`,
    ...data.latency.orders.map((order, index) => `- Category order ${index + 1} completed ms: ${distribution(order)}; incomplete=${order.incomplete}/${order.denominator}; not-started=${order.notStarted}/${order.denominator}`),
    `- Router total ms: ${distribution(data.latency.total)}`,
    "", "## Quota", "",
    `- Usable routed sessions: ${data.quota.denominator}/${data.sessionCount}`,
  ];
  for (const [pool, values] of Object.entries(data.quota.pools)) {
    lines.push(`- ${pool} snapshot age seconds: n=${values.age.count}/${data.quota.denominator}, p50=${values.age.p50 ?? "no data"}, p95=${values.age.p95 ?? "no data"}, max=${values.age.max ?? "no data"}`,
      `- ${pool} selector unknown: ${fraction(values.selectorUnknown)}`,
      `- ${pool} known without weekly pace: ${fraction(values.knownWithoutWeeklyPace)}`);
  }
  for (const [reason, count] of Object.entries(data.quota.poolReasons)) lines.push(`- Pool reason ${reason}: ${fraction(share(count, data.quota.denominator))}`);
  lines.push("", "## Would-be split", "", `- Usable routed sessions: ${data.wouldBe.denominator}/${data.sessionCount}`);
  for (const [name, values] of [["Pool", data.wouldBe.pools], ["Proposed model", data.wouldBe.models], ["Category", data.wouldBe.categories]] as const) {
    if (!Object.keys(values).length) lines.push(`- ${name}: no data (n=0)`);
    for (const [key, value] of Object.entries(values)) lines.push(`- ${name} ${key}: ${fraction(value)}`);
  }
  lines.push(`- Proposed differs from actual: ${fraction(data.wouldBe.changed)}`, "", "## Integrity", "",
    `- Comparable executions: ${data.integrity.compared}/${data.integrity.attempts}`,
    `- Executed model mismatches (investigate fallback/retry): ${data.integrity.mismatches}/${data.integrity.compared}`,
    `- Not comparable: ${data.integrity.notComparable}/${data.integrity.attempts}`,
    `- Sessions with multiple modelRoute entries: ${fraction(data.integrity.multipleLocks)}`,
    `- Invalid lines or entries skipped: ${data.integrity.invalidLines} (absolute count across ${data.sessionCount} sessions)`,
    `- Sessions spanning table versions: ${fraction(data.spansTableVersions)}`);
  return lines;
}

export function renderRoutingReport(report: RoutingReport): string {
  const population = report.window.shadow + report.window.enforced + report.window.mixed;
  const lines = ["# Model routing report", "", "## Window", "",
    `- First included record: ${report.window.first === null ? "no data" : new Date(report.window.first).toISOString()}`,
    `- Last included record: ${report.window.last === null ? "no data" : new Date(report.window.last).toISOString()}`,
    `- Days covered: ${report.window.days ?? "no data"}`,
    `- Shadow sessions: ${report.window.shadow}/${population}`,
    `- Mixed sessions (excluded): ${report.window.mixed}/${population}`,
    `- Enforced sessions (excluded): ${report.window.enforced}/${population}`,
  ];
  if (report.window.underSevenDays) lines.push("", "Warning: under 7 days of data.");
  lines.push("", `Percentiles: ${report.percentileMethod}.`, "", ...renderMetrics(report.total));
  if (Object.keys(report.byVersion).length > 1) {
    for (const [version, data] of Object.entries(report.byVersion)) {
      lines.push("", `# Table version: ${version}`, "", "Session metrics exclude sessions spanning versions; call metrics use each attempt's version.", "", ...renderMetrics(data));
    }
  }
  return `${lines.join("\n")}\n`;
}
