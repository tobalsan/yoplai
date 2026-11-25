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
import { CHEAP_CEILING, CHEAP_WINDOW, facts, fixture, FULL_CEILING, IDLE_MS, OUTPUT_CAP, probe, scenario, shipmentCode, STEPS, tokens } from "./scenario.js";

export type Counts = Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite">;
export type RequestRow = {
  at: string; turn: string; messages: Message[]; estimate: number;
  cacheRetention: NonNullable<SimpleStreamOptions["cacheRetention"]> | "default";
  usage?: Counts; stopped?: string;
};
type KeeperRow = { at: string; estimate: number; cap: number; usage?: Counts; result?: "ok" | "failed" };
export type Budget = { contextWindow: number; maxTokens: number; ceiling: number; tail: number };
export type Run = {
  budget: Budget; requests: RequestRow[]; keeper: KeeperRow[]; answers: Record<string, string>;
  steps: number[]; stepRequests: { step: number; turn: string; request: number }[];
  seams: Pick<Extract<FeedItem, { role: "seam" }>, "id" | "carried">[];
  cuts: number[]; beforeProbe: number[]; gapRequest: number; gapMs: number;
  history: { id: string; chars: number }[]; origins: Partial<Record<typeof facts[number]["id"], string>>;
  expectedReply: string; issues: string[];
};

function counts({ input, output, cacheRead, cacheWrite }: Counts): Counts {
  return { input, output, cacheRead, cacheWrite };
}

export const breaks = (requests: RequestRow[]) => requests.slice(1).flatMap(({ messages }, index) => {
  const prev = requests[index]!.messages;
  return JSON.stringify(messages.slice(0, prev.length)) === JSON.stringify(prev) ? [] : [index + 1];
});

