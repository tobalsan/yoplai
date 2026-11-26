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
  return values[0] === expected && !("stale" in fact && answer.includes(fact.stale));
}

const clippings = [
  "The librarian tucked a folded map into the back of the atlas.",
  "A blue bench stood beside the ticket window at the old station.",
  "The bookbinder left a stack of plain covers on the workbench.",
  "A brass hook held the curtain open beside the shop doorway.",
  "Afternoon light fell across the tiled steps of the reading room.",
  "The gallery opened early so visitors could sketch the chairs.",
  "A striped scarf hung on the wooden peg nearest the front door.",
  "The tailor moved the small mirror closer to the fitting room.",
  "The corner shop displayed a new set of cups in the window.",
  "The tram stopped beside the plaza where the stone fountain stood.",
  "A clerk laid the spare notebooks beside the register.",
  "The carpenter set a low stool near the window to dry.",
];

export function filler(chars: number, seed: number) {
  let state = seed;
  let text = "";
  while (text.length < chars) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const sentence = clippings[(state >>> 16) % clippings.length]!;
    const next = text ? " " + sentence : sentence;
    if (text.length + next.length > chars) break;
    text += next;
  }
  // Fill the remainder without truncating a sentence.
  return text.padEnd(chars);
}

export function scenario() {
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
  ].map(([id, text]) => ({ id: id!, text: text! }));
  const kiln = `Kiln seal: ${facts[2].value}\n` + filler(2_000, 19);
  const digests = ["Belfry digest: chimes varnished.", "Aquarium digest: spare filter delivered.", "Folio digest: blank dividers filed."];
  const relevance = ["New topic: why does the Moon show phases? Answer in one sentence.", "New topic: why does ice float? Answer in one sentence."];
  const ledger = "Complete all three ledger steps in this turn without asking for confirmation between steps. Call record_eval_step once for each of steps 1, 2, and 3 in order. After each tool result, proceed directly to the next step in a separate tool call. Do not repeat a completed step. After step 3, give a one-sentence confirmation.";
  return { opening, kiln, digests, relevance, ledger };
}

export function fixture(home: () => string, data: ReturnType<typeof scenario>, stepResultChars: (step: number) => number) {
  return defineExtension({ name: "compaction-eval", tools: [
    defineTool({ name: "read_kiln", description: "Read the invented kiln fixture file", parameters: { type: "object" },
      outputLimits: { maxBytes: Buffer.byteLength(data.kiln) },
      async execute() { return { output: [{ type: "text", text: await fs.readFile(path.join(home(), "kiln.txt"), "utf8") }] }; } }),
    defineTool({ name: "record_eval_step", description: "Append one numbered step to the eval ledger",
      outputLimits: { maxBytes: FULL_CEILING * 2 }, parameters: {
      type: "object", properties: { step: { type: "number", enum: STEPS } }, required: ["step"],
    }, async execute({ step }) {
      if (!STEPS.includes(step)) throw new Error("Invalid ledger step");
      await fs.appendFile(path.join(home(), "steps.txt"), `${step}\n`);
      const chars = stepResultChars(step);
      const status = step === 3 ? "Step 3 recorded. All steps done." : `Step ${step} recorded in the ledger. Next: step ${step + 1}.`;
      const prefix = `${status}\n--- attached step log (no action needed) ---\n`;
      // Include the status and label in the driver’s existing result budget.
      const text = chars > prefix.length ? prefix + filler(chars - prefix.length, 20 + step) : status;
      return { output: [{ type: "text", text }] };
    } }),
  ] });
}
