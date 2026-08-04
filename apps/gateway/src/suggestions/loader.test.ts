import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSuggestions } from "./loader.js";

const dirs: string[] = [];

async function workspace() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-suggestions-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true })));
});

describe("loadSuggestions", () => {
  it("returns an empty list for missing or malformed files", async () => {
    const dir = await workspace();
    await expect(loadSuggestions(dir)).resolves.toEqual([]);
    await fs.writeFile(path.join(dir, "suggestions.yaml"), "[not valid");
    await expect(loadSuggestions(dir)).resolves.toEqual([]);
  });

  it("keeps valid entries and drops invalid entries", async () => {
    const dir = await workspace();
    await fs.writeFile(
      path.join(dir, "suggestions.yaml"),
      "- title: Plan work\n  prompt: Plan this work\n- title: Missing prompt\n- title: ''\n  prompt: Empty title\n"
    );

    await expect(loadSuggestions(dir)).resolves.toEqual([
      { title: "Plan work", prompt: "Plan this work" },
    ]);
  });
});
