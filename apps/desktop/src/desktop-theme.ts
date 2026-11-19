import type { BrowserWindow, WebContents, WebFrameMain } from "electron";
import { isThemeChoice, readThemePreference, writeThemePreference, type ThemeChoice } from "./preferences.js";

type NativeTheme = Pick<Electron.NativeTheme, "themeSource" | "shouldUseDarkColors" | "on" | "removeListener">;

export function startupColor(choice: ThemeChoice | undefined, systemDark: boolean): string {
  const dark = choice === "dark" || (choice !== "light" && systemDark);
  return dark ? "#000000" : "#ffffff";
}

function isCurrentFrame(contents: WebContents, frame: WebFrameMain | null, origin: string | undefined): boolean {
  if (!origin || !frame || frame.detached || frame !== contents.mainFrame) return false;
  return URL.parse(frame.url)?.origin === origin && URL.parse(contents.getURL())?.origin === origin;
}

export function createDesktopTheme(userData: string, nativeTheme: NativeTheme) {
  let preference = readThemePreference(userData);
  nativeTheme.themeSource = preference ?? "system";
  const background = () => startupColor(preference, nativeTheme.shouldUseDarkColors);

  function attach(win: BrowserWindow, activeOrigin: () => string | undefined): void {
    const contents = win.webContents;
    const updateBackground = () => win.setBackgroundColor(background());
    nativeTheme.on("updated", updateBackground);
    win.once("closed", () => nativeTheme.removeListener("updated", updateBackground));

    let pendingNavigation = false;
    contents.on("did-start-navigation", (event) => {
      if (event.isMainFrame && !event.isSameDocument) pendingNavigation = true;
    });
    contents.on("did-frame-navigate", (_event, _url, _code, _status, isMainFrame) => {
      if (isMainFrame) pendingNavigation = false;
    });
    contents.ipc.on("desktop-theme", (event, action: unknown, choice: unknown) => {
      if (pendingNavigation || !isCurrentFrame(contents, event.senderFrame, activeOrigin())
        || (action !== "load" && action !== "save") || !isThemeChoice(choice)) {
        event.returnValue = null;
        return;
      }
      const next = action === "load" && preference !== undefined ? preference : choice;
      if (preference !== next) {
        try {
          writeThemePreference(userData, next);
        } catch {
          console.error("[desktop] Cannot save the theme preference.");
        }
        preference = next;
        nativeTheme.themeSource = next;
        updateBackground();
      }
      event.returnValue = next;
    });
  }

  return { attach, background };
}
