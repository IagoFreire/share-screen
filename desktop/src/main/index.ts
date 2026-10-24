import fs from "node:fs";
import path from "node:path";
import {
  app,
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  Notification,
  safeStorage,
  session,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";
import { autoUpdater } from "electron-updater";
import type { DesktopLoginResponse, StoredLogin } from "@screenshare-bot/shared";
import { LOGIN_TIMEOUT_MS, runLoopbackLogin } from "./auth/loopbackLogin";
import { createSessionStore } from "./auth/sessionStore";
import { APP_NAME, userDataPath } from "./appIdentity";
import { APP_ICON_PATH, createAppTray, type AppTray } from "./appTray";
import { decideCloseAction, isNotification } from "./tray";
import { toIpcResult } from "./ipcResult";
import { isExeName, listAudioApps, startAppAudio, type AppAudioCapture } from "./audioHelper";
import { buildContentSecurityPolicy, isAllowedPermission } from "./webSecurity";
import { createSourceSelection, isSourceId, pickDisplayMedia, THUMBNAIL_SIZE, toDesktopSource } from "./capture";
import { isAllowedNavigation } from "./navigation";
import { resolveServerOrigin } from "./serverOrigin";
import { mainWindowWebPreferences } from "./windowOptions";

/**
 * Electron main process. The window is a thin shell around desktop.html, which the
 * relay serves like any other client page; this process only does what a web page
 * can't: frameless window chrome, capture-source picking, the OAuth loopback, the tray.
 */

const serverOrigin = resolveServerOrigin(process.env);
const appUrl = `${serverOrigin}/desktop.html`;

/** Chromium's "navigation aborted" -- a redirect or a newer load, not a real failure. */
const ERR_ABORTED = -3;

/** Time the page gets to send stop-presenting before a quit tears the window down. */
const QUIT_GRACE_MS = 400;
const APP_USER_MODEL_ID = "dev.iagofreire.screenshare";
/** Upper bound on the exclusion list a page may send to the audio helper. */
const MAX_EXCLUDED_APPS = 50;

let mainWindow: BrowserWindow | null = null;
let appTray: AppTray | null = null;
/** Mirrors the page's broadcast state (desktop:set-live). */
let isLive = false;
let isQuitting = false;

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
    const pick = sourceSelection.take();
    if (!isAllowedNavigation(request.frame?.url ?? "", serverOrigin)) {
      callback({});
      return;
    }
    desktopCapturer
      .getSources({ types: ["screen", "window"] })
      .then((sources) => callback(pickDisplayMedia(pick, sources) ?? {}))
      .catch((error: unknown) => {
        console.error("Listing capture sources failed:", error);
        callback({});
      });
  });
}

/** CSP on the server's pages and a permission allowlist -- see webSecurity.ts. */
function installWebSecurity(): void {
  const policy = buildContentSecurityPolicy(serverOrigin);
  session.defaultSession.webRequest.onHeadersReceived({ urls: [`${serverOrigin}/*`] }, (details, callback) => {
    if (details.resourceType !== "mainFrame") {
      callback({});
      return;
    }
    callback({ responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [policy] } });
  });
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
    const mediaTypes = "mediaTypes" in details ? details.mediaTypes : undefined;
    callback(isAllowedPermission(permission, details.requestingUrl, serverOrigin, mediaTypes));
  });
  session.defaultSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) =>
    isAllowedPermission(permission, requestingOrigin, serverOrigin),
  );
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
    title: APP_NAME,
    icon: APP_ICON_PATH,
    show: false,
    webPreferences: mainWindowWebPreferences(path.join(__dirname, "../preload/index.js")),
  });

  window.once("ready-to-show", () => window.show());

  // Mid-broadcast, the close button tucks the window into the tray instead of ending
  // the live; "Sair" in the tray (or quitting Windows) still closes for real.
  window.on("close", (event) => {
    if (decideCloseAction({ live: isLive, quitting: isQuitting }) === "hide-to-tray") {
      event.preventDefault();
      window.hide();
    }
  });

  window.webContents.on("will-navigate", (event, url) => {
    if (isAllowedNavigation(url, serverOrigin)) return;
    event.preventDefault();
    if (/^https?:/.test(url)) void shell.openExternal(url);
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  // A reload (logout, an invalid session) or a renderer crash takes the page's broadcast
  // with it, and nothing on the page is left to send setLive(false). Without this the
  // tray would keep the live badge and the close button would keep hiding the window.
  window.webContents.on("did-start-navigation", (details) => {
    if (!details.isMainFrame || details.isSameDocument) return;
    setLiveState(false);
    stopAppAudio();
  });
  window.webContents.on("render-process-gone", () => {
    setLiveState(false);
    stopAppAudio();
  });

  // Server down or the tunnel offline: a local page with a retry button beats a blank window.
  window.webContents.on("did-fail-load", (_event, errorCode, _description, _url, isMainFrame) => {
    if (isMainFrame && errorCode !== ERR_ABORTED) showOfflinePage(window);
  });

  void window.loadURL(appUrl);
  return window;
}

/** The bundled per-app audio helper (desktop/native/audio-helper). */
function audioHelperPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "audio-helper.exe")
    : path.join(__dirname, "../../native/audio-helper/target/release/audio-helper.exe");
}

let appAudio: AppAudioCapture | null = null;

