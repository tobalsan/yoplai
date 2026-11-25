import { lazyStream, type Message, type SimpleStreamOptions, type Usage } from "@earendil-works/pi-ai-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { CompactionEntry, type ConversationId, type Cursor, type EntryRecord } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { FeedItem, FeedWindow } from "@yoplai/shared";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { vi } from "vitest";
import { startDurableTestGateway, type RealTestModel } from "../../test-utils/durable-gateway.js";
import type { DurableModelsFactory } from "../models.js";
import { InputEntry } from "../state.js";
import { durableStorePath } from "../store-path.js";
import { CHEAP_CEILING, CHEAP_WINDOW, facts, filler, fixture, FULL_CEILING, IDLE_MS, OUTPUT_CAP, probe, scenario, shipmentCode, STEPS, tokens } from "./scenario.js";

export type Counts = Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite">;
export type RequestRow = {
  at: string; turn: string; messages: Message[]; estimate: number;
  cacheRetention: NonNullable<SimpleStreamOptions["cacheRetention"]> | "default";
  usage?: Counts; stopped?: string;
};
type KeeperRow = { at: string; estimate: number; cap: number; usage?: Counts; result?: "ok" | "failed" };
type Padding = { id: string; chars: number };
export type Drive = { opening: Padding[]; ledger: Padding[]; steps: number[] };
export type Budget = { contextWindow: number; maxTokens: number; ceiling: number; tail: number };
export type Run = {
  budget: Budget; requests: RequestRow[]; keeper: KeeperRow[]; answers: Record<string, string>;
  steps: number[]; stepRequests: { step: number; turn: string; request: number }[];
  seams: Pick<Extract<FeedItem, { role: "seam" }>, "id" | "carried">[];
  cuts: number[]; beforeProbe: number[]; gapRequest: number; gapMs: number;
  history: { id: string; chars: number }[]; origins: Partial<Record<typeof facts[number]["id"], string>>;
  expectedReply: string; issues: string[]; drive: Drive;
};

function counts({ input, output, cacheRead, cacheWrite }: Counts): Counts {
  return { input, output, cacheRead, cacheWrite };
}

export const breaks = (requests: RequestRow[]) => requests.slice(1).flatMap(({ messages }, index) => {
  const prev = requests[index]!.messages;
  return JSON.stringify(messages.slice(0, prev.length)) === JSON.stringify(prev) ? [] : [index + 1];
});

export function scenarioIssues({ requests, seams, cuts, beforeProbe, stepRequests, history, origins }: Pick<Run, "requests" | "seams" | "cuts" | "beforeProbe" | "stepRequests" | "history" | "origins">, baseline: boolean) {
  const issues: string[] = [];
  if (seams.length !== cuts.length) issues.push(`Seams (${seams.length}) differ from prefix breaks (${cuts.length})`);
  if (baseline) {
    if (seams.length || cuts.length) issues.push("Baseline must have no cuts");
  } else {
    const firstProbe = requests.findIndex(row => row.turn === "probe-0");
    const secondProbe = requests.findIndex(row => row.turn === "probe-1");
    const [first, second] = cuts;
    if (cuts.length !== 2 || beforeProbe[0] !== 1 || beforeProbe[1] !== 2 ||
      first === undefined || second === undefined || !(first < firstProbe && firstProbe < second && second < secondProbe)) {
      issues.push("Expected exactly one prefix break before each probe batch");
    }
    const firstSeam = history.findIndex(entry => entry.id === seams[0]?.id);
    const unplanted = facts.filter(({ id }) => {
      const plant = history.findIndex(entry => entry.id === origins[id]);
      return plant < 0 || plant >= firstSeam;
    });
    if (unplanted.length) issues.push(`First seam is not after every scored fact plant: ${unplanted.map(({ id }) => id).join(", ")}`);
    if (second === undefined || requests[second - 1]?.turn !== "ledger" || requests[second]?.turn !== "ledger") {
      issues.push("Second prefix break did not land mid ledger tool run");
    } else {
      const ledger = stepRequests.filter(event => event.turn === "ledger");
      // Request index `second` is the first after the break.
      if (ledger.length !== STEPS.length || ledger.some(({ step, request }, i) =>
        step !== STEPS[i] || request <= (ledger[i - 1]?.request ?? -1)) ||
        !ledger.some(event => event.request < second) || !ledger.some(event => event.request >= second)) {
        issues.push("Second prefix break did not separate ordered ledger step executions");
      }
    }
  }
  const seal = `Kiln seal: ${facts[2].value}`;
  if (!requests.some(row => row.turn === "kiln" && row.messages.some(message =>
    message.role === "toolResult" && message.toolName === "read_kiln" && !message.isError &&
    message.content.some(block => block.type === "text" && block.text.split("\n", 1)[0] === seal)))) {
    issues.push("Opening kiln turn did not receive a successful read_kiln result with the seal");
  }
  return issues;
}

