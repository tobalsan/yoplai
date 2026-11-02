import { describe, expect, it } from "vitest";
import { buildRoutingReport, renderRoutingReport } from "./report.js";
import type { RoutingAttempt } from "./attempt.js";
import type { RoutingReportSession } from "./report.js";
import type { RouteLock } from "./session-router.js";

describe("routing report", () => {
  it("reports an empty population as no data with null percentiles", () => {
    const report = buildRoutingReport([], { since: 0 });
    expect(report.window).toEqual({ first: null, last: null, days: null, shadow: 0, enforced: 0, mixed: 0, underSevenDays: false });
    expect(report.total.latency.predicate).toEqual({ count: 0, p50: null, p95: null });
    expect(report.total.detection.firstAttempt).toEqual({ count: 0, denominator: 0, share: null });
    expect(renderRoutingReport(report)).toContain("no data");
  });
});

const start = Date.parse("2026-11-01T00:00:00Z");
function attempt(overrides: Partial<RoutingAttempt> = {}): RoutingAttempt {
  return { v: 1, at: start, mode: "shadow", tableVersion: "v1", threshold: 0.8, seq: 1,
    userMessageAt: start, predicate: { result: "no", probability: 0.1, latencyMs: 10 },
    decision: "none", noLockReason: "predicate-no", actual: "anthropic/usual", totalMs: 12, ...overrides };
}
function session(overrides: Partial<RoutingReportSession> = {}): RoutingReportSession {
  return { owner: "single-user", agent: "helper", session: "s1", entries: [{ role: "user", timestamp: start }],
    lockCount: 0, attempts: [attempt()], invalidLineCount: 0, ...overrides };
}

it("filters fresh sessions and agents, separating modes and using record times for the window", () => {
  const report = buildRoutingReport([
    session(),
    session({ session: "enforced", attempts: [attempt({ mode: "enforce", at: start + 86_400_000 })] }),
    session({ session: "mixed", attempts: [attempt(), attempt({ mode: "enforce" })] }),
    session({ session: "old", entries: [{ role: "user", timestamp: start - 1 }] }),
    session({ session: "late", entries: [{ role: "user", timestamp: start + 172_800_000 }] }),
    session({ agent: "other" }),
    session({ session: "no-record", attempts: [] }),
  ], { since: start, until: start + 172_800_000, agents: ["helper"] });
  expect(report.window).toEqual({ first: start, last: start + 86_400_000, days: 1, shadow: 1, enforced: 1, mixed: 1, underSevenDays: true });
  expect(report.sessions.map((row) => [row.session, row.state, row.tableVersion])).toEqual([
    ["s1", "shadow", "v1"], ["enforced", "enforced", "v1"], ["mixed", "mixed", "v1"],
  ]);
  expect(report.total.outcomes.neverLocked).toEqual({ count: 1, denominator: 1, reasons: { "predicate-no": 1 } });
  expect(renderRoutingReport(report)).toContain("under 7 days");
});

function lock(overrides: Partial<RouteLock> = {}): RouteLock {
  return { version: 1, kind: "routed", mode: "shadow", provider: "openai-codex", model: "routed", category: "code", score: 0.8,
    tableVersion: "v1", pool: "chatgpt", reason: "pace", decidedAt: new Date(start).toISOString(), ...overrides };
}
function routed(overrides: Partial<RoutingAttempt> = {}): RoutingAttempt {
  return attempt({ predicate: { result: "yes", probability: 0.9, latencyMs: 10 },
    classify: { result: "ok", category: "code", score: 0.8, latencyMs: 20, orders: [{ ms: 15, completed: true }, { ms: 20, completed: true }] },
    decision: "routed", noLockReason: undefined, pool: "chatgpt", poolReason: "pace", proposed: "openai-codex/routed",
    quota: { claude: { ageSeconds: 10, fiveHour: "ok", pace: 1.1 }, chatgpt: { ageSeconds: 20, fiveHour: "ok", pace: 0.2 } }, ...overrides });
}

