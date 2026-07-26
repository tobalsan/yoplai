import { beforeEach, describe, expect, it, vi } from "vitest";

const loadConfig = vi.fn();
const getAgent = vi.fn();
const setSingleAgentMode = vi.fn();
const setLoadedConfig = vi.fn();
const startServer = vi.fn();
const loadExtensions = vi.fn();
const getExtensionRuntime = vi.fn(() => ({ runtime: true }));
const createExtensionContext = vi.fn();
const prepareStartupConfig = vi.fn();
const logComponentSummary = vi.fn();
const resolveStartupConfig = vi.fn();
const startGatewayHotReload = vi.fn();

vi.mock("../config/index.js", () => ({
  loadConfig,
  getAgent,
  setSingleAgentMode,
  setLoadedConfig,
}));

vi.mock("../server/index.js", () => ({
  startServer,
}));

vi.mock("../server/api.core.js", () => ({
  api: {},
}));

vi.mock("../extensions/registry.js", () => ({
  loadExtensions,
  getExtensionRuntime,
  setExtensionActivator: vi.fn(),
}));

vi.mock("../extensions/context.js", () => ({
  createExtensionContext,
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
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.YOPLAI_UI_PORT;
  });

  it("starts extensions before opening the HTTP server", async () => {
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
