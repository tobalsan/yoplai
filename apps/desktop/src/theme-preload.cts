import { contextBridge, ipcRenderer } from "electron";

if (process.isMainFrame && location.protocol === "http:") {
  contextBridge.exposeInMainWorld("yoplaiDesktopTheme", {
    load: (choice: unknown) => ipcRenderer.sendSync("desktop-theme", "load", choice),
    takeWaitFirstScreen: () => ipcRenderer.sendSync("desktop-theme", "wait-first-screen") === true,
    save: (choice: unknown) => ipcRenderer.sendSync("desktop-theme", "save", choice),
  });
}
