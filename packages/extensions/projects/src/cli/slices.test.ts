import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Command } from "commander";
import { registerSlicesCommands, resolveAddSliceSpecs } from "./slices.js";

async function setupProject(
  root: string,
  id: string,
  title: string
): Promise<string> {
  const dir = path.join(root, `${id}_test`);
  const repoDir = path.join(root, ".repos", id);
  await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "README.md"),
    `---\nid: ${JSON.stringify(id)}\ntitle: ${JSON.stringify(title)}\nstatus: "active"\nrepo: ${JSON.stringify(repoDir)}\n---\n`,
    "utf8"
  );
  return dir;
}

async function setupProjectWithoutRepo(
  root: string,
  id: string,
  title: string
): Promise<string> {
  const dir = path.join(root, `${id}_test`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "README.md"),
    `---\nid: ${JSON.stringify(id)}\ntitle: ${JSON.stringify(title)}\nstatus: "active"\n---\n`,
    "utf8"
  );
  return dir;
}

function createProgram() {
  const program = new Command();
  program.name("slices").exitOverride();
  registerSlicesCommands(program);
  return program;
}

describe("slices CLI", () => {
  let prevHome: string | undefined;
  let homeDir: string;
  let projectsRoot: string;

  beforeEach(async () => {
    prevHome = process.env.YOPLAI_HOME;
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-home-"));
    projectsRoot = path.join(homeDir, "projects");
    await fs.mkdir(projectsRoot, { recursive: true });
    process.env.YOPLAI_HOME = homeDir;
    await fs.writeFile(
      path.join(homeDir, "yoplai.json"),
      JSON.stringify({ agents: [], projects: { root: projectsRoot } }),
      "utf8"
    );
  });

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.YOPLAI_HOME;
    else process.env.YOPLAI_HOME = prevHome;
    await fs.rm(homeDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("add creates slice and prints id", async () => {
    await setupProject(projectsRoot, "PRO-101", "Proj");
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
      logs.push(String(msg ?? ""));
    });

    await createProgram().parseAsync([
      "node",
      "slices",
      "add",
      "--project",
      "PRO-101",
      "--repo",
      path.join(projectsRoot, ".repos", "PRO-101"),
      "Auth flow",
    ]);

    expect(logs[0]).toBe("PRO-101-S01");
    const projectDir = path.join(projectsRoot, "PRO-101_test");
    const readme = await fs.readFile(
      path.join(projectDir, "slices", "PRO-101-S01", "README.md"),
      "utf8"
    );
    expect(readme).toContain('title: "Auth flow"');
    expect(readme).not.toContain("## Must");
    const specs = await fs.readFile(
      path.join(projectDir, "slices", "PRO-101-S01", "SPECS.md"),
      "utf8"
    );
    expect(specs).toBe("");

    const scopeMap = await fs.readFile(
      path.join(projectDir, "SCOPE_MAP.md"),
      "utf8"
    );
    expect(scopeMap).toContain("# Scope map — PRO-101");
    expect(scopeMap).toContain("| PRO-101-S01 | Auth flow | todo | figuring |");
  });

  it("add accepts --repo when project has no repo", async () => {
    await setupProjectWithoutRepo(projectsRoot, "PRO-101", "Proj");
    const repoDir = path.join(homeDir, "slice-repo");
    await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });

    await createProgram().parseAsync([
      "node",
      "slices",
      "add",
      "--project",
      "PRO-101",
      "--repo",
      repoDir,
      "Auth flow",
    ]);

    const readme = await fs.readFile(
      path.join(
        projectsRoot,
        "PRO-101_test",
        "slices",
        "PRO-101-S01",
        "README.md"
      ),
      "utf8"
    );
    expect(readme).toContain(`repo: ${JSON.stringify(repoDir)}`);
  });

  it("add writes positional specs to SPECS.md", async () => {
    await setupProject(projectsRoot, "PRO-101", "Proj");

    await createProgram().parseAsync([
      "node",
      "slices",
      "add",
      "--project",
      "PRO-101",
      "--repo",
      path.join(projectsRoot, ".repos", "PRO-101"),
      "Auth flow",
      "Specs body",
    ]);

    const specs = await fs.readFile(
      path.join(
        projectsRoot,
        "PRO-101_test",
        "slices",
        "PRO-101-S01",
        "SPECS.md"
      ),
      "utf8"
    );
    expect(specs).toBe("Specs body");
  });

  it("add writes --specs inline content to SPECS.md", async () => {
    await setupProject(projectsRoot, "PRO-101", "Proj");

    await createProgram().parseAsync([
      "node",
      "slices",
      "add",
      "--project",
      "PRO-101",
      "--repo",
      path.join(projectsRoot, ".repos", "PRO-101"),
      "Auth flow",
      "--specs",
      "Inline specs",
    ]);

    const specs = await fs.readFile(
      path.join(
        projectsRoot,
        "PRO-101_test",
        "slices",
        "PRO-101-S01",
        "SPECS.md"
      ),
      "utf8"
    );
    expect(specs).toBe("Inline specs");
  });

  it("add writes --specs @file content to SPECS.md", async () => {
    await setupProject(projectsRoot, "PRO-101", "Proj");
    const specsPath = path.join(homeDir, "specs.md");
    await fs.writeFile(specsPath, "File specs\n", "utf8");

    await createProgram().parseAsync([
      "node",
      "slices",
      "add",
      "--project",
      "PRO-101",
      "--repo",
      path.join(projectsRoot, ".repos", "PRO-101"),
      "Auth flow",
      "--specs",
      `@${specsPath}`,
    ]);

    const specs = await fs.readFile(
      path.join(
        projectsRoot,
        "PRO-101_test",
        "slices",
        "PRO-101-S01",
        "SPECS.md"
      ),
      "utf8"
    );
    expect(specs).toBe("File specs\n");
  });

  it("resolves --specs - content from stdin", async () => {
    await expect(
      resolveAddSliceSpecs(undefined, "-", async () => "stdin specs\n")
    ).resolves.toBe("stdin specs\n");
  });

  it("rejects positional specs and --specs together", async () => {
    await expect(
      resolveAddSliceSpecs("Specs body", "Other specs")
    ).rejects.toThrow("Use either positional <specs> or --specs, not both.");
  });

  it("list supports no flags and filters", async () => {
    await setupProject(projectsRoot, "PRO-101", "One");
    await setupProject(projectsRoot, "PRO-102", "Two");
    await createProgram().parseAsync([
      "node",
      "slices",
      "add",
      "--project",
      "PRO-101",
      "A",
    ]);
    await createProgram().parseAsync([
      "node",
      "slices",
      "add",
      "--project",
      "PRO-102",
      "B",
    ]);

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
      logs.push(String(msg ?? ""));
    });

    await createProgram().parseAsync(["node", "slices", "list"]);
    expect(logs[0]).toContain("PRO-101-S01");
    expect(logs[0]).toContain("PRO-102-S01");

    logs.length = 0;
    await createProgram().parseAsync([
      "node",
      "slices",
      "list",
      "--project",
      "PRO-101",
      "--status",
      "todo",
    ]);
    expect(logs[0]).toContain("PRO-101-S01");
    expect(logs[0]).not.toContain("PRO-102-S01");
  });

  it("get resolves slice across projects", async () => {
    await setupProject(projectsRoot, "PRO-101", "One");
    await setupProject(projectsRoot, "PRO-102", "Two");
    await createProgram().parseAsync([
      "node",
      "slices",
      "add",
      "--project",
      "PRO-102",
      "Slice B",
    ]);

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
      logs.push(String(msg ?? ""));
    });

    await createProgram().parseAsync(["node", "slices", "get", "PRO-102-S01"]);
    expect(logs[0]).toContain("id: PRO-102-S01");
    expect(logs[0]).toContain("title: Slice B");
  });

  it("move updates slice status and regenerates SCOPE_MAP", async () => {
    await setupProject(projectsRoot, "PRO-101", "Proj");
    await createProgram().parseAsync([
      "node",
      "slices",
      "add",
      "--project",
      "PRO-101",
      "--repo",
      path.join(projectsRoot, ".repos", "PRO-101"),
      "Work",
    ]);

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
      logs.push(String(msg ?? ""));
    });

    await createProgram().parseAsync([
      "node",
      "slices",
      "move",
      "PRO-101-S01",
      "in_progress",
    ]);
    expect(logs[0]).toContain("PRO-101-S01");
    expect(logs[0]).toContain("in_progress");

    const projectDir = path.join(projectsRoot, "PRO-101_test");
    const readme = await fs.readFile(
      path.join(projectDir, "slices", "PRO-101-S01", "README.md"),
      "utf8"
    );
    expect(readme).toContain('"in_progress"');

    const scopeMap = await fs.readFile(
      path.join(projectDir, "SCOPE_MAP.md"),
      "utf8"
    );
    expect(scopeMap).toContain("in_progress");
  });

  it("move rejects invalid status with clear message", async () => {
    await setupProject(projectsRoot, "PRO-101", "Proj");
    await createProgram().parseAsync([
      "node",
      "slices",
      "add",
      "--project",
      "PRO-101",
      "--repo",
      path.join(projectsRoot, ".repos", "PRO-101"),
      "Work",
    ]);

    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((msg?: unknown) => {
      errors.push(String(msg ?? ""));
    });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    await expect(
      createProgram().parseAsync([
        "node",
        "slices",
        "move",
        "PRO-101-S01",
        "shipped",
      ])
    ).rejects.toThrow("EXIT:1");
    expect(errors[0]).toContain('Invalid status "shipped"');
    expect(errors[0]).toContain("todo");
    expect(errors[0]).toContain("cancelled");
  });

  it("rename updates title in frontmatter and SCOPE_MAP", async () => {
    await setupProject(projectsRoot, "PRO-101", "Proj");
    await createProgram().parseAsync([
      "node",
      "slices",
      "add",
      "--project",
      "PRO-101",
      "--repo",
      path.join(projectsRoot, ".repos", "PRO-101"),
      "Old Name",
    ]);

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
      logs.push(String(msg ?? ""));
    });

    await createProgram().parseAsync([
      "node",
      "slices",
      "rename",
      "PRO-101-S01",
      "New Name",
    ]);
    expect(logs[0]).toContain("PRO-101-S01");
    expect(logs[0]).toContain("New Name");

    const projectDir = path.join(projectsRoot, "PRO-101_test");
    const readme = await fs.readFile(
      path.join(projectDir, "slices", "PRO-101-S01", "README.md"),
      "utf8"
    );
    expect(readme).toContain('"New Name"');

    const scopeMap = await fs.readFile(
      path.join(projectDir, "SCOPE_MAP.md"),
      "utf8"
    );
    expect(scopeMap).toContain("New Name");
    expect(scopeMap).not.toContain("Old Name");
  });

  it("block adds blockers with dedupe and unblock removes them", async () => {
    await setupProject(projectsRoot, "PRO-101", "Proj");
    await createProgram().parseAsync([
      "node",
      "slices",
      "add",
      "--project",
      "PRO-101",
      "--repo",
      path.join(projectsRoot, ".repos", "PRO-101"),
      "A",
    ]);
    await createProgram().parseAsync([
      "node",
      "slices",
      "add",
      "--project",
      "PRO-101",
      "--repo",
      path.join(projectsRoot, ".repos", "PRO-101"),
      "B",
    ]);
    await createProgram().parseAsync([
      "node",
      "slices",
      "add",
      "--project",
      "PRO-101",
      "--repo",
      path.join(projectsRoot, ".repos", "PRO-101"),
      "C",
    ]);

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
      logs.push(String(msg ?? ""));
    });

    await createProgram().parseAsync([
      "node",
      "slices",
      "block",
      "PRO-101-S01",
      "--on",
      "PRO-101-S02,PRO-101-S02,PRO-101-S03",
    ]);
    expect(logs.at(-1)).toBe("blocked_by: [PRO-101-S02, PRO-101-S03]");

    const projectDir = path.join(projectsRoot, "PRO-101_test");
    let readme = await fs.readFile(
      path.join(projectDir, "slices", "PRO-101-S01", "README.md"),
      "utf8"
    );
    expect(readme).toContain('blocked_by: ["PRO-101-S02","PRO-101-S03"]');

    await createProgram().parseAsync([
      "node",
      "slices",
      "unblock",
      "PRO-101-S01",
      "--from",
      "PRO-101-S02",
    ]);
    expect(logs.at(-1)).toBe("blocked_by: [PRO-101-S03]");

    await createProgram().parseAsync([
      "node",
      "slices",
      "unblock",
      "PRO-101-S01",
    ]);
    expect(logs.at(-1)).toBe("blocked_by: []");
    readme = await fs.readFile(
      path.join(projectDir, "slices", "PRO-101-S01", "README.md"),
      "utf8"
    );
    expect(readme).not.toContain("blocked_by");
  });

  it("block rejects missing blockers, self-blocks, and cycles", async () => {
    await setupProject(projectsRoot, "PRO-101", "Proj");
    await createProgram().parseAsync([
      "node",
      "slices",
      "add",
      "--project",
      "PRO-101",
      "--repo",
      path.join(projectsRoot, ".repos", "PRO-101"),
      "A",
    ]);
    await createProgram().parseAsync([
      "node",
      "slices",
      "add",
      "--project",
      "PRO-101",
      "--repo",
      path.join(projectsRoot, ".repos", "PRO-101"),
      "B",
    ]);
    await createProgram().parseAsync([
      "node",
      "slices",
      "add",
      "--project",
      "PRO-101",
      "--repo",
      path.join(projectsRoot, ".repos", "PRO-101"),
      "C",
    ]);

    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((msg?: unknown) => {
      errors.push(String(msg ?? ""));
    });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    await expect(
      createProgram().parseAsync([
        "node",
        "slices",
        "block",
        "PRO-101-S01",
        "--on",
        "PRO-101-S99",
      ])
    ).rejects.toThrow("EXIT:1");
    expect(errors.at(-1)).toContain("Blocker slice not found: PRO-101-S99");

    await expect(
      createProgram().parseAsync([
        "node",
        "slices",
        "block",
        "PRO-101-S01",
        "--on",
        "PRO-101-S01",
      ])
    ).rejects.toThrow("EXIT:1");
    expect(errors.at(-1)).toContain("Slice cannot block itself: PRO-101-S01");

    await createProgram().parseAsync([
      "node",
      "slices",
      "block",
      "PRO-101-S01",
      "--on",
      "PRO-101-S02",
    ]);
    await createProgram().parseAsync([
      "node",
      "slices",
      "block",
      "PRO-101-S02",
      "--on",
      "PRO-101-S03",
    ]);

    await expect(
      createProgram().parseAsync([
        "node",
        "slices",
        "block",
        "PRO-101-S03",
        "--on",
        "PRO-101-S01",
      ])
    ).rejects.toThrow("EXIT:1");
    expect(errors.at(-1)).toContain(
      "would create cycle: PRO-101-S03 → PRO-101-S01 → PRO-101-S02 → PRO-101-S03"
    );
  });

  it("unblock --from rejects blockers not currently present", async () => {
    await setupProject(projectsRoot, "PRO-101", "Proj");
    await createProgram().parseAsync([
      "node",
      "slices",
      "add",
      "--project",
      "PRO-101",
      "--repo",
      path.join(projectsRoot, ".repos", "PRO-101"),
      "A",
    ]);
    await createProgram().parseAsync([
      "node",
      "slices",
      "add",
      "--project",
      "PRO-101",
      "--repo",
      path.join(projectsRoot, ".repos", "PRO-101"),
      "B",
    ]);
    await createProgram().parseAsync([
      "node",
      "slices",
      "add",
      "--project",
      "PRO-101",
      "--repo",
      path.join(projectsRoot, ".repos", "PRO-101"),
      "C",
    ]);
    await createProgram().parseAsync([
      "node",
      "slices",
      "block",
      "PRO-101-S01",
      "--on",
      "PRO-101-S02",
    ]);

    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((msg?: unknown) => {
      errors.push(String(msg ?? ""));
    });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    await expect(
      createProgram().parseAsync([
        "node",
        "slices",
        "unblock",
        "PRO-101-S01",
        "--from",
        "PRO-101-S03,PRO-101-S99",
      ])
    ).rejects.toThrow("EXIT:1");
    expect(errors.at(-1)).toContain(
      "Blockers not found on PRO-101-S01: PRO-101-S03, PRO-101-S99"
    );
  });

  it("comment appends timestamped entry to THREAD.md and preserves prior content", async () => {
    await setupProject(projectsRoot, "PRO-101", "Proj");
    await createProgram().parseAsync([
      "node",
      "slices",
      "add",
      "--project",
      "PRO-101",
      "--repo",
      path.join(projectsRoot, ".repos", "PRO-101"),
      "Work",
    ]);

    // First comment
    await createProgram().parseAsync([
      "node",
      "slices",
      "comment",
      "PRO-101-S01",
      "First comment",
    ]);

    const projectDir = path.join(projectsRoot, "PRO-101_test");
    const threadAfterFirst = await fs.readFile(
      path.join(projectDir, "slices", "PRO-101-S01", "THREAD.md"),
      "utf8"
    );
    expect(threadAfterFirst).toContain("First comment");
    // Should have a timestamp heading
    expect(threadAfterFirst).toMatch(/## \d{4}-\d{2}-\d{2}T/);

    // Second comment — prior content must be preserved
    await createProgram().parseAsync([
      "node",
      "slices",
      "comment",
      "PRO-101-S01",
      "Second comment",
    ]);

    const threadAfterSecond = await fs.readFile(
      path.join(projectDir, "slices", "PRO-101-S01", "THREAD.md"),
      "utf8"
    );
    expect(threadAfterSecond).toContain("First comment");
    expect(threadAfterSecond).toContain("Second comment");
  });

  it("comment writes explicit author metadata when --author is passed", async () => {
    await setupProject(projectsRoot, "PRO-101", "Proj");
    await createProgram().parseAsync([
      "node",
      "slices",
      "add",
      "--project",
      "PRO-101",
      "--repo",
      path.join(projectsRoot, ".repos", "PRO-101"),
      "Work",
    ]);

    await createProgram().parseAsync([
      "node",
      "slices",
      "comment",
      "PRO-101-S01",
      "--author",
      "Worker",
      "Implemented.",
    ]);

    const thread = await fs.readFile(
      path.join(
        projectsRoot,
        "PRO-101_test",
        "slices",
        "PRO-101-S01",
        "THREAD.md"
      ),
      "utf8"
    );
    expect(thread).toContain("[author:Worker]");
    expect(thread).toContain("[date:");
    expect(thread).toContain("Implemented.");
  });

  it("merger-conflict records explicit conflict metadata", async () => {
    await setupProject(projectsRoot, "PRO-101", "Proj");
    await createProgram().parseAsync([
      "node",
      "slices",
      "add",
      "--project",
      "PRO-101",
      "Work",
    ]);

    await createProgram().parseAsync([
      "node",
      "slices",
      "merger-conflict",
      "PRO-101-S01",
      "src/app.ts\npackage.json",
    ]);

    const readme = await fs.readFile(
      path.join(
        projectsRoot,
        "PRO-101_test",
        "slices",
        "PRO-101-S01",
        "README.md"
      ),
      "utf8"
    );
    expect(readme).toContain('"summary":"src/app.ts, package.json"');
    expect(readme).toContain('"source":"merger_outcome"');
  });

  it("Merger conflict comments do not downgrade explicit conflict metadata", async () => {
    await setupProject(projectsRoot, "PRO-101", "Proj");
    await createProgram().parseAsync([
      "node",
      "slices",
      "add",
      "--project",
      "PRO-101",
      "Work",
    ]);

    await createProgram().parseAsync([
      "node",
      "slices",
      "merger-conflict",
      "PRO-101-S01",
      "src/app.ts",
    ]);
    await createProgram().parseAsync([
      "node",
      "slices",
      "comment",
      "PRO-101-S01",
      "--author",
      "Merger",
      "Merge conflict - needs human: package.json",
    ]);

    const readme = await fs.readFile(
      path.join(
        projectsRoot,
        "PRO-101_test",
        "slices",
        "PRO-101-S01",
        "README.md"
      ),
      "utf8"
    );
    expect(readme).toContain('"summary":"src/app.ts"');
    expect(readme).toContain('"source":"merger_outcome"');
    expect(readme).not.toContain('"summary":"package.json"');
    expect(readme).not.toContain('"source":"merger_comment"');
  });

  it("moving a slice away from ready_to_merge clears Merger conflict metadata", async () => {
    await setupProject(projectsRoot, "PRO-101", "Proj");
    await createProgram().parseAsync([
      "node",
      "slices",
      "add",
      "--project",
      "PRO-101",
      "Work",
    ]);

    await createProgram().parseAsync([
      "node",
      "slices",
      "merger-conflict",
      "PRO-101-S01",
      "src/app.ts",
    ]);
    await createProgram().parseAsync([
      "node",
      "slices",
      "move",
      "PRO-101-S01",
      "todo",
    ]);

    const readme = await fs.readFile(
      path.join(
        projectsRoot,
        "PRO-101_test",
        "slices",
        "PRO-101-S01",
        "README.md"
      ),
      "utf8"
    );
    expect(readme).not.toContain("merger_conflict");
  });

  it("comment bumps updated_at", async () => {
    await setupProject(projectsRoot, "PRO-101", "Proj");
    await createProgram().parseAsync([
      "node",
      "slices",
      "add",
      "--project",
      "PRO-101",
      "--repo",
      path.join(projectsRoot, ".repos", "PRO-101"),
      "Work",
    ]);

    const beforeReadme = await fs.readFile(
      path.join(
        projectsRoot,
        "PRO-101_test",
        "slices",
        "PRO-101-S01",
        "README.md"
      ),
      "utf8"
    );
    const beforeMatch = beforeReadme.match(/updated_at: "([^"]+)"/);
    const beforeTs = beforeMatch?.[1] ?? "";

    // Wait a tiny bit to ensure timestamp differs
    await new Promise((r) => setTimeout(r, 5));

    await createProgram().parseAsync([
      "node",
      "slices",
      "comment",
      "PRO-101-S01",
      "hello",
    ]);

    const afterReadme = await fs.readFile(
      path.join(
        projectsRoot,
        "PRO-101_test",
        "slices",
        "PRO-101-S01",
        "README.md"
      ),
      "utf8"
    );
    const afterMatch = afterReadme.match(/updated_at: "([^"]+)"/);
    const afterTs = afterMatch?.[1] ?? "";

    expect(afterTs).not.toBe("");
    expect(afterTs).not.toBe(beforeTs);
  });

  it("cancel moves slice to cancelled status", async () => {
    await setupProject(projectsRoot, "PRO-101", "Proj");
    await createProgram().parseAsync([
      "node",
      "slices",
      "add",
      "--project",
      "PRO-101",
      "--repo",
      path.join(projectsRoot, ".repos", "PRO-101"),
      "Work",
    ]);

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
      logs.push(String(msg ?? ""));
    });

    await createProgram().parseAsync([
      "node",
      "slices",
      "cancel",
      "PRO-101-S01",
    ]);
    expect(logs[0]).toContain("PRO-101-S01");
    expect(logs[0]).toContain("cancelled");

    const projectDir = path.join(projectsRoot, "PRO-101_test");
    const readme = await fs.readFile(
      path.join(projectDir, "slices", "PRO-101-S01", "README.md"),
      "utf8"
    );
    expect(readme).toContain('"cancelled"');

    const scopeMap = await fs.readFile(
      path.join(projectDir, "SCOPE_MAP.md"),
      "utf8"
    );
    expect(scopeMap).toContain("cancelled");
  });

  it("works for slugged project dir when config uses extensions.projects.root", async () => {
    await fs.writeFile(
      path.join(homeDir, "yoplai.json"),
      JSON.stringify({
        agents: [],
        extensions: { projects: { root: projectsRoot } },
      }),
      "utf8"
    );

    const projectDir = path.join(
      projectsRoot,
      "PRO-222_gateway-created-project"
    );
    const repoDir = path.join(projectsRoot, ".repos", "PRO-222");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(projectDir, "README.md"),
      `---\nid: "PRO-222"\ntitle: "Gateway Created Project"\nstatus: "active"\n---\n`,
      "utf8"
    );

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
      logs.push(String(msg ?? ""));
    });

    await createProgram().parseAsync([
      "node",
      "slices",
      "add",
      "--project",
      "PRO-222",
      "--repo",
      repoDir,
      "Gateway slice",
    ]);

    expect(logs[0]).toBe("PRO-222-S01");

    await expect(
      fs.stat(path.join(projectDir, "slices", "PRO-222-S01", "README.md"))
    ).resolves.toBeTruthy();
    const scopeMap = await fs.readFile(
      path.join(projectDir, "SCOPE_MAP.md"),
      "utf8"
    );
    expect(scopeMap).toContain("PRO-222-S01");
    expect(scopeMap).toContain("Gateway slice");
  });

  it("prefers extensions.projects.root over deprecated projects.root", async () => {
    const legacyRoot = path.join(homeDir, "projects-legacy");
    const canonicalRoot = path.join(homeDir, "projects-canonical");
    await fs.mkdir(legacyRoot, { recursive: true });
    await fs.mkdir(canonicalRoot, { recursive: true });

    await fs.writeFile(
      path.join(homeDir, "yoplai.json"),
      JSON.stringify({
        agents: [],
        projects: { root: legacyRoot },
        extensions: { projects: { root: canonicalRoot } },
      }),
      "utf8"
    );

    const canonicalProjectDir = path.join(canonicalRoot, "PRO-333_canonical");
    const repoDir = path.join(canonicalRoot, ".repos", "PRO-333");
    await fs.mkdir(canonicalProjectDir, { recursive: true });
    await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(canonicalProjectDir, "README.md"),
      `---\nid: "PRO-333"\ntitle: "Canonical Project"\nstatus: "active"\n---\n`,
      "utf8"
    );

    await createProgram().parseAsync([
      "node",
      "slices",
      "add",
      "--project",
      "PRO-333",
      "--repo",
      repoDir,
      "Canonical slice",
    ]);

    await expect(
      fs.stat(
        path.join(canonicalProjectDir, "slices", "PRO-333-S01", "README.md")
      )
    ).resolves.toBeTruthy();
    await expect(
      fs.stat(
        path.join(
          legacyRoot,
          "PRO-333_canonical",
          "slices",
          "PRO-333-S01",
          "README.md"
        )
      )
    ).rejects.toThrow();
  });

  it("prints clear errors for missing project and missing slice", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((msg?: unknown) => {
      errors.push(String(msg ?? ""));
    });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    await expect(
      createProgram().parseAsync([
        "node",
        "slices",
        "add",
        "--project",
        "PRO-999",
        "Missing",
      ])
    ).rejects.toThrow("EXIT:1");
    expect(errors[0]).toBe("Project not found: PRO-999");

    errors.length = 0;
    await setupProject(projectsRoot, "PRO-101", "One");
    await expect(
      createProgram().parseAsync(["node", "slices", "get", "PRO-101-S99"])
    ).rejects.toThrow("EXIT:1");
    expect(errors[0]).toBe("Slice not found: PRO-101-S99");
  });
});
