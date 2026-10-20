import path from "node:path";
import {
  app,
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  safeStorage,
  session,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";
import type { DesktopLoginResponse, StoredLogin } from "@screenshare-bot/shared";
import { LOGIN_TIMEOUT_MS, runLoopbackLogin } from "./auth/loopbackLogin";
import { createSessionStore } from "./auth/sessionStore";
import { createSourceSelection, isSourceId, pickDisplayMedia, THUMBNAIL_SIZE, toDesktopSource } from "./capture";
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

/** Picked in desktop.html's own picker; granted on the page's next getDisplayMedia(). */
const sourceSelection = createSourceSelection();

/** Only the server's own pages may drive the IPC bridge (see navigation.ts). */
function isTrustedSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return isAllowedNavigation(event.senderFrame?.url ?? "", serverOrigin);
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  if (!isTrustedSender(event)) throw new Error("Origem não autorizada.");
}

/**
 * Answers the page's getDisplayMedia() with the source it picked beforehand (see
 * capture.ts). Anything else -- no pick, or a window that closed in between -- is denied.
 */
function installDisplayMediaHandler(): void {
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const selectedId = sourceSelection.take();
    if (!isAllowedNavigation(request.frame?.url ?? "", serverOrigin)) {
      callback({});
      return;
    }
    desktopCapturer
      .getSources({ types: ["screen", "window"] })
      .then((sources) => callback(pickDisplayMedia(selectedId, sources) ?? {}))
      .catch((error: unknown) => {
        console.error("Listing capture sources failed:", error);
        callback({});
      });
  });
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

  ipcMain.handle("desktop:get-sources", async (event) => {
    assertTrustedSender(event);
    const sources = await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: THUMBNAIL_SIZE,
      fetchWindowIcons: true,
    });
    return sources.map(toDesktopSource);
  });

  ipcMain.handle("desktop:select-source", async (event, id: unknown) => {
    assertTrustedSender(event);
    if (!isSourceId(id)) throw new Error("Fonte de captura inválida.");
    sourceSelection.set(id);
  });

  const sessionStore = createSessionStore({
    filePath: path.join(app.getPath("userData"), "session.bin"),
    encrypt: (text) => safeStorage.encryptString(text),
    decrypt: (data) => safeStorage.decryptString(data),
  });
  let loginInProgress: Promise<StoredLogin> | null = null;

  ipcMain.handle("desktop:login", async (event) => {
    assertTrustedSender(event);
    // A second click while the browser is open joins the running login instead of
    // failing on the busy loopback port.
    loginInProgress ??= runLoopbackLogin({
      openExternal: (url) => shell.openExternal(url),
      fetchClientId: fetchDiscordClientId,
      exchange: exchangeLoginCode,
      timeoutMs: LOGIN_TIMEOUT_MS,
    })
      .then(async (login) => {
        if (safeStorage.isEncryptionAvailable()) await sessionStore.save(login);
        mainWindow?.show();
        mainWindow?.focus();
        return login;
      })
      .finally(() => {
        loginInProgress = null;
      });
    return loginInProgress;
  });

  ipcMain.handle("desktop:get-stored-login", async (event) => {
    assertTrustedSender(event);
    return safeStorage.isEncryptionAvailable() ? sessionStore.load() : null;
  });

  ipcMain.handle("desktop:logout", async (event) => {
    assertTrustedSender(event);
    await sessionStore.clear();
  });
}

async function fetchDiscordClientId(): Promise<string> {
  const response = await fetch(`${serverOrigin}/api/config`);
  const body = (await response.json()) as { clientId?: unknown };
  if (!response.ok || typeof body.clientId !== "string" || !body.clientId) {
    throw new Error(`GET /api/config failed with HTTP ${response.status}.`);
  }
  return body.clientId;
}

async function exchangeLoginCode(code: string): Promise<DesktopLoginResponse> {
  const response = await fetch(`${serverOrigin}/api/desktop/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!response.ok) throw new Error(`POST /api/desktop/login failed with HTTP ${response.status}.`);
  return (await response.json()) as DesktopLoginResponse;
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
    installDisplayMediaHandler();
    mainWindow = createMainWindow();
  });

  app.on("window-all-closed", () => app.quit());
}
