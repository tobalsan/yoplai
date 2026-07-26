import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import os from "node:os";
import {
  parseTasks,
  parseAcceptanceCriteria,
  serializeTasks,
  readSpec,
  writeSpec,
} from "./tasks.js";

describe("projects tasks parser", () => {
  let tmpDir: string;
  let projectsRoot: string;
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-project-tasks-"));
    projectsRoot = path.join(tmpDir, "projects");
    await fs.mkdir(projectsRoot, { recursive: true });
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpDir;
    process.env.USERPROFILE = tmpDir;
    vi.resetModules();
  });

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("parses tasks from markdown section", () => {
    const content = [
      "# Spec",
      "",
      "## Tasks",
      "",
      "### Backend",
      "",
      "- [ ] **Add area YAML store** `status:todo`",
      "  Implement gateway endpoint",
      "",
      "### Frontend",
      "",
      "- [x] **Design token system** `agent:codex-1`",
      "  Define CSS custom properties",
      "",
      "## Notes",
      "Done.",
      "",
    ].join("\n");

    const tasks = parseTasks(content);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toMatchObject({
      title: "Add area YAML store",
      status: "todo",
      checked: false,
      description: "Implement gateway endpoint",
      order: 0,
    });
    expect(tasks[1]).toMatchObject({
      title: "Design token system",
      status: "done",
      checked: true,
      agentId: "codex-1",
      description: "Define CSS custom properties",
      order: 1,
    });
  });

  it("serializes tasks while preserving content outside section", () => {
    const content = [
      "# Spec",
      "",
      "## Tasks",
      "",
      "### Backend",
      "",
      "- [ ] **Old task** `status:todo`",
      "",
      "### Frontend",
      "",
      "- [ ] **Old UI task** `status:todo`",
      "",
      "## Notes",
      "Keep this text.",
      "",
    ].join("\n");
    const tasks = [
      {
        title: "New task",
        description: "Line 1\nLine 2",
        status: "in_progress" as const,
        checked: false,
        order: 0,
      },
      {
        title: "New UI task",
        status: "todo" as const,
        checked: false,
        order: 1,
      },
    ];

    const next = serializeTasks(tasks, content);
    expect(next).toContain("## Tasks");
    expect(next).toContain("### Backend");
    expect(next).toContain("### Frontend");
    expect(next).toContain("- [ ] **New task** `status:in_progress`");
    expect(next).toContain("- [ ] **New UI task** `status:todo`");
    expect(next).toContain("  Line 1");
    expect(next).toContain("## Notes\nKeep this text.");

    const roundTrip = parseTasks(next);
    expect(roundTrip).toHaveLength(2);
    expect(roundTrip[0].title).toBe("New task");
    expect(roundTrip[0].status).toBe("in_progress");
    expect(roundTrip[0].description).toBe("Line 1\nLine 2");
    expect(roundTrip[1].title).toBe("New UI task");
  });

  it("appends new tasks into the last subsection when subsections exist", () => {
    const content = [
      "## Tasks",
      "",
      "### Backend",
      "",
      "- [ ] **Backend task** `status:todo`",
      "",
      "### Frontend",
      "",
      "- [ ] **Frontend task** `status:todo`",
      "",
    ].join("\n");
    const tasks = [
      {
        title: "Backend task",
        status: "todo" as const,
        checked: false,
        order: 0,
      },
      {
        title: "Frontend task",
        status: "todo" as const,
        checked: false,
        order: 1,
      },
      {
        title: "New trailing task",
        status: "todo" as const,
        checked: false,
        order: 2,
      },
    ];

    const next = serializeTasks(tasks, content);
    const frontendIndex = next.indexOf("### Frontend");
    const trailingTaskIndex = next.indexOf("**New trailing task**");
    expect(frontendIndex).toBeGreaterThanOrEqual(0);
    expect(trailingTaskIndex).toBeGreaterThan(frontendIndex);
  });

  it("handles missing and acceptance criteria sections", () => {
    expect(parseTasks("# Empty doc\n")).toEqual([]);

    const content = [
      "## Acceptance Criteria",
      "",
      "- [ ] **Task one**",
      "- [x] **Task two** `status:done`",
      "",
    ].join("\n");
    const acceptance = parseAcceptanceCriteria(content);
    expect(acceptance).toHaveLength(2);
    expect(acceptance[0].status).toBe("todo");
    expect(acceptance[1].status).toBe("done");
  });

  it("reads and writes SPECS.md by project id", async () => {
    const config = {
      agents: [],
      sessions: { idleMinutes: 360 },
      projects: { root: projectsRoot },
    };
    const projectDir = path.join(projectsRoot, "PRO-1_test_project");
    await fs.mkdir(projectDir, { recursive: true });

    const initial = "## Tasks\n\n- [ ] **Initial** `status:todo`\n";
    await writeSpec(config, "PRO-1", initial);
    const afterWrite = await readSpec(config, "PRO-1");
    expect(afterWrite).toContain("Initial");

    await writeSpec(
      config,
      "PRO-1",
      "## Tasks\n\n- [x] **Updated** `status:done`\n"
    );
    const updated = await readSpec(config, "PRO-1");
    expect(updated).toContain("Updated");
    expect(await readSpec(config, "PRO-404")).toBe("");
  });
});
