import { Menu, nativeImage, Tray, type NativeImage } from "electron";
import { drawTrayIcon } from "./tray";

/** Drawn at 2x and tagged as such, so the tray stays crisp on scaled displays. */
const ICON_PIXELS = 32;
const ICON_SCALE = 2;

function trayImage(live: boolean): NativeImage {
  return nativeImage.createFromBitmap(drawTrayIcon(ICON_PIXELS, live), {
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
    tray.setToolTip(live ? "ScreenShare — ao vivo" : "ScreenShare");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Abrir ScreenShare", click: actions.open },
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
