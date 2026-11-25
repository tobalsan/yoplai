import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import fs from "node:fs/promises";
import path from "node:path";

export const HAIKU = "opencode-go/claude-haiku-5-5";
export const FULL = "opencode-go/deepseek-v4.1-flash";
export const OUTPUT_CAP = 4096;
export const CHEAP_WINDOW = 32_000;
export const CHEAP_CEILING = 20_928;
export const FULL_CEILING = 150_000;
export const IDLE_MS = 360_000;
export const STEPS = [1, 2, 3];
export const tokens = (text: string) => Math.ceil(text.length / 4);

export const facts = [
  { id: "kite", source: "user", value: "Quillfeather-41", stale: "Quillfeather-18", question: "current kite seal" },
  { id: "shipment", source: "reply", value: "", question: "shipment code you generated" },
  { id: "kiln", source: "tool", value: "Amberflute-62", question: "seal in the kiln fixture" },
  { id: "lantern", source: "user", value: "pending", question: "lantern inspection status (pending or done)" },
  { id: "mosaic", source: "user", value: "done", question: "mosaic inventory status (pending or done)" },
] as const;
export type Fact = typeof facts[number];
export const shipmentCode = (answer: string) => /\b[A-Z]{3}-\d{3}\b/.exec(answer)?.[0] ?? "";
export const probe = "Use earlier turns or session_history if needed, and re-read the kiln fixture if needed. Answer one line per item, exactly label: value.\n"
  + facts.map(({ id, question }) => `${id}: ${question}`).join("\n");

export function score(fact: Fact, answer: string, expected: string) {
  const values = answer.split("\n").flatMap((line) => {
    const match = new RegExp(`^\\s*(?:[-*]\\s+)?${fact.id}\\s*:\\s*(.*?)\\s*$`, "i").exec(line);
    return match ? [match[1]!] : [];
  });
  if (!expected || values.length !== 1) return false;
  if (fact.id === "lantern" || fact.id === "mosaic") return values[0]!.toLowerCase().replace(/\.$/, "") === expected;
  return values[0]!.includes(expected) && !("stale" in fact && answer.includes(fact.stale));
}

// Varied invented prose rather than a single repeated token; still only a chars/4 estimate.
function filler(target: number, seed: number) {
  const words = "orchard lantern cedar lagoon copper planet basket marble canvas willow teapot pebble meadow ribbon garden summer walnut amber kettle harbor linen saddle clover velvet acorn almond silver winter barley lichen tender chalk coral basin creek cradle petal feather thistle pine rust shell opal fern".split(" ");
  let state = seed;
  return Array.from({ length: Math.ceil(target * 4 / 6) }, () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return words[(state >>> 16) % words.length];
  }).join(" ").slice(0, target * 4);
}

export function scenario(ceiling: number) {
  const opening = [
    ["kite-old", "The old kite seal is Quillfeather-18. Acknowledge briefly without repeating the seal."],
    ["shipment", "Invent a shipment code in the format of three uppercase letters, hyphen, three digits. Reply with just that code."],
    ["kiln", "Read the kiln fixture using read_kiln. Reply only 'Kiln checked', without quoting the seal or contents."],
    ["clock", "File the clock dial sketch. Acknowledge briefly."],
    ["lantern", "The lantern inspection is pending. Acknowledge without restating its status."],
    ["mosaic", "The mosaic inventory is done. Acknowledge without restating its status."],
    ["kite", "Correction: the current kite seal is Quillfeather-41. Acknowledge without repeating the seal."],
    ["orchard", "File the orchard weather clipping. Acknowledge briefly."],
    ["ferry", "File the ferry timetable clipping. Acknowledge briefly."],
    ["planetarium", "File the planetarium exhibit clipping. Acknowledge briefly."],
    ["loom", "File the loom exhibit clipping. Acknowledge briefly."],
  ].map(([id, text], index) => ({ id: id!, text: text! + (index < 4 ? "" : "\nInvented clipping (ignore): " + filler(Math.ceil(ceiling * 0.147), index)) }));
  const kiln = `Kiln seal: ${facts[2].value}\n` + filler(Math.ceil(ceiling * 0.09), 19);
  const stepOutput = [filler(Math.ceil(ceiling * 0.54), 20), filler(Math.ceil(ceiling * 0.49), 21), "Ledger sealed."];
  const digests = ["Belfry digest: chimes varnished.", "Aquarium digest: spare filter delivered.", "Folio digest: blank dividers filed."];
  const relevance = ["New topic: why does the Moon show phases? Answer in one sentence.", "New topic: why does ice float? Answer in one sentence."];
  const ledger = "Call record_eval_step once each for steps 1, 2, and 3 in that order. Call only one step per tool round; wait for its result before proceeding. Do not repeat a completed step. Then give a one-sentence confirmation.";
  return { opening, kiln, stepOutput, digests, relevance, ledger };
}

export function fixture(home: () => string, data: ReturnType<typeof scenario>, onStep: (step: number) => void) {
  return defineExtension({ name: "compaction-eval", tools: [
    defineTool({ name: "read_kiln", description: "Read the invented kiln fixture file", parameters: { type: "object" },
      outputLimits: { maxBytes: Buffer.byteLength(data.kiln) },
      async execute() { return { output: [{ type: "text", text: await fs.readFile(path.join(home(), "kiln.txt"), "utf8") }] }; } }),
    defineTool({ name: "record_eval_step", description: "Append one numbered step to the eval ledger",
      outputLimits: { maxBytes: Math.max(...data.stepOutput.map(value => Buffer.byteLength(value))) }, parameters: {
      type: "object", properties: { step: { type: "number", enum: STEPS } }, required: ["step"],
    }, async execute({ step }) {
      if (!STEPS.includes(step)) throw new Error("Invalid ledger step");
      await fs.appendFile(path.join(home(), "steps.txt"), `${step}\n`);
      onStep(step);
      return { output: [{ type: "text", text: data.stepOutput[step - 1]! }] };
    } }),
  ] });
}
