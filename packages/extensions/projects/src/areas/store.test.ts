import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import os from "node:os";

describe("areas store", () => {
  let tmpDir: string;
  let projectsRoot: string;
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-areas-store-"));
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

  it("supports area CRUD", async () => {
    const { createArea, listAreas, getArea, updateArea, deleteArea } =
      await import("./store.js");
    const config = {
      agents: [],
      sessions: { idleMinutes: 360 },
      projects: { root: projectsRoot },
    };

    const created = await createArea(config, {
      id: "yoplai",
      title: "Yoplai",
      color: "#3b8ecc",
      order: 2,
    });
    expect(created.id).toBe("yoplai");

    const fetched = await getArea(config, "yoplai");
    expect(fetched?.title).toBe("Yoplai");

    await createArea(config, {
      id: "cloudifai",
      title: "Cloudifai",
      color: "#8a3bcc",
      order: 1,
    });
    const listed = await listAreas(config);
    expect(listed.map((area) => area.id)).toEqual(["cloudifai", "yoplai"]);

    const updated = await updateArea(config, "yoplai", {
      title: "Yoplai v3",
      order: 0,
    });
    expect(updated.title).toBe("Yoplai v3");
    expect(updated.order).toBe(0);

    const deleted = await deleteArea(config, "yoplai");
    expect(deleted).toBe(true);
    expect(await getArea(config, "yoplai")).toBeNull();
  });

  it("migrates inferred areas and seeds defaults", async () => {
    const { migrateAreas } = await import("./store.js");
    const config = {
      agents: [],
      sessions: { idleMinutes: 360 },
      projects: { root: projectsRoot },
    };

    const areaDir = path.join(projectsRoot, "PRO-1_yoplai_area_store");
    const ranksourceDir = path.join(projectsRoot, "PRO-2_ranksource_search");
    const existingAreaDir = path.join(projectsRoot, "PRO-3_cloudifai_core");
    await fs.mkdir(areaDir, { recursive: true });
    await fs.mkdir(ranksourceDir, { recursive: true });
    await fs.mkdir(existingAreaDir, { recursive: true });

    await fs.writeFile(
      path.join(areaDir, "README.md"),
      '---\nid: "PRO-1"\ntitle: "Area Store"\n---\n# Area Store\n',
      "utf8"
    );
    await fs.writeFile(
      path.join(ranksourceDir, "README.md"),
      '---\nid: "PRO-2"\ntitle: "Ranksource"\n---\n# Ranksource\n',
      "utf8"
    );
    await fs.writeFile(
      path.join(existingAreaDir, "README.md"),
      '---\nid: "PRO-3"\ntitle: "Cloudifai"\narea: "cloudifai"\n---\n# Cloudifai\n',
      "utf8"
    );

    const result = await migrateAreas(config);
    expect(result.seededAreas).toEqual(["yoplai", "ranksource", "cloudifai"]);
    expect(result.updatedProjects).toContain("PRO-1_yoplai_area_store");
    expect(result.updatedProjects).toContain("PRO-2_ranksource_search");
    expect(result.skippedProjects).toContain("PRO-3_cloudifai_core");

    const areaReadme = await fs.readFile(
      path.join(areaDir, "README.md"),
      "utf8"
    );
    const ranksourceReadme = await fs.readFile(
      path.join(ranksourceDir, "README.md"),
      "utf8"
    );
    expect(areaReadme).toContain('area: "yoplai"');
    expect(ranksourceReadme).toContain('area: "ranksource"');

    await expect(
      fs.stat(path.join(projectsRoot, ".areas", "yoplai.yaml"))
    ).resolves.toBeDefined();
    await expect(
      fs.stat(path.join(projectsRoot, ".areas", "ranksource.yaml"))
    ).resolves.toBeDefined();
    await expect(
      fs.stat(path.join(projectsRoot, ".areas", "cloudifai.yaml"))
    ).resolves.toBeDefined();
  });
});
