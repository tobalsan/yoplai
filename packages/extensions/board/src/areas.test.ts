import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  scanAreaSummaries,
  toggleAreaHidden,
  updateLoopEntry,
  parseLoopEntries,
  splitEntryContent,
} from "./areas.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "areas-test-"));
  await fs.mkdir(path.join(tmpDir, ".areas"), { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeArea(id: string, yaml: string, loop?: string) {
  const areasDir = path.join(tmpDir, ".areas");
  await fs.writeFile(path.join(areasDir, `${id}.yaml`), yaml, "utf-8");
  if (loop !== undefined) {
    await fs.writeFile(path.join(areasDir, `${id}.loop.md`), loop, "utf-8");
  }
}

async function readLoop(id: string): Promise<string> {
  return fs.readFile(path.join(tmpDir, ".areas", `${id}.loop.md`), "utf-8");
}

// ── parseLoopEntries ────────────────────────────────────────────────

describe("parseLoopEntries", () => {
  it("parses dated entries", () => {
    const raw = `# Test

[[2026-04-10]]
- Did thing A
- Did thing B

[[2026-04-11]]
- Did thing C

Next:
- Do thing D
`;
    const entries = parseLoopEntries(raw);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.date).toBe("2026-04-10");
    expect(entries[0]!.body).toContain("Did thing A");
    expect(entries[1]!.date).toBe("2026-04-11");
    expect(entries[1]!.body).toContain("Did thing C");
    expect(entries[1]!.body).toContain("Next:");
  });

  it("handles text on the same line as date", () => {
    const raw = `[[2026-04-07]] Skipped today.\n`;
    const entries = parseLoopEntries(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.body).toBe("Skipped today.");
  });

  it("returns empty for no dated entries", () => {
    const raw = `# Just a title\nSome notes\n`;
    expect(parseLoopEntries(raw)).toEqual([]);
  });
});

// ── splitEntryContent ───────────────────────────────────────────────

describe("splitEntryContent", () => {
  it("splits on 'Next:'", () => {
    const result = splitEntryContent("- Did A\n- Did B\n\nNext:\n- Do C");
    expect(result.recentlyDone).toBe("- Did A\n- Did B");
    expect(result.whatsNext).toBe("- Do C");
  });

  it("handles 'Next is to' variant", () => {
    const result = splitEntryContent("Did stuff.\n\nNext is to do more stuff.");
    expect(result.recentlyDone).toBe("Did stuff.");
    expect(result.whatsNext).toBe("to do more stuff.");
  });

  it("handles 'Todo next:' variant", () => {
    const result = splitEntryContent("Done.\n\nTodo next:\n- item");
    expect(result.recentlyDone).toBe("Done.");
    expect(result.whatsNext).toBe("- item");
  });

  it("returns all as done when no Next line", () => {
    const result = splitEntryContent("- Did A\n- Did B");
    expect(result.recentlyDone).toBe("- Did A\n- Did B");
    expect(result.whatsNext).toBe("");
  });

  it("handles empty body", () => {
    const result = splitEntryContent("");
    expect(result.recentlyDone).toBe("");
    expect(result.whatsNext).toBe("");
  });
});

// ── scanAreaSummaries ───────────────────────────────────────────────

describe("scanAreaSummaries", () => {
  it("returns empty array when .areas dir missing", async () => {
    const result = await scanAreaSummaries("/nonexistent/path");
    expect(result).toEqual([]);
  });

  it("returns empty array when .areas has no yaml files", async () => {
    const result = await scanAreaSummaries(tmpDir);
    expect(result).toEqual([]);
  });

  it("reads area config without loop file", async () => {
    await writeArea(
      "yoplai",
      "id: yoplai\ntitle: Yoplai\ncolor: '#3b8ecc'\norder: 1\n",
    );

    const result = await scanAreaSummaries(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "yoplai",
      title: "Yoplai",
      color: "#3b8ecc",
      order: 1,
      recentlyDone: "",
      whatsNext: "",
    });
  });

  it("extracts latest entry from dated loop file", async () => {
    await writeArea(
      "yoplai",
      "id: yoplai\ntitle: Yoplai\ncolor: '#3b8ecc'\norder: 1\n",
      `# Yoplai

[[2026-04-25]]
- Old stuff

Next:
- Old plans

[[2026-04-26]]
- Shipped board projects tab
- Fixed CLI build error

Next:
- Area summaries feature
`,
    );

    const result = await scanAreaSummaries(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0]!.recentlyDone).toContain("Shipped board projects tab");
    expect(result[0]!.recentlyDone).not.toContain("Old stuff");
    expect(result[0]!.whatsNext).toContain("Area summaries feature");
    expect(result[0]!.whatsNext).not.toContain("Old plans");
  });

  it("sorts by order then title", async () => {
    await writeArea("ranksource", "id: ranksource\ntitle: Ranksource\ncolor: '#cc6b3b'\norder: 2\n");
    await writeArea("yoplai", "id: yoplai\ntitle: Yoplai\ncolor: '#3b8ecc'\norder: 1\n");
    await writeArea("cloudifai", "id: cloudifai\ntitle: Cloudifai\ncolor: '#FFE100'\norder: 3\n");

    const result = await scanAreaSummaries(tmpDir);
    expect(result.map((a) => a.id)).toEqual(["yoplai", "ranksource", "cloudifai"]);
  });

  it("uses defaults for missing config fields", async () => {
    await writeArea("mystery", "id: mystery\n");

    const result = await scanAreaSummaries(tmpDir);
    expect(result[0]).toMatchObject({
      id: "mystery",
      title: "mystery",
      color: "#6b7280",
      order: 999,
    });
  });

  it("reads hidden flag from yaml", async () => {
    await writeArea("stale", "id: stale\ntitle: Stale\ncolor: '#999'\nhidden: true\n");
    await writeArea("active", "id: active\ntitle: Active\ncolor: '#0f0'\n");

    const result = await scanAreaSummaries(tmpDir);
    expect(result.find((a) => a.id === "stale")!.hidden).toBe(true);
    expect(result.find((a) => a.id === "active")!.hidden).toBe(false);
  });

  it("skips areas with unreadable yaml", async () => {
    const areasDir = path.join(tmpDir, ".areas");
    await fs.mkdir(path.join(areasDir, "bad.yaml"), { recursive: true });
    await writeArea("good", "id: good\ntitle: Good\ncolor: '#000'\n");

    const result = await scanAreaSummaries(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("good");
  });
});

