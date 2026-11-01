import { MAX_STREAM_GAIN } from "@screenshare-bot/shared";

/**
 * "Ganho": the admin's loudness control for the broadcast being watched, 0-1000%, for
 * everyone watching it -- a presenter whose apps play quietly can be fixed from the
 * viewer side. The relay re-checks the admin and stores it (set-stream-gain); every
 * player applies it on top of its own volume, behind a limiter. Shared by the Activity,
 * watch.html and the desktop app's player, like the quality picker.
 */

const MAX_PERCENT = MAX_STREAM_GAIN * 100;
const STEP_PERCENT = 10;
/** Slider moves are sent at most this often while dragging. */
const SEND_EVERY_MS = 150;
const PRESETS = [100, 200, 400, 1000];

export function percentFromGain(gain: number | undefined): number {
  return Math.round((gain ?? 1) * 100);
}

export function gainFromPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 1;
  return Math.min(MAX_PERCENT, Math.max(0, percent)) / 100;
}

export function gainButtonLabel(gain: number | undefined): string {
  return `Ganho ${percentFromGain(gain)}%`;
}

export interface GainControl {
  /** Goes in the player's overlay bar. */
  element: HTMLElement;
  /** `visible`: an admin watching someone else's broadcast. `gain`: what it is now. */
  update(state: { visible: boolean; gain: number | undefined }): void;
  close(): void;
}

export function createGainControl(onChange: (gain: number) => void): GainControl {
  const element = document.createElement("div");
  element.className = "gain-control";
  element.style.display = "none";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "gain-btn";
  button.title = "Ganho do som para todos (só admin)";
  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-expanded", "false");

  const popup = document.createElement("div");
  popup.className = "gain-pop";
  popup.setAttribute("role", "dialog");
  popup.setAttribute("aria-label", "Ganho do som para todos");
  popup.hidden = true;

  const title = document.createElement("p");
  title.className = "gain-title";
  title.textContent = "Ganho para todos";
  const hint = document.createElement("p");
  hint.className = "gain-hint";
  hint.textContent = "Aumenta o som desta live para todo mundo que assiste.";

  const value = document.createElement("output");
  value.className = "gain-value";

  const slider = document.createElement("input");
  slider.type = "range";
  slider.className = "gain-slider";
  slider.min = "0";
  slider.max = String(MAX_PERCENT);
  slider.step = String(STEP_PERCENT);
  slider.setAttribute("aria-label", "Ganho em porcentagem");

  const presets = document.createElement("div");
  presets.className = "gain-presets";
  for (const percent of PRESETS) {
    const preset = document.createElement("button");
    preset.type = "button";
    preset.className = "gain-preset";
    preset.textContent = percent === 100 ? "Normal" : `${percent}%`;
    preset.addEventListener("click", () => setPercent(percent, true));
    presets.append(preset);
  }

  popup.append(title, hint, value, slider, presets);
  element.append(button, popup);

  let current = 100;
  let dragging = false;
  let sendTimer: ReturnType<typeof setTimeout> | null = null;

  function show(percent: number): void {
    current = percent;
    slider.value = String(percent);
    slider.style.setProperty("--fill", `${(percent / MAX_PERCENT) * 100}%`);
    value.textContent = `${percent}%`;
    button.textContent = gainButtonLabel(percent / 100);
    button.classList.toggle("is-boosted", percent !== 100);
  }

  function send(): void {
    if (sendTimer) clearTimeout(sendTimer);
    sendTimer = null;
    onChange(gainFromPercent(current));
  }

  function setPercent(percent: number, immediately: boolean): void {
    show(Math.round(gainFromPercent(percent) * 100));
    if (immediately) send();
    else sendTimer ??= setTimeout(send, SEND_EVERY_MS);
  }

  slider.addEventListener("input", () => {
    dragging = true;
    setPercent(Number(slider.value), false);
  });
  slider.addEventListener("change", () => {
    dragging = false;
    setPercent(Number(slider.value), true);
  });

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
    slider.focus();
  });

  show(100);

  return {
    element,
    update({ visible, gain }) {
      element.style.display = visible ? "" : "none";
      if (!visible) close();
      // Don't yank the slider from under a drag; the relay echoes the value back anyway.
      if (!dragging && sendTimer === null) show(percentFromGain(gain));
    },
    close,
  };
}
