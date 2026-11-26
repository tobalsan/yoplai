import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { emptyMemory, renderMemory } from "../memory.js";
import { pair, prepare, requirePaid, settings } from "./entry.js";
import { cold, originDistances, report, sources } from "./report.js";
import { idleGap, keeperCompletions, projection, scenarioIssues, type RequestRow } from "./runner.js";
import { facts, filler, FULL, HAIKU, IDLE_MS, score } from "./scenario.js";

it("generates seeded, exact-length filler from complete sentences", () => {
  for (const chars of [0, 127, 2_000, 4_000, 20_013]) {
    const text = filler(chars, 19);
    expect(text).toHaveLength(chars);
    expect(filler(chars, 19)).toBe(text);
    if (chars) expect(text.trimEnd()).toMatch(/^[A-Z][a-z ]+\.( [A-Z][a-z ]+\.)*$/);
  }
  expect(filler(4_000, 19)).not.toBe(filler(4_000, 20));
});

it("drives cheap and full compaction scenarios through the gateway with Faux", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "compaction-eval-report-"));
  try {
    const pairs = [];
    for (const model of [HAIKU, FULL]) {
      const full = model === FULL;
      const plan = await prepare(model, full);
      const measured = await pair(plan, { faux: true, long: !full });
      const { cut, baseline } = measured;
      pairs.push(measured);
      if (full) expect(projection([{ ...measured, full: false }])).toContain(`${FULL}: cut`);
      expect(cut.issues, JSON.stringify({ cuts: cut.cuts.map(i => cut.requests[i]?.turn), seams: cut.seams, beforeProbe: cut.beforeProbe })).toEqual([]);
      if (!baseline) throw new Error("Expected valid baseline");
      expect(Math.max(...baseline.requests.map(row => row.estimate))).toBeLessThan(plan.baseline.ceiling / 2);
      expect(baseline.issues).toEqual([]);
      expect(cut.cuts.map(i => cut.requests[i]?.turn)).toEqual([cut.drive.opening.at(-1)?.id, "ledger"]);
      expect(cut.seams).toHaveLength(2);
      expect(baseline.seams).toEqual([]);
      expect(cut.steps).toEqual([1, 2, 3]);
      expect(cut.stepRequests.map(({ request }) => request < cut.cuts[1]!)).toEqual([true, true, false]);
      expect(Object.keys(cut.origins).sort()).toEqual(facts.map(({ id }) => id).sort());
      expect(baseline.steps).toEqual([1, 2, 3]);
      for (const run of [cut, baseline]) {
        for (const { step, request } of run.stepRequests) {
          const result = run.requests[request + 1]?.messages.find(message =>
            message.role === "toolResult" && message.toolName === "record_eval_step" && message.toolCallId === `step-${step}`);
          const status = step === 3 ? "Step 3 recorded. All steps done." : `Step ${step} recorded in the ledger. Next: step ${step + 1}.`;
          if (result?.role !== "toolResult") throw new Error(`Expected result for ledger step ${step}`);
          expect(result.isError).toBe(false);
          const [block] = result.content;
          if (block?.type !== "text") throw new Error(`Expected text for ledger step ${step}`);
          const { text } = block;
          if (step === 3) expect(text).toBe(status);
          else {
            expect(text.startsWith(`${status}\n--- attached step log (no action needed) ---\n`)).toBe(true);
            expect(text).toHaveLength(run.drive.steps[step - 1]!);
          }
        }
      }
      expect(cut.answers["topic-1"]).toContain("Ice");
      expect(cut.keeper.length).toBeGreaterThan(0);
      expect(sources(cut, "probe-0", facts[1]), JSON.stringify(cut.requests.filter(row => row.turn === "probe-0").at(-1)?.messages.filter(m => m.role === "toolResult" && m.toolName.includes("history")))).toContain("session_history");
      expect(sources(cut, "probe-0", facts[2])).toContain("tool re-read");
      expect(cut.requests[cut.gapRequest]?.usage?.cacheRead).toBe(0);
      expect(cold(cut), JSON.stringify(cut.requests.map((row, i) => [row.turn, cut.cuts.includes(i), row.usage?.cacheRead, i === cut.gapRequest]))).toEqual([1, 1]);
      expect(cold({ ...cut, requests: cut.requests.map(row => ({ ...row, usage: undefined })) })).toBeUndefined();
      const reportPath = await report(dir, model, cut, baseline, full);
      const markdown = await fs.readFile(reportPath, "utf8");
      for (const heading of ["Recall", "Side effects", "Relevance", "Cache and request usage", "Keeper completions", "Recommendations", "Pass bars"]) {
        expect(markdown).toContain(`## ${heading}`);
      }
      expect(markdown).toContain("PASS (90.0% vs 100.0%");
      expect(markdown).toContain("Side effects (exactly one per step): PASS");
      expect(markdown).toContain(full ? "informational; counts: 1, 1" : "PASS: 1, 1");
      expect(markdown).toContain("tool | 50.0% | 100.0% | -50.0 | ⚠ source below 70%");
      expect(markdown).toMatch(/summary characters per cut [1-9]\d*, [1-9]\d*/);
      const kite = markdown.split("\n").find(line => line.startsWith("| probe-0 / kite "));
      expect(kite).toContain("summary index");
      expect(kite).toMatch(/ \| −[1-9]\d*, −[1-9]\d* \|$/);
      for (const line of markdown.split("\n").filter(row => /^\| probe-0 \/ (kite|shipment|kiln|lantern|mosaic) /.test(row))) {
        expect(line).not.toContain("unknown");
      }
      const retention = full ? "default" : "long";
      expect(markdown).toContain(`cut ${retention}; baseline ${retention}.`);
      const raw = JSON.parse(await fs.readFile(reportPath.replace(/\.md$/, ".json"), "utf8"));
      expect(raw.cut).toMatchObject({ seams: cut.seams, stepRequests: cut.stepRequests, origins: cut.origins });
      for (const run of [raw.cut, raw.baseline]) {
        expect(run.requests).toEqual(expect.arrayContaining([
          expect.objectContaining({ turn: "probe-0", cacheRetention: retention, messages: expect.any(Array) }),
        ]));
      }
    }
    const projected = projection(pairs);
    expect(projected).toMatch(/claude-haiku-5-5: cut \d+ \+ baseline \d+ = \d+ tokens/);
    expect(projected).toMatch(/deepseek-v4.1-flash --full: cut \d+ \+ baseline \d+ = \d+ tokens/);
    expect(projected).toMatch(/Keeper allowance: \d+ tokens\nTotal: \d+ tokens/);
    console.log(projected);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}, 60_000);

