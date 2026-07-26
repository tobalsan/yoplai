import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import os from "node:os";
import type { GatewayConfig } from "@yoplai/shared";
import {
  getCachedSpace,
  invalidateSpaceCache,
} from "./space-cache.js";

async function waitFor<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 2_000
): Promise<T> {
  const started = Date.now();
  let last: T;
  do {
    last = await fn();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() - started < timeoutMs);
  return last;
}

async function writeProjectReadme(
  projectDir: string,
  id: string,
  title = "Space Cache Test"
): Promise<void> {
  const frontmatter = [
    "---",
    `id: ${JSON.stringify(id)}`,
    `title: ${JSON.stringify(title)}`,
    "---",
    "",
    `# ${title}`,
    "",
  ].join("\n");
  await fs.writeFile(path.join(projectDir, "README.md"), frontmatter, "utf8");
}

async function writeSpaceFile(
  projectDir: string,
  projectId: string,
  branch: string
): Promise<void> {
  await fs.writeFile(
    path.join(projectDir, "space.json"),
    JSON.stringify(
      {
        version: 1,
        projectId,
        branch,
        worktreePath: `/tmp/${projectId}`,
        baseBranch: "main",
        integrationBlocked: false,
        queue: [
          {
            id: "entry-1",
            workerSlug: "alpha",
            runMode: "worktree",
            worktreePath: `/tmp/${projectId}/alpha`,
            shas: ["abc123"],
            status: "pending",
            createdAt: "2026-04-30T00:00:00.000Z",
          },
        ],
        updatedAt: "2026-04-30T00:00:00.000Z",
      },
      null,
      2
    ),
    "utf8"
  );
}

