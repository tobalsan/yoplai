import { app, BrowserWindow, session, shell } from "electron";
import { errorPageUrl } from "./error-page.js";
import { decideNavigation, decideWindowOpen, isPermissionAllowed } from "./links.js";
import { LogBuffer } from "./log-buffer.js";
import { createDevLaunchPlan } from "./launch-plan.js";
import { startStack } from "./stack.js";
import { createStackController } from "./stack-controller.js";

const log = new LogBuffer(50);
const stackController = createStackController(() =>
  startStack({ log, createPlan: createDevLaunchPlan, onCrash: (reason) => !quitting && showError(reason) })
);
let mainWindow: BrowserWindow | null = null;
let quitting = false;

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

void app.whenReady().then(async () => {
  console.log("[desktop] ready");
  installPermissionHandlers();
  mainWindow = createWindow();
  await startAndLoad();
});