it.each([0.7, 1.4])("keeps both cut placements at %s× chars/4", async fauxRatio => {
  for (const model of [HAIKU, FULL]) {
    const { cut, baseline } = await pair(await prepare(model, model === FULL), { faux: true, fauxRatio });
    expect(cut.issues).toEqual([]);
    expect(cut.steps).toEqual([1, 2, 3]);
    expect(cut.beforeProbe).toEqual([1, 2]);
    expect(baseline?.issues).toEqual([]);
  }
}, 60_000);

it("stops at the padding cap and skips the baseline for an invalid cut", async () => {
  const { cut, baseline } = await pair(await prepare(HAIKU, false), { faux: true, fauxRatio: 0.1 });
  expect(cut.issues).toContainEqual(expect.stringContaining("opening: padding did not reach target (cap 24, used 24"));
  expect(baseline).toBeUndefined();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "compaction-eval-skipped-"));
  try {
    const file = await report(dir, HAIKU, cut, baseline, false);
    expect(await fs.readFile(file, "utf8")).toContain("Baseline skipped because the cut run was INVALID.");
    expect(JSON.parse(await fs.readFile(file.replace(/\.md$/, ".json"), "utf8")).baseline).toBeNull();
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}, 60_000);

it("caps model requests in a ledger turn that keeps calling tools and skips its baseline", async () => {
  const { cut, baseline } = await pair(await prepare(HAIKU, false), {
    faux: true, fauxLedgerSteps: Array<number>(27).fill(1),
  });
  expect(cut.issues).toContain("ledger: model request cap (8) reached");
  const ledger = cut.requests.filter(row => row.turn === "ledger");
  expect(ledger).toHaveLength(8);
  expect(ledger.every(row => row.stopped === "toolUse")).toBe(true);
  expect(cut.steps).toEqual(Array<number>(8).fill(1));
  expect(cut.requests.at(-1)?.turn).toBe("ledger");
  expect(baseline).toBeUndefined();
}, 60_000);

it("keeps idling until the measured gap reaches six minutes on a slow wall clock", async () => {
  // Paid rerun: macOS ran the wall clock 13.208 ppm slower than the timer clock, and the timer fired 1.5 ms late.
  let timer = 0;
  const waits: number[] = [];
  const gap = await idleGap(IDLE_MS, async ms => { waits.push(ms); timer += ms + 1.5; }, () => Math.floor(timer * (1 - 13.208e-6)));
  expect(gap).toBeGreaterThanOrEqual(IDLE_MS);
  expect(waits).toEqual([IDLE_MS, 4]);
  expect(await idleGap(20)).toBeGreaterThanOrEqual(20);
});

