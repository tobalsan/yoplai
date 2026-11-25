import fs from "node:fs/promises";
import path from "node:path";
import { facts, probe, STEPS, score, tokens, type Fact } from "./scenario.js";
import type { RequestRow, Run } from "./runner.js";

const text = (message: RequestRow["messages"][number]) => typeof message.content === "string" ? message.content
  : message.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");
const summary = (message: RequestRow["messages"][number]) => {
  if (message.role !== "user") return undefined;
  const prefix = "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
  const suffix = "\n</summary>";
  const value = text(message);
  if (value.startsWith(prefix + "Older messages are stored outside this context.") && value.endsWith(suffix)) {
    return value.slice(prefix.length, -suffix.length);
  }
};
const isProbe = (message: RequestRow["messages"][number]) =>
  message.role === "user" && text(message).endsWith(probe);
const matches = (fact: Fact, value: string, expected: string) => Boolean(expected) && (
  fact.id === "lantern" || fact.id === "mosaic" ? new RegExp(`${fact.id}[^.\\n]{0,30}\\b${expected}\\b`, "i").test(value) : value.includes(expected));
const expected = (run: Pick<Run, "expectedReply">, fact: Fact) => fact.id === "shipment" ? run.expectedReply : fact.value;

export function sources(run: Pick<Run, "requests" | "expectedReply">, turn: string, fact: Fact) {
  const value = expected(run, fact);
  const found = new Set<string>();
  const kilnReads = new Map<string, string>();
  for (const row of run.requests) for (const message of row.messages) {
    if (message.role === "toolResult" && message.toolName === "read_kiln" && !kilnReads.has(message.toolCallId)) {
      kilnReads.set(message.toolCallId, row.turn);
    }
  }
  for (const { messages } of run.requests.filter(row => row.turn === turn)) for (const message of messages) {
    if (message.role === "system") continue;
    const body = summary(message);
    if (body !== undefined) {
      const sections = body.split(/\n\n(Running turn|Memory|Older requests)(?=\n|$)/);
      for (let i = 1; i < sections.length; i += 2) {
        const name = sections[i]!;
        if (matches(fact, sections[i + 1]!, value)) found.add(name === "Older requests" ? "summary index" : name);
      }
    } else if (!isProbe(message) && matches(fact, text(message), value)) {
      found.add(message.role === "toolResult" && message.toolName === "session_history" ? "session_history"
        : message.role === "toolResult" && message.toolName === "read_kiln" && kilnReads.get(message.toolCallId) === turn ? "tool re-read" : "retained messages");
    }
  }
  return [...found];
}

function originDistances(run: Run, fact: Fact) {
  return run.cuts.map(i => {
    const previous = run.requests[i - 1]!.messages;
    const next = run.requests[i]!.messages.find(m => m.role !== "system" && summary(m) === undefined);
    const boundary = previous.findIndex(m => JSON.stringify(m) === JSON.stringify(next));
    const origin = previous.findIndex(m => m.role !== "system" && summary(m) === undefined && !isProbe(m) && matches(fact, text(m), expected(run, fact)));
    if (origin < 0 || boundary < 0) return "unknown";
    const distance = tokens(JSON.stringify(previous.slice(Math.min(origin, boundary), Math.max(origin, boundary))));
    return origin < boundary ? `−${distance}` : `+${origin === boundary ? 0 : distance}`;
  }).join(", ") || "n/a";
}

export function cold(run: Run) {
  const first = run.requests[0]?.usage;
  // Pi normalizes absent cache fields to zero: all-zero data is ambiguous.
  const measurable = first && run.requests.some(({ usage }) => usage && (usage.cacheRead > 0 || usage.cacheWrite > 0));
  if (!measurable) return undefined;
  const prefix = first.input + first.cacheRead + first.cacheWrite;
  return run.cuts.map((i, index) => run.requests.slice(i, run.cuts[index + 1]).filter(({ usage }, j) =>
    i + j !== run.gapRequest && usage && usage.cacheRead <= prefix).length);
}

