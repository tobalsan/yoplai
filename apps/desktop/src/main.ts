import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, Menu, nativeTheme, session, shell, type MenuItem, type MenuItemConstructorOptions } from "electron";
import { createDesktopTheme } from "./desktop-theme.js";
import { createDevHome, seedDevHome } from "./dev-home.js";
import { errorPageUrl } from "./error-page.js";
import { decideNavigation, decideWindowOpen, isPermissionAllowed } from "./links.js";
import { LogBuffer } from "./log-buffer.js";
import { createDevLaunchPlan, createPackagedLaunchPlan, type LaunchPlan, type LaunchPorts } from "./launch-plan.js";
import { resolveHome, seedHome } from "./packaged-env.js";
import { readSplashPreference, writeSplashPreference } from "./preferences.js";
import { fallbackPath, probeShellPath } from "./shell-path.js";
import { startStack } from "./stack.js";
import { createStackController } from "./stack-controller.js";

const log = new LogBuffer(50);
let createPlan: ((ports: LaunchPorts) => LaunchPlan) | undefined;
const devHome = app.isPackaged ? undefined : createDevHome(process.env, process.argv.slice(2), app.getPath("appData"));
if (devHome) {
  console.log(`[desktop] YOPLAI_HOME=${devHome.home} (${devHome.mode})`);
  fs.mkdirSync(devHome.userData, { recursive: true });
  app.setPath("userData", devHome.userData);
  app.setPath("sessionData", devHome.userData);
}

const stackController = createStackController(() =>
  startStack({ log, createPlan: (ports) => createPlan!(ports), onCrash: (reason) => !quitting && showError(reason) })
);
let mainWindow: BrowserWindow | null = null;
let quitting = false;
let attempt = 0;
let setupMenuItem: MenuItem | null = null;
const SPLASH_PATH = path.join(import.meta.dirname, "splash/splash.html");
type SplashMode = "splash" | "wait";

function invalidateAttempt(): void {
  attempt++;
  if (setupMenuItem) setupMenuItem.enabled = false;
}
/** A packaged app runs one instance. The dev app keeps its own rules, so two worktrees can run side by side. */
const hasInstanceLock = !app.isPackaged || app.requestSingleInstanceLock();

/** Packaged only: seed the home and read the login shell PATH once. Later restarts reuse the plan. */
let packagedReady: Promise<void> | null = null;
function preparePackagedPlan(): Promise<void> {
  packagedReady ??= (async () => {
    const home = resolveHome(process.env, app.getPath("appData"));
    seedHome(home);
    const shellPath = await probeShellPath({ parentEnv: process.env }).catch(() => fallbackPath(process.env.PATH));
    createPlan = (ports) =>
      createPackagedLaunchPlan(ports, {
        execPath: process.execPath,
        resourcesPath: process.resourcesPath,
        home,
        shellPath,
        parentEnv: process.env,
      });
  })().catch((error: unknown) => {
    packagedReady = null;
    throw error;
  });
  return packagedReady;
}

function openExternal(url: string): void {
  void shell.openExternal(url);
}

function showError(reason: string): void {
  invalidateAttempt();
  void mainWindow?.loadURL(errorPageUrl(reason, log.tail())).catch(() => undefined);
}

const SECURE_WEB_PREFERENCES = {
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  webviewTag: false,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
} as const;

function createWindow(theme: ReturnType<typeof createDesktopTheme>): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280, height: 860, titleBarStyle: "hiddenInset", backgroundColor: theme.background(),
    webPreferences: { ...SECURE_WEB_PREFERENCES, preload: path.join(import.meta.dirname, "theme-preload.cjs") },
  });
  theme.attach(win, () => mainWindow === win && !quitting ? stackController.current()?.uiOrigin : undefined);
  // Child windows (OAuth) must reach identity providers, so only the main window is pinned.
  win.webContents.on("will-navigate", (event, url) => {
    const decision = decideNavigation({ url, uiOrigin: stackController.current()?.uiOrigin ?? "" });
    if (decision === "allow") return;
    event.preventDefault();
    if (decision === "restart") void startAndLoad("wait");
    else if (decision === "system-browser") openExternal(url);
  });
  win.on("closed", () => {
    invalidateAttempt();
    mainWindow = null;
  });
  return win;
}

