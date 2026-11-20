import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let home: string;

const loadConfig = vi.fn();
const getAgent = vi.fn();
const setSingleAgentMode = vi.fn();
const setLoadedConfig = vi.fn();
const startServer = vi.fn();
const loadExtensions = vi.fn();
const getExtensionRuntime = vi.fn(() => ({ runtime: true }));
const createExtensionContext = vi.fn();
const bindExtensionContext = vi.fn((context: Record<string, unknown>, extensionId: string) => ({ ...context, extensionId }));
const setExtensionActivator = vi.fn();
const prepareStartupConfig = vi.fn();
const logComponentSummary = vi.fn();
const resolveStartupConfig = vi.fn();
const startGatewayHotReload = vi.fn();

vi.mock("../config/index.js", () => ({
  get CONFIG_DIR() { return home; },
  loadConfig,
  getAgent,
  setSingleAgentMode,
  setLoadedConfig,
}));

vi.mock("../server/index.js", () => ({
  startServer,
}));

vi.mock("../server/api.core.js", () => ({
  buildInnerApi: (extensions: { registerRoutes: (app: object) => void }[]) => {
    const app = {};
    for (const extension of extensions) extension.registerRoutes(app);
    return app;
  },
}));

vi.mock("../extensions/registry.js", () => ({
  loadExtensions,
  getExtensionRuntime,
  setExtensionActivator,
}));

vi.mock("../extensions/context.js", () => ({
  createExtensionContext,
  bindExtensionContext,
}));

vi.mock("../config/validate.js", () => ({
  prepareStartupConfig,
  logComponentSummary,
  resolveStartupConfig,
}));

vi.mock("../config/hot-reload.js", () => ({
  startGatewayHotReload,
}));

describe("startGatewayCommand", () => {
  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-startup-"));
    vi.clearAllMocks();
    delete process.env.YOPLAI_UI_PORT;
  });

  afterEach(async () => { await fs.rm(home, { recursive: true, force: true }); });

  it("initializes dashboard storage before extensions and opens the HTTP server last", async () => {
    const order: string[] = [];
    const rawConfig = { agents: [{ id: "alpha" }] };
    const config = {
      agents: [{ id: "alpha" }],
      gateway: { port: 4003 },
      ui: { enabled: true, port: 3003 },
    };
    const extensions = [
      {
        id: "multiUser",
        registerRoutes: vi.fn(() => {
          order.push("register:multiUser");
        }),
        start: vi.fn(async () => {
          expect(JSON.parse(await fs.readFile(path.join(home, "canvas", "schema.json"), "utf8"))).toEqual({ version: 1, migrationComplete: true });
          order.push("start:multiUser");
        }),
      },
      {
        id: "scheduler",
        registerRoutes: vi.fn(() => {
          order.push("register:scheduler");
        }),
        start: vi.fn(async () => {
          order.push("start:scheduler");
        }),
      },
    ];

    loadConfig.mockReturnValue(rawConfig);
    resolveStartupConfig.mockResolvedValue(rawConfig);
    loadExtensions.mockResolvedValue(extensions);
    prepareStartupConfig.mockResolvedValue({
      resolvedConfig: config,
      summary: { loaded: [], skipped: [] },
    });
    createExtensionContext.mockReturnValue({ ctx: true });
    startServer.mockImplementation(() => {
      order.push("startServer");
    });

    const { startGatewayCommand } = await import("./gateway.js");
    const result = await startGatewayCommand({});

    expect(order).toEqual([
      "register:multiUser",
      "register:scheduler",
      "start:multiUser",
      "start:scheduler",
      "startServer",
    ]);
    expect(createExtensionContext).toHaveBeenCalledWith({
      ...config,
      gateway: { port: 4003 },
      ui: { enabled: true, port: 3003 },
    });
    expect(startServer).toHaveBeenCalledWith(undefined, undefined, {
      runtime: true,
    });
    expect(setLoadedConfig).toHaveBeenCalledWith(config);
    expect(result.actualPort).toBe(4003);
    expect(result.uiPort).toBe(3003);
    expect(extensions[0].start).toHaveBeenCalledWith({ ctx: true, extensionId: "multiUser" });
    expect(extensions[1].start).toHaveBeenCalledWith({ ctx: true, extensionId: "scheduler" });
    const activated = { id: "external", registerRoutes: vi.fn(), start: vi.fn(async () => {}) };
    await setExtensionActivator.mock.calls[0][0](activated);
    expect(activated.start).toHaveBeenCalledWith({ ctx: true, extensionId: "external" });
  });

  it("sets single-agent mode before starting extensions", async () => {
    const order: string[] = [];
    const rawConfig = { agents: [{ id: "alpha" }] };
    const config = {
      agents: [{ id: "alpha", name: "Alpha" }],
      gateway: { port: 4000 },
      ui: { enabled: false, port: 3000 },
    };
    const extensions = [
      {
        id: "multiUser",
        registerRoutes: vi.fn(),
        start: vi.fn(async () => {
          expect(JSON.parse(await fs.readFile(path.join(home, "canvas", "schema.json"), "utf8"))).toEqual({ version: 1, migrationComplete: true });
          order.push("start:multiUser");
        }),
      },
    ];

    loadConfig.mockReturnValue(rawConfig);
    resolveStartupConfig.mockResolvedValue(rawConfig);
    loadExtensions.mockResolvedValue(extensions);
    prepareStartupConfig.mockResolvedValue({
      resolvedConfig: config,
      summary: { loaded: [], skipped: [] },
    });
    createExtensionContext.mockReturnValue({ ctx: true });
    getAgent.mockReturnValue({ id: "alpha", name: "Alpha" });
    setSingleAgentMode.mockImplementation(() => {
      order.push("singleAgent");
    });
    startServer.mockImplementation(() => {
      order.push("startServer");
    });

    const { startGatewayCommand } = await import("./gateway.js");
    await startGatewayCommand({ agentId: "alpha" });

    expect(order).toEqual(["singleAgent", "start:multiUser", "startServer"]);
    expect(setSingleAgentMode).toHaveBeenCalledWith("alpha");
  });
});