export function scenarioIssues({ requests, seams, cuts, beforeProbe, stepRequests }: Pick<Run, "requests" | "seams" | "cuts" | "beforeProbe" | "stepRequests">, baseline: boolean) {
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

function observe(requests: RequestRow[], current: () => string, redact: (value: string) => string) {
  return (factory: DurableModelsFactory): DurableModelsFactory => async (agent, policy) => {
    const models = await factory(agent, policy);
    const stream = models.streamSimple.bind(models);
    models.streamSimple = (model, transcript, options) => {
      const serialized = JSON.stringify(transcript.messages, (_name, value: unknown) => typeof value === "string" ? redact(value) : value);
      const row: RequestRow = {
        at: new Date().toISOString(), turn: current(), messages: JSON.parse(serialized), estimate: tokens(serialized),
        cacheRetention: options?.cacheRetention ?? "default",
      };
      requests.push(row);
      async function* recorded() {
        for await (const event of stream(model, transcript, options)) {
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

const feedUrl = "/api/agents/pilot/feed?limit=200";
export async function run(ref: string, variant: "cheap" | "full" | "baseline", budget: Budget, options: {
  faux?: boolean; long?: boolean; idle?: (ms: number) => Promise<unknown>; apiKey?: string;
}) {
  const baseline = variant === "baseline";
  const data = scenario(variant === "full" ? FULL_CEILING : CHEAP_CEILING);
  const requests: RequestRow[] = [];
  const keeper: KeeperRow[] = [];
  const stepRequests: Run["stepRequests"] = [];
  let home = "";
  let turn = "";
  const redact = (value: string) => options.apiKey ? value.replaceAll(options.apiKey, "[redacted]") : value;
  const gateway = await startDurableTestGateway({
    realModel: options.faux ? undefined : { ...reference(ref), apiKey: options.apiKey, limits: variant === "full" ? undefined : {
      maxTokens: OUTPUT_CAP, ...(variant === "cheap" && { contextWindow: CHEAP_WINDOW }),
    } },
    fauxLimits: options.faux ? { contextWindow: budget.contextWindow, maxTokens: budget.maxTokens } : undefined,
    fixtureExtensions: async () => [(await import("../../session-history/index.js")).sessionHistoryExtension],
    fixture: { extension: fixture(() => home, data, step => stepRequests.push({ step, turn, request: requests.length - 1 })) },
    wrapModels: observe(requests, () => turn, redact),
    extraYaml: "toolDeferral: { enabled: false }\nretryMaxAttempts: 1" + (options.long ? "\nsandbox:\n  env: { PI_CACHE_RETENTION: long }" : ""),
  });
  home = gateway.home;
  const { MaintenanceCompletion, completeMaintenance } = await import("../../maintenance/completion.js");
  const maintenance = vi.spyOn(MaintenanceCompletion, "complete").mockImplementation(async (params) => {
    const row: KeeperRow = { at: new Date().toISOString(), estimate: tokens(params.system + params.prompt), cap: params.maxTokens };
    keeper.push(row);
    const result = options.faux ? '{"topics":[]}' : await completeMaintenance(params, { onUsage: usage => { row.usage = counts(usage); } });
    row.result = result === null ? "failed" : "ok";
    return result;
  });
  const answers: Record<string, string> = {};
  let shipmentId = "";
  const beforeProbe: number[] = [];
  const issues: string[] = [];
  let gapMs = 0;
  let gapRequest = -1;
  type Script = Parameters<typeof gateway.script>[number];
  const warm = { input: 1200, output: 20, cacheRead: 2200, cacheWrite: 0 };
  const use = (content: string) => ({ content, usage: warm });
  let seams: Run["seams"] = [];
  async function send(id: string, text: string, ...script: Script[]) {
    turn = id;
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
      // Faux exercises these two boundaries deterministically; real runs use measured provider usage.
      const input = index === data.opening.length - 2 ? Math.floor((variant === "full" ? FULL_CEILING : CHEAP_CEILING) * 0.88) : 1200;
      const usage = { input, output: 6, cacheRead: 50, cacheWrite: 50 };
      await send(opening.id, opening.text, ...(opening.id === "kiln" ? [{ content: { tool: "read_kiln", id: "initial-kiln" }, usage: warm }] : []), { content: short, usage });
    }
    const expectedReply = shipmentCode(answers.shipment ?? "");
    if (!expectedReply) issues.push("No valid reply-sourced shipment code");
    for (const index of [0, 1]) {
      if (index === 1) {
        const script = STEPS.map(step => ({ content: { tool: "record_eval_step", id: `step-${step}`, args: { step } }, usage: {
          input: step === 2 ? Math.floor(budget.ceiling * 0.62) : 2600, cacheRead: step === 3 ? 0 : 2200, output: 30,
        } }));
        await send("ledger", data.ledger, ...script, use("The ledger is sealed."));
      }
      // First relevance question opens the post-cut cache prefix before the idle check.
      await send(`topic-${index}`, data.relevance[index]!, use(index ? "Ice is less dense than liquid water." : "We see different fractions of the Moon's sunlit half."));
      if (index === 0 && !baseline) {
        const start = Date.now();
        await (options.idle ?? sleep)(IDLE_MS);
        gapMs = Date.now() - start;
        gapRequest = requests.length;
      }
      beforeProbe.push(seams.length);
      const reply = facts.map(({ id, value }) => `${id}: ${id === "shipment" ? expectedReply : id === "kiln" && index === 1 && !baseline ? "unknown" : value}`).join("\n");
      await send(`probe-${index}`, probe,
        { content: { tool: "session_history", id: `probe-history-${index}`, args: { action: "read", around: shipmentId, role: "assistant", n: 1 } },
          usage: index === 0 && !baseline ? { ...warm, cacheRead: 0 } : warm },
        { content: { tool: "read_kiln", id: `probe-kiln-${index}` }, usage: warm }, use(reply));
    }
    const cuts = breaks(requests);
    issues.push(...scenarioIssues({ requests, seams, cuts, beforeProbe, stepRequests }, baseline));
    if (requests.some(row => !row.stopped || row.stopped === "error" || row.stopped === "aborted")) issues.push("Incomplete or failed model request");
    if (!baseline && !options.faux && gapMs < IDLE_MS) issues.push("Idle gap was shorter than six minutes");
    const steps = (await fs.readFile(path.join(home, "steps.txt"), "utf8")).trim().split("\n").filter(Boolean).map(Number);
    const conversationId = await gateway.mainConversationId("local") as ConversationId | undefined;
    const journal = conversationId ? await loggedHistory(home, conversationId, data, shipmentId, redact) : { history: [], origins: {} };
    return { ...journal, budget, requests, keeper, answers, steps, stepRequests, seams, cuts, beforeProbe, gapRequest, gapMs, expectedReply, issues } satisfies Run;
  } finally {
    await gateway.close();
    maintenance.mockRestore();
  }
}

export function projection(pairs: { model: string; full: boolean; cut: Run; baseline: Run }[]) {
  const total = (run: Run) => run.requests.reduce((sum, row) => sum + row.estimate + run.budget.maxTokens, 0);
  const lines = pairs.map(({ model, full, cut, baseline }) => `${model}${full ? " --full" : ""}: cut ${total(cut)} + baseline ${total(baseline)} = ${total(cut) + total(baseline)} tokens`);
  // Batches group complete public turns: reserve one capped completion per scripted turn per run,
  // including catch-up, using one token per input byte plus system/framing room.
  const allowance = pairs.flatMap(({ cut, baseline }) => [cut, baseline]).reduce((sum, run) => sum + Object.keys(run.answers).length * 23_000, 0);
  const main = pairs.reduce((sum, { cut, baseline }) => sum + total(cut) + total(baseline), 0);
  return [...lines, `Keeper allowance: ${allowance} tokens`, `Total: ${main + allowance} tokens`].join("\n");
}
