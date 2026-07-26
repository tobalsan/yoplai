import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import os from "node:os";
import {
  createSlice,
  getSlice,
  updateSlice,
  readSliceCounters,
  regenerateScopeMap,
} from "./slices.js";

describe("slice storage primitives", () => {
  let tmpDir: string;
  let projectDir: string;
  let repoDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-slices-"));
    projectDir = path.join(tmpDir, "PRO-238_auth-flow");
    repoDir = path.join(tmpDir, "repo");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(projectDir, "README.md"),
      `---\nid: "PRO-238"\ntitle: "Auth Flow"\nstatus: "active"\nrepo: "${repoDir}"\n---\n`,
      "utf8"
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("creates slices dir and counters on first create", async () => {
    const created = await createSlice(projectDir, {
      projectId: "PRO-238",
      title: "Auth flow",
    });

    expect(created.id).toBe("PRO-238-S01");
    await expect(
      fs.stat(path.join(projectDir, "slices", "PRO-238-S01"))
    ).resolves.toBeDefined();

    const counters = await readSliceCounters(projectDir);
    expect(counters.lastSliceId).toBe(1);

    const countersRaw = await fs.readFile(
      path.join(projectDir, ".meta", "counters.json"),
      "utf8"
    );
    expect(JSON.parse(countersRaw)).toEqual({ lastSliceId: 1 });
  });

  it("allocates IDs per-project and persists counter", async () => {
    const first = await createSlice(projectDir, {
      projectId: "PRO-238",
      title: "Auth",
    });
    const second = await createSlice(projectDir, {
      projectId: "PRO-238",
      title: "Settings",
    });

    expect(first.id).toBe("PRO-238-S01");
    expect(second.id).toBe("PRO-238-S02");
    expect((await readSliceCounters(projectDir)).lastSliceId).toBe(2);
  });

  it("seeds missing counter from max slice id already on disk", async () => {
    for (const [id, title] of [
      ["PRO-238-S01", "First"],
      ["PRO-238-S02", "Second"],
      ["PRO-238-S03", "Third"],
    ]) {
      await createSlice(projectDir, {
        projectId: "PRO-238",
        sliceId: id,
        title,
        status: "done",
      });
    }

    await fs.rm(path.join(projectDir, ".meta", "counters.json"), {
      force: true,
    });

    const created = await createSlice(projectDir, {
      projectId: "PRO-238",
      title: "Fourth",
    });

    expect(created.id).toBe("PRO-238-S04");
    expect((await readSliceCounters(projectDir)).lastSliceId).toBe(4);
    const third = await getSlice(projectDir, "PRO-238-S03");
    expect(third.frontmatter.title).toBe("Third");
  });

  it("seeds missing counter from archived slice dirs under slices", async () => {
    await createSlice(projectDir, {
      projectId: "PRO-238",
      sliceId: "PRO-238-S03",
      title: "Archived",
      status: "done",
    });
    await fs.mkdir(path.join(projectDir, "slices", ".done"), {
      recursive: true,
    });
    await fs.rename(
      path.join(projectDir, "slices", "PRO-238-S03"),
      path.join(projectDir, "slices", ".done", "PRO-238-S03")
    );
    await fs.rm(path.join(projectDir, ".meta", "counters.json"), {
      force: true,
    });

    const created = await createSlice(projectDir, {
      projectId: "PRO-238",
      title: "Next",
    });

    expect(created.id).toBe("PRO-238-S04");
    expect((await readSliceCounters(projectDir)).lastSliceId).toBe(4);
  });

  it("rejects direct duplicate slice id creation without overwriting", async () => {
    await createSlice(projectDir, {
      projectId: "PRO-238",
      sliceId: "PRO-238-S03",
      title: "Original",
      readme: "## Original\n",
    });

    await expect(
      createSlice(projectDir, {
        projectId: "PRO-238",
        sliceId: "PRO-238-S03",
        title: "Duplicate",
        readme: "## Duplicate\n",
      })
    ).rejects.toThrow("Slice id already assigned: PRO-238-S03");

    const original = await getSlice(projectDir, "PRO-238-S03");
    expect(original.frontmatter.title).toBe("Original");
    expect(original.docs.readme).toBe("## Original\n");
  });

  it("rejects direct reuse of a previously assigned slice id after folder removal", async () => {
    await createSlice(projectDir, {
      projectId: "PRO-238",
      sliceId: "PRO-238-S03",
      title: "Original",
    });
    await fs.rm(path.join(projectDir, "slices", "PRO-238-S03"), {
      recursive: true,
      force: true,
    });

    await expect(
      createSlice(projectDir, {
        projectId: "PRO-238",
        sliceId: "PRO-238-S03",
        title: "Duplicate",
      })
    ).rejects.toThrow("Slice id already assigned: PRO-238-S03");

    const created = await createSlice(projectDir, {
      projectId: "PRO-238",
      title: "Next",
    });
    expect(created.id).toBe("PRO-238-S04");
  });

  it("round-trips frontmatter without loss on update", async () => {
    const created = await createSlice(projectDir, {
      projectId: "PRO-238",
      title: "Auth",
    });

    const escaped = 'A "quote" with \\ slash and \n newline';
    const updated = await updateSlice(projectDir, created.id, {
      frontmatter: {
        blocked_by: ["PRO-238-S02"],
        extra_json: { nested: [1, "two", true] },
        extra_text: "hello",
        escaped_text: escaped,
        nullable: null,
        empty_list: [],
      },
      status: "in_progress",
    });

    expect(updated.frontmatter.blocked_by).toEqual(["PRO-238-S02"]);
    expect(updated.frontmatter.extra_text).toBe("hello");
    expect(updated.frontmatter.extra_json).toEqual({
      nested: [1, "two", true],
    });
    expect(updated.frontmatter.escaped_text).toBe(escaped);
    expect(updated.frontmatter.nullable).toBeNull();
    expect(updated.frontmatter.empty_list).toEqual([]);
    expect(updated.frontmatter.status).toBe("in_progress");

    const reread = await getSlice(projectDir, created.id);
    expect(reread.frontmatter.blocked_by).toEqual(["PRO-238-S02"]);
    expect(reread.frontmatter.extra_text).toBe("hello");
    expect(reread.frontmatter.extra_json).toEqual({ nested: [1, "two", true] });
    expect(reread.frontmatter.escaped_text).toBe(escaped);
    expect(reread.frontmatter.nullable).toBeNull();
    expect(reread.frontmatter.empty_list).toEqual([]);

    const cleared = await updateSlice(projectDir, created.id, {
      frontmatter: { blocked_by: [] },
    });
    expect(cleared.frontmatter.blocked_by).toBeUndefined();
    const raw = await fs.readFile(
      path.join(projectDir, "slices", created.id, "README.md"),
      "utf8"
    );
    expect(raw).not.toContain("blocked_by");
  });

  it("round-trips slice repo frontmatter", async () => {
    const sliceRepoDir = path.join(tmpDir, "slice-repo");
    await fs.mkdir(path.join(sliceRepoDir, ".git"), { recursive: true });
    const created = await createSlice(projectDir, {
      projectId: "PRO-238",
      title: "Auth",
    });

    const updated = await updateSlice(projectDir, created.id, {
      frontmatter: { repo: sliceRepoDir },
    });

    expect(updated.frontmatter.repo).toBe(sliceRepoDir);
    const reread = await getSlice(projectDir, created.id);
    expect(reread.frontmatter.repo).toBe(sliceRepoDir);

    const cleared = await updateSlice(projectDir, created.id, {
      frontmatter: { repo: "" },
    });
    expect(cleared.frontmatter.repo).toBeUndefined();
    const raw = await fs.readFile(
      path.join(projectDir, "slices", created.id, "README.md"),
      "utf8"
    );
    expect(raw).not.toContain("repo:");
  });

  it("requires a slice repo when the project has no repo", async () => {
    await fs.writeFile(
      path.join(projectDir, "README.md"),
      '---\nid: "PRO-238"\ntitle: "Auth Flow"\nstatus: "active"\n---\n',
      "utf8"
    );

    await expect(
      createSlice(projectDir, {
        projectId: "PRO-238",
        title: "Auth",
      })
    ).rejects.toThrow(
      "Cannot create slice: project PRO-238 has no repo. Pass --repo <abs path>"
    );

    const created = await createSlice(projectDir, {
      projectId: "PRO-238",
      title: "Auth",
      repo: repoDir,
    });
    expect(created.frontmatter.repo).toBe(repoDir);
  });

  it("rejects clearing slice repo when the project has no repo", async () => {
    await fs.writeFile(
      path.join(projectDir, "README.md"),
      '---\nid: "PRO-238"\ntitle: "Auth Flow"\nstatus: "active"\n---\n',
      "utf8"
    );
    const created = await createSlice(projectDir, {
      projectId: "PRO-238",
      title: "Auth",
      repo: repoDir,
    });

    await expect(
      updateSlice(projectDir, created.id, {
        frontmatter: { repo: "" },
      })
    ).rejects.toThrow(
      "Cannot update slice: project PRO-238 has no repo. Pass --repo <abs path>"
    );
  });

  it("rejects invalid slice repo frontmatter", async () => {
    const created = await createSlice(projectDir, {
      projectId: "PRO-238",
      title: "Auth",
    });

    await expect(
      updateSlice(projectDir, created.id, {
        frontmatter: { repo: "relative/repo" },
      })
    ).rejects.toThrow("Slice repo must be an absolute path");
    await expect(
      updateSlice(projectDir, created.id, {
        frontmatter: { repo: path.join(tmpDir, "missing") },
      })
    ).rejects.toThrow("Slice repo is not a git repo");
  });

  it("regenerates empty scope map", async () => {
    await regenerateScopeMap(projectDir, "PRO-238");

    const scopeMap = await fs.readFile(
      path.join(projectDir, "SCOPE_MAP.md"),
      "utf8"
    );
    expect(scopeMap).toContain("# Scope map — PRO-238");
    expect(scopeMap).toContain("| Slice | Title | Status | Hill |");
    expect(scopeMap).not.toContain("PRO-238-S01");
  });

  it("regenerates scope map for single and multiple slices in deterministic id order", async () => {
    await createSlice(projectDir, {
      projectId: "PRO-238",
      title: "First",
    });
    await createSlice(projectDir, {
      projectId: "PRO-238",
      title: "Second",
    });

    const scopeMap = await fs.readFile(
      path.join(projectDir, "SCOPE_MAP.md"),
      "utf8"
    );
    const first = scopeMap.indexOf("PRO-238-S01");
    const second = scopeMap.indexOf("PRO-238-S02");
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(-1);
    expect(first).toBeLessThan(second);
  });

  it("writes scope map atomically and leaves no temp file", async () => {
    await createSlice(projectDir, {
      projectId: "PRO-238",
      title: "Auth",
    });

    await regenerateScopeMap(projectDir, "PRO-238");

    const scopeMapPath = path.join(projectDir, "SCOPE_MAP.md");
    const raw = await fs.readFile(scopeMapPath, "utf8");
    expect(raw).toContain(
      "<!-- Auto-generated by yoplai. Do not edit by hand. -->"
    );
    expect(raw).toContain("| PRO-238-S01 | Auth | todo | figuring |");

    const files = await fs.readdir(projectDir);
    expect(
      files.some(
        (name) => name.includes("SCOPE_MAP.md") && name.includes(".tmp")
      )
    ).toBe(false);
  });

  it("updates README atomically and no temp file left", async () => {
    const created = await createSlice(projectDir, {
      projectId: "PRO-238",
      title: "Auth",
    });

    await updateSlice(projectDir, created.id, { readme: "## Must\n- login\n" });

    const readmePath = path.join(projectDir, "slices", created.id, "README.md");
    const raw = await fs.readFile(readmePath, "utf8");
    expect(raw).toContain("## Must");

    const files = await fs.readdir(path.dirname(readmePath));
    expect(files.some((name) => name.includes(".tmp"))).toBe(false);
  });

  it("falls back to README body when SPECS is missing", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((message?: unknown) => {
      errors.push(String(message ?? ""));
    });
    const created = await createSlice(projectDir, {
      projectId: "PRO-238",
      title: "Legacy specs",
      readme: "## Legacy specs\n\nUse README body.\n",
      specs: "## Current specs\n",
    });
    await fs.rm(path.join(projectDir, "slices", created.id, "SPECS.md"));

    const legacy = await getSlice(projectDir, created.id);
    await getSlice(projectDir, created.id);

    expect(legacy.docs.readme).toBe("## Legacy specs\n\nUse README body.\n");
    expect(legacy.docs.specs).toBe("## Legacy specs\n\nUse README body.\n");
    expect(errors).toEqual([
      "Slice PRO-238-S01 is missing SPECS.md; using README.md body. Run: yoplai slices specs PRO-238-S01 --from-readme",
    ]);
  });

  it("does not emit a specs fallback hint when SPECS exists", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((message?: unknown) => {
      errors.push(String(message ?? ""));
    });
    const created = await createSlice(projectDir, {
      projectId: "PRO-238",
      title: "Current specs",
      readme: "## README body\n",
      specs: "## Specs body\n",
    });

    const slice = await getSlice(projectDir, created.id);

    expect(slice.docs.specs).toBe("## Specs body\n");
    expect(errors).toEqual([]);
  });

  it("editing fallback specs creates SPECS without changing README body", async () => {
    const created = await createSlice(projectDir, {
      projectId: "PRO-238",
      title: "Legacy edit",
      readme: "## Legacy body\n\nKeep me.\n",
    });
    const sliceDir = path.join(projectDir, "slices", created.id);
    await fs.rm(path.join(sliceDir, "SPECS.md"));
    const beforeReadme = await fs.readFile(
      path.join(sliceDir, "README.md"),
      "utf8"
    );

    const updated = await updateSlice(projectDir, created.id, {
      specs: "## New specs\n",
    });

    expect(updated.docs.specs).toBe("## New specs\n");
    await expect(
      fs.readFile(path.join(sliceDir, "SPECS.md"), "utf8")
    ).resolves.toBe("## New specs\n");
    const afterReadme = await fs.readFile(
      path.join(sliceDir, "README.md"),
      "utf8"
    );
    expect(
      afterReadme.replace(/updated_at: "[^"]+"/, 'updated_at: "<updated>"')
    ).toBe(
      beforeReadme.replace(/updated_at: "[^"]+"/, 'updated_at: "<updated>"')
    );
  });

  it("parses frontmatter-only README and returns empty fallback specs", async () => {
    const created = await createSlice(projectDir, {
      projectId: "PRO-238",
      title: "Frontmatter only",
      readme: "",
      specs: "unused",
    });
    await fs.rm(path.join(projectDir, "slices", created.id, "SPECS.md"));

    const slice = await getSlice(projectDir, created.id);

    expect(slice.frontmatter.title).toBe("Frontmatter only");
    expect(slice.docs.readme).toBe("");
    expect(slice.docs.specs).toBe("");
  });

  it("concurrent scope map regens serialize", async () => {
    await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        createSlice(projectDir, {
          projectId: "PRO-238",
          title: `Slice ${index + 1}`,
        })
      )
    );

    await Promise.all(
      Array.from({ length: 10 }, () =>
        regenerateScopeMap(projectDir, "PRO-238")
      )
    );

    const scopeMap = await fs.readFile(
      path.join(projectDir, "SCOPE_MAP.md"),
      "utf8"
    );
    expect(scopeMap).toContain("PRO-238-S01");
    expect(scopeMap).toContain("PRO-238-S04");
    expect(scopeMap).not.toContain("undefined");
  });

  it("concurrent creates do not collide", async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        createSlice(projectDir, {
          projectId: "PRO-238",
          title: `Slice ${index + 1}`,
        })
      )
    );

    const ids = results.map((item) => item.id).sort();
    expect(new Set(ids).size).toBe(12);
    expect(ids[0]).toBe("PRO-238-S01");
    expect(ids[11]).toBe("PRO-238-S12");
    expect((await readSliceCounters(projectDir)).lastSliceId).toBe(12);
  });

  it("rejects invalid projectId before path joins", async () => {
    await expect(
      createSlice(projectDir, {
        projectId: "../PRO-238",
        title: "bad",
      })
    ).rejects.toThrow("Invalid projectId");

    await expect(
      createSlice(projectDir, {
        projectId: "PRO-abc",
        title: "bad",
      })
    ).rejects.toThrow("Invalid projectId");
  });

  it("rejects invalid sliceId before path joins", async () => {
    await expect(getSlice(projectDir, "../PRO-238-S01")).rejects.toThrow(
      "Invalid sliceId"
    );
    await expect(updateSlice(projectDir, "PRO-238/../S01", {})).rejects.toThrow(
      "Invalid sliceId"
    );
    await expect(getSlice(projectDir, "PRO-238-Sx1")).rejects.toThrow(
      "Invalid sliceId"
    );
  });
});
