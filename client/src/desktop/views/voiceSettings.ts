import { h } from "../dom.js";
import { chooseDevice, savedDevice, type AudioDevice, type DeviceKind } from "../../voice/voiceDevices.js";
import { LEVEL_FLOOR_DB, levelOfDb } from "../../voice/voiceLevel.js";
import type { VoiceSession } from "../../voice/voiceSession.js";
import { devicePicker, toggleSwitch, volumeSlider } from "./voiceControls.js";

/**
 * What the dock's chevrons open, Discord's voice settings in small: for the microphone
 * its device, volume, sensitivity bar, RNNoise and a test; for the output its device and
 * a test sound. voiceUi.ts owns the panel itself and swaps this content in, so a refresh
 * never replays the panel's opening or changes its size: every text here keeps its
 * length whatever the state, and focus comes back to the control marked data-focus-key.
 */

/** What the content is drawn from. voiceUi.ts redraws it only when this changes, so never mid-drag. */
export function devicePanelKey(kind: DeviceKind, devices: readonly AudioDevice[], session: VoiceSession): string {
  const state = session.state();
  return JSON.stringify([kind, devices, savedDevice(kind), state.noiseSuppression, state.micTest !== "off", state.outputTest]);
}

export function devicePanelLabel(kind: DeviceKind): string {
  return kind === "input" ? "Configurações do microfone" : "Configurações de saída";
}

export function devicePanelContent(kind: DeviceKind, devices: readonly AudioDevice[], session: VoiceSession): HTMLElement[] {
  return kind === "input" ? inputSettings(devices, session) : outputSettings(devices, session);
}

function pickerField(kind: DeviceKind, devices: readonly AudioDevice[], session: VoiceSession): HTMLElement {
  const label = kind === "input" ? "Dispositivo de entrada" : "Dispositivo de saída";
  return h(
    "div",
    { class: "vc-field" },
    h("span", { class: "vc-pop-label" }, label),
    devicePicker({
      label,
      devices,
      selectedId: chooseDevice(devices, savedDevice(kind)),
      onPick: (deviceId) => session.setDevice(kind, deviceId),
    }),
  );
}

/**
 * Discord's input sensitivity: the live level runs along the bar, amber below the mark
 * and green past it; dragging the mark sets what's quiet enough not to be sent.
 */
function sensitivityField(session: VoiceSession): HTMLElement {
  const readout = h("span", { class: "vc-field-value" });
  const range = h("input", {
    class: "vc-sense-range",
    type: "range",
    min: String(LEVEL_FLOOR_DB),
    max: "0",
    step: "1",
    "aria-label": "Sensibilidade do microfone",
    "data-focus-key": "sensitivity",
  });
  range.value = String(session.state().sensitivityDb);
  // voiceUi.ts paints the microphone's level on it every frame (data-input-level).
  const bar = h("div", { class: "vc-sense", "data-input-level": "" }, h("span", { class: "vc-sense-fill" }), range);

  function paint(): void {
    const text = `${range.value} dB`;
    readout.textContent = text;
    range.setAttribute("aria-valuetext", text);
    bar.style.setProperty("--mark", levelOfDb(Number(range.value)).toFixed(3));
  }

  paint();
  range.addEventListener("input", () => {
    paint();
    session.setSensitivity(Number(range.value));
  });
  return h(
    "div",
    { class: "vc-field" },
    h("div", { class: "vc-field-head" }, h("span", { class: "vc-pop-label" }, "Sensibilidade"), readout),
    bar,
    h("small", { class: "vc-hint" }, "Abaixo da marca, você não transmite."),
  );
}

/** Not disabled while busy: a disabled button drops the keyboard's focus. */
function testButton(focusKey: string, label: string, active: boolean, onClick: () => void): HTMLElement {
  return h(
    "button",
    { class: `vc-test${active ? " is-on" : ""}`, type: "button", "data-focus-key": focusKey, onClick },
    label,
  );
}

function inputSettings(devices: readonly AudioDevice[], session: VoiceSession): HTMLElement[] {
  const state = session.state();
  // Straight from one to the other: the moment the microphone takes to open isn't worth a label.
  const testing = state.micTest !== "off";
  return [
    pickerField("input", devices, session),
    volumeSlider({ label: "Volume do microfone", value: state.inputGain, onInput: (gain) => session.setInputGain(gain) }),
    sensitivityField(session),
    h(
      "div",
      { class: "vc-toggle-row" },
      h("span", {}, h("strong", {}, "Cancelamento de ruído"), h("small", {}, "RNNoise, open source, roda no seu PC")),
      toggleSwitch("Cancelamento de ruído", state.noiseSuppression, (on) => session.setNoiseSuppression(on)),
    ),
    h(
      "div",
      { class: "vc-test-row" },
      testButton("mic-test", testing ? "Parar teste" : "Testar microfone", testing, () => session.toggleMicTest()),
      h("small", { class: "vc-hint" }, "Você se ouve como os outros te ouvem."),
    ),
  ];
}

function outputSettings(devices: readonly AudioDevice[], session: VoiceSession): HTMLElement[] {
  const state = session.state();
  return [
    pickerField("output", devices, session),
    h(
      "div",
      { class: "vc-test-row" },
      testButton("output-test", state.outputTest ? "Tocando…" : "Testar saída", false, () => session.testOutput()),
      h("small", { class: "vc-hint" }, "Toca um som curto no dispositivo escolhido."),
    ),
  ];
}