it("counts durable outcomes but excludes missing or ambiguous lock attempts from usable metrics", () => {
  const low = routed({ decision: "usual", pool: undefined, proposed: undefined,
    classify: { result: "ok", category: "code", score: 0.7999, latencyMs: 20, orders: [null, null] } });
  const noPool = routed({ decision: "usual", pool: undefined, proposed: undefined, poolReason: "quota-unknown" });
  const report = buildRoutingReport([
    session({ session: "routed", lock: lock(), lockCount: 1, attempts: [routed()] }),
    session({ session: "low", lock: lock({ kind: "usual", pool: undefined, score: 0.7999, reason: "score<0.8" }), lockCount: 1, attempts: [low] }),
    session({ session: "no-pool", lock: lock({ kind: "usual", pool: undefined, reason: "quota-unknown" }), lockCount: 1, attempts: [noPool] }),
    session({ session: "lock-only", lock: lock(), lockCount: 1, attempts: [] }),
    session({ session: "missing", lock: lock(), lockCount: 1, attempts: [attempt()] }),
    session({ session: "ambiguous", lock: lock(), lockCount: 1, attempts: [routed(), routed()] }),
  ], { since: start });
  expect(report.total.outcomes).toEqual({
    lockedRouted: { count: 4, denominator: 6, share: 4 / 6 },
    lockedUsualBelow: { count: 1, denominator: 6, share: 1 / 6 },
    lockedUsualNoPool: { count: 1, denominator: 6, share: 1 / 6, reasons: { "quota-unknown": 1 } },
    lockAttemptMissing: { count: 3, denominator: 6, share: 0.5 },
    neverLocked: { count: 0, denominator: 6, reasons: {} },
  });
  expect(report.total.score.atOrAbove).toEqual({ count: 2, denominator: 3, share: 2 / 3 });
  expect(report.total.score.below).toEqual({ count: 1, denominator: 3, share: 1 / 3 });
  expect(report.total.score.highScoreNoPool).toEqual({ count: 1, denominator: 3, share: 1 / 3 });
  expect(report.total.score.distribution).toEqual({ count: 3, p50: 0.8, p90: 0.8, min: 0.7999 });
});

it("measures prefix detection proxies with explicit denominators and last classification availability", () => {
  const yes = routed({ decision: "none", noLockReason: "both-5h-exhausted" });
  const unavailable = attempt({ predicate: { result: "unavailable", reason: "timeout", latencyMs: 30 }, noLockReason: "predicate-unavailable" });
  const categoryUnavailable = routed({ classify: { result: "unavailable", reason: "refusal", latencyMs: 20, orders: [null, null] }, decision: "none", noLockReason: "classify-unavailable" });
  const twoUsers = [{ role: "user" as const, timestamp: start }, { role: "user" as const, timestamp: start + 100 }];
  const report = buildRoutingReport([
    session({ session: "first", attempts: [yes] }),
    session({ session: "second", attempts: [attempt(), yes] }),
    session({ session: "third", attempts: [attempt(), unavailable, yes] }),
    session({ session: "fourth", attempts: [attempt(), attempt(), attempt(), yes] }),
    session({ session: "miss", entries: twoUsers, attempts: [attempt(), unavailable] }),
    session({ session: "one-no", attempts: [attempt()] }),
    session({ session: "classify-unavailable", entries: twoUsers, attempts: [yes, categoryUnavailable] }),
    session({ session: "missing", lock: lock(), attempts: [attempt()], lockCount: 1 }),
  ], { since: start });
  expect(report.total.detection).toEqual({
    usableSessions: 7,
    attemptsUntilYes: { denominator: 5, counts: { "1": 2, "2": 1, "3": 1, "4+": 1 } },
    firstAttempt: { count: 2, denominator: 7, share: 2 / 7 },
    possibleMisses: { count: 1, denominator: 2, share: 0.5 },
    unavailableAttempts: { count: 2, denominator: 16, share: 0.125 },
  });
  expect(report.total.score.classificationUnavailable).toEqual({ count: 1, denominator: 5, share: 0.2 });
  expect(report.total.score.classifiedWithoutLock).toEqual({ count: 5, denominator: 7, share: 5 / 7 });
});