const REQUEST_CAP = 8;
type Turn = { id: string; firstRequest: number; capped: boolean };

function observe(requests: RequestRow[], turn: Turn, issues: string[], redact: (value: string) => string, fauxRatio?: number) {
  let prefix = 0;
  return (factory: DurableModelsFactory): DurableModelsFactory => async (agent, policy) => {
    const models = await factory(agent, policy);
    const stream = models.streamSimple.bind(models);
    models.streamSimple = (model, transcript, options) => {
      if (requests.length - turn.firstRequest >= REQUEST_CAP) {
        const reason = `${turn.id}: model request cap (${REQUEST_CAP}) reached`;
        if (!turn.capped) issues.push(reason);
        turn.capped = true;
        // Settle through Durable's normal model-error path without calling the provider.
        return lazyStream(model, async () => { throw new Error(reason); }, undefined, options?.signal);
      }
      const serialized = JSON.stringify(transcript.messages, (_name, value: unknown) => typeof value === "string" ? redact(value) : value);
      const row: RequestRow = {
        at: new Date().toISOString(), turn: turn.id, messages: JSON.parse(serialized), estimate: tokens(serialized),
        cacheRetention: options?.cacheRetention ?? "default",
      };
      requests.push(row);
      async function* recorded() {
        for await (const event of stream(model, transcript, options)) {
          if (event.type === "done" && fauxRatio !== undefined) {
            const prev = requests.at(-2);
            const prompt = Math.ceil(row.estimate * fauxRatio);
            if (!prev) prefix = prompt;
            const cold = !prev || JSON.stringify(row.messages.slice(0, prev.messages.length)) !== JSON.stringify(prev.messages)
              || (row.turn === "probe-0" && prev.turn === "topic-0");
            const cacheRead = cold ? 0 : Math.min(prompt, prefix + 1);
            const input = prompt - cacheRead;
            const output = Math.max(6, tokens(JSON.stringify(event.message.content)));
            const usage = { ...event.message.usage, input, cacheRead, cacheWrite: 0, output, totalTokens: prompt + output };
            event.message = { ...event.message, usage };
          }
          const final = event.type === "done" ? event.message : event.type === "error" ? event.error : undefined;
          if (final) { row.usage = counts(final.usage); row.stopped = final.stopReason; }
          yield event;
        }
      }
      return lazyStream(model, async () => recorded(), undefined, options?.signal);
    };
    return models;
  };
}

function reference(ref: string) {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) throw new Error("Expected provider/model");
  return { provider: ref.slice(0, slash), model: ref.slice(slash + 1) };
}

async function resolveBudget(ref: string, realModel: RealTestModel): Promise<Budget> {
  const { createDurableModels } = await import("../models.js");
  const { createMainCompactionSettings } = await import("../compaction.js");
  const { getAgent } = await import("../../config/index.js");
  const agent = getAgent("pilot");
  if (!agent) throw new Error("Eval agent missing");
  const models = await createDurableModels(agent, async () => undefined);
  const model = models.getModel(realModel.provider, realModel.model);
  const settings = createMainCompactionSettings(models)(agent).modelOverrides[ref];
  if (!model || !settings) throw new Error(`Model not found in offline registry: ${ref}`);
  return { contextWindow: model.contextWindow, maxTokens: model.maxTokens,
    ceiling: model.contextWindow - settings.reserveTokens, tail: settings.keepRecentTokens };
}

export async function preflight(ref: string, variant: "cheap" | "full" | "baseline") {
  const realModel: RealTestModel = { ...reference(ref), limits: variant === "full" ? undefined : {
    maxTokens: OUTPUT_CAP, ...(variant === "cheap" && { contextWindow: CHEAP_WINDOW }),
  } };
  const gateway = await startDurableTestGateway({ realModel }); // No Main admission or model stream.
  try {
    const budget = await resolveBudget(ref, realModel);
    console.log(`Preflight ${ref} ${variant}: contextWindow=${budget.contextWindow} maxTokens=${budget.maxTokens} ceiling=${budget.ceiling} tail=${budget.tail}`);
    const ceiling = variant === "cheap" ? CHEAP_CEILING : FULL_CEILING;
    if (budget.ceiling !== ceiling || budget.tail !== Math.min(20_000, Math.floor(ceiling / 4)) ||
      (variant !== "full" && budget.maxTokens !== OUTPUT_CAP) || (variant === "cheap" && budget.contextWindow !== CHEAP_WINDOW)) {
      throw new Error(`Offline compaction budget differs from intended ${variant} settings`);
    }
    return budget;
  } finally { await gateway.close(); }
}

