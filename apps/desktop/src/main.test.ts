import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BrowserWindowConstructorOptions, MenuItemConstructorOptions } from "electron";
import type { Stack, StackHooks } from "./stack.js";
import { RESTART_URL } from "./links.js";

const storage = vi.hoisted(() => ({ root: "" }));
const desktop = vi.hoisted(() => ({
  options: vi.fn(),
  menu: vi.fn((template: MenuItemConstructorOptions[]) => ({
    getMenuItemById: (id: string) => (template[0].submenu as MenuItemConstructorOptions[]).find((item) => item.id === id),
  })),
  loadFile: vi.fn<(_file: string, _options: { query: { mode: string } }) => Promise<void>>(),
  loadURL: vi.fn<(_url: string) => Promise<void>>(),
  execute: vi.fn<(_code: string) => Promise<void>>(),
  onNavigation: vi.fn<(name: string, listener: (event: { preventDefault(): void }, url: string) => void) => void>(),
  probe: vi.fn(async () => "/usr/bin"),
  start: vi.fn<(hooks: StackHooks) => { ready: Promise<Stack>; stop: Stack["stop"] }>(),
}));

vi.mock("electron", () => ({
  app: {
    name: "Yoplai",
    isPackaged: true,
    requestSingleInstanceLock: () => true,
    getPath: (name: string) => path.join(storage.root, name),
    on: vi.fn(),
    whenReady: async () => {},
  },
  BrowserWindow: class {
    constructor(options: BrowserWindowConstructorOptions) { desktop.options(options); }
    on = vi.fn();
    loadFile = desktop.loadFile;
    loadURL = desktop.loadURL;
    webContents = { on: desktop.onNavigation, executeJavaScript: desktop.execute };
  },
  Menu: { buildFromTemplate: desktop.menu, setApplicationMenu: vi.fn() },
  session: { defaultSession: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() } },
  shell: { openExternal: vi.fn() },
}));
vi.mock("./shell-path.js", () => ({ probeShellPath: desktop.probe }));
vi.mock("./stack.js", () => ({ startStack: desktop.start }));

const uiUrl = "http://127.0.0.1:3000";
const stop = async () => {};
const stack = { uiUrl, uiOrigin: uiUrl, stop };
const signals = ["SIGINT", "SIGTERM"] as const;
let previous: Set<NodeJS.SignalsListener>;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  desktop.loadFile.mockReset().mockResolvedValue(undefined);
  desktop.loadURL.mockReset().mockResolvedValue(undefined);
  desktop.execute.mockReset().mockResolvedValue(undefined);
  desktop.start.mockReset().mockImplementation(() => ({ ready: Promise.resolve(stack), stop }));
  storage.root = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-start-"));
  vi.stubEnv("HOME", path.join(storage.root, "home"));
  vi.stubEnv("YOPLAI_HOME", path.join(storage.root, "yoplai"));
  vi.stubEnv("YOPLAI_SPLASH_STATS", "");
  await fs.mkdir(process.env.HOME!);
  previous = new Set(signals.flatMap((signal) => process.listeners(signal)));
});

afterEach(async () => {
  for (const signal of signals) {
    for (const listener of process.listeners(signal)) {
      if (!previous.has(listener)) process.off(signal, listener);
    }
  }
  vi.unstubAllEnvs();
  await fs.rm(storage.root, { recursive: true, force: true });
});

function appMenu(): MenuItemConstructorOptions[] {
  return desktop.menu.mock.calls[0][0][0].submenu as MenuItemConstructorOptions[];
}

function setupItem(): MenuItemConstructorOptions {
  return appMenu().find((item) => item.label === "Run setup again…")!;
}

it("starts the splash before the packaged plan and waits for the page, stack, and fade", async () => {
  const page = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<Stack>();
  const fade = Promise.withResolvers<void>();
  const ui = Promise.withResolvers<void>();
  desktop.loadFile.mockReturnValue(page.promise);
  desktop.start.mockReturnValue({ ready: ready.promise, stop });
  desktop.execute.mockReturnValue(fade.promise);
  desktop.loadURL.mockReturnValue(ui.promise);
  await import("./main.js");
  await vi.waitFor(() => expect(desktop.start).toHaveBeenCalled());
  expect(desktop.loadFile).toHaveBeenCalledWith(expect.stringMatching(/splash\/splash\.html$/), { query: { mode: "splash" } });
  const invocation = (fn: typeof desktop.loadFile | typeof desktop.probe | typeof desktop.start) => fn.mock.invocationCallOrder[0];
  expect(invocation(desktop.loadFile)).toBeLessThan(invocation(desktop.probe));
  expect(invocation(desktop.probe)).toBeLessThan(invocation(desktop.start));
  expect(desktop.execute).not.toHaveBeenCalled();
  expect(desktop.loadURL).not.toHaveBeenCalled();
  expect(setupItem().enabled).toBe(false);
  page.resolve();
  await Promise.resolve();
  expect(desktop.execute).not.toHaveBeenCalled();
  ready.resolve(stack);
  await vi.waitFor(() => expect(desktop.execute).toHaveBeenCalledWith("window.yoplaiSplash.finish()"));
  expect(desktop.loadURL).not.toHaveBeenCalled();
  fade.resolve();
  await vi.waitFor(() => expect(desktop.loadURL).toHaveBeenCalledWith(uiUrl));
  expect(setupItem().enabled).toBe(false);
  ui.resolve();
  await vi.waitFor(() => expect(setupItem().enabled).toBe(true));
  setupItem().click?.({} as never, undefined, {} as never);
  expect(desktop.loadURL).toHaveBeenLastCalledWith(`${uiUrl}/setup?restart=1`);
  expect(desktop.execute).toHaveBeenCalledTimes(1);
});

