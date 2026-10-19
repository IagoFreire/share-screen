import { contextBridge, ipcRenderer } from "electron";
import type { DesktopApi, DesktopSource, StoredLogin } from "@screenshare-bot/shared";

/**
 * Exposes `window.desktop` to desktop.html. Every call is a narrow, typed IPC message;
 * the main process re-checks that the sender is the relay's own page before acting, so
 * this bridge is not a way out of the sandbox for anything else that ends up loaded.
 */

const api: DesktopApi = {
  getSources: () => ipcRenderer.invoke("desktop:get-sources") as Promise<DesktopSource[]>,
  selectSource: (id) => ipcRenderer.invoke("desktop:select-source", id) as Promise<void>,
  login: () => ipcRenderer.invoke("desktop:login") as Promise<StoredLogin>,
  getStoredLogin: () => ipcRenderer.invoke("desktop:get-stored-login") as Promise<StoredLogin | null>,
  logout: () => ipcRenderer.invoke("desktop:logout") as Promise<void>,
  setLive: (live) => ipcRenderer.send("desktop:set-live", live === true),
  notify: (title, body) => ipcRenderer.send("desktop:notify", String(title), String(body)),
  onEndLiveRequested: (listener) => {
    ipcRenderer.on("desktop:end-live", () => listener());
  },
  windowControls: {
    minimize: () => ipcRenderer.send("desktop:window", "minimize"),
    toggleMaximize: () => ipcRenderer.send("desktop:window", "toggle-maximize"),
    close: () => ipcRenderer.send("desktop:window", "close"),
  },
};

contextBridge.exposeInMainWorld("desktop", api);
