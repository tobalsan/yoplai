import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { RESTART_URL } from "./links.js";

const desktop = vi.hoisted(() => ({
  loadURL: vi.fn(async (_url: string) => {}),
  onNavigation: vi.fn<(name: string, listener: (event: { preventDefault(): void }, url: string) => void) => void>(),
  start: vi.fn(() => {
    const uiUrl = "http://127.0.0.1:3000";
    const stop = async () => {};
    return { ready: Promise.resolve({ uiUrl, uiOrigin: uiUrl, stop }), stop };
  }),
}));

vi.mock("electron", () => ({
  app: {
    isPackaged: true,
    requestSingleInstanceLock: () => true,
    getPath: () => process.env.HOME,
    on: vi.fn(),
    whenReady: async () => {},
  },
  BrowserWindow: class {
    loadURL = desktop.loadURL;
    webContents = { on: desktop.onNavigation };
  },
  session: { defaultSession: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() } },
  shell: { openExternal: vi.fn() },
}));
vi.mock("./shell-path.js", () => ({ probeShellPath: async () => "/usr/bin" }));
vi.mock("./stack.js", () => ({ startStack: desktop.start }));

it("starts from the Restart link after the user corrects invalid config JSON", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-restart-"));
  const home = path.join(root, "yoplai");
  const signals = ["SIGINT", "SIGTERM"] as const;
  const previous = new Set(signals.flatMap((signal) => process.listeners(signal)));
  try {
    vi.stubEnv("HOME", root);
    vi.stubEnv("YOPLAI_HOME", home);
    await fs.mkdir(home);
    const config = path.join(home, "yoplai.json");
    await fs.writeFile(config, "{");

    await import("./main.js");
    await vi.waitFor(() => expect(desktop.loadURL).toHaveBeenCalled());
    const [errorUrl] = desktop.loadURL.mock.calls[0];
    expect(decodeURIComponent(errorUrl)).toContain("Yoplai could not start");
    expect(decodeURIComponent(errorUrl)).toContain("Correct the JSON in the desktop config. Select Restart.");
    expect(decodeURIComponent(errorUrl)).toContain(RESTART_URL);
    expect(desktop.start).not.toHaveBeenCalled();

    await fs.writeFile(config, '{"version":3,"agents":[]}');
    const navigate = desktop.onNavigation.mock.calls.find(([name]) => name === "will-navigate")?.[1];
    expect(navigate).toBeDefined();
    navigate?.({ preventDefault: vi.fn() }, RESTART_URL);

    await vi.waitFor(() => expect(desktop.loadURL).toHaveBeenCalledWith("http://127.0.0.1:3000"));
    expect(desktop.start).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await fs.readFile(config, "utf8")).agents).toBe("$YOPLAI_HOME/agents/*");
  } finally {
    for (const signal of signals) {
      for (const listener of process.listeners(signal)) {
        if (!previous.has(listener)) process.off(signal, listener);
      }
    }
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  }
});