async function loggedHistory(home: string, conversationId: ConversationId, data: ReturnType<typeof scenario>, shipmentId: string, redact: (value: string) => string) {
  const storage = await openNodeSqliteStorage(durableStorePath(home, "pilot"));
  const entries: EntryRecord[] = [];
  try {
    let cursor: Cursor | undefined;
    do {
      const page = await storage.scanEntries({ conversationId, order: "ascending" }, 200, cursor, BACKGROUND_CONTEXT);
      entries.push(...page.items);
      cursor = page.next;
    } while (cursor !== undefined);
  } finally { await storage.close(BACKGROUND_CONTEXT); }
  const openings = new Map(data.opening.map(({ id, text }) => [text, id]));
  const origins: Run["origins"] = {};
  let opening: string | undefined;
  const history = entries.map(entry => {
    const id = `m_${entry.id}`;
    if (InputEntry.is(entry)) {
      opening = openings.get(entry.data.text);
      if (opening === "kite" || opening === "lantern" || opening === "mosaic") origins[opening] ??= id;
    }
    if (id === shipmentId && entry.model?.some(message => message.role === "assistant")) origins.shipment = id;
    if (opening === "kiln" && entry.model?.some(message => message.role === "toolResult" && message.toolName === "read_kiln" && !message.isError &&
      message.content.some(block => block.type === "text" && block.text.split("\n", 1)[0] === `Kiln seal: ${facts[2].value}`))) origins.kiln ??= id;
    // Exclude summaries and bookkeeping; count original serialized message bodies once.
    const chars = CompactionEntry.is(entry) ? 0 : (entry.model ?? []).reduce((sum, message) =>
      sum + JSON.stringify(message, (_name, value: unknown) => typeof value === "string" ? redact(value) : value).length, 0);
    return { id, chars };
  });
  return { history, origins };
}

// Durable starts with measured prompt + output, then charges new text at chars/3.5.
const contextSize = (row?: RequestRow) => row?.usage && row.stopped !== "error" && row.stopped !== "aborted"
  ? row.usage.input + row.usage.cacheRead + row.usage.cacheWrite + row.usage.output : 0;
const payloadChars = (budget: number) => Math.ceil(3.5 * budget);
const PADDING_CAP = 24;

export function keeperCompletions() {
  const pending = new Set<Promise<unknown>>();
  return {
    track<T>(promise: Promise<T>) {
      pending.add(promise);
      const remove = () => { pending.delete(promise); };
      void promise.then(remove, remove);
      return promise;
    },
    async close(closeGateway: () => Promise<void>) {
      try { await closeGateway(); }
      finally { await Promise.allSettled(pending); }
    },
  };
}

