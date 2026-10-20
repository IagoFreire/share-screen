import type { LayerInfo } from "@screenshare-bot/shared";

/**
 * The viewer's quality picker for simulcast broadcasts (sent by the desktop app):
 * "Automático" -- the relay picks from what the connection keeps up with -- or one fixed
 * version. Shared by the Activity, watch.html and the desktop app's player. Hidden for
 * broadcasts that only carry one version (the browser tab).
 */

export type QualityChoice = number | "auto";

export interface QualityMenuItem {
  choice: QualityChoice;
  label: string;
  detail: string;
  selected: boolean;
}

const describe = (layer: LayerInfo | undefined) => (layer ? `${layer.height}p${layer.framerate}` : "");

export function qualityButtonLabel(layers: LayerInfo[], choice: QualityChoice, currentLayer: number): string {
  if (choice === "auto") return `Auto · ${layers[currentLayer]?.height ?? layers[0]?.height}p`;
  return describe(layers[choice]);
}

export function qualityMenuItems(layers: LayerInfo[], choice: QualityChoice, currentLayer: number): QualityMenuItem[] {
  return [
    { choice: "auto", label: "Automático", detail: describe(layers[currentLayer]), selected: choice === "auto" },
    ...layers.map((layer) => ({
      choice: layer.layer,
      label: `${layer.height}p`,
      detail: `${layer.framerate} fps`,
      selected: choice === layer.layer,
    })),
  ];
}

export interface QualityMenu {
  /** Goes in the player's overlay bar. */
  element: HTMLElement;
  update(layers: LayerInfo[] | undefined, choice: QualityChoice, currentLayer: number): void;
  close(): void;
}

export function createQualityMenu(onSelect: (choice: QualityChoice) => void): QualityMenu {
  const element = document.createElement("div");
  element.className = "quality-menu";
  element.style.display = "none";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "quality-btn";
  button.title = "Qualidade";
  button.setAttribute("aria-haspopup", "menu");

  const popup = document.createElement("div");
  popup.className = "quality-pop";
  popup.setAttribute("role", "menu");
  popup.hidden = true;
  element.append(button, popup);

  let state: { layers: LayerInfo[]; choice: QualityChoice; currentLayer: number } | null = null;

  function onOutside(event: MouseEvent): void {
    if (!element.contains(event.target as Node)) close();
  }

  function close(): void {
    popup.hidden = true;
    button.setAttribute("aria-expanded", "false");
    document.removeEventListener("click", onOutside, true);
  }

  function renderItems(): void {
    if (!state) return;
    popup.replaceChildren(
      ...qualityMenuItems(state.layers, state.choice, state.currentLayer).map((item) => {
        const row = document.createElement("button");
        row.type = "button";
        row.className = `quality-item${item.selected ? " is-selected" : ""}`;
        row.setAttribute("role", "menuitemradio");
        row.setAttribute("aria-checked", item.selected ? "true" : "false");
        const label = document.createElement("span");
        label.textContent = item.label;
        const detail = document.createElement("small");
        detail.textContent = item.detail;
        row.append(label, detail);
        row.addEventListener("click", () => {
          close();
          onSelect(item.choice);
        });
        return row;
      }),
    );
  }

  button.addEventListener("click", () => {
    if (!popup.hidden) {
      close();
      return;
    }
    renderItems();
    popup.hidden = false;
    button.setAttribute("aria-expanded", "true");
    document.addEventListener("click", onOutside, true);
  });

  return {
    element,
    update(layers, choice, currentLayer) {
      if (!layers || layers.length < 2) {
        state = null;
        element.style.display = "none";
        close();
        return;
      }
      state = { layers, choice, currentLayer };
      element.style.display = "";
      button.textContent = qualityButtonLabel(layers, choice, currentLayer);
      if (!popup.hidden) renderItems();
    },
    close,
  };
}