it.each([
  [[7], 7, 7],
  [[10, 20], 10, 20],
  [[30, 10, 20], 20, 30],
  [[40, 10, 30, 20], 20, 40],
] as const)("uses nearest rank for call percentiles of %j", (values, p50, p95) => {
  const report = buildRoutingReport([session({ attempts: values.map((value) => attempt({ predicate: { result: "no", probability: 0.1, latencyMs: value }, totalMs: value + 1 })) })], { since: start });
  expect(report.total.latency.predicate).toEqual({ count: values.length, p50, p95 });
  expect(report.total.latency.total).toEqual({ count: values.length, p50: p50 + 1, p95: p95 + 1 });
});

it("reports wall timings and separates completed, incomplete and not-started order calls", () => {
  const report = buildRoutingReport([session({ attempts: [
    routed({ classify: { result: "ok", category: "code", score: 0.8, latencyMs: 30, orders: [{ ms: 10, completed: true }, { ms: 30, completed: true }] } }),
    routed({ classify: { result: "unavailable", reason: "timeout", latencyMs: 40, orders: [{ ms: 20, completed: true }, { ms: 40, completed: false }] } }),
    routed({ classify: { result: "unavailable", reason: "no_key", latencyMs: 0, orders: [null, null] } }),
  ] })], { since: start });
  expect(report.total.latency.category).toEqual({ count: 3, p50: 30, p95: 40 });
  expect(report.total.latency.orders).toEqual([
    { count: 2, p50: 10, p95: 20, incomplete: 0, notStarted: 1, denominator: 3 },
    { count: 1, p50: 30, p95: 30, incomplete: 1, notStarted: 1, denominator: 3 },
  ]);
  expect(report.percentileMethod).toBe("nearest rank: index ceil(p * n) - 1");
});

it("aggregates quota freshness and would-be splits only from usable routed lock attempts", () => {
  const quotaA = { claude: { ageSeconds: 10, fiveHour: "ok" as const, pace: 1.1 }, chatgpt: { ageSeconds: 20, fiveHour: "absent" as const, pace: 0.2 } };
  const quotaB = { claude: { ageSeconds: null, fiveHour: "unknown" as const, pace: null }, chatgpt: { ageSeconds: 40, fiveHour: "ok" as const, pace: null } };
  const report = buildRoutingReport([
    session({ session: "a", lock: lock(), lockCount: 1, attempts: [routed({ quota: quotaA })] }),
    session({ session: "b", lock: lock({ pool: "claude", provider: "anthropic", model: "usual", category: "write", reason: "preference" }), lockCount: 1,
      attempts: [routed({ quota: quotaB, pool: "claude", proposed: "anthropic/usual", poolReason: "preference", classify: { result: "ok", category: "write", score: 0.8, latencyMs: 20, orders: [null, null] } })] }),
    session({ session: "missing", lock: lock(), lockCount: 1, attempts: [] }),
  ], { since: start });
  expect(report.total.quota).toEqual({
    denominator: 2,
    pools: {
      claude: { age: { count: 1, p50: 10, p95: 10, max: 10 }, selectorUnknown: { count: 1, denominator: 2, share: 0.5 }, knownWithoutWeeklyPace: { count: 0, denominator: 2, share: 0 } },
      chatgpt: { age: { count: 2, p50: 20, p95: 40, max: 40 }, selectorUnknown: { count: 0, denominator: 2, share: 0 }, knownWithoutWeeklyPace: { count: 1, denominator: 2, share: 0.5 } },
    }, poolReasons: { pace: 1, preference: 1 },
  });
  expect(report.total.wouldBe).toEqual({ denominator: 2,
    pools: { chatgpt: { count: 1, denominator: 2, share: 0.5 }, claude: { count: 1, denominator: 2, share: 0.5 } },
    models: { "openai-codex/routed": { count: 1, denominator: 2, share: 0.5 }, "anthropic/usual": { count: 1, denominator: 2, share: 0.5 } },
    categories: { code: { count: 1, denominator: 2, share: 0.5 }, write: { count: 1, denominator: 2, share: 0.5 } },
    changed: { count: 1, denominator: 2, share: 0.5 },
  });
  expect(report.sessions[0]).toMatchObject({ proposed: "openai-codex/routed", actual: "anthropic/usual", category: "code", score: 0.8, pool: "chatgpt" });
});

