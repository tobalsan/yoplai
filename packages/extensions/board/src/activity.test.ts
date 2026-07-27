import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  aggregateActivity,
  MAX_ACTIVITY_ITEMS,
  resetActivityCache,
} from "./activity.js";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "yoplai-board-activity-"));
}

function makeProject(
  root: string,
  id: string,
  frontmatter: Record<string, string>
): string {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  fs.writeFileSync(path.join(dir, "README.md"), `---\n${fm}\n---\n\nbody\n`);
  return dir;
}

function makeSlice(
  projectDir: string,
  sliceId: string,
  frontmatter: Record<string, string>
): string {
  const dir = path.join(projectDir, "slices", sliceId);
  fs.mkdirSync(dir, { recursive: true });
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  fs.writeFileSync(path.join(dir, "README.md"), `---\n${fm}\n---\n\nbody\n`);
  return dir;
}

function makeSession(
  projectDir: string,
  slug: string,
  state: Record<string, unknown>
): void {
  const dir = path.join(projectDir, "sessions", slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state));
}

function makeThread(
  dir: string,
  entries: Array<{ author: string; date: string; body: string }>
): void {
  const sections = entries
    .map((e) => `[author:${e.author}]\n[date:${e.date}]\n${e.body}`)
    .join("\n\n---\n---\n\n");
  fs.writeFileSync(path.join(dir, "THREAD.md"), sections + "\n");
}

