/**
 * Tests for yoplai projects migrate-to-slices
 *
 * Covers one project per legacy status and golden assertions.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runMigration } from "./migrate.js";

// ─── Test helpers ─────────────────────────────────────────────────────────────

type ProjectSeed = {
  id: string;
  /** e.g. "PRO-001" directory uses "PRO-001" as the dir name */
  title: string;
  status: string;
  /** Optional file contents to pre-populate */
  specs?: string;
  tasks?: string;
  validation?: string;
  thread?: string;
};

async function seedProject(root: string, seed: ProjectSeed): Promise<string> {
  const dir = path.join(root, seed.id);
  await fs.mkdir(dir, { recursive: true });

  const fm = [
    "---",
    `id: ${JSON.stringify(seed.id)}`,
    `title: ${JSON.stringify(seed.title)}`,
    `status: ${JSON.stringify(seed.status)}`,
    "---",
    "",
  ].join("\n");
  await fs.writeFile(
    path.join(dir, "README.md"),
    fm + "Project description.\n",
    "utf8"
  );

  if (seed.specs !== undefined) {
    await fs.writeFile(path.join(dir, "SPECS.md"), seed.specs, "utf8");
  }
  if (seed.tasks !== undefined) {
    await fs.writeFile(path.join(dir, "TASKS.md"), seed.tasks, "utf8");
  }
  if (seed.validation !== undefined) {
    await fs.writeFile(
      path.join(dir, "VALIDATION.md"),
      seed.validation,
      "utf8"
    );
  }
  if (seed.thread !== undefined) {
    await fs.writeFile(path.join(dir, "THREAD.md"), seed.thread, "utf8");
  }

  return dir;
}