/** Handlers for every web contents, including OAuth and MCP app child windows. */
app.on("web-contents-created", (_event, contents) => {
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.setWindowOpenHandler(({ url, frameName }) => {
    const decision = decideWindowOpen({ url, frameName });
    if (decision === "child-window") {
      return { action: "allow", overrideBrowserWindowOptions: { webPreferences: SECURE_WEB_PREFERENCES } };
    }
    if (decision === "system-browser") openExternal(url);
    return { action: "deny" };
  });
});

function installMenu(userData: string, splash: boolean): void {
  const restartSetup: MenuItemConstructorOptions = {
    id: "restart-setup",
    label: "Run setup again…",
    enabled: false,
    click: () => {
      const stack = stackController.current();
      if (stack && setupMenuItem?.enabled && !quitting) {
        void mainWindow?.loadURL(new URL("/setup?restart=1", stack.uiUrl).href).catch(() => undefined);
      }
    },
  };
  const splashOption: MenuItemConstructorOptions = {
    label: "Show Splash at Start",
    type: "checkbox",
    checked: splash,
    click: (item) => {
      try {
        writeSplashPreference(userData, item.checked);
      } catch {
        item.checked = !item.checked;
        console.error("[desktop] Cannot save the splash preference.");
      }
    },
  };
  const template: MenuItemConstructorOptions[] = [
    { label: app.name, submenu: [
      { role: "about" }, { type: "separator" }, restartSetup, splashOption, { type: "separator" },
      { role: "services" }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" },
      { role: "unhide" }, { type: "separator" }, { role: "quit" },
    ] },
    { role: "editMenu" }, { role: "viewMenu" }, { role: "windowMenu" },
  ];
  const menu = Menu.buildFromTemplate(template);
  setupMenuItem = menu.getMenuItemById("restart-setup");
  Menu.setApplicationMenu(menu);
}

function installPermissionHandlers(): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((contents, permission, callback) => {
    callback(isPermissionAllowed(permission, contents.getURL(), stackController.current()?.uiOrigin ?? ""));
  });
  ses.setPermissionCheckHandler((_contents, permission, requestingOrigin) =>
    isPermissionAllowed(permission, requestingOrigin, stackController.current()?.uiOrigin ?? "")
  );
}

async function startAndLoad(mode: SplashMode): Promise<void> {
  const win = mainWindow;
  if (!win || quitting) return;
  invalidateAttempt();
  const token = attempt;
  const isCurrent = () => token === attempt;
  try {
    const pageLoaded = win.loadFile(SPLASH_PATH, { query: { mode } }).then(() => true, () => false);
    if (devHome) {
      if (!createPlan) {
        const keyName = seedDevHome(devHome, process.env);
        createPlan = (ports) => createDevLaunchPlan(ports, devHome, process.env, keyName);
      }
    } else {
      await preparePackagedPlan();
    }
    if (!isCurrent()) return;
    const stack = await stackController.restart();
    if (await pageLoaded && isCurrent()) {
      await win.webContents.executeJavaScript("window.yoplaiSplash.finish()").catch(() => undefined);
      if (isCurrent() && process.env.YOPLAI_SPLASH_STATS === "1") {
        const stats = await win.webContents.executeJavaScript("window.yoplaiSplash.stats()").catch(() => null);
        if (isCurrent() && stats) console.log("[desktop] splash stats", JSON.stringify(stats));
      }
    }
    if (!isCurrent()) return;
    await win.loadURL(stack.uiUrl);
    if (isCurrent() && setupMenuItem) setupMenuItem.enabled = true;
  } catch (err) {
    if (isCurrent()) showError((err as Error).message);
  }
}

async function shutdown(): Promise<void> {
  if (quitting) return;
  quitting = true;
  invalidateAttempt();
  await stackController.shutdown();
  app.exit(0);
}

app.on("window-all-closed", () => void shutdown());
app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  void shutdown();
});
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

if (!hasInstanceLock) app.quit();

void app.whenReady().then(async () => {
  if (!hasInstanceLock) return;
  if (!app.isPackaged) app.dock?.setIcon(path.join(import.meta.dirname, "../resources/icon.png"));
  console.log("[desktop] ready");
  installPermissionHandlers();
  const userData = app.getPath("userData");
  mainWindow = createWindow(createDesktopTheme(userData, nativeTheme));
  const splash = readSplashPreference(userData);
  installMenu(userData, splash);
  await startAndLoad(splash ? "splash" : "wait");
});
