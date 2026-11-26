import { defineDocFamily, type EntryId } from "@earendil-works/pi-durable";
import { z } from "zod";
import { oneLine } from "../history/condense.js";

const MAX_TOPICS = 32;
const MAX_REFS = 8;
const MAX_NOTE_CHARS = 600;
const MAX_TITLE_CHARS = 100;
const MAX_DRIFT = 8;
const MAX_PLAN_ITEMS = 12;
const MAX_PLAN_ITEM_CHARS = 250;

const topicKind = z.enum(["open", "decision", "digest"]);
type Topic = { id: string; kind: z.infer<typeof topicKind>; title: string; note: string; refs: string[] };
type Drift = { note: string; at: number; refs: string[] };
type Plan = { goals: string[]; nextSteps: string[]; updatedAt: number | null };
type Memory = { topics: Topic[]; drift: Drift[]; plan: Plan; through: EntryId | null };

export function emptyMemory(): Memory {
  return { topics: [], drift: [], plan: { goals: [], nextSteps: [], updatedAt: null }, through: null };
}

export const MemoryDoc = defineDocFamily<Memory, null>({
  kind: "yoplai.memory",
  family: true,
  scope: "session",
  version: 1,
  initial: emptyMemory,
  migrate(_doc, version) { throw new Error("Unsupported memory document version: " + version); },
  checkpointWhen: (_state, _ops, { deltasSinceBase }) => deltasSinceBase >= 100,
});

const planItems = z.array(z.string().trim().min(1).max(MAX_PLAN_ITEM_CHARS)).max(MAX_PLAN_ITEMS);
const planInput = z.object({ goals: planItems, nextSteps: planItems }).strict();
const planListParameter = {
  type: "array", maxItems: MAX_PLAN_ITEMS, items: { type: "string", minLength: 1, maxLength: MAX_PLAN_ITEM_CHARS },
} as const;
export const planParameters = {
  type: "object",
  properties: { goals: planListParameter, nextSteps: planListParameter },
  required: ["goals", "nextSteps"],
  additionalProperties: false,
} as const;

export function applyPlan(doc: Readonly<Memory>, input: unknown, at: number): Memory {
  return { ...doc, plan: { ...planInput.parse(input), updatedAt: at } };
}

const note = z.string().transform(oneLine).pipe(z.string().min(1));
const change = z.object({ note, refs: z.array(z.string()).default([]) });
const keeperResult = z.object({
  topics: z.array(z.union([
    change.extend({ id: z.string().min(1), kind: topicKind.optional(), title: note.optional(), resolved: z.boolean().optional() }),
    change.extend({ id: z.undefined(), kind: topicKind, title: note, resolved: z.boolean().optional() }),
  ])),
  drift: z.array(change).default([]),
});

export function applyKeeperResult(doc: Readonly<Memory>, result: unknown, knownIds: ReadonlySet<string>, at: number): Memory {
  const update = keeperResult.parse(result);
  const topics = new Map(doc.topics.map((topic) => [topic.id, topic]));
  const publicRefs = (refs: string[]) => [...new Set(refs.filter((ref) => knownIds.has(ref)))].slice(-MAX_REFS);
  const changed = new Set<string>();
  let sequence = 1;
  for (const change of update.topics) {
    if (change.id !== undefined) {
      const existing = topics.get(change.id);
      if (!existing) continue;
      topics.set(existing.id, {
        id: existing.id,
        kind: existing.kind === "open" && change.resolved ? "decision" : change.kind ?? existing.kind,
        title: change.title?.slice(0, MAX_TITLE_CHARS) ?? existing.title,
        note: change.note.slice(0, MAX_NOTE_CHARS),
        refs: publicRefs([...existing.refs, ...change.refs]),
      });
      changed.add(existing.id);
    } else {
      while (topics.has("t_" + sequence)) sequence++;
      const id = "t_" + sequence++;
      topics.set(id, {
        id, kind: change.kind, title: change.title.slice(0, MAX_TITLE_CHARS),
        note: change.note.slice(0, MAX_NOTE_CHARS), refs: publicRefs(change.refs),
      });
      changed.add(id);
    }
  }
  const drift = [...doc.drift, ...update.drift.map(({ note, refs }) => ({
    note: note.slice(0, MAX_NOTE_CHARS), at, refs: publicRefs(refs),
  }))].slice(-MAX_DRIFT);
  const ordered = [...topics.values()].sort((a, b) =>
    Number(a.kind === "digest") - Number(b.kind === "digest") || Number(changed.has(b.id)) - Number(changed.has(a.id)));
  return { ...doc, topics: ordered.slice(0, MAX_TOPICS), drift };
}

export function renderMemory(doc: Readonly<Memory>, maxChars: number): string | undefined {
  const cite = (refs: string[]) => refs.length ? " (refs: " + refs.join(", ") + ")" : "";
  const labels = { open: "Open", decision: "Decision", digest: "Digest" };
  const topicLine = ({ kind, title, note, refs }: Topic) =>
    "- " + labels[kind] + ": " + oneLine(title) + ": " + oneLine(note) + cite(refs);
  const lines = [
    ...doc.topics.filter(({ kind }) => kind !== "digest").map(topicLine),
    ...doc.plan.goals.map((goal) => "- Goal: " + oneLine(goal)),
    ...doc.plan.nextSteps.map((step) => "- Next step: " + oneLine(step)),
    ...doc.drift.map(({ note, refs }) => "- Drift: " + oneLine(note) + cite(refs)),
    ...doc.topics.filter(({ kind }) => kind === "digest").map(topicLine),
  ];
  let text = "";
  for (const line of lines) {
    const next = text ? text + "\n" + line : line;
    if (next.length > maxChars) break;
    text = next;
  }
  return text || undefined;
}