const cell = (value: string) => value.replaceAll("|", "\\|").replaceAll("<", "&lt;").replaceAll("\n", " · ");
const retention = (run: Run) => [...new Set(run.requests.map(row => row.cacheRetention))].join(", ") || "no requests";
const pct = (value: number) => (100 * value).toFixed(1);
const verdict = (passed: boolean) => passed ? "PASS" : "FAIL";
const usageCells = (usage?: RequestRow["usage"]) => usage ? `${usage.input} | ${usage.cacheRead} | ${usage.cacheWrite} | ${usage.output}` : "— | — | — | —";

export async function report(dir: string, model: string, cut: Run, baseline: Run, full: boolean) {
  const rows = [0, 1].flatMap(batch => facts.map(fact => {
    const turn = `probe-${batch}`;
    const a = score(fact, cut.answers[turn] ?? "", expected(cut, fact));
    const b = score(fact, baseline.answers[turn] ?? "", expected(baseline, fact));
    return { fact, turn, a, b };
  }));
  const rate = (items: typeof rows, key: "a" | "b") => items.filter(row => row[key]).length / items.length;
  const a = rate(rows, "a"), b = rate(rows, "b");
  const coldCounts = cold(cut);
  const counts = (run: Run) => STEPS.map(step => run.steps.filter(value => value === step).length);
  const sideEffects = [cut, baseline].every(run => run.steps.length === STEPS.length && counts(run).every(n => n === 1));
  const issues = [...cut.issues.map(s => `cut: ${s}`), ...baseline.issues.map(s => `baseline: ${s}`)];
  const lines = [
    `# Durable compaction eval — ${model}`, "", issues.length ? `**INVALID:** ${issues.join("; ")}` : "**Valid scenario.**", "",
    `Stream cache retention (default = delegated to provider): cut ${retention(cut)}; baseline ${retention(baseline)}.`,
    full ? "Full-size cut vs cheap-scenario baseline on the same model (a full-size uncut baseline exceeds the 150k ceiling). Cache is informational only." :
      "Cheap cuts do not test the production 20k tail or 16k-character summary budget at scale. At 150k the tail is ~4× larger and the same summary takes ~7× less of the ceiling.",
    "OpenCode Go's Anthropic route does not use pi-ai Anthropic message threads; direct Anthropic may behave differently.",
    "Cold proxy: post-cut cacheRead ≤ P (first request input + cacheRead + cacheWrite). Requests are grouped through the next cut; exclude the idle-gap request. Pi normalizes missing cache fields to zero; without any positive cache usage the proxy is unmeasurable.",
    "Keeper calls use separate completions. Both runs have a 20,000-byte transcript/memory prompt budget and a 2,000-token output cap.",
    "", "## Pass bars", "",
    `- Recall (≤10 points below baseline): ${verdict((b - a) <= 0.1 + Number.EPSILON)} (${pct(a)}% vs ${pct(b)}%; Δ ${pct(a - b)} points)`,
    `- Side effects (exactly one per step): ${verdict(sideEffects)}`,
    `- Cold requests (≤1 per cut): ${full ? "informational; " : ""}${coldCounts ? `${full ? "counts" : verdict(coldCounts.every(n => n <= 1))}: ${coldCounts.join(", ") || "none"}` : "unmeasurable"}`,
    "", "## Recall", "",
    "Availability is not causality. Distances are estimated tokens from each cut boundary (negative = removed; positive = retained; unknown = not measurable from adjoining requests).", "",
    "| Source | Cut | Baseline | Gap (points) | Warning |", "|---|---:|---:|---:|---|",
  ];
  for (const source of ["user", "reply", "tool"] as const) {
    const items = rows.filter(row => row.fact.source === source);
    const x = rate(items, "a"), y = rate(items, "b");
    lines.push(`| ${source} | ${pct(x)}% | ${pct(y)}% | ${pct(x - y)} | ${x < 0.7 ? "⚠ source below 70%" : "—"} |`);
  }
  lines.push("", "| Probe / fact | Cut result / answer | Baseline result / answer | Cut available sources | Baseline available sources | Cut distances |",
    "|---|---|---|---|---|---|");
  for (const { fact, turn, a: hit, b: baseHit } of rows) {
    const excerpt = (run: Run) => cell((run.answers[turn]?.split("\n").find(line => line.includes(`${fact.id}:`)) ?? run.answers[turn] ?? "—").slice(0, 160));
    lines.push(`| ${turn} / ${fact.id} (${fact.source}) | ${hit ? "hit" : "miss"}: ${excerpt(cut)} | ${baseHit ? "hit" : "miss"}: ${excerpt(baseline)} | ${hit ? sources(cut, turn, fact).join(", ") || "none found" : "—"} | ${baseHit ? sources(baseline, turn, fact).join(", ") || "none found" : "—"} | ${originDistances(cut, fact)} |`);
  }
  lines.push("", "## Side effects", "", "| Step | Cut | Baseline |", "|---|---:|---:|");
  for (const [i, step] of STEPS.entries()) lines.push(`| ${step} | ${counts(cut)[i]} | ${counts(baseline)[i]} |`);
  lines.push("", "## Relevance", "", "| New topic | Cut answer | Baseline answer |", "|---|---|---|");
  for (const [i, label] of ["Moon phases", "Floating ice"].entries()) lines.push(`| ${label} | ${cell(cut.answers[`topic-${i}`] ?? "—")} | ${cell(baseline.answers[`topic-${i}`] ?? "—")} |`);
  lines.push("", "## Cache and request usage");
  for (const [label, run] of [["Cut", cut], ["Baseline", baseline]] as const) {
    const sizes = run.cuts.map(i => run.requests[i]!.messages.map(summary).find(body => body !== undefined)?.length ?? 0);
    lines.push("", `### ${label}: ceiling ${run.budget.ceiling}, tail ${run.budget.tail}, summary characters per cut ${sizes.join(", ") || "none"}`,
      "", `Seams: ${run.seams.length}; prefix breaks: ${run.cuts.length}; idle gap: ${run.gapRequest < 0 ? "none" : `${run.gapMs} ms`}.`, "",
      "| # | Timestamp | Turn | Markers | Messages | Est. prompt | Input | Read | Write | Output |", "|---:|---|---|---|---:|---:|---:|---:|---:|---:|");
    run.requests.forEach((row, i) => {
      const marker = [run.cuts.includes(i) && "after cut", run.cuts.includes(i + 1) && "before cut", i === run.gapRequest && "after idle"].filter(Boolean).join(", ");
      lines.push(`| ${i + 1} | ${row.at} | ${row.turn} | ${marker} | ${row.messages.length} | ${row.estimate} | ${usageCells(row.usage)} |`);
    });
  }
  lines.push("", "## Keeper completions", "", "| Run | Timestamp | Est. prompt | Output cap | Result | Input | Read | Write | Output |", "|---|---|---:|---:|---|---:|---:|---:|---:|");
  for (const [label, run] of [["Cut", cut], ["Baseline", baseline]] as const) for (const row of run.keeper) {
    lines.push(`| ${label} | ${row.at} | ${row.estimate} | ${row.cap} | ${row.result ?? "pending"} | ${usageCells(row.usage)} |`);
  }
  lines.push("", "## Recommendations", "",
    `- Summary kind: no change; data insufficient (${pct(a - b)} point recall gap; no alternate summary tested).`,
    `- Ceiling: no change; data insufficient (${cut.budget.ceiling} tokens; cold counts ${coldCounts?.join(", ") || "unmeasurable"}).`,
    `- Tail: no change; data insufficient (${cut.budget.tail} tokens; see per-fact distances; no alternate tail tested).`,
    "", "The companion JSON retains the original request context for auditing probe availability and prefix breaks.", "");
  await fs.mkdir(dir, { recursive: true });
  const base = path.join(dir, model.replace(/[^a-z\d.-]+/gi, "-") + (full ? "-full" : ""));
  await fs.writeFile(`${base}.json`, JSON.stringify({ cut, baseline }, null, 2));
  await fs.writeFile(`${base}.md`, lines.join("\n"));
  return `${base}.md`;
}
