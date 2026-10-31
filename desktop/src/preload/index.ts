import { contextBridge, ipcRenderer } from "electron";
import type { AudioApp, DesktopApi, DesktopSource, StoredLogin, UpdateStatus } from "@screenshare-bot/shared";

/**
 * Exposes `window.desktop` to desktop.html. Every call is a narrow, typed IPC message;
 * the main process re-checks that the sender is the relay's own page before acting, so
 * this bridge is not a way out of the sandbox for anything else that ends up loaded.
 */

const api: DesktopApi = {
  getSources: () => ipcRenderer.invoke("desktop:get-sources") as Promise<DesktopSource[]>,
  selectSource: (id, options) => ipcRenderer.invoke("desktop:select-source", id, options?.audio !== false) as Promise<void>,
  // Main resolves { ok, value | message } (see main/ipcResult.ts) so the message shown
  // is the pt-BR one, not Electron's "Error invoking remote method" wrapper. The type
  // is restated here because a sandboxed preload can't import local modules.
  login: async () => {
    const result = (await ipcRenderer.invoke("desktop:login")) as
      | { ok: true; value: StoredLogin }
      | { ok: false; message: string };
    if (!result.ok) throw new Error(result.message);
    return result.value;
  },
  cancelLogin: () => ipcRenderer.invoke("desktop:cancel-login") as Promise<void>,
  getStoredLogin: () => ipcRenderer.invoke("desktop:get-stored-login") as Promise<StoredLogin | null>,
  logout: () => ipcRenderer.invoke("desktop:logout") as Promise<void>,
  setLive: (live) => ipcRenderer.send("desktop:set-live", live === true),
  notify: (title, body) => ipcRenderer.send("desktop:notify", String(title), String(body)),
  onEndLiveRequested: (listener) => {
    ipcRenderer.on("desktop:end-live", () => listener());
  },
  appAudio: {
    listApps: () => ipcRenderer.invoke("desktop:audio-apps") as Promise<AudioApp[]>,
    start: async (exclude) => {
      const result = (await ipcRenderer.invoke("desktop:audio-start", exclude)) as
        | { ok: true }
        | { ok: false; message: string };
      if (!result.ok) throw new Error(result.message);
    },
    stop: () => ipcRenderer.send("desktop:audio-stop"),
    onBlock: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, data: Uint8Array) => {
        // Copied into a fresh buffer: the IPC payload's byteOffset needn't be 4-aligned.
        const samples = new Float32Array(data.byteLength / 4);
        new Uint8Array(samples.buffer).set(data);
        listener(samples);
      };
      ipcRenderer.on("desktop:audio-block", handler);
      return () => ipcRenderer.removeListener("desktop:audio-block", handler);
    },
    onEnded: (listener) => {
      ipcRenderer.on("desktop:audio-ended", () => listener());
    },
  },
  updates: {
    getState: () => ipcRenderer.invoke("desktop:update-state") as Promise<{ version: string; status: UpdateStatus }>,
    check: () => ipcRenderer.invoke("desktop:update-check") as Promise<void>,
    install: () => ipcRenderer.send("desktop:update-install"),
    onStatus: (listener) => {
      ipcRenderer.on("desktop:update-status", (_event, status: UpdateStatus) => listener(status));
    },
  },
  windowControls: {
    minimize: () => ipcRenderer.send("desktop:window", "minimize"),
    toggleMaximize: () => ipcRenderer.send("desktop:window", "toggle-maximize"),
    close: () => ipcRenderer.send("desktop:window", "close"),
  },
};

contextBridge.exposeInMainWorld("desktop", api);