describe("board activity feed aggregator", () => {
  let tmpDir: string;
  let projectsRoot: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    projectsRoot = path.join(tmpDir, "projects");
    fs.mkdirSync(projectsRoot, { recursive: true });
    resetActivityCache();
  });

  afterEach(() => {
    resetActivityCache();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array for empty projects root", async () => {
    const items = await aggregateActivity({ projectsRoot });
    expect(items).toEqual([]);
  });

  it("aggregates project status from frontmatter", async () => {
    makeProject(projectsRoot, "PRO-001", {
      id: "PRO-001",
      title: "Test",
      status: "active",
      updated_at: "2025-01-10T10:00:00.000Z",
    });

    const items = await aggregateActivity({ projectsRoot });
    const projectItem = items.find(
      (i) => i.type === "project_status" && i.projectId === "PRO-001"
    );
    expect(projectItem).toBeDefined();
    expect(projectItem?.actor).toBe("PRO-001");
    expect(projectItem?.action).toBe("→ active");
    expect(projectItem?.timestamp).toBe("2025-01-10T10:00:00.000Z");
    expect(projectItem?.color).toBe("green");
  });

  it("aggregates slice status from frontmatter", async () => {
    const projDir = makeProject(projectsRoot, "PRO-002", {
      id: "PRO-002",
      status: "active",
      updated_at: "2025-01-01T00:00:00.000Z",
    });
    makeSlice(projDir, "PRO-002-S01", {
      id: "PRO-002-S01",
      status: "review",
      updated_at: "2025-01-15T08:00:00.000Z",
    });

    const items = await aggregateActivity({ projectsRoot });
    const sliceItem = items.find(
      (i) => i.type === "slice_status" && i.sliceId === "PRO-002-S01"
    );
    expect(sliceItem).toBeDefined();
    expect(sliceItem?.actor).toBe("PRO-002-S01");
    expect(sliceItem?.action).toBe("→ review");
    expect(sliceItem?.timestamp).toBe("2025-01-15T08:00:00.000Z");
    expect(sliceItem?.color).toBe("purple");
  });

  it("aggregates run_start and run_complete from session state.json", async () => {
    const projDir = makeProject(projectsRoot, "PRO-003", {
      id: "PRO-003",
      status: "active",
      updated_at: "2025-01-01T00:00:00.000Z",
    });
    makeSession(projDir, "worker", {
      started_at: "2025-02-01T09:00:00.000Z",
      finished_at: "2025-02-01T10:00:00.000Z",
      outcome: "done",
      cli: "codex",
    });

    const items = await aggregateActivity({ projectsRoot });
    const startItem = items.find(
      (i) => i.type === "run_start" && i.runSlug === "worker"
    );
    const completeItem = items.find(
      (i) => i.type === "run_complete" && i.runSlug === "worker"
    );

    expect(startItem?.timestamp).toBe("2025-02-01T09:00:00.000Z");
    expect(startItem?.action).toBe("run started");
    expect(startItem?.color).toBe("green");

    expect(completeItem?.timestamp).toBe("2025-02-01T10:00:00.000Z");
    expect(completeItem?.action).toBe("run completed");
    expect(completeItem?.color).toBe("green");
  });

  it("marks errored run with yellow color", async () => {
    const projDir = makeProject(projectsRoot, "PRO-004", {
      id: "PRO-004",
      status: "active",
      updated_at: "2025-01-01T00:00:00.000Z",
    });
    makeSession(projDir, "runner", {
      started_at: "2025-03-01T08:00:00.000Z",
      finished_at: "2025-03-01T08:30:00.000Z",
      outcome: "error",
      cli: "claude",
    });

    const items = await aggregateActivity({ projectsRoot });
    const completeItem = items.find(
      (i) => i.type === "run_complete" && i.projectId === "PRO-004"
    );
    expect(completeItem?.color).toBe("yellow");
    expect(completeItem?.action).toBe("run errored");
  });

  it("aggregates THREAD.md comments with timestamps", async () => {
    const projDir = makeProject(projectsRoot, "PRO-005", {
      id: "PRO-005",
      status: "active",
      updated_at: "2025-01-01T00:00:00.000Z",
    });
    makeThread(projDir, [
      {
        author: "Alice",
        date: "2025-04-01T12:00:00.000Z",
        body: "Initial comment",
      },
      {
        author: "Bob",
        date: "2025-04-02T09:00:00.000Z",
        body: "Follow-up note",
      },
    ]);

    const items = await aggregateActivity({ projectsRoot });
    const comments = items.filter(
      (i) => i.type === "thread_comment" && i.projectId === "PRO-005"
    );
    expect(comments).toHaveLength(2);
    const alice = comments.find((i) => i.actor === "Alice");
    expect(alice?.action).toBe("Initial comment");
    expect(alice?.timestamp).toBe("2025-04-01T12:00:00.000Z");
  });

  it("aggregates slice THREAD.md comments", async () => {
    const projDir = makeProject(projectsRoot, "PRO-006", {
      id: "PRO-006",
      status: "active",
      updated_at: "2025-01-01T00:00:00.000Z",
    });
    const sliceDir = makeSlice(projDir, "PRO-006-S01", {
      status: "in_progress",
      updated_at: "2025-01-05T00:00:00.000Z",
    });
    makeThread(sliceDir, [
      { author: "Dev", date: "2025-01-06T10:00:00.000Z", body: "Slice note" },
    ]);

    const items = await aggregateActivity({ projectsRoot });
    const sliceComment = items.find(
      (i) => i.type === "thread_comment" && i.sliceId === "PRO-006-S01"
    );
    expect(sliceComment).toBeDefined();
    expect(sliceComment?.actor).toBe("Dev");
    expect(sliceComment?.action).toBe("Slice note");
  });

  it("sorts items newest first", async () => {
    const projDir = makeProject(projectsRoot, "PRO-007", {
      id: "PRO-007",
      status: "active",
      updated_at: "2025-01-03T00:00:00.000Z",
    });
    makeThread(projDir, [
      { author: "X", date: "2025-01-01T00:00:00.000Z", body: "older" },
      { author: "Y", date: "2025-01-05T00:00:00.000Z", body: "newer" },
    ]);

    const items = await aggregateActivity({ projectsRoot });
    const timestamps = items.map((i) => i.timestamp);
    for (let idx = 0; idx < timestamps.length - 1; idx++) {
      const a = new Date(timestamps[idx] ?? "").getTime();
      const b = new Date(timestamps[idx + 1] ?? "").getTime();
      expect(a).toBeGreaterThanOrEqual(b);
    }
  });

  it("caps at MAX_ACTIVITY_ITEMS (100)", async () => {
    // Create enough events to exceed the cap
    for (let i = 1; i <= 30; i++) {
      const id = `PRO-${String(i).padStart(3, "0")}`;
      const projDir = makeProject(projectsRoot, id, {
        id,
        status: "active",
        updated_at: `2025-01-${String(i).padStart(2, "0")}T00:00:00.000Z`,
      });
      // Add 3 thread entries per project → 30*3 = 90 thread + 30 project = 120 events total
      makeThread(projDir, [
        {
          author: "A",
          date: `2025-02-${String(i).padStart(2, "0")}T00:00:00.000Z`,
          body: "c1",
        },
        {
          author: "B",
          date: `2025-02-${String(i).padStart(2, "0")}T01:00:00.000Z`,
          body: "c2",
        },
        {
          author: "C",
          date: `2025-02-${String(i).padStart(2, "0")}T02:00:00.000Z`,
          body: "c3",
        },
      ]);
    }

    const items = await aggregateActivity({
      projectsRoot,
      limit: MAX_ACTIVITY_ITEMS,
    });
    expect(items.length).toBeLessThanOrEqual(MAX_ACTIVITY_ITEMS);
  });

  it("respects custom limit parameter", async () => {
    makeProject(projectsRoot, "PRO-010", {
      id: "PRO-010",
      status: "active",
      updated_at: "2025-01-10T00:00:00.000Z",
    });
    const projDir = path.join(projectsRoot, "PRO-010");
    makeThread(projDir, [
      { author: "A", date: "2025-01-11T00:00:00.000Z", body: "c1" },
      { author: "B", date: "2025-01-12T00:00:00.000Z", body: "c2" },
      { author: "C", date: "2025-01-13T00:00:00.000Z", body: "c3" },
    ]);

    const items = await aggregateActivity({ projectsRoot, limit: 2 });
    expect(items.length).toBeLessThanOrEqual(2);
  });

  it("filters to a specific project with projectId", async () => {
    makeProject(projectsRoot, "PRO-011", {
      id: "PRO-011",
      status: "active",
      updated_at: "2025-01-01T00:00:00.000Z",
    });
    makeProject(projectsRoot, "PRO-012", {
      id: "PRO-012",
      status: "shaping",
      updated_at: "2025-01-02T00:00:00.000Z",
    });

    const items = await aggregateActivity({
      projectsRoot,
      projectId: "PRO-012",
    });
    expect(items.every((i) => i.projectId === "PRO-012")).toBe(true);
    expect(items.length).toBeGreaterThan(0);
  });

  it("returns empty for unknown projectId", async () => {
    const items = await aggregateActivity({
      projectsRoot,
      projectId: "PRO-999",
    });
    expect(items).toHaveLength(0);
  });

  it("does not scan outside the projects root", async () => {
    makeProject(tmpDir, "PRO-OUTSIDE", {
      id: "PRO-OUTSIDE",
      status: "active",
      updated_at: "2025-01-01T00:00:00.000Z",
    });

    const items = await aggregateActivity({
      projectsRoot,
      projectId: "../PRO-OUTSIDE",
    });
    expect(items).toEqual([]);
  });

  it("uses in-memory cache on repeated requests", async () => {
    makeProject(projectsRoot, "PRO-013", {
      id: "PRO-013",
      status: "active",
      updated_at: "2025-01-10T00:00:00.000Z",
    });

    const items1 = await aggregateActivity({ projectsRoot });
    // Add a new project AFTER first call — cache should return same result
    makeProject(projectsRoot, "PRO-014", {
      id: "PRO-014",
      status: "active",
      updated_at: "2025-01-11T00:00:00.000Z",
    });
    const items2 = await aggregateActivity({ projectsRoot });

    // items2 should come from cache (same as items1)
    expect(items2).toHaveLength(items1.length);
  });

  it("cache is invalidated after TTL", async () => {
    const now = Date.now();
    vi.setSystemTime(now);

    makeProject(projectsRoot, "PRO-015", {
      id: "PRO-015",
      status: "active",
      updated_at: "2025-01-10T00:00:00.000Z",
    });

    const items1 = await aggregateActivity({ projectsRoot, cacheTtlMs: 100 });

    // Add new project and advance time past TTL
    makeProject(projectsRoot, "PRO-016", {
      id: "PRO-016",
      status: "shaping",
      updated_at: "2025-01-11T00:00:00.000Z",
    });
    vi.setSystemTime(now + 200);

    const items2 = await aggregateActivity({ projectsRoot, cacheTtlMs: 100 });
    expect(items2.length).toBeGreaterThan(items1.length);

    vi.useRealTimers();
  });

  it("deduplicates events by id", async () => {
    makeProject(projectsRoot, "PRO-020", {
      id: "PRO-020",
      status: "done",
      updated_at: "2025-06-01T00:00:00.000Z",
    });

    // Call twice with same params (cache miss because resetActivityCache called in afterEach)
    const items1 = await aggregateActivity({ projectsRoot, cacheTtlMs: 0 });
    resetActivityCache();
    const items2 = await aggregateActivity({ projectsRoot, cacheTtlMs: 0 });

    // Each call should return same items (no duplicates within a single response)
    const ids1 = items1.map((i) => i.id);
    expect(new Set(ids1).size).toBe(ids1.length);
    const ids2 = items2.map((i) => i.id);
    expect(new Set(ids2).size).toBe(ids2.length);
  });

  it("formats item fields: id, type, projectId, actor, action, timestamp, color", async () => {
    makeProject(projectsRoot, "PRO-021", {
      id: "PRO-021",
      status: "review",
      updated_at: "2025-07-01T00:00:00.000Z",
    });

    const items = await aggregateActivity({ projectsRoot });
    const item = items.find(
      (i) => i.projectId === "PRO-021" && i.type === "project_status"
    );
    expect(item).toMatchObject({
      id: expect.stringContaining("PRO-021"),
      type: "project_status",
      projectId: "PRO-021",
      actor: "PRO-021",
      action: "→ review",
      timestamp: "2025-07-01T00:00:00.000Z",
      color: "purple",
    });
  });

  it("truncates long THREAD.md body to 60 chars with ellipsis", async () => {
    const projDir = makeProject(projectsRoot, "PRO-022", {
      id: "PRO-022",
      status: "active",
      updated_at: "2025-01-01T00:00:00.000Z",
    });
    const longBody = "A".repeat(80);
    makeThread(projDir, [
      { author: "Alice", date: "2025-01-02T00:00:00.000Z", body: longBody },
    ]);

    const items = await aggregateActivity({ projectsRoot });
    const comment = items.find((i) => i.type === "thread_comment");
    expect(comment?.action?.length).toBeLessThanOrEqual(61); // 60 + ellipsis char
    expect(comment?.action).toMatch(/…$/);
  });

  it("includes sliceId on run events when state.json has slice_id", async () => {
    const projDir = makeProject(projectsRoot, "PRO-023", {
      id: "PRO-023",
      status: "active",
      updated_at: "2025-01-01T00:00:00.000Z",
    });
    makeSlice(projDir, "PRO-023-S01", {
      status: "in_progress",
      updated_at: "2025-01-02T00:00:00.000Z",
    });
    makeSession(projDir, "worker-s01", {
      started_at: "2025-01-03T09:00:00.000Z",
      slice_id: "PRO-023-S01",
      cli: "codex",
    });

    const items = await aggregateActivity({ projectsRoot });
    const runItem = items.find(
      (i) => i.type === "run_start" && i.runSlug === "worker-s01"
    );
    expect(runItem?.sliceId).toBe("PRO-023-S01");
  });
});
