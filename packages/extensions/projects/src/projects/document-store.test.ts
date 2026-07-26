import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import os from "node:os";
import {
  appendThreadEntry,
  assertCanClearProjectRepo,
  assertSliceRepoInvariant,
  deleteThreadEntry,
  formatMarkdown,
  formatThreadFrontmatter,
  parseThread,
  regenerateScopeMap,
  renderScopeMap,
  shouldAutoMarkProjectDone,
  updateThreadEntry,
  validateProjectStatus,
} from "./document-store.js";

describe("project document store", () => {
  let tmpDir: string;
  let projectDir: string;
  let repoDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-doc-store-"));
    projectDir = path.join(tmpDir, "PRO-7_docs");
    repoDir = path.join(tmpDir, "repo");
    await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });
    await fs.mkdir(projectDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("validates project lifecycle statuses and normalizes legacy statuses", () => {
    expect(validateProjectStatus(" active ")).toBe("active");
    expect(validateProjectStatus("triage")).toBe("triage");
    expect(validateProjectStatus("ready_to_merge")).toBe("ready_to_merge");
    expect(validateProjectStatus("shaping:repo")).toBe("shaping:repo");
    expect(validateProjectStatus(undefined)).toBeNull();
    expect(validateProjectStatus("todo")).toBe("active");
    expect(validateProjectStatus("maybe")).toBe("triage");
    expect(() => validateProjectStatus("unknown")).toThrow(
      "Invalid project status"
    );
  });

  it("parses, updates, and deletes thread entries", () => {
    const first = appendThreadEntry("", "PRO-7", {
      author: "Alice",
      date: "2026-01-01",
      body: "First",
    });
    const second = appendThreadEntry(first, "PRO-7", {
      author: "Bob",
      date: "2026-01-02",
      body: "Second",
    });

    expect(parseThread(second)).toEqual([
      { author: "Alice", date: "2026-01-01", body: "First" },
      { author: "Bob", date: "2026-01-02", body: "Second" },
    ]);

    const updated = updateThreadEntry(second, "PRO-7", 0, "Updated");
    expect(updated.entry).toEqual({
      author: "Alice",
      date: "2026-01-01",
      body: "Updated",
    });
    expect(parseThread(updated.next)[0]?.body).toBe("Updated");

    const deleted = deleteThreadEntry(updated.next, "PRO-7", 1);
    expect(parseThread(deleted)).toHaveLength(1);
  });

  it("enforces slice repo inheritance invariant", async () => {
    await fs.writeFile(
      path.join(projectDir, "README.md"),
      formatMarkdown({ id: "PRO-7", title: "No Repo", status: "active" }, ""),
      "utf8"
    );

    await expect(
      assertSliceRepoInvariant(projectDir, { project_id: "PRO-7" }, "create")
    ).rejects.toThrow("Cannot create slice");

    await expect(
      assertSliceRepoInvariant(
        projectDir,
        { project_id: "PRO-7", repo: repoDir },
        "create"
      )
    ).resolves.toBeUndefined();
  });

  it("blocks clearing a project repo while slices depend on it", () => {
    expect(() =>
      assertCanClearProjectRepo([
        { id: "PRO-7-S01", frontmatter: {} },
        { id: "PRO-7-S02", frontmatter: { repo: repoDir } },
      ])
    ).toThrow("PRO-7-S01");
  });

  it("renders and regenerates generated scope maps", async () => {
    await fs.mkdir(path.join(projectDir, "slices", "PRO-7-S02"), {
      recursive: true,
    });
    await fs.mkdir(path.join(projectDir, "slices", "PRO-7-S01"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(projectDir, "slices", "PRO-7-S02", "README.md"),
      formatMarkdown(
        {
          id: "PRO-7-S02",
          title: "Second",
          status: "done",
          hill_position: "done",
        },
        ""
      ),
      "utf8"
    );
    await fs.writeFile(
      path.join(projectDir, "slices", "PRO-7-S01", "README.md"),
      formatMarkdown(
        {
          id: "PRO-7-S01",
          title: "First",
          status: "todo",
          hill_position: "figuring",
        },
        ""
      ),
      "utf8"
    );

    expect(
      renderScopeMap("PRO-7", [
        {
          id: "PRO-7-S03",
          title: "A | B",
          status: "todo",
          hillPosition: "figuring",
        },
      ])
    ).toContain("A \\| B");

    await regenerateScopeMap(projectDir, "PRO-7");
    const scopeMap = await fs.readFile(
      path.join(projectDir, "SCOPE_MAP.md"),
      "utf8"
    );
    expect(scopeMap.indexOf("PRO-7-S01")).toBeLessThan(
      scopeMap.indexOf("PRO-7-S02")
    );
  });

  it("centralizes project auto-done lifecycle check", () => {
    expect(
      shouldAutoMarkProjectDone("active", [
        { frontmatter: { status: "done" } },
        { frontmatter: { status: "cancelled" } },
      ])
    ).toBe(true);
    expect(
      shouldAutoMarkProjectDone("active", [
        { frontmatter: { status: "cancelled" } },
      ])
    ).toBe(false);
    expect(shouldAutoMarkProjectDone("shaping", [])).toBe(false);
  });

  it("formats project thread frontmatter", () => {
    expect(formatThreadFrontmatter("PRO-7")).toBe("---\nproject: PRO-7\n---\n");
  });
});
