// Player styles come from the shared stylesheet; desktop.css lays the app around it.
// Imported from JS for the same cache-busting reason as main.ts.
import "../ui/app.css";
import "./desktop.css";
import type { DesktopApi, StoredLogin } from "@screenshare-bot/shared";
import { h } from "./dom.js";
import { startDesktopApp } from "./desktopApp.js";
import { renderLoginScreen } from "./views/loginScreen.js";
import { titleBar } from "./views/shell.js";

/**
 * Entry point for desktop.html -- the page the ScreenShare desktop app (Electron)
 * loads into its window. Outside the app there is no `window.desktop` bridge, so the
 * page only says where it belongs.
 */

function startLoggedIn(api: DesktopApi, content: HTMLElement, login: StoredLogin): void {
  startDesktopApp(content, api, login, { onTransmit: null, isLive: () => false, viewerCount: () => null });
}

async function boot(api: DesktopApi, content: HTMLElement): Promise<void> {
  const stored = await api.getStoredLogin().catch(() => null);
  if (stored) {
    startLoggedIn(api, content, stored);
    return;
  }
  renderLoginScreen(content, async () => {
    startLoggedIn(api, content, await api.login());
  });
}

function main(): void {
  const root = document.querySelector<HTMLDivElement>("#app");
  if (!root) throw new Error("#app root element not found.");
  document.body.classList.add("desktop");

  const api = window.desktop ?? null;
  const content = h("div", { class: "desk-content" });
  root.replaceChildren(titleBar(api?.windowControls ?? null), content);

  if (!api) {
    content.replaceChildren(h("p", { class: "desk-outside" }, "Abra esta página pelo app ScreenShare."));
    return;
  }
  void boot(api, content);
}

main();