// ── toggleAreaHidden ────────────────────────────────────────────────

describe("toggleAreaHidden", () => {
  it("sets hidden: true on an area", async () => {
    await writeArea("test", "id: test\ntitle: Test\ncolor: '#fff'\n");
    await toggleAreaHidden(tmpDir, "test", true);

    const result = await scanAreaSummaries(tmpDir);
    expect(result[0]!.hidden).toBe(true);
  });

  it("removes hidden when set to false", async () => {
    await writeArea("test", "id: test\ntitle: Test\ncolor: '#fff'\nhidden: true\n");
    await toggleAreaHidden(tmpDir, "test", false);

    const result = await scanAreaSummaries(tmpDir);
    expect(result[0]!.hidden).toBe(false);

    const raw = await fs.readFile(path.join(tmpDir, ".areas", "test.yaml"), "utf-8");
    expect(raw).not.toContain("hidden");
  });

  it("throws for missing area", async () => {
    await expect(toggleAreaHidden(tmpDir, "nope", true)).rejects.toThrow(
      "Area config not found",
    );
  });
});

// ── updateLoopEntry ─────────────────────────────────────────────────

describe("updateLoopEntry", () => {
  it("creates loop file if none exists", async () => {
    await writeArea("fresh", "id: fresh\ntitle: Fresh Area\ncolor: '#0f0'\n");
    await updateLoopEntry(tmpDir, "fresh", "2026-04-27", "- Did something\n\nNext:\n- Do more");

    const raw = await readLoop("fresh");
    expect(raw).toContain("# Fresh Area");
    expect(raw).toContain("[[2026-04-27]]");
    expect(raw).toContain("- Did something");
    expect(raw).toContain("Next:");
  });

  it("appends new entry to existing loop", async () => {
    await writeArea(
      "test",
      "id: test\ntitle: Test\ncolor: '#fff'\n",
      `# Test

[[2026-04-26]]
- Old entry
`,
    );

    await updateLoopEntry(tmpDir, "test", "2026-04-27", "- New entry\n\nNext:\n- Future");
    const raw = await readLoop("test");

    expect(raw).toContain("[[2026-04-26]]");
    expect(raw).toContain("- Old entry");
    expect(raw).toContain("[[2026-04-27]]");
    expect(raw).toContain("- New entry");
  });

  it("replaces today's entry idempotently", async () => {
    await writeArea(
      "test",
      "id: test\ntitle: Test\ncolor: '#fff'\n",
      `# Test

[[2026-04-27]]
- First version
`,
    );

    await updateLoopEntry(tmpDir, "test", "2026-04-27", "- Updated version");
    const raw = await readLoop("test");

    expect(raw).not.toContain("First version");
    expect(raw).toContain("- Updated version");
    // Should only have one [[2026-04-27]] entry
    expect(raw.match(/\[\[2026-04-27\]\]/g)).toHaveLength(1);
  });

  it("replaces today when it's between other entries", async () => {
    await writeArea(
      "test",
      "id: test\ntitle: Test\ncolor: '#fff'\n",
      `# Test

[[2026-04-25]]
- Day 25

[[2026-04-26]]
- Day 26 original

[[2026-04-27]]
- Day 27
`,
    );

    await updateLoopEntry(tmpDir, "test", "2026-04-26", "- Day 26 updated");
    const raw = await readLoop("test");

    expect(raw).toContain("- Day 25");
    expect(raw).toContain("- Day 26 updated");
    expect(raw).not.toContain("Day 26 original");
    expect(raw).toContain("- Day 27");
  });

  it("preserves display when re-scanning after update", async () => {
    await writeArea("test", "id: test\ntitle: Test\ncolor: '#fff'\n");
    await updateLoopEntry(tmpDir, "test", "2026-04-27", "- Done stuff\n\nNext:\n- Plan stuff");

    const summaries = await scanAreaSummaries(tmpDir);
    expect(summaries[0]!.recentlyDone).toContain("Done stuff");
    expect(summaries[0]!.whatsNext).toContain("Plan stuff");
  });
});
