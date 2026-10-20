import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import os from "node:os";
import { writeTestV3Config } from "../test-utils/v3-config.js";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function setup(branding?: Record<string, unknown>) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-branding-"));
  const homeDir = path.join(tmpDir, ".yoplai");
  process.env.YOPLAI_HOME = homeDir;
  process.env.HOME = tmpDir;
  process.env.USERPROFILE = tmpDir;
  await writeTestV3Config(homeDir, {
    agents: [{ id: "main", name: "Main" }],
    ...(branding ? { extraConfig: { branding } } : {}),
  });
  await fs.mkdir(path.join(homeDir, "branding"), { recursive: true });
  await fs.writeFile(path.join(homeDir, "branding", "icon.png"), PNG_BYTES);
  await fs.writeFile(path.join(tmpDir, "outside.png"), PNG_BYTES);
  vi.resetModules();
  const { clearConfigCacheForTests } = await import("../config/index.js");
  clearConfigCacheForTests();
  const { api } = await import("./api.core.js");
  return { api, tmpDir };
}

describe("branding icon and manifest API", () => {
  const saved = {
    home: process.env.YOPLAI_HOME,
    userHome: process.env.HOME,
    profile: process.env.USERPROFILE,
  };
  const dirs: string[] = [];

  function restoreEnv(key: string, value: string | undefined) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  beforeAll(() => {
    dirs.length = 0;
  });

  afterAll(async () => {
    restoreEnv("YOPLAI_HOME", saved.home);
    restoreEnv("HOME", saved.userHome);
    restoreEnv("USERPROFILE", saved.profile);
    await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it("serves the configured icon with its content type", async () => {
    const { api, tmpDir } = await setup({ name: "Acme", icon: "branding/icon.png" });
    dirs.push(tmpDir);
    const res = await api.request("/branding/icon");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG_BYTES);
  });

  it("returns 404 when no icon is configured", async () => {
    const { api, tmpDir } = await setup();
    dirs.push(tmpDir);
    expect((await api.request("/branding/icon")).status).toBe(404);
  });

  it("rejects an icon path outside the home directory", async () => {
    const { api, tmpDir } = await setup({ icon: "../outside.png" });
    dirs.push(tmpDir);
    expect((await api.request("/branding/icon")).status).toBe(400);
  });

  it("rejects an icon in a sibling directory that shares the home prefix", async () => {
    const { api, tmpDir } = await setup({ icon: "../.yoplai-backup/icon.png" });
    dirs.push(tmpDir);
    await fs.mkdir(path.join(tmpDir, ".yoplai-backup"));
    await fs.writeFile(path.join(tmpDir, ".yoplai-backup", "icon.png"), PNG_BYTES);
    expect((await api.request("/branding/icon")).status).toBe(400);
  });

  it("builds the manifest from branding with an icon", async () => {
    const { api, tmpDir } = await setup({ name: "Acme", icon: "branding/icon.png" });
    dirs.push(tmpDir);
    const res = await api.request("/manifest.webmanifest");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/manifest+json");
    const manifest = await res.json();
    expect(manifest.name).toBe("Acme");
    expect(manifest.short_name).toBe("Acme");
    expect(manifest.display).toBe("standalone");
    expect(manifest.icons).toEqual([
      { src: "/api/branding/icon", sizes: "any", type: "image/png", purpose: "any" },
    ]);
  });

  it("omits manifest icons and defaults the name without branding", async () => {
    const { api, tmpDir } = await setup();
    dirs.push(tmpDir);
    const manifest = await (await api.request("/manifest.webmanifest")).json();
    expect(manifest.name).toBe("Yoplai");
    expect(manifest.icons).toEqual([]);
  });

  it("advertises the icon url in capabilities", async () => {
    const { api, tmpDir } = await setup({ icon: "branding/icon.png" });
    dirs.push(tmpDir);
    const body = await (await api.request("/capabilities")).json();
    expect(body.branding.icon).toBe("/api/branding/icon");
  });
});
