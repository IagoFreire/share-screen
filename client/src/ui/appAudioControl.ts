import type { AppAudioStatus } from "@screenshare-bot/shared";

/**
 * "Apps": the admin's per-app switch for a desktop live's sound. Lists the apps the
 * presenter's audio helper reports (audio-status) and takes one out of the live, or puts
 * it back (set-app-audio-disabled). The relay re-checks the admin; the presenter isn't
 * told and can't undo it -- it lasts until that live ends. Beside "Ganho" in the player's
 * overlay bar, in the Activity, watch.html and the desktop app's player alike.
 */

export interface AppAudioRow {
  exe: string;
  name: string;
  /** An admin took it out of this live. */
  disabled: boolean;
}

export function appAudioRows(status: AppAudioStatus | null): AppAudioRow[] {
  if (!status) return [];
  return status.apps
    .map(({ exe, state }) => ({ exe, name: exe.replace(/\.exe$/i, ""), disabled: state === "disabled" }))
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR", { sensitivity: "base" }));
}

export function appAudioButtonLabel(rows: readonly AppAudioRow[]): string {
  const off = rows.filter((row) => row.disabled).length;
  return off > 0 ? `Apps · ${off} off` : "Apps";
}

export interface AppAudioControl {
  /** Goes in the player's overlay bar. */
  element: HTMLElement;
  /** `visible`: an admin watching someone else's desktop live. `status`: its latest report. */
  update(state: { visible: boolean; status: AppAudioStatus | null }): void;
  close(): void;
}

export function createAppAudioControl(onToggle: (exe: string, disabled: boolean) => void): AppAudioControl {
  const element = document.createElement("div");
  element.className = "gain-control app-audio-control";
  element.style.display = "none";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "gain-btn";
  button.title = "Som de cada app desta live (só admin)";
  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-expanded", "false");

  const popup = document.createElement("div");
  popup.className = "gain-pop app-audio-pop";
  popup.setAttribute("role", "dialog");
  popup.setAttribute("aria-label", "Som de cada app");
  popup.hidden = true;

  const title = document.createElement("p");
  title.className = "gain-title";
  title.textContent = "Apps nesta live";
  const hint = document.createElement("p");
  hint.className = "gain-hint";
  hint.textContent = "Desligar tira o som do app para todos. Quem transmite não é avisado; vale até a live acabar.";
  const list = document.createElement("ul");
  list.className = "app-audio-list";

  popup.append(title, hint, list);
  element.append(button, popup);

  /** Clicked, waiting for the helper's next report to confirm (about a second). */
  const pending = new Map<string, boolean>();

  function renderRows(rows: readonly AppAudioRow[]): void {
    const items = rows.map((row) => {
      const wanted = pending.get(row.exe.toLowerCase());
      const disabled = wanted ?? row.disabled;

      const item = document.createElement("li");
      item.className = "app-audio-row";
      item.classList.toggle("is-off", disabled);

      const name = document.createElement("span");
      name.className = "app-audio-name";
      name.textContent = row.name;
      name.title = row.exe;

      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "app-audio-toggle";
      toggle.textContent = wanted === undefined ? (disabled ? "Religar" : "Desligar") : "…";
      toggle.disabled = wanted !== undefined;
      toggle.setAttribute("aria-label", `${disabled ? "Religar" : "Desligar"} o som de ${row.name}`);
      toggle.addEventListener("click", () => {
        pending.set(row.exe.toLowerCase(), !disabled);
        onToggle(row.exe, !disabled);
        renderRows(rows);
      });

      item.append(name, toggle);
      return item;
    });

    if (items.length === 0) {
      const empty = document.createElement("li");
      empty.className = "app-audio-empty";
      empty.textContent = "Nenhum app com som agora.";
      list.replaceChildren(empty);
    } else {
      list.replaceChildren(...items);
    }
  }

  function onOutside(event: MouseEvent): void {
    if (!element.contains(event.target as Node)) close();
  }

  function close(): void {
    popup.hidden = true;
    button.setAttribute("aria-expanded", "false");
    document.removeEventListener("click", onOutside, true);
  }

  button.addEventListener("click", () => {
    if (!popup.hidden) {
      close();
      return;
    }
    popup.hidden = false;
    button.setAttribute("aria-expanded", "true");
    document.addEventListener("click", onOutside, true);
  });

  let lastStatus: AppAudioStatus | null | undefined;

  return {
    element,
    update({ visible, status }) {
      const shown = visible && status !== null;
      element.style.display = shown ? "" : "none";
      if (!shown) {
        close();
        pending.clear();
        lastStatus = undefined;
        return;
      }
      if (status === lastStatus) return;
      lastStatus = status;
      const rows = appAudioRows(status);
      // The report confirms a click once it shows the app the way it was asked to be.
      for (const row of rows) {
        const key = row.exe.toLowerCase();
        if (pending.get(key) === row.disabled) pending.delete(key);
      }
      button.textContent = appAudioButtonLabel(rows);
      button.classList.toggle("is-boosted", rows.some((row) => row.disabled));
      renderRows(rows);
    },
    close,
  };
}