it("drains already-started keeper calls after shutdown before exposing their rows", async () => {
  const completions = keeperCompletions();
  const usage = { input: 123, cacheRead: 5, cacheWrite: 6, output: 7 };
  let finish!: (counts: typeof usage) => void;
  const provider = new Promise<typeof usage>(resolve => { finish = resolve; });
  const row: { result: string; usage?: typeof usage } = { result: "pending" };
  void completions.track(provider.then(counts => { Object.assign(row, { result: "ok", usage: counts }); }));
  let closed = false;
  let serialized: string | undefined;
  const teardown = completions.close(async () => { closed = true; }).then(() => { serialized = JSON.stringify(row); });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(closed).toBe(true);
  expect(serialized).toBeUndefined();
  finish(usage);
  await teardown;
  expect(serialized).toBe(JSON.stringify({ result: "ok", usage }));
});

it("attributes wrapped summary sections even when the index quotes an older probe", () => {
  const memory = renderMemory({ ...emptyMemory(), topics: [
    { id: "t_1", kind: "open", title: "Lantern inspection", note: "pending", refs: ["m_9"] },
    { id: "t_2", kind: "decision", title: "Kite seal", note: "Quillfeather-41", refs: ["m_10", "m_11"] },
  ] }, 1000);
  expect(memory).toContain("- Open: Lantern inspection: pending (refs: m_9)");
  const content = [
    "The conversation history before this point was compacted into the following summary:\n\n<summary>\nOlder messages are stored outside this context.",
    "Running turn\n- mosaic: done",
    `Memory\n${memory}`,
    "Older requests\n[m_10] Use earlier turns or session_history\n[m_9] lantern: pending\n</summary>",
  ].join("\n\n");
  const requests: RequestRow[] = [{ at: "", estimate: 0, cacheRetention: "default", turn: "probe-1", messages: [
    { role: "user", content: [{ type: "text", text: content }], timestamp: 0 },
  ] }];
  const run = { requests, expectedReply: "" };
  expect(sources(run, "probe-1", facts[0])).toEqual(["Memory"]);
  expect(sources(run, "probe-1", facts[3])).toEqual(["Memory", "summary index"]);
  expect(sources(run, "probe-1", facts[4])).toEqual(["Running turn"]);
});

it("rejects uncovered or misplaced cuts and missing or late fact plants", () => {
  const requests: RequestRow[] = ["kiln", "loom", "topic-0", "probe-0", "ledger", "ledger", "topic-1", "probe-1", "probe-1"]
    .map(turn => ({ turn, at: "", estimate: 0, cacheRetention: "default", messages: [] }));
  const kiln: RequestRow["messages"][number] = {
    role: "toolResult", toolName: "read_kiln", toolCallId: "probe-read", isError: false,
    content: [{ type: "text", text: `Kiln seal: ${facts[2].value}\nFixture content` }], timestamp: 0,
  };
  requests[8]!.messages.push(kiln);
  const seam = (id: string) => ({ id, carried: { firstKept: "m_1", indexed: 0 } });
  const stepsAt = (...indices: number[]) => indices.map((request, i) => ({ request, step: i + 1, turn: "ledger" }));
  const origins = { shipment: "m_2", kiln: "m_4", lantern: "m_5", mosaic: "m_6", kite: "m_7" };
  const history = Array.from({ length: 9 }, (_, i) => ({ id: `m_${i + 2}`, chars: 0 }));
  const run = { requests, history, origins, seams: [seam("m_8"), seam("m_10")], cuts: [1, 5], beforeProbe: [1, 2], stepRequests: stepsAt(3, 4, 5) };
  const missingSeal = "Opening kiln turn did not receive a successful read_kiln result with the seal";
  const baseline = { ...run, seams: [], cuts: [], beforeProbe: [0, 0] };
  expect(scenarioIssues(run, false)).toEqual([missingSeal]);
  expect(scenarioIssues(baseline, true)).toEqual([missingSeal]);
  requests[0]!.messages.push({ ...kiln, toolCallId: "opening-read", isError: true });
  expect(scenarioIssues(run, false)).toEqual([missingSeal]);
  requests[0]!.messages.push({ ...kiln, toolCallId: "opening-retry" });
  expect(scenarioIssues(run, false)).toEqual([]);
  expect(scenarioIssues(baseline, true)).toEqual([]);
  expect(scenarioIssues({ ...run, seams: [seam("m_3"), run.seams[1]!] }, false)).toEqual([
    "First seam is not after every scored fact plant: kite, kiln, lantern, mosaic",
  ]);
  expect(scenarioIssues({ ...run, origins: { ...origins, kiln: "m_99", kite: undefined } }, false)).toEqual([
    "First seam is not after every scored fact plant: kite, kiln",
  ]);
  for (const stepRequests of [stepsAt(2, 3, 4), stepsAt(5, 6, 7), stepsAt(3, 4, 4)]) {
    expect(scenarioIssues({ ...run, stepRequests }, false)).toEqual(["Second prefix break did not separate ordered ledger step executions"]);
  }
  expect(scenarioIssues({ ...run, seams: [...run.seams, seam("extra")], cuts: [1, 2, 5], beforeProbe: [2, 3] }, false)).toEqual([
    "Expected exactly one prefix break before each probe batch", "Second prefix break did not land mid ledger tool run",
  ]);
  expect(scenarioIssues({ ...run, cuts: [1, 6] }, false)).toEqual(["Second prefix break did not land mid ledger tool run"]);
  expect(scenarioIssues({ ...run, seams: [...run.seams, seam("extra")], cuts: [1, 5, 8] }, false)).toEqual([
    "Expected exactly one prefix break before each probe batch",
  ]);
});

