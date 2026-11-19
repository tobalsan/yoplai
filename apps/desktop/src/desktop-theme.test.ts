import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BrowserWindow, NativeTheme } from "electron";
import { expect, it, vi } from "vitest";
import { createDesktopTheme, startupColor } from "./desktop-theme.js";
import { readThemePreference, writeThemePreference } from "./preferences.js";

it.each([
  [undefined, false, "#ffffff"], [undefined, true, "#000000"],
  ["system", false, "#ffffff"], ["system", true, "#000000"],
  ["light", true, "#ffffff"], ["dark", false, "#000000"],
] as const)("resolves %s with dark appearance %s to %s", (choice, dark, color) => {
  expect(startupColor(choice, dark)).toBe(color);
});

function harness(userData: string) {
  const native = Object.assign(new EventEmitter(), { themeSource: "system", shouldUseDarkColors: true });
  const theme = createDesktopTheme(userData, native as unknown as NativeTheme);
  const origin = "http://127.0.0.1:7000";
  let activeOrigin = origin;
  const frame = { url: `${origin}/setup`, detached: false };
  const contents = Object.assign(new EventEmitter(), { mainFrame: frame, getURL: () => frame.url, ipc: new EventEmitter() });
  const win = Object.assign(new EventEmitter(), { webContents: contents, setBackgroundColor: vi.fn() });
  theme.attach(win as unknown as BrowserWindow, () => activeOrigin);
  const send = (action: string, choice: unknown, senderFrame = frame, ipc = contents.ipc) => {
    const event = { senderFrame, returnValue: undefined };
    ipc.emit("desktop-theme", event, action, choice);
    return event.returnValue;
  };
  return { theme, native, win, frame, origin, contents, send, setOrigin: (origin: string) => { activeOrigin = origin; } };
}

function withProfile(run: (userData: string) => void) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-theme-"));
  try { run(userData); } finally { fs.rmSync(userData, { recursive: true, force: true }); }
}

it("imports the first choice and rejects messages from other frames and navigations", () => withProfile((userData) => {
  const { contents, send, frame, origin, setOrigin } = harness(userData);
  expect(send("load", "light")).toBe("light");
  expect(send("save", "invalid")).toBeNull();
  expect(send("save", "dark", { ...frame })).toBeNull();
  expect(send("save", "dark", frame, new EventEmitter())).toBeUndefined();
  contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
  expect(send("save", "dark")).toBeNull();
  contents.emit("did-frame-navigate", {}, "", 200, "", true);
  for (const url of ["file:///splash.html", "data:text/html,error", "http://localhost:7000", "http://127.0.0.1:7001"]) {
    frame.url = url;
    expect(send("save", "dark")).toBeNull();
  }
  frame.url = origin;
  setOrigin("http://127.0.0.1:7001");
  expect(send("save", "dark")).toBeNull();
  expect(readThemePreference(userData)).toBe("light");
}));

it("applies the saved choice before paint and updates the window in System mode", () => withProfile((userData) => {
  writeThemePreference(userData, "light");
  const { theme, native, win, send } = harness(userData);
  expect(theme.background()).toBe("#ffffff");
  expect(send("load", "system")).toBe("light");
  expect(native.themeSource).toBe("light");
  expect(send("save", "system")).toBe("system");
  expect(readThemePreference(userData)).toBe("system");
  expect(native.themeSource).toBe("system");
  expect(win.setBackgroundColor).toHaveBeenLastCalledWith("#000000");
  native.shouldUseDarkColors = false;
  native.emit("updated");
  expect(win.setBackgroundColor).toHaveBeenLastCalledWith("#ffffff");
}));
