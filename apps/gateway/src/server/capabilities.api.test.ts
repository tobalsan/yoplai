import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import os from "node:os";
import { writeTestV3Config } from "../test-utils/v3-config.js";

describe("/capabilities API", () => {
  let tmpDir: string;
  let prevHomeDir: string | undefined;
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-capabilities-"));
    prevHomeDir = process.env.YOPLAI_HOME;
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    process.env.YOPLAI_HOME = path.join(tmpDir, ".yoplai");
    process.env.HOME = tmpDir;
    process.env.USERPROFILE = tmpDir;

    await writeTestV3Config(path.join(tmpDir, ".yoplai"), {
      agents: [{ id: "main", name: "Main" }],
      extensions: {
        scheduler: { enabled: true },
      },
    });

    vi.resetModules();
    const { clearConfigCacheForTests, loadConfig } =
      await import("../config/index.js");
    clearConfigCacheForTests();
    const { loadExtensions } = await import("../extensions/registry.js");
    await loadExtensions(loadConfig());
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

  it("returns loaded component and agent ids", async () => {
    const { api } = await import("./api.core.js");

    const response = await Promise.resolve(api.request("/capabilities"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      version: 2,
      apps: { available: false },
      // only configured extensions load (heartbeat absent from config)
      extensions: { canvas: true, sessionHistory: true, deviceTools: true, scheduler: true },
      agents: ["main"],
      multiUser: false,
      desktopSetup: false,
      // a local single-user gateway enables agent management by default
      agentManagement: { create: true, edit: true },
      forkedAgents: false,
      enableCronMonitoring: false,
      dashboardEmbed: { version: 1, assetVersion: "v3", policyVersion: 1, enabled: true },
    });
  });

  it("reports the browser link only while the relay is on and the listener accepts 127.0.0.1", async () => {
    const { api } = await import("./api.core.js");
    const state = await import("../relay/state.js");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const available = async () => ((await (await Promise.resolve(api.request("/capabilities"))).json()) as { relayLink?: { available: boolean } }).relayLink?.available;
    try {
      state.configureRelay("127.0.0.1", false);
      state.setGatewayListener({ address: "127.0.0.1", port: 4000 });
      expect(await available()).toBe(true);
      for (const address of ["127.0.0.2", "::1"]) {
        state.setGatewayListener({ address, port: 4000 });
        expect(await available()).toBe(false);
      }
      state.setGatewayListener({ address: "127.0.0.1", port: 4000 });
      // With the relay off, the gateway reports no relayLink at all.
      state.configureRelay("127.0.0.1", true);
      expect(await available()).toBeUndefined();
    } finally {
      state.setGatewayListener(undefined);
      state.configureRelay("127.0.0.1", true);
      vi.restoreAllMocks();
    }
  });
});