function stopAppAudio(): void {
  appAudio?.stop();
  appAudio = null;
}

function setLiveState(live: boolean): void {
  isLive = live;
  appTray?.setLive(live);
}

function showMainWindow(): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** Quitting while live first asks the page to end the broadcast, so viewers see it stop. */
function quitApp(): void {
  const finish = () => {
    isQuitting = true;
    app.quit();
  };
  if (!isLive) {
    finish();
    return;
  }
  mainWindow?.webContents.send("desktop:end-live");
  setTimeout(finish, QUIT_GRACE_MS);
}

function registerIpc(): void {
  ipcMain.on("desktop:set-live", (event, live: unknown) => {
    if (!isTrustedSender(event)) return;
    setLiveState(live === true);
  });

  ipcMain.handle("desktop:audio-apps", async (event) => {
    assertTrustedSender(event);
    return listAudioApps(audioHelperPath(), process.pid);
  });

  // Excludes this app's whole process tree (process.pid) on top of the user's list.
  ipcMain.handle("desktop:audio-start", async (event, exclude: unknown) => {
    assertTrustedSender(event);
    return toIpcResult(
      (async () => {
        if (!Array.isArray(exclude) || exclude.length > MAX_EXCLUDED_APPS || !exclude.every(isExeName)) {
          throw new Error("Lista de apps inválida.");
        }
        if (!fs.existsSync(audioHelperPath())) throw new Error("A captura de áudio por app não está disponível.");
        stopAppAudio();
        const sender = event.sender;
        appAudio = startAppAudio(
          audioHelperPath(),
          process.pid,
          exclude,
          (block) => {
            if (!sender.isDestroyed()) sender.send("desktop:audio-block", block);
          },
          () => {
            appAudio = null;
            if (!sender.isDestroyed()) sender.send("desktop:audio-ended");
          },
        );
      })(),
    );
  });

  ipcMain.on("desktop:audio-stop", (event) => {
    if (isTrustedSender(event)) stopAppAudio();
  });

  ipcMain.on("desktop:notify", (event, title: unknown, body: unknown) => {
    if (!isTrustedSender(event) || !isNotification(title, body) || !Notification.isSupported()) return;
    const notification = new Notification({ title: title as string, body: body as string });
    notification.on("click", showMainWindow);
    notification.show();
  });

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

  ipcMain.handle("desktop:select-source", async (event, id: unknown, audio: unknown) => {
    assertTrustedSender(event);
    if (!isSourceId(id)) throw new Error("Fonte de captura inválida.");
    // Anything but an explicit false keeps the default: broadcast with sound.
    sourceSelection.set({ id, audio: audio !== false });
  });

  const sessionStore = createSessionStore({
    filePath: path.join(app.getPath("userData"), "session.bin"),
    encrypt: (text) => safeStorage.encryptString(text),
    decrypt: (data) => safeStorage.decryptString(data),
  });
  let loginInProgress: Promise<StoredLogin> | null = null;
  let loginAbort: AbortController | null = null;

  // Resolves to an IpcResult rather than rejecting, so the page shows the pt-BR message
  // itself instead of Electron's "Error invoking remote method ..." wrapper.
  ipcMain.handle("desktop:login", async (event) => {
    assertTrustedSender(event);
    // A second click while the browser is open joins the running login instead of
    // failing on the busy loopback port.
    if (!loginInProgress) {
      loginAbort = new AbortController();
      loginInProgress = runLoopbackLogin({
        openExternal: (url) => shell.openExternal(url),
        fetchClientId: fetchDiscordClientId,
        exchange: exchangeLoginCode,
        timeoutMs: LOGIN_TIMEOUT_MS,
        signal: loginAbort.signal,
      })
        .then(async (login) => {
          if (safeStorage.isEncryptionAvailable()) await sessionStore.save(login);
          showMainWindow();
          return login;
        })
        .finally(() => {
          loginInProgress = null;
          loginAbort = null;
        });
    }
    return toIpcResult(loginInProgress);
  });

  ipcMain.handle("desktop:cancel-login", async (event) => {
    assertTrustedSender(event);
    loginAbort?.abort();
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

// The data folder from before the rename (see appIdentity.ts) -- set before anything
// reads it, the single-instance lock included. A dev run's --user-data-dir still wins.
if (!app.commandLine.hasSwitch("user-data-dir")) {
  app.setPath("userData", userDataPath(app.getPath("appData")));
}

// A second launch focuses the running app instead of opening another window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showMainWindow);
  app.on("before-quit", () => {
    isQuitting = true;
    stopAppAudio();
  });

  // Groups notifications under the app's name instead of "electron.app.Electron".
  app.setAppUserModelId(APP_USER_MODEL_ID);

  void app.whenReady().then(() => {
    registerIpc();
    installWebSecurity();
    installDisplayMediaHandler();
    appTray = createAppTray({
      open: showMainWindow,
      endLive: () => mainWindow?.webContents.send("desktop:end-live"),
      quit: quitApp,
    });
    // Installed copies update themselves from the GitHub Releases (see package.json
    // "publish"); a dev run has no release feed to compare against.
    if (app.isPackaged) {
      autoUpdater.checkForUpdatesAndNotify().catch((error: unknown) => console.error("Update check failed:", error));
    }
    mainWindow = createMainWindow();
  });

  app.on("window-all-closed", () => app.quit());
}