it("loads the UI if the fade fails", async () => {
  desktop.execute.mockRejectedValue(new Error());
  await import("./main.js");
  await vi.waitFor(() => expect(desktop.loadURL).toHaveBeenCalledWith(uiUrl));
});

it("shows a start error without waiting for the splash page", async () => {
  desktop.loadFile.mockReturnValue(new Promise(() => {}));
  desktop.start.mockImplementation(() => ({ ready: Promise.reject(new Error("Gateway stopped")), stop }));
  await import("./main.js");
  await vi.waitFor(() => expect(desktop.loadURL).toHaveBeenCalled());
  expect(decodeURIComponent(desktop.loadURL.mock.calls[0][0])).toContain("Gateway stopped");
  expect(desktop.execute).not.toHaveBeenCalled();
  expect(setupItem().enabled).toBe(false);
});

it("keeps the error page if the stack crashes during the fade", async () => {
  const fade = Promise.withResolvers<void>();
  desktop.execute.mockReturnValue(fade.promise);
  await import("./main.js");
  await vi.waitFor(() => expect(desktop.execute).toHaveBeenCalled());
  desktop.start.mock.calls[0][0].onCrash("Gateway stopped");
  fade.reject(new Error());
  await new Promise(setImmediate);
  expect(desktop.loadURL).toHaveBeenCalledTimes(1);
  expect(decodeURIComponent(desktop.loadURL.mock.calls[0][0])).toContain("Gateway stopped");
  expect(setupItem().enabled).toBe(false);
});

it("starts in wait mode from the Restart link after the user corrects invalid JSON", async () => {
  const home = process.env.YOPLAI_HOME!;
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
  expect(desktop.options).toHaveBeenCalledWith(expect.objectContaining({
    titleBarStyle: "hiddenInset", backgroundColor: "#000000",
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false,
      allowRunningInsecureContent: false, experimentalFeatures: false },
  }));

  await fs.writeFile(config, '{"version":3,"agents":[]}');
  const navigate = desktop.onNavigation.mock.calls.find(([name]) => name === "will-navigate")?.[1];
  expect(navigate).toBeDefined();
  navigate?.({ preventDefault: vi.fn() }, RESTART_URL);

  await vi.waitFor(() => expect(desktop.loadURL).toHaveBeenCalledWith(uiUrl));
  expect(desktop.loadFile).toHaveBeenLastCalledWith(expect.any(String), { query: { mode: "wait" } });
  expect(desktop.start).toHaveBeenCalledTimes(1);
  const [menu] = desktop.menu.mock.calls[0];
  expect(menu.map((item) => item.role ?? item.label)).toEqual(["Yoplai", "editMenu", "viewMenu", "windowMenu"]);
  expect(appMenu().some((item) => item.role === "quit")).toBe(true);
  expect(JSON.parse(await fs.readFile(config, "utf8")).agents).toBe("$YOPLAI_HOME/agents/*");
});

it("reads the splash checkbox at start and saves its new value for the next start", async () => {
  const userData = path.join(storage.root, "userData");
  await fs.mkdir(userData);
  const preferences = path.join(userData, "desktop-preferences.json");
  await fs.writeFile(preferences, '{"splash":false}');
  await import("./main.js");
  await vi.waitFor(() => expect(desktop.loadURL).toHaveBeenCalledWith(uiUrl));
  expect(desktop.loadFile).toHaveBeenCalledWith(expect.any(String), { query: { mode: "wait" } });
  const option = appMenu()[appMenu().indexOf(setupItem()) + 1];
  expect(option).toMatchObject({ label: "Show Splash at Start", type: "checkbox", checked: false });
  option.click?.({ checked: true } as never, undefined, {} as never);
  expect(JSON.parse(await fs.readFile(preferences, "utf8"))).toEqual({ splash: true });
  expect(desktop.loadFile).toHaveBeenCalledTimes(1);
});
