import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import os from "node:os";
import { writeTestV3Config } from "../test-utils/v3-config.js";

describe("extension-disabled API responses", () => {
  let tmpDir: string;
  let prevHomeDir: string | undefined;
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-component-404-"));
    prevHomeDir = process.env.YOPLAI_HOME;
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    process.env.YOPLAI_HOME = path.join(tmpDir, ".yoplai");
    process.env.HOME = tmpDir;
    process.env.USERPROFILE = tmpDir;

    await writeTestV3Config(path.join(tmpDir, ".yoplai"), {
      agents: [{ id: "main", name: "Main" }],
      extensions: {},
    });

    vi.resetModules();
    const { clearConfigCacheForTests } = await import("../config/index.js");
    clearConfigCacheForTests();
  });

  afterAll(async () => {
    if (prevHomeDir === undefined) delete process.env.YOPLAI_HOME;
    else process.env.YOPLAI_HOME = prevHomeDir;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns a structured 404 for disabled extension routes", async () => {
    const { app } = await import("./index.js");

    const response = await Promise.resolve(app.request("/api/projects"));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "extension_disabled",
      extension: "projects",
    });
  });
});
