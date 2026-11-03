/**
 * "Carregando a live…" over the player, from the moment a live is picked (or the picture
 * restarts) until its first frame is drawn. That wait -- a keyframe round trip, a decoder
 * starting -- otherwise shows as a black player that looks broken.
 */
export interface LoadingOverlay {
  show(): void;
  hide(): void;
}

/** Shown only once the wait passes this, so a quick start never flashes it. */
const SHOW_AFTER_MS = 250;

/** Placed right before `under`, so that element (the idle screen) still covers it. */
export function createLoadingOverlay(host: HTMLElement, under: HTMLElement): LoadingOverlay {
  const element = document.createElement("div");
  element.className = "player-loading";
  element.setAttribute("role", "status");
  element.hidden = true;
  element.innerHTML = `<span class="player-loading-spinner" aria-hidden="true"></span><span>Carregando a live…</span>`;
  host.insertBefore(element, under);
  let timer: ReturnType<typeof setTimeout> | null = null;

  return {
    show() {
      if (timer !== null || !element.hidden) return;
      timer = setTimeout(() => {
        timer = null;
        element.hidden = false;
      }, SHOW_AFTER_MS);
    },
    hide() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      element.hidden = true;
    },
  };
}
