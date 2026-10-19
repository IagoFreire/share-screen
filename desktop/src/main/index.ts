import path from "node:path";
import { app, BrowserWindow, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { isAllowedNavigation } from "./navigation";
import { resolveServerOrigin } from "./serverOrigin";

/**
 * Electron main process. The window is a thin shell around desktop.html, which the
 * relay serves like any other client page; this process only does what a web page
 * can't: frameless window chrome, capture-source picking, the OAuth loopback, the tray.
 */

const serverOrigin = resolveServerOrigin(process.env);
const appUrl = `${serverOrigin}/desktop.html`;

/** Chromium's "navigation aborted" -- a redirect or a newer load, not a real failure. */
const ERR_ABORTED = -3;

let mainWindow: BrowserWindow | null = null;

/** Only the server's own pages may drive the IPC bridge (see navigation.ts). */
function isTrustedSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return isAllowedNavigation(event.senderFrame?.url ?? "", serverOrigin);
}

function showOfflinePage(window: BrowserWindow): void {
  void window.loadFile(path.join(__dirname, "../../static/offline.html"), { query: { target: appUrl } });
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 560,
    frame: false,
    backgroundColor: "#313338",
    title: "ScreenShare",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  window.once("ready-to-show", () => window.show());

  window.webContents.on("will-navigate", (event, url) => {
    if (isAllowedNavigation(url, serverOrigin)) return;
    event.preventDefault();
    if (/^https?:/.test(url)) void shell.openExternal(url);
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  // Server down or the tunnel offline: a local page with a retry button beats a blank window.
  window.webContents.on("did-fail-load", (_event, errorCode, _description, _url, isMainFrame) => {
    if (isMainFrame && errorCode !== ERR_ABORTED) showOfflinePage(window);
  });

  void window.loadURL(appUrl);
  return window;
}

function registerIpc(): void {
  ipcMain.on("desktop:window", (event, action: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || !isTrustedSender(event)) return;
    if (action === "minimize") window.minimize();
    else if (action === "toggle-maximize") window.isMaximized() ? window.unmaximize() : window.maximize();
    else if (action === "close") window.close();
  });

  const notYet = async (event: IpcMainInvokeEvent) => {
    if (!isTrustedSender(event)) throw new Error("Origem não autorizada.");
    throw new Error("Ainda não disponível nesta versão do app.");
  };
  for (const channel of ["desktop:get-sources", "desktop:select-source", "desktop:login"]) {
    ipcMain.handle(channel, notYet);
  }
  ipcMain.handle("desktop:get-stored-login", async () => null);
  ipcMain.handle("desktop:logout", async () => undefined);
}

// A second launch focuses the running app instead of opening another window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  void app.whenReady().then(() => {
    registerIpc();
    mainWindow = createMainWindow();
  });

  app.on("window-all-closed", () => app.quit());
}
