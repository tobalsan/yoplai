import { app, BrowserWindow, session, shell } from "electron";
import { errorPageUrl } from "./error-page.js";
import { decideNavigation, decideWindowOpen, isPermissionAllowed } from "./links.js";
import { LogBuffer } from "./log-buffer.js";
import { createDevHome, createDevLaunchPlan, createPackagedLaunchPlan, type LaunchPlan, type LaunchPorts } from "./launch-plan.js";
import { resolveHome, seedHome } from "./packaged-env.js";
import { fallbackPath, probeShellPath } from "./shell-path.js";
import { startStack } from "./stack.js";
import { createStackController } from "./stack-controller.js";

const log = new LogBuffer(50);
let devHome: string | undefined;
let createPlan: (ports: LaunchPorts) => LaunchPlan = (ports) => createDevLaunchPlan(ports, devHome ??= createDevHome());
const stackController = createStackController(() =>
  startStack({ log, createPlan: (ports) => createPlan(ports), onCrash: (reason) => !quitting && showError(reason) })
);
let mainWindow: BrowserWindow | null = null;
let quitting = false;
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
  void mainWindow?.loadURL(errorPageUrl(reason, log.tail()));
}

const SECURE_WEB_PREFERENCES = {
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  webviewTag: false,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
} as const;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({ width: 1280, height: 860, webPreferences: SECURE_WEB_PREFERENCES });
  // Child windows (OAuth) must reach identity providers, so only the main window is pinned.
  win.webContents.on("will-navigate", (event, url) => {
    const decision = decideNavigation({ url, uiOrigin: stackController.current()?.uiOrigin ?? "" });
    if (decision === "allow") return;
    event.preventDefault();
    if (decision === "restart") void startAndLoad();
    else if (decision === "system-browser") openExternal(url);
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

function installPermissionHandlers(): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((contents, permission, callback) => {
    callback(isPermissionAllowed(permission, contents.getURL(), stackController.current()?.uiOrigin ?? ""));
  });
  ses.setPermissionCheckHandler((_contents, permission, requestingOrigin) =>
    isPermissionAllowed(permission, requestingOrigin, stackController.current()?.uiOrigin ?? "")
  );
}

async function startAndLoad(): Promise<void> {
  try {
    if (app.isPackaged) await preparePackagedPlan();
    const stack = await stackController.restart();
    if (!quitting) await mainWindow?.loadURL(stack.uiUrl);
  } catch (err) {
    if (!quitting) showError((err as Error).message);
  }
}

async function shutdown(): Promise<void> {
  if (quitting) return;
  quitting = true;
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
  console.log("[desktop] ready");
  installPermissionHandlers();
  mainWindow = createWindow();
  await startAndLoad();
});