async function readFrontmatter(
  filePath: string
): Promise<Record<string, string>> {
  const raw = await fs.readFile(filePath, "utf8");
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const fm: Record<string, string> = {};
  for (const line of (match[1] ?? "").split("\n")) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (!m) continue;
    fm[m[1] as string] = (m[2] ?? "").replace(/^"|"$/g, "").trim();
  }
  return fm;
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe("migrate-to-slices", () => {
  let prevHome: string | undefined;
  let homeDir: string;
  let projectsRoot: string;
  let configPath: string;

  beforeEach(async () => {
    prevHome = process.env.YOPLAI_HOME;
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-migrate-"));
    projectsRoot = path.join(homeDir, "projects");
    configPath = path.join(homeDir, "yoplai.json");

    await fs.mkdir(projectsRoot, { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify({ agents: [], projects: { root: projectsRoot } }),
      "utf8"
    );
    process.env.YOPLAI_HOME = homeDir;
  });

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.YOPLAI_HOME;
    else process.env.YOPLAI_HOME = prevHome;
    await fs.rm(homeDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // ─── Status mapping per §10.1 ───────────────────────────────────────────────

  it("not_now → project:shaping, no slice created", async () => {
    await seedProject(projectsRoot, {
      id: "PRO-001",
      title: "Not Now Project",
      status: "not_now",
      specs: "## Spec content",
    });

    const result = await runMigration({
      config: configPath,
      skipGatewayCheck: true,
    });
    const r = result.projects.find((p) => p.id === "PRO-001")!;

    expect(r.outcome).toBe("no-slice");
    expect(r.projectStatus).toBe("shaping");
    expect(r.sliceId).toBeUndefined();

    // project README status updated
    const fm = await readFrontmatter(
      path.join(projectsRoot, "PRO-001", "README.md")
    );
    expect(fm.status).toBe("shaping");

    // slices/ dir NOT created
    await expect(
      fs.stat(path.join(projectsRoot, "PRO-001", "slices"))
    ).rejects.toThrow();

    // SPECS.md remains in project root (not moved)
    const specs = await fs.readFile(
      path.join(projectsRoot, "PRO-001", "SPECS.md"),
      "utf8"
    );
    expect(specs).toBe("## Spec content");
  });

  it("maybe → project:shaping, no slice created", async () => {
    await seedProject(projectsRoot, {
      id: "PRO-002",
      title: "Maybe Project",
      status: "maybe",
    });

    const result = await runMigration({
      config: configPath,
      skipGatewayCheck: true,
    });
    const r = result.projects.find((p) => p.id === "PRO-002")!;

    expect(r.outcome).toBe("no-slice");
    expect(r.projectStatus).toBe("shaping");
    await expect(
      fs.stat(path.join(projectsRoot, "PRO-002", "slices"))
    ).rejects.toThrow();
  });

  it("shaping → project:shaping, slice:todo", async () => {
    await seedProject(projectsRoot, {
      id: "PRO-003",
      title: "Shaping Project",
      status: "shaping",
      specs: "# Spec",
    });

    const result = await runMigration({
      config: configPath,
      skipGatewayCheck: true,
    });
    const r = result.projects.find((p) => p.id === "PRO-003")!;

    expect(r.outcome).toBe("migrated");
    expect(r.projectStatus).toBe("shaping");
    expect(r.sliceStatus).toBe("todo");
    expect(r.sliceId).toBe("PRO-003-S01");

    const sliceFm = await readFrontmatter(
      path.join(projectsRoot, "PRO-003", "slices", "PRO-003-S01", "README.md")
    );
    expect(sliceFm.status).toBe("todo");
    expect(sliceFm.hill_position).toBe("figuring");
    expect(sliceFm.title).toBe("Shaping Project");
  });

  it("todo → project:active, slice:todo", async () => {
    await seedProject(projectsRoot, {
      id: "PRO-004",
      title: "Todo Project",
      status: "todo",
      specs: "Spec content",
      tasks: "- [ ] Task 1",
    });

    const result = await runMigration({
      config: configPath,
      skipGatewayCheck: true,
    });
    const r = result.projects.find((p) => p.id === "PRO-004")!;

    expect(r.outcome).toBe("migrated");
    expect(r.projectStatus).toBe("active");
    expect(r.sliceStatus).toBe("todo");

    const projectFm = await readFrontmatter(
      path.join(projectsRoot, "PRO-004", "README.md")
    );
    expect(projectFm.status).toBe("active");

    // SPECS.md moved into slice dir
    const sliceDir = path.join(
      projectsRoot,
      "PRO-004",
      "slices",
      "PRO-004-S01"
    );
    const specs = await fs.readFile(path.join(sliceDir, "SPECS.md"), "utf8");
    expect(specs).toBe("Spec content");

    // SPECS.md removed from project root
    await expect(
      fs.stat(path.join(projectsRoot, "PRO-004", "SPECS.md"))
    ).rejects.toThrow();

    // TASKS.md moved
    const tasks = await fs.readFile(path.join(sliceDir, "TASKS.md"), "utf8");
    expect(tasks).toBe("- [ ] Task 1");

    // SCOPE_MAP.md generated
    const scopeMap = await fs.readFile(
      path.join(projectsRoot, "PRO-004", "SCOPE_MAP.md"),
      "utf8"
    );
    expect(scopeMap).toContain("# Scope map — PRO-004");
    expect(scopeMap).toContain("| PRO-004-S01 |");
  });

  it("in_progress → project:active, slice:in_progress", async () => {
    await seedProject(projectsRoot, {
      id: "PRO-005",
      title: "In Progress",
      status: "in_progress",
    });

    const result = await runMigration({
      config: configPath,
      skipGatewayCheck: true,
    });
    const r = result.projects.find((p) => p.id === "PRO-005")!;

    expect(r.outcome).toBe("migrated");
    expect(r.projectStatus).toBe("active");
    expect(r.sliceStatus).toBe("in_progress");

    const sliceFm = await readFrontmatter(
      path.join(projectsRoot, "PRO-005", "slices", "PRO-005-S01", "README.md")
    );
    expect(sliceFm.status).toBe("in_progress");
  });

  it("review → project:active, slice:review", async () => {
    await seedProject(projectsRoot, {
      id: "PRO-006",
      title: "Review Project",
      status: "review",
    });

    const result = await runMigration({
      config: configPath,
      skipGatewayCheck: true,
    });
    const r = result.projects.find((p) => p.id === "PRO-006")!;

    expect(r.outcome).toBe("migrated");
    expect(r.projectStatus).toBe("active");
    expect(r.sliceStatus).toBe("review");
  });

  it("ready_to_merge → project:active, slice:ready_to_merge", async () => {
    await seedProject(projectsRoot, {
      id: "PRO-007",
      title: "Ready to Merge",
      status: "ready_to_merge",
    });

    const result = await runMigration({
      config: configPath,
      skipGatewayCheck: true,
    });
    const r = result.projects.find((p) => p.id === "PRO-007")!;

    expect(r.outcome).toBe("migrated");
    expect(r.projectStatus).toBe("active");
    expect(r.sliceStatus).toBe("ready_to_merge");
  });

  it("done → project:done, slice:done", async () => {
    await seedProject(projectsRoot, {
      id: "PRO-008",
      title: "Done Project",
      status: "done",
      validation: "All criteria met.",
    });

    const result = await runMigration({
      config: configPath,
      skipGatewayCheck: true,
    });
    const r = result.projects.find((p) => p.id === "PRO-008")!;

    expect(r.outcome).toBe("migrated");
    expect(r.projectStatus).toBe("done");
    expect(r.sliceStatus).toBe("done");

    const sliceFm = await readFrontmatter(
      path.join(projectsRoot, "PRO-008", "slices", "PRO-008-S01", "README.md")
    );
    expect(sliceFm.status).toBe("done");

    // VALIDATION.md moved
    const sliceDir = path.join(
      projectsRoot,
      "PRO-008",
      "slices",
      "PRO-008-S01"
    );
    const validation = await fs.readFile(
      path.join(sliceDir, "VALIDATION.md"),
      "utf8"
    );
    expect(validation).toBe("All criteria met.");
  });

  it("cancelled → project:cancelled, slice:cancelled", async () => {
    await seedProject(projectsRoot, {
      id: "PRO-009",
      title: "Cancelled Project",
      status: "cancelled",
    });

    const result = await runMigration({
      config: configPath,
      skipGatewayCheck: true,
    });
    const r = result.projects.find((p) => p.id === "PRO-009")!;

    expect(r.outcome).toBe("migrated");
    expect(r.projectStatus).toBe("cancelled");
    expect(r.sliceStatus).toBe("cancelled");
  });

  it("archived → unchanged, skipped", async () => {
    await seedProject(projectsRoot, {
      id: "PRO-010",
      title: "Archived Project",
      status: "archived",
    });

    const result = await runMigration({
      config: configPath,
      skipGatewayCheck: true,
    });
    const r = result.projects.find((p) => p.id === "PRO-010")!;

    expect(r.outcome).toBe("skipped");
    // README not modified
    const fm = await readFrontmatter(
      path.join(projectsRoot, "PRO-010", "README.md")
    );
    expect(fm.status).toBe("archived");
    // slices/ not created
    await expect(
      fs.stat(path.join(projectsRoot, "PRO-010", "slices"))
    ).rejects.toThrow();
  });

  // ─── Idempotency ─────────────────────────────────────────────────────────────

  it("skips already-migrated projects (has slices/)", async () => {
    await seedProject(projectsRoot, {
      id: "PRO-011",
      title: "Already Migrated",
      status: "todo",
    });

    // First run
    await runMigration({ config: configPath, skipGatewayCheck: true });

    // Second run
    const result2 = await runMigration({
      config: configPath,
      skipGatewayCheck: true,
    });
    const r = result2.projects.find((p) => p.id === "PRO-011")!;
    expect(r.outcome).toBe("skipped");

    // No second slice created
    const slices = await fs.readdir(
      path.join(projectsRoot, "PRO-011", "slices")
    );
    expect(slices.filter((s) => /^PRO-011-S/.test(s))).toHaveLength(1);
  });

  // ─── Intact files ─────────────────────────────────────────────────────────────

  it("README.md content (pitch) and THREAD.md remain intact after migration", async () => {
    const seed = await seedProject(projectsRoot, {
      id: "PRO-012",
      title: "Content Check",
      status: "in_progress",
      thread: "## 2026-05-01\n\nDecision: use SQLite.",
    });

    const originalReadme = await fs.readFile(
      path.join(seed, "README.md"),
      "utf8"
    );
    const originalPitchBody = originalReadme.replace(/^---[\s\S]*?---\n/, "");

    await runMigration({ config: configPath, skipGatewayCheck: true });

    // README content unchanged (only frontmatter status updated)
    const updatedReadme = await fs.readFile(
      path.join(seed, "README.md"),
      "utf8"
    );
    const updatedPitchBody = updatedReadme.replace(/^---[\s\S]*?---\n/, "");
    expect(updatedPitchBody).toBe(originalPitchBody);

    // THREAD.md at project root remains (untouched)
    const thread = await fs.readFile(path.join(seed, "THREAD.md"), "utf8");
    expect(thread).toBe("## 2026-05-01\n\nDecision: use SQLite.");
  });

  it("run state.json files are not touched", async () => {
    const seed = await seedProject(projectsRoot, {
      id: "PRO-013",
      title: "State Check",
      status: "in_progress",
    });

    // Write a fake state.json
    const sessionsDir = path.join(seed, "sessions", "worker");
    await fs.mkdir(sessionsDir, { recursive: true });
    const stateContent = JSON.stringify({ runId: "abc123", status: "done" });
    const statePath = path.join(sessionsDir, "state.json");
    await fs.writeFile(statePath, stateContent, "utf8");

    await runMigration({ config: configPath, skipGatewayCheck: true });

    // state.json unchanged
    const afterContent = await fs.readFile(statePath, "utf8");
    expect(afterContent).toBe(stateContent);
  });

  // ─── Counters ─────────────────────────────────────────────────────────────────

  it("creates .meta/counters.json with lastSliceId: 1", async () => {
    await seedProject(projectsRoot, {
      id: "PRO-014",
      title: "Counter Test",
      status: "todo",
    });

    await runMigration({ config: configPath, skipGatewayCheck: true });

    const countersPath = path.join(
      projectsRoot,
      "PRO-014",
      ".meta",
      "counters.json"
    );
    const counters = JSON.parse(await fs.readFile(countersPath, "utf8")) as {
      lastSliceId: number;
    };
    expect(counters.lastSliceId).toBe(1);
  });

  // ─── Slice THREAD.md ──────────────────────────────────────────────────────────

  it("initializes empty slice THREAD.md", async () => {
    await seedProject(projectsRoot, {
      id: "PRO-015",
      title: "Thread Init",
      status: "todo",
    });

    await runMigration({ config: configPath, skipGatewayCheck: true });

    const threadPath = path.join(
      projectsRoot,
      "PRO-015",
      "slices",
      "PRO-015-S01",
      "THREAD.md"
    );
    const content = await fs.readFile(threadPath, "utf8");
    expect(content).toBe("");
  });

  // ─── Summary counts ───────────────────────────────────────────────────────────

  it("returns correct summary counts for mixed statuses", async () => {
    await seedProject(projectsRoot, {
      id: "PRO-101",
      title: "A",
      status: "todo",
    });
    await seedProject(projectsRoot, {
      id: "PRO-102",
      title: "B",
      status: "not_now",
    });
    await seedProject(projectsRoot, {
      id: "PRO-103",
      title: "C",
      status: "archived",
    });

    const result = await runMigration({
      config: configPath,
      skipGatewayCheck: true,
    });

    expect(result.migratedCount).toBe(1); // PRO-101
    expect(result.noSliceCount).toBe(1); // PRO-102
    expect(result.skippedCount).toBe(1); // PRO-103
  });

  // ─── Gateway check ────────────────────────────────────────────────────────────

  it("throws if gateway is detected running", async () => {
    await seedProject(projectsRoot, {
      id: "PRO-201",
      title: "X",
      status: "todo",
    });

    // Mock isPortReachable by making isGatewayRunning return true via net mock
    // We patch the gateway port to something occupied by an actual server.
    // Simpler: patch the config to use port of a server we start.
    const net = await import("node:net");
    const server = net.createServer();
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    const addr = server.address() as { port: number };

    // Write config pointing to occupied port
    const specialConfig = path.join(homeDir, "test-gateway.json");
    await fs.writeFile(
      specialConfig,
      JSON.stringify({
        agents: [],
        projects: { root: projectsRoot },
        gateway: { port: addr.port },
      }),
      "utf8"
    );

    try {
      await expect(runMigration({ config: specialConfig })).rejects.toThrow(
        /Gateway is running/
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
