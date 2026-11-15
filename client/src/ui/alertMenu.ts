import type { AlertSound } from "@screenshare-bot/shared";

/**
 * The alert button's sound list: the bell opens it, and picking a sound plays it at the
 * presenter (play-alert). Wraps the existing #alert-btn, so its visibility rules stay
 * where they are. Shared by the Activity, watch.html and the desktop app's player.
 */

export const ALERT_MENU_ITEMS: ReadonlyArray<{ sound: AlertSound; label: string }> = [
  { sound: "knock", label: "Bater na porta" },
  { sound: "usb-in", label: "USB conectado" },
  { sound: "usb-out", label: "USB desconectado" },
];

/** The sound lasts about half a second; this stops a double-click from stacking them. */
const LOCKOUT_MS = 2000;

export function attachAlertMenu(button: HTMLButtonElement, onPick: (sound: AlertSound) => void): { close(): void } {
  const wrapper = document.createElement("div");
  wrapper.className = "gain-control alert-menu";
  button.before(wrapper);
  wrapper.append(button);
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");

  const popup = document.createElement("div");
  popup.className = "gain-pop alert-pop";
  popup.setAttribute("role", "menu");
  popup.setAttribute("aria-label", "Sons de alerta");
  popup.hidden = true;

  const title = document.createElement("p");
  title.className = "gain-title";
  title.textContent = "Tocar para quem transmite";
  popup.append(title);

  for (const item of ALERT_MENU_ITEMS) {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "alert-option";
    option.setAttribute("role", "menuitem");
    option.textContent = item.label;
    option.addEventListener("click", () => {
      close();
      onPick(item.sound);
      button.disabled = true;
      setTimeout(() => {
        button.disabled = false;
      }, LOCKOUT_MS);
    });
    popup.append(option);
  }
  wrapper.append(popup);

  function onOutside(event: MouseEvent): void {
    if (!wrapper.contains(event.target as Node)) close();
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      close();
      button.focus();
    }
  }

  function close(): void {
    popup.hidden = true;
    button.setAttribute("aria-expanded", "false");
    document.removeEventListener("click", onOutside, true);
    document.removeEventListener("keydown", onKey);
  }

  button.addEventListener("click", () => {
    if (button.disabled) return;
    if (!popup.hidden) {
      close();
      return;
    }
    popup.hidden = false;
    button.setAttribute("aria-expanded", "true");
    document.addEventListener("click", onOutside, true);
    document.addEventListener("keydown", onKey);
    popup.querySelector<HTMLButtonElement>(".alert-option")?.focus();
  });

  return { close };
}