it("compares only the first complete assistant identity in the matched human turn", () => {
  const report = buildRoutingReport([
    session({ session: "mismatch", entries: [
      { role: "user", timestamp: start }, { role: "assistant", timestamp: start + 1 },
      { role: "assistant", timestamp: start + 2, provider: "openai-codex", model: "fallback" },
      { role: "assistant", timestamp: start + 3, provider: "anthropic", model: "usual" },
      { role: "user", timestamp: start + 4 },
    ], lockCount: 2, invalidLineCount: 3 }),
    session({ session: "match", entries: [{ role: "user", timestamp: start }, { role: "assistant", timestamp: start + 1, provider: "anthropic", model: "usual" }] }),
    session({ session: "duplicate", entries: [{ role: "user", timestamp: start }, { role: "user", timestamp: start }, { role: "assistant", timestamp: start + 1, provider: "anthropic", model: "usual" }] }),
    session({ session: "missing-model", entries: [{ role: "user", timestamp: start }, { role: "assistant", timestamp: start + 1, provider: "anthropic" }] }),
    session({ session: "next-turn", entries: [{ role: "user", timestamp: start }, { role: "user", timestamp: start + 1 }, { role: "assistant", timestamp: start + 2, provider: "anthropic", model: "usual" }] }),
    session({ session: "unmatched", attempts: [attempt({ userMessageAt: start + 10 })] }),
    session({ session: "no-assistant" }),
  ], { since: start });
  expect(report.total.integrity).toEqual({ attempts: 7, compared: 2, mismatches: 1, notComparable: 5,
    multipleLocks: { count: 1, denominator: 7, share: 1 / 7 }, invalidLines: 3 });
  expect(report.sessions.find((row) => row.session === "mismatch")?.integrityMismatches).toBe(1);
});

it("groups sessions by their recorded table version and calls by each attempt version", () => {
  const report = buildRoutingReport([
    session({ session: "one" }),
    session({ session: "two", lock: lock({ tableVersion: "v2" }), lockCount: 1,
      attempts: [routed({ tableVersion: "v2", predicate: { result: "yes", probability: 0.9, latencyMs: 40 } })] }),
    session({ session: "spanning", attempts: [attempt(), attempt({ tableVersion: "v2", predicate: { result: "no", probability: 0.1, latencyMs: 50 } })] }),
  ], { since: start });
  expect(report.total.sessionCount).toBe(3);
  expect(report.total.spansTableVersions).toEqual({ count: 1, denominator: 3, share: 1 / 3 });
  expect(report.byVersion.v1.sessionCount).toBe(1);
  expect(report.byVersion.v2.sessionCount).toBe(1);
  expect(report.byVersion.v1.latency.predicate).toEqual({ count: 2, p50: 10, p95: 10 });
  expect(report.byVersion.v2.latency.predicate).toEqual({ count: 2, p50: 40, p95: 50 });
  expect(report.sessions.find((row) => row.session === "spanning")?.spansTableVersions).toBe(true);
});

it("prints all report sections, denominators, version groups and privacy-safe rows", () => {
  const canary = "PRIVATE MESSAGE sk-fake-token account-ref-canary";
  const input = session({ lock: lock(), lockCount: 1, attempts: [routed({ quota: {
    claude: { ageSeconds: 5, fiveHour: "ok", pace: 0.2 }, chatgpt: { ageSeconds: 10, fiveHour: "ok", pace: 0.1 },
  } })] });
  const report = buildRoutingReport([Object.assign(input, { message: canary }), session({ session: "v2", attempts: [attempt({ tableVersion: "v2" })] })], { since: start });
  const markdown = renderRoutingReport(report);
  expect(markdown).toContain("## Window");
  expect(markdown).toContain("## Outcomes");
  expect(markdown).toContain("## Real-request detection (prefix-only proxies)");
  expect(markdown).toContain("## Score");
  expect(markdown).toContain("## Latency");
  expect(markdown).toContain("## Quota");
  expect(markdown).toContain("## Would-be split");
  expect(markdown).toContain("## Integrity");
  expect(markdown).toContain("Locked routed: 1/2 (50.00%)");
  expect(markdown).toContain("Table version: v1");
  expect(markdown).toContain("nearest rank: index ceil(p * n) - 1");
  expect(markdown + JSON.stringify(report)).not.toContain(canary);
});