const feedUrl = "/api/agents/pilot/feed?limit=200";
export async function run(ref: string, variant: "cheap" | "full" | "baseline", budget: Budget, options: {
  faux?: boolean; fauxRatio?: number; fauxLedgerSteps?: readonly number[]; long?: boolean; idle?: (ms: number) => Promise<unknown>; apiKey?: string; replay?: Drive;
}) {
  const baseline = variant === "baseline";
  const data = scenario();
  const drive: Drive = { opening: [], ledger: [], steps: [] };
  const size = () => contextSize(requests.at(-1));
  const issues: string[] = [];
  const chunk = Math.floor(budget.ceiling / 8);
  const requests: RequestRow[] = [];
  const keeper: KeeperRow[] = [];
  const stepRequests: Run["stepRequests"] = [];
  let home = "";
  const turn: Turn = { id: "", firstRequest: 0, capped: false };
  const redact = (value: string) => options.apiKey ? value.replaceAll(options.apiKey, "[redacted]") : value;
  const gateway = await startDurableTestGateway({
    realModel: options.faux ? undefined : { ...reference(ref), apiKey: options.apiKey, limits: variant === "full" ? undefined : {
      maxTokens: OUTPUT_CAP, ...(variant === "cheap" && { contextWindow: CHEAP_WINDOW }),
    } },
    fauxLimits: options.faux ? { contextWindow: budget.contextWindow, maxTokens: budget.maxTokens } : undefined,
    fixtureExtensions: async () => [(await import("../../session-history/index.js")).sessionHistoryExtension],
    fixture: { extension: fixture(() => home, data, step => {
      stepRequests.push({ step, turn: turn.id, request: requests.length - 1 });
      let chars = options.replay?.steps[step - 1] ?? 0;
      if (!baseline && step < 3) {
        const remaining = budget.ceiling - size();
        // Re-measure at each tool call. The first result is deliberately sub-threshold;
        // the second crosses using Durable's estimate for the as-yet unseen result.
        const amount = step === 1 ? Math.floor(remaining * 0.45) : remaining + 128;
        if (!size() || amount <= 0 || amount > budget.ceiling * 0.5 || remaining < 0) {
          issues.push(`Ledger step ${step}: no safe output size (context ${size()}, remaining ${remaining})`);
        } else {
          chars = payloadChars(amount);
        }
      }
      drive.steps[step - 1] = chars;
      return chars ? filler(chars, 20 + step) : "Ledger sealed.";
    }) },
    wrapModels: observe(requests, turn, issues, redact, options.faux ? options.fauxRatio ?? 1 : undefined),
    extraYaml: "toolDeferral: { enabled: false }\nretryMaxAttempts: 1" + (options.long ? "\nsandbox:\n  env: { PI_CACHE_RETENTION: long }" : ""),
  });
  home = gateway.home;
  const { MaintenanceCompletion, completeMaintenance } = await import("../../maintenance/completion.js");
  const completions = keeperCompletions();
  const maintenance = vi.spyOn(MaintenanceCompletion, "complete").mockImplementation((params) => completions.track((async () => {
    const row: KeeperRow = { at: new Date().toISOString(), estimate: tokens(params.system + params.prompt), cap: params.maxTokens };
    keeper.push(row);
    const result = options.faux ? '{"topics":[]}' : await completeMaintenance(params, { onUsage: usage => { row.usage = counts(usage); } });
    row.result = result === null ? "failed" : "ok";
    return result;
  })()));
  const answers: Record<string, string> = {};
  let shipmentId = "";
  const beforeProbe: number[] = [];
  let gapMs = 0;
  let gapRequest = -1;
  type Script = Parameters<typeof gateway.script>[number];
  let seams: Run["seams"] = [];
  async function send(id: string, text: string, ...script: Script[]) {
    turn.id = id;
    turn.firstRequest = requests.length;
    if (options.faux) gateway.script(...script);
    const response = await gateway.send("local", text, { clientSendId: id });
    const feedResponse = await gateway.request("local", feedUrl);
    if (!feedResponse.ok) throw new Error(`Feed returned HTTP ${feedResponse.status}`);
    const feed: FeedWindow = await feedResponse.json();
    if (feed.hasBefore) issues.push(`${id}: feed was truncated`);
    seams = feed.items.flatMap(item => item.role === "seam" ? [{ id: item.id, carried: item.carried }] : []);
    const last = feed.items.at(-1);
    if (!response.ok || last?.role !== "assistant") issues.push(`${id}: no settled answer (HTTP ${response.status})`);
    else {
      answers[id] = redact(last.text);
      if (id === "shipment") shipmentId = last.id;
    }
  }
  async function pad(phase: "opening" | "ledger", { id, chars }: Padding) {
    drive[phase].push({ id, chars });
    await send(id, "File this invented clipping. Reply only 'Noted'.\n" + filler(chars, 100 + drive[phase].length), "Noted.");
  }
  async function fill(phase: "opening" | "ledger", ready: () => boolean) {
    if (turn.capped) return false;
    if (baseline) {
      for (const padding of options.replay?.[phase] ?? []) {
        await pad(phase, padding);
        if (turn.capped) return false;
      }
      return true;
    }
    for (let i = 0; i < PADDING_CAP && !ready(); i++) {
      if (!size() || issues.length || seams.length > (phase === "opening" ? 0 : 1)) break;
      await pad(phase, { id: `${phase}-padding-${i}`, chars: payloadChars(chunk) });
    }
    if (turn.capped) return false;
    if (ready()) return true;
    issues.push(`${phase}: padding did not reach target (cap ${PADDING_CAP}, used ${drive[phase].length}, context ${size()}, seams ${seams.length})`);
    return false;
  }
  function headroom(label: string, expectedSeams: number) {
    if (turn.capped) return false;
    if (baseline) return true;
    if (seams.length === expectedSeams && size() > 0 && size() < budget.ceiling * 0.84) return true;
    issues.push(`${label}: expected ${expectedSeams} seams and probe headroom (got ${seams.length}, context ${size()}/${budget.ceiling})`);
    return false;
  }
  try {
    await fs.writeFile(path.join(home, "kiln.txt"), data.kiln);
    await fs.writeFile(path.join(home, "steps.txt"), "");
    for (const [index, opening] of data.opening.entries()) {
      if (index > 0 && index % 3 === 0) {
        const digest = data.digests[index / 3 - 1]!;
        await gateway.writePassiveEntry("local", { kind: "eval.digest", data: { digest }, model: [
          { role: "user", content: digest, timestamp: Date.now() },
        ] });
      }
      const short = opening.id === "shipment" ? "FEN-742" : opening.id === "kiln" ? "Kiln checked" : "Noted.";
      await send(opening.id, opening.text, ...(opening.id === "kiln" ? [{ tool: "read_kiln", id: "initial-kiln" }] : []), short);
      if (turn.capped) break;
    }
    const expectedReply = shipmentCode(answers.shipment ?? "");
    if (!expectedReply) issues.push("No valid reply-sourced shipment code");
    const openingReady = await fill("opening", () => seams.length === 1);
    for (const index of openingReady ? [0, 1] : []) {
      if (index === 1) {
        if (!await fill("ledger", () => seams.length === 1 && size() >= budget.ceiling * 0.54) || !headroom("Before ledger", 1)) break;
        const script = (options.fauxLedgerSteps ?? STEPS).map((step, i) => ({ tool: "record_eval_step", id: `step-${i + 1}`, args: { step } }));
        await send("ledger", data.ledger, ...script, "The ledger is sealed.");
      }
      if (!headroom(`Before topic ${index}`, index + 1)) break;
      // First relevance question opens the post-cut cache prefix before the idle check.
      await send(`topic-${index}`, data.relevance[index]!, index ? "Ice is less dense than liquid water." : "We see different fractions of the Moon's sunlit half.");
      if (!headroom(`Before probe ${index}`, index + 1)) break;
      if (index === 0 && !baseline) {
        const start = Date.now();
        await (options.idle ?? sleep)(IDLE_MS);
        gapMs = Date.now() - start;
        gapRequest = requests.length;
      }
      beforeProbe.push(seams.length);
      const reply = facts.map(({ id, value }) => `${id}: ${id === "shipment" ? expectedReply : id === "kiln" && index === 1 && !baseline ? "unknown" : value}`).join("\n");
      await send(`probe-${index}`, probe,
        { tool: "session_history", id: `probe-history-${index}`, args: { action: "read", around: shipmentId, role: "assistant", n: 1 } },
        { tool: "read_kiln", id: `probe-kiln-${index}` }, reply);
    }
    const cuts = breaks(requests);
    if (requests.some(row => !row.stopped || row.stopped === "error" || row.stopped === "aborted")) issues.push("Incomplete or failed model request");
    if (!baseline && !options.faux && gapMs < IDLE_MS) issues.push("Idle gap was shorter than six minutes");
    const steps = (await fs.readFile(path.join(home, "steps.txt"), "utf8")).trim().split("\n").filter(Boolean).map(Number);
    const conversationId = await gateway.mainConversationId("local") as ConversationId | undefined;
    const journal = conversationId ? await loggedHistory(home, conversationId, data, shipmentId, redact) : { history: [], origins: {} };
    issues.push(...scenarioIssues({ ...journal, requests, seams, cuts, beforeProbe, stepRequests }, baseline));
    return { ...journal, budget, requests, keeper, answers, steps, stepRequests, seams, cuts, beforeProbe, gapRequest, gapMs, expectedReply, issues, drive } satisfies Run;
  } finally {
    try { await completions.close(gateway.close); }
    finally { maintenance.mockRestore(); }
  }
}

export function projection(pairs: { model: string; full: boolean; cut: Run; baseline?: Run }[]) {
  const total = (run?: Run) => run?.requests.reduce((sum, row) => sum + contextSize(row) - (row.usage?.output ?? 0) + run.budget.maxTokens, 0) ?? 0;
  const lines = pairs.map(({ model, full, cut, baseline }) => `${model}${full ? " --full" : ""}: cut ${total(cut)} + baseline ${total(baseline)} = ${total(cut) + total(baseline)} tokens`);
  // Batches group complete public turns: reserve one capped completion per scripted turn per run,
  // including catch-up, using one token per input byte plus system/framing room.
  const allowance = pairs.flatMap(({ cut, baseline }) => baseline ? [cut, baseline] : [cut]).reduce((sum, run) => sum + Object.keys(run.answers).length * 23_000, 0);
  const main = pairs.reduce((sum, { cut, baseline }) => sum + total(cut) + total(baseline), 0);
  return [...lines, `Keeper allowance: ${allowance} tokens`, `Total: ${main + allowance} tokens`].join("\n");
}
