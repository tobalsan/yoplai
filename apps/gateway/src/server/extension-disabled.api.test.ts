import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import os from "node:os";
import { z } from "zod";
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
      extensions: { probe: { enabled: false } },
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

  it("serves core main-agent preferences when multi-user is disabled", async () => {
    const { app } = await import("./index.js");
    const initial = await app.request("/api/me/main-agent");
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({ mainAgentId: null, accessible: false, pickerDismissedAt: null });
    const saved = await app.request("/api/me/main-agent", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ mainAgentId: "main" }) });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ mainAgentId: "main", accessible: true, pickerDismissedAt: null });
    expect(await (await app.request("/api/me/main-agent")).json()).toEqual({ mainAgentId: "main", accessible: true, pickerDismissedAt: null });
    const cleared = await app.request("/api/me/main-agent", { method: "DELETE" });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ mainAgentId: null, accessible: false, pickerDismissedAt: null });
    for (const url of ["/api/me", "/api/me/admin", "/api/admin/users"]) {
      const blocked = await app.request(url);
      expect(blocked.status).toBe(404);
      expect(await blocked.json()).toEqual({ error: "extension_disabled", extension: "multiUser" });
    }
  });

  it("serves core extension flags through the full app when multi-user is disabled", async () => {
    const { app } = await import("./index.js");
    const expected = { extensions: ["webhooks"], mcp: ["https://a.test/mcp"], system: { extensions: ["webhooks"], mcp: ["https://a.test/mcp"] } };
    const saved = await app.request("/api/admin/top-extensions", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(expected),
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual(expected);
    expect(await (await app.request("/api/top-extensions")).json()).toEqual(expected);
    expect(await (await app.request("/api/admin/top-extensions")).json()).toMatchObject(expected);
    expect((await app.request("/api/admin/users")).status).toBe(404);
  });

  it("gates routes loaded from an external extension", async () => {
    const { getExtensionRuntime } = await import("../extensions/registry.js");
    getExtensionRuntime().load([
      {
        id: "probe",
        displayName: "Probe",
        description: "Probe extension",
        dependencies: [],
        configSchema: z.object({}),
        routePrefixes: ["/api/probe"],
        validateConfig: () => ({ valid: true, errors: [] }),
        registerRoutes: () => undefined,
        start: async () => undefined,
        stop: async () => undefined,
        capabilities: () => [],
      },
    ]);
    const { app } = await import("./index.js");

    for (const path of ["/api/probe", "/api/probe/sub"]) {
      const response = await Promise.resolve(app.request(path));
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        error: "extension_disabled",
        extension: "probe",
      });
    }
  });
});