it("handles a large record population without spreading it into function arguments", () => {
  const repeated = attempt();
  const attempts = Array<RoutingAttempt>(150_000).fill(repeated);
  attempts.push(attempt({ at: start + 7 * 86_400_000 }));
  const report = buildRoutingReport([session({ attempts })], { since: start });
  expect(report.window.days).toBe(7);
  expect(report.window.underSevenDays).toBe(false);
  expect(report.total.latency.predicate.count).toBe(150_001);
});

it("uses a lock-only session's recorded mode/version and each lock attempt's threshold", () => {
  const report = buildRoutingReport([
    session({ session: "lock-only-enforce", attempts: [], lock: lock({ mode: "enforce", tableVersion: "old" }), lockCount: 1 }),
    session({ session: "mixed-lock", attempts: [attempt()], lock: lock({ mode: "enforce" }), lockCount: 1 }),
    session({ session: "higher-threshold", attempts: [routed({ threshold: 0.9, decision: "usual", pool: undefined, proposed: undefined, poolReason: undefined, quota: undefined })],
      lock: lock({ kind: "usual", pool: undefined, reason: "score<0.9" }), lockCount: 1 }),
  ], { since: start });
  expect(report.window).toMatchObject({ shadow: 1, enforced: 1, mixed: 1 });
  expect(report.sessions[0]).toMatchObject({ state: "enforced", tableVersion: "old", routingState: "locked-routed" });
  expect(report.total.score.below).toEqual({ count: 1, denominator: 1, share: 1 });
  expect(report.total.score.atOrAbove).toEqual({ count: 0, denominator: 1, share: 0 });
});

it("excludes sessions with missing lock attempts from classification-unavailable score shares", () => {
  const report = buildRoutingReport([
    session({ session: "usable", lock: lock(), lockCount: 1, attempts: [routed()] }),
    session({ session: "lost-attempt", lock: lock(), lockCount: 1, attempts: [attempt({
      predicate: { result: "yes", probability: 0.9, latencyMs: 10 },
      classify: { result: "unavailable", reason: "timeout", latencyMs: 20, orders: [null, null] },
      noLockReason: "classify-unavailable",
    })] }),
  ], { since: start });
  expect(report.total.score.classificationUnavailable).toEqual({ count: 0, denominator: 1, share: 0 });
  expect(report.total.outcomes.lockAttemptMissing).toEqual({ count: 1, denominator: 2, share: 0.5 });
});

it("uses every valid lock as mode and table-version evidence", () => {
  const lastShadow = lock();
  const report = buildRoutingReport([
    session({ session: "mixed-locks", lock: lastShadow, locks: [lock({ mode: "enforce", tableVersion: "v0" }), lastShadow],
      lockCount: 2, attempts: [routed()] }),
    session({ session: "spanning-locks", lock: lastShadow, locks: [lock({ tableVersion: "v0" }), lastShadow],
      lockCount: 2, attempts: [routed()] }),
  ], { since: start });
  expect(report.window).toMatchObject({ shadow: 1, mixed: 1, enforced: 0 });
  expect(report.total.spansTableVersions).toEqual({ count: 1, denominator: 1, share: 1 });
  expect(report.total.outcomes.lockedRouted).toEqual({ count: 1, denominator: 1, share: 1 });
  expect(report.byVersion.v0.sessionCount).toBe(0);
  expect(report.byVersion.v1.sessionCount).toBe(0);
  expect(report.byVersion.v1.latency.predicate.count).toBe(1);
});
