import path from "node:path";
import { Menu, nativeImage, Tray, type NativeImage } from "electron";
import { APP_NAME } from "./appIdentity";
import { withLiveBadge } from "./tray";

/** Janja: the window's icon and, with the live badge on top, the tray's. */
export const APP_ICON_PATH = path.join(__dirname, "../../static/janja.png");

/** Rendered at 2x and tagged as such, so the tray stays crisp on scaled displays. */
const ICON_PIXELS = 32;
const ICON_SCALE = 2;

/** The icon at tray size as BGRA, read from disk once. */
let iconBitmap: Buffer | null = null;

function trayImage(live: boolean): NativeImage {
  iconBitmap ??= nativeImage
    .createFromPath(APP_ICON_PATH)
    .resize({ width: ICON_PIXELS, height: ICON_PIXELS, quality: "best" })
    .toBitmap();
  // Unreadable icon: an empty tray image beats crashing the app on start.
  if (iconBitmap.length !== ICON_PIXELS * ICON_PIXELS * 4) return nativeImage.createEmpty();
  return nativeImage.createFromBitmap(withLiveBadge(iconBitmap, ICON_PIXELS, live), {
    width: ICON_PIXELS,
    height: ICON_PIXELS,
    scaleFactor: ICON_SCALE,
  });
}

export interface AppTrayActions {
  open(): void;
  endLive(): void;
  quit(): void;
}

export interface AppTray {
  setLive(live: boolean): void;
}

/** The notification-area icon: open the window, end a broadcast, or quit. */
export function createAppTray(actions: AppTrayActions): AppTray {
  const tray = new Tray(trayImage(false));

  function render(live: boolean): void {
    tray.setImage(trayImage(live));
    tray.setToolTip(live ? `${APP_NAME} — ao vivo` : APP_NAME);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `Abrir ${APP_NAME}`, click: actions.open },
        { label: "Encerrar transmissão", enabled: live, click: actions.endLive },
        { type: "separator" },
        { label: "Sair", click: actions.quit },
      ]),
    );
  }

  tray.on("click", actions.open);
  render(false);
  return { setLive: render };
}