describe("space cache", () => {
  let tmpDir: string;
  let projectsRoot: string;
  let config: GatewayConfig;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-space-cache-"));
    projectsRoot = path.join(tmpDir, "projects");
    await fs.mkdir(projectsRoot, { recursive: true });
    config = {
      agents: [],
      sessions: { idleMinutes: 360 },
      projects: { root: projectsRoot },
    } as unknown as GatewayConfig;
  });

  afterEach(async () => {
    invalidateSpaceCache();
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns null when space.json does not exist", async () => {
    const projectDir = path.join(projectsRoot, "PRO-1_space-cache");
    await fs.mkdir(projectDir, { recursive: true });
    await writeProjectReadme(projectDir, "PRO-1");

    await expect(getCachedSpace(config, "PRO-1")).resolves.toBeNull();
  });

  it("returns parsed content when space.json exists", async () => {
    const projectDir = path.join(projectsRoot, "PRO-1_space-cache");
    await fs.mkdir(projectDir, { recursive: true });
    await writeProjectReadme(projectDir, "PRO-1");
    await writeSpaceFile(projectDir, "PRO-1", "space/PRO-1");

    const space = await getCachedSpace(config, "PRO-1");

    expect(space?.projectId).toBe("PRO-1");
    expect(space?.branch).toBe("space/PRO-1");
    expect(space?.queue[0]?.workerSlug).toBe("alpha");
  });

  it("returns same cached object on second read", async () => {
    const projectDir = path.join(projectsRoot, "PRO-1_space-cache");
    await fs.mkdir(projectDir, { recursive: true });
    await writeProjectReadme(projectDir, "PRO-1");
    await writeSpaceFile(projectDir, "PRO-1", "space/PRO-1");

    const first = await getCachedSpace(config, "PRO-1");
    const second = await getCachedSpace(config, "PRO-1");

    expect(second).toBe(first);
  });

  it("invalidates and re-reads after file is modified", async () => {
    const projectDir = path.join(projectsRoot, "PRO-1_space-cache");
    await fs.mkdir(projectDir, { recursive: true });
    await writeProjectReadme(projectDir, "PRO-1");
    await writeSpaceFile(projectDir, "PRO-1", "space/PRO-1");
    await getCachedSpace(config, "PRO-1");

    await writeSpaceFile(projectDir, "PRO-1", "space/PRO-1-updated");
    const updated = await waitFor(
      () => getCachedSpace(config, "PRO-1"),
      (space) => space?.branch === "space/PRO-1-updated"
    );

    expect(updated?.branch).toBe("space/PRO-1-updated");
  });

  it("handles malformed JSON without throwing", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const projectDir = path.join(projectsRoot, "PRO-1_space-cache");
    await fs.mkdir(projectDir, { recursive: true });
    await writeProjectReadme(projectDir, "PRO-1");
    await fs.writeFile(path.join(projectDir, "space.json"), "{", "utf8");

    await expect(getCachedSpace(config, "PRO-1")).resolves.toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("failed to parse space.json:")
    );
  });

  it("handles file deletion mid-watch", async () => {
    const projectDir = path.join(projectsRoot, "PRO-1_space-cache");
    await fs.mkdir(projectDir, { recursive: true });
    await writeProjectReadme(projectDir, "PRO-1");
    await writeSpaceFile(projectDir, "PRO-1", "space/PRO-1");
    expect(await getCachedSpace(config, "PRO-1")).not.toBeNull();

    await fs.unlink(path.join(projectDir, "space.json"));
    const deleted = await waitFor(
      () => getCachedSpace(config, "PRO-1"),
      (space) => space === null
    );

    expect(deleted).toBeNull();
  });

  it("invalidateSpaceCache(projectId) clears that entry only", async () => {
    const projectOneDir = path.join(projectsRoot, "PRO-1_space-cache");
    const projectTwoDir = path.join(projectsRoot, "PRO-2_space-cache");
    await fs.mkdir(projectOneDir, { recursive: true });
    await fs.mkdir(projectTwoDir, { recursive: true });
    await writeProjectReadme(projectOneDir, "PRO-1");
    await writeProjectReadme(projectTwoDir, "PRO-2");
    await writeSpaceFile(projectOneDir, "PRO-1", "space/PRO-1");
    await writeSpaceFile(projectTwoDir, "PRO-2", "space/PRO-2");

    const firstOne = await getCachedSpace(config, "PRO-1");
    const firstTwo = await getCachedSpace(config, "PRO-2");
    invalidateSpaceCache("PRO-1");

    expect(await getCachedSpace(config, "PRO-1")).not.toBe(firstOne);
    expect(await getCachedSpace(config, "PRO-2")).toBe(firstTwo);
  });

  it("invalidateSpaceCache() clears all entries", async () => {
    const projectOneDir = path.join(projectsRoot, "PRO-1_space-cache");
    const projectTwoDir = path.join(projectsRoot, "PRO-2_space-cache");
    await fs.mkdir(projectOneDir, { recursive: true });
    await fs.mkdir(projectTwoDir, { recursive: true });
    await writeProjectReadme(projectOneDir, "PRO-1");
    await writeProjectReadme(projectTwoDir, "PRO-2");
    await writeSpaceFile(projectOneDir, "PRO-1", "space/PRO-1");
    await writeSpaceFile(projectTwoDir, "PRO-2", "space/PRO-2");

    const firstOne = await getCachedSpace(config, "PRO-1");
    const firstTwo = await getCachedSpace(config, "PRO-2");
    invalidateSpaceCache();

    expect(await getCachedSpace(config, "PRO-1")).not.toBe(firstOne);
    expect(await getCachedSpace(config, "PRO-2")).not.toBe(firstTwo);
  });

  it("dedupes concurrent reads of same project", async () => {
    const projectDir = path.join(projectsRoot, "PRO-1_space-cache");
    await fs.mkdir(projectDir, { recursive: true });
    await writeProjectReadme(projectDir, "PRO-1");
    await writeSpaceFile(projectDir, "PRO-1", "space/PRO-1");

    const [first, second] = await Promise.all([
      getCachedSpace(config, "PRO-1"),
      getCachedSpace(config, "PRO-1"),
    ]);

    expect(second).toBe(first);
  });
});
