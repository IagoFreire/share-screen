import { h, icon } from "../dom.js";
import type { AudioDevice } from "../../voice/voiceDevices.js";

/**
 * The small controls of the voice panels, drawn in the app's own style instead of the
 * system's: a device list (a native <select> opens a Windows-white menu), a 0-200%
 * volume slider and an on/off switch.
 */

const CHEVRON = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 9.5l5 5 5-5z"/></svg>`;
const CHECK = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>`;

export interface DevicePickerOptions {
  label: string;
  devices: readonly AudioDevice[];
  selectedId: string | null;
  onPick(deviceId: string): void;
}

/** A button showing the device in use; it opens the list in place, keyboard included. */
export function devicePicker(options: DevicePickerOptions): HTMLElement {
  const selected = options.devices.find((device) => device.deviceId === options.selectedId);
  const button = h(
    "button",
    { class: "vc-picker-btn", type: "button", "aria-haspopup": "listbox", "aria-expanded": "false", "aria-label": options.label },
    h("span", { class: "vc-picker-value" }, selected?.label ?? "Procurando dispositivos…"),
    icon(CHEVRON, "vc-picker-chevron"),
  );
  const items = options.devices.map((device) => {
    const isSelected = device.deviceId === options.selectedId;
    const item = h(
      "li",
      {
        class: `vc-picker-option${isSelected ? " is-selected" : ""}`,
        role: "option",
        tabindex: "-1",
        "aria-selected": isSelected ? "true" : "false",
        title: device.label,
      },
      h("span", { class: "vc-picker-option-label" }, device.label),
      isSelected ? icon(CHECK, "vc-picker-check") : null,
    );
    item.addEventListener("click", () => pick(device.deviceId));
    return item;
  });
  const list = h("ul", { class: "vc-picker-list", role: "listbox", "aria-label": options.label, hidden: true }, ...items);
  const root = h("div", { class: "vc-picker" }, button, list);

  function setOpen(open: boolean): void {
    list.hidden = !open;
    root.classList.toggle("is-open", open);
    button.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) (items.find((item) => item.classList.contains("is-selected")) ?? items[0])?.focus();
  }

  function pick(deviceId: string): void {
    setOpen(false);
    button.focus();
    if (deviceId !== options.selectedId) options.onPick(deviceId);
  }

  button.addEventListener("click", () => setOpen(list.hidden));
  list.addEventListener("keydown", (event) => {
    const index = items.indexOf(document.activeElement as HTMLLIElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      items[(index + step + items.length) % items.length]?.focus();
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const device = options.devices[index];
      if (device) pick(device.deviceId);
    } else if (event.key === "Escape") {
      event.stopPropagation();
      setOpen(false);
      button.focus();
    }
  });
  // Tabbing or clicking away folds the list back up.
  root.addEventListener("focusout", (event) => {
    if (!root.contains(event.relatedTarget as Node | null)) setOpen(false);
  });
  return root;
}

export interface VolumeSliderOptions {
  label: string;
  /** 0 to 2. */
  value: number;
  onInput(value: number): void;
}

/** 0-200% in whole percents, filled up to the thumb; the 100% notch is the unchanged level. */
export function volumeSlider(options: VolumeSliderOptions): HTMLElement {
  const readout = h("span", { class: "vc-field-value" });
  const input = h("input", { class: "vc-range", type: "range", min: "0", max: "200", step: "1", "aria-label": options.label });
  input.value = String(Math.round(options.value * 100));

  function paint(): void {
    const percent = `${input.value}%`;
    readout.textContent = percent;
    input.setAttribute("aria-valuetext", percent);
    input.style.setProperty("--fill", `${Number(input.value) / 2}%`);
  }

  paint();
  input.addEventListener("input", () => {
    paint();
    options.onInput(Number(input.value) / 100);
  });
  return h(
    "div",
    { class: "vc-field" },
    h("div", { class: "vc-field-head" }, h("span", { class: "vc-pop-label" }, options.label), readout),
    input,
  );
}

export function toggleSwitch(label: string, on: boolean, onToggle: (on: boolean) => void): HTMLElement {
  return h(
    "button",
    {
      class: `vc-switch${on ? " is-on" : ""}`,
      type: "button",
      role: "switch",
      "aria-checked": on ? "true" : "false",
      "aria-label": label,
      onClick: () => onToggle(!on),
    },
    h("span", { class: "vc-switch-knob" }),
  );
}
