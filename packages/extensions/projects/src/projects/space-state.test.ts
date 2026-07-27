import type { GatewayConfig } from "@yoplai/shared";
import { describe, expect, it } from "vitest";
import {
  buildSpaceDefaults,
  parseSpaceFile,
  SpaceStateStore,
  type ProjectSpace,
  type SpaceProjectContext,
} from "./space-state.js";

describe("space state", () => {
  it("normalizes space.json queue entries", () => {
    const parsed = parseSpaceFile(
      JSON.stringify({
        projectId: " PRO-1 ",
        branch: " space/PRO-1 ",
        worktreePath: " /tmp/space ",
        integrationBlocked: true,
        queue: [
          {
            id: "entry-1",
            workerSlug: " alpha ",
            runMode: "clone",
            worktreePath: " /tmp/worker ",
            shas: [" a ", "", 42, "b"],
            status: "unknown",
            createdAt: "2026-05-06T00:00:00.000Z",
          },
          { id: "", workerSlug: "bad", worktreePath: "/tmp/bad" },
        ],
      })
    );

    expect(parsed?.projectId).toBe("PRO-1");
    expect(parsed?.baseBranch).toBe("main");
    expect(parsed?.integrationBlocked).toBe(true);
    expect(parsed?.queue).toHaveLength(1);
    expect(parsed?.queue[0]).toMatchObject({
      id: "entry-1",
      workerSlug: "alpha",
      runMode: "clone",
      worktreePath: "/tmp/worker",
      shas: ["a", "b"],
      status: "pending",
    });
  });

  it("serializes concurrent project-space mutations", async () => {
    const config = {
      agents: [],
      sessions: { idleMinutes: 360 },
      projects: { root: "/tmp/projects" },
    } as unknown as GatewayConfig;
    let persisted = buildSpaceDefaults({ config, projectId: "PRO-1" });
    let releaseFirst!: () => void;
    const firstPending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let secondStarted = false;

    class MemorySpaceStateStore extends SpaceStateStore {
      override async resolveProjectContext(): Promise<SpaceProjectContext> {
        return {
          projectId: "PRO-1",
          projectDir: "/tmp/projects/PRO-1",
          repo: "/tmp/repo",
          spaceFilePath: "/tmp/projects/PRO-1/space.json",
          leaseFilePath: "/tmp/projects/PRO-1/space-lease.json",
        };
      }

      override async readSpaceFile(): Promise<ProjectSpace> {
        return structuredClone(persisted);
      }

      override async writeSpaceFile(
        _filePath: string,
        space: ProjectSpace
      ): Promise<void> {
        persisted = structuredClone(space);
      }
    }

    const firstStore = new MemorySpaceStateStore(config);
    const secondStore = new MemorySpaceStateStore(config);
    const first = firstStore.persistProjectSpace("PRO-1", async (space) => {
      await firstPending;
      return {
        ...space,
        queue: [
          {
            id: "first",
            workerSlug: "alpha",
            runMode: "worktree",
            worktreePath: "/tmp/alpha",
            shas: ["a"],
            status: "pending",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      };
    });
    const second = secondStore.persistProjectSpace("PRO-1", (space) => {
      secondStarted = true;
      return {
        ...space,
        queue: [
          ...space.queue,
          {
            id: "second",
            workerSlug: "beta",
            runMode: "worktree",
            worktreePath: "/tmp/beta",
            shas: ["b"],
            status: "pending",
            createdAt: "2026-01-01T00:00:01.000Z",
          },
        ],
      };
    });

    await Promise.resolve();
    expect(secondStarted).toBe(false);
    releaseFirst();
    await Promise.all([first, second]);
    expect(persisted.queue.map((entry) => entry.id)).toEqual([
      "first",
      "second",
    ]);
  });
});