it("scores corrected and status facts without accepting stale or conflicting answers", () => {
  expect(score(facts[0], "kite: Quillfeather-41", facts[0].value)).toBe(true);
  expect(score(facts[0], "kite: Quillfeather-18", facts[0].value)).toBe(false);
  expect(score(facts[0], "kite: Quillfeather-41 or Quillfeather-18", facts[0].value)).toBe(false);
  expect(score(facts[2], "kiln: Amberflute-62", facts[2].value)).toBe(true);
  expect(score(facts[2], "kiln: Amberflute-621", facts[2].value)).toBe(false);
  expect(score(facts[3], "lantern: pending", "pending")).toBe(true);
  expect(score(facts[3], "lantern: not pending", "pending")).toBe(false);
  expect(score(facts[4], "mosaic: done", "done")).toBe(true);
  expect(score(facts[4], "mosaic: pending", "done")).toBe(false);
  expect(score(facts[1], "shipment: FEN-742", "FEN-742")).toBe(true);
  expect(score(facts[1], "shipment: FEN-742", "")).toBe(false);
});

it("requires an exact paid opt-in and keeps full mode off by default", () => {
  expect(() => requirePaid(undefined)).toThrow("Paid eval refused");
  expect(() => requirePaid("true")).toThrow("Paid eval refused");
  expect(settings([])).toMatchObject({ models: [HAIKU], full: false });
  expect(settings(["--full"])).toMatchObject({ models: [FULL], full: true });
});

it("does not credit session_history for quoted probes, negated statuses, or near-miss identifiers", () => {
  const history = (text: string): RequestRow => ({ at: "", estimate: 0, cacheRetention: "default", turn: "probe-1", messages: [
    { role: "toolResult", toolName: "session_history", toolCallId: "h", isError: false, content: [{ type: "text", text }], timestamp: 0 },
  ] });
  const identify = (text: string) => sources({ requests: [history(text)], expectedReply: "" }, "probe-1", facts[2]);
  expect(identify("kiln: Amberflute-621; XAmberflute-62; Amberflute-62-extra")).toEqual([]);
  expect(identify("kiln: (Amberflute-62).")).toEqual(["session_history"]);
  const probeText = facts.map(({ id, question }) => `${id}: ${question}`).join("\n");
  for (const quoted of [probeText, JSON.stringify(probeText).slice(1, -1)]) {
    for (const fact of [facts[3], facts[4]]) {
      expect(sources({ requests: [history(quoted)], expectedReply: "" }, "probe-1", fact)).toEqual([]);
    }
  }
  const run = { requests: [history("The lantern inspection is pending. The mosaic inventory is not done. Is the mosaic inventory done? mosaic: pending or done")], expectedReply: "" };
  expect(sources(run, "probe-1", facts[3])).toEqual(["session_history"]);
  expect(sources(run, "probe-1", facts[4])).toEqual([]);
});

it("measures the same planted entry against changing feed boundaries", () => {
  const history = [4, 8, 16, 0, 0].map((chars, i) => ({ id: `m_${i}`, chars }));
  const seams = [0, 2].map((kept, i) => ({ id: `m_${i + 3}`, carried: { firstKept: `m_${kept}`, indexed: 0 } }));
  expect(originDistances({ history, seams, cuts: [4, 9], origins: { kite: "m_1" } }, facts[0])).toBe("+1, −2");
});
