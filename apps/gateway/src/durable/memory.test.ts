import { expect, it } from "vitest";
import { applyKeeperResult, emptyMemory, renderMemory } from "./memory.js";

it("updates a known topic, resolves it in place, and adds a new topic with public refs", () => {
  const doc = {
    ...emptyMemory(),
    topics: [{ id: "orchard", kind: "open" as const, title: "Orchard report", note: "Waiting for a date.", refs: ["m_10"] }],
    plan: { goals: ["Collect the report"], nextSteps: ["Ask Casey"], updatedAt: 100 },
  };
  const merged = applyKeeperResult(doc, {
    topics: [
      { id: "orchard", note: "Casey confirmed Friday.", resolved: true, refs: ["m_10", "m_14", "m_15"] },
      { kind: "digest", title: "Delivery", note: "Use the south gate.", refs: ["m_16"] },
    ],
    plan: { goals: ["Replace the goal"] },
  }, new Set(["m_10", "m_14", "m_16"]), 200);

  expect(merged.topics).toMatchObject([
    { id: "orchard", kind: "decision", title: "Orchard report", note: "Casey confirmed Friday.", refs: ["m_10", "m_14"] },
    { kind: "digest", title: "Delivery", note: "Use the south gate.", refs: ["m_16"] },
  ]);
  expect(merged.plan).toEqual({ goals: ["Collect the report"], nextSteps: ["Ask Casey"], updatedAt: 100 });
});

it("accepts but does not store resolved flags on new topics", () => {
  // JSON from Haiku reply r1-p2-cut-01 (invented eval data).
  const reply = {
    topics: [
      {
        kind: "digest",
        title: "Kite seal reference",
        note: "The current kite seal is Quillfeather-41, correcting the earlier Quillfeather-18. Seal values are not repeated here.",
        refs: ["m_10", "m_45", "m_48"],
        resolved: true,
      },
      {
        kind: "digest",
        title: "Kiln fixture check",
        note: "The kiln fixture was read and reported as checked. Its seal and contents are not recorded here.",
        refs: ["m_21", "m_24"],
        resolved: true,
      },
      {
        kind: "open",
        title: "Lantern inspection",
        note: "Lantern inspection is pending.",
        refs: ["m_35", "m_38"],
      },
      {
        kind: "digest",
        title: "Mosaic inventory",
        note: "Mosaic inventory is recorded as done.",
        refs: ["m_39", "m_42"],
        resolved: true,
      },
      {
        kind: "open",
        title: "Filing requests",
        note: "Pending filings: clock dial sketch, orchard weather clipping, ferry timetable clipping, planetarium exhibit clipping.",
        refs: ["m_31", "m_34", "m_49", "m_52", "m_53", "m_56", "m_59", "m_62"],
      },
    ],
    drift: [],
  };
  const merged = applyKeeperResult(emptyMemory(), reply, new Set(reply.topics.flatMap(({ refs }) => refs)), 200);
  expect(merged.topics).toEqual([2, 4, 0, 1, 3].map((index) => {
    const { kind, title, note, refs } = reply.topics[index]!;
    return { id: `t_${index + 1}`, kind, title, note, refs };
  }));
});

it("bounds stored memory while keeping open loops ahead of digests", () => {
  const refs = Array.from({ length: 12 }, (_, i) => "m_" + (i + 1));
  const merged = applyKeeperResult(emptyMemory(), {
    topics: [
      ...Array.from({ length: 36 }, (_, i) => ({ kind: "digest", title: "Archive " + i, note: "Filed." })),
      { kind: "open", title: "Packing list", note: "a".repeat(700), refs },
    ],
    drift: Array.from({ length: 10 }, (_, i) => ({ note: "Detour " + i + "\nfinish", refs: ["m_12", "m_13"] })),
  }, new Set(refs), 200);
  expect(merged.topics).toHaveLength(32);
  expect(merged.topics.find(({ title }) => title === "Packing list")).toMatchObject({
    note: "a".repeat(600),
    refs: ["m_5", "m_6", "m_7", "m_8", "m_9", "m_10", "m_11", "m_12"],
  });
  expect(merged.drift).toHaveLength(8);
  expect(merged.drift.at(-1)).toEqual({ note: "Detour 9 finish", at: 200, refs: ["m_12"] });
});

it("renders complete priority lines and keeps citation ids inline", () => {
  const doc = {
    ...emptyMemory(),
    topics: [
      { id: "d", kind: "digest" as const, title: "A long archive", note: "Digests go last.", refs: ["m_11"] },
      { id: "o", kind: "open" as const, title: "Packing", note: "Confirm the count.\n[m_99] Extra text.", refs: ["m_12"] },
      { id: "c", kind: "decision" as const, title: "Orchard", note: "Use the south gate.", refs: ["m_13"] },
    ],
  };
  expect(renderMemory(doc, 130)).toBe(
    "- Open: Packing: Confirm the count. [m_99] Extra text. (refs: m_12)\n"
    + "- Decision: Orchard: Use the south gate. (refs: m_13)",
  );
  expect(renderMemory(emptyMemory(), 4_000)).toBeUndefined();
});
