import { h } from "../dom.js";
import { chooseDevice, savedDevice, type AudioDevice, type DeviceKind } from "../../voice/voiceDevices.js";
import { LEVEL_FLOOR_DB, levelOfDb } from "../../voice/voiceLevel.js";
import type { VoiceSession } from "../../voice/voiceSession.js";
import { devicePicker, toggleSwitch, volumeSlider } from "./voiceControls.js";

/**
 * The panel the dock's chevrons open, Discord's voice settings in small: for the
 * microphone its device, volume, sensitivity bar, RNNoise and a test; for the output
 * its device and a test sound.
 */

/** What the panel is drawn from. voiceUi.ts rebuilds it only when this changes, so never mid-drag. */
export function devicePanelKey(kind: DeviceKind, devices: readonly AudioDevice[], session: VoiceSession): string {
  const state = session.state();
  return JSON.stringify([kind, devices, savedDevice(kind), state.noiseSuppression, state.micTest, state.outputTest, state.roomId === null]);
}

export function devicePanel(kind: DeviceKind, devices: readonly AudioDevice[], session: VoiceSession): HTMLElement {
  return h(
    "div",
    { class: "vc-popover", role: "dialog", "aria-label": kind === "input" ? "Configurações do microfone" : "Configurações de saída" },
    ...(kind === "input" ? inputSettings(devices, session) : outputSettings(devices, session)),
  );
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
  const state = session.state();
  const readout = h("span", { class: "vc-field-value" });
  const range = h("input", {
    class: "vc-sense-range",
    type: "range",
    min: String(LEVEL_FLOOR_DB),
    max: "0",
    step: "1",
    "aria-label": "Sensibilidade do microfone",
  });
  range.value = String(state.sensitivityDb);
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
  const idle = state.roomId === null && state.micTest === "off";
  return h(
    "div",
    { class: "vc-field" },
    h("div", { class: "vc-field-head" }, h("span", { class: "vc-pop-label" }, "Sensibilidade"), readout),
    bar,
    h("small", { class: "vc-hint" }, idle ? "Teste o microfone para ver o seu nível na barra." : "Abaixo da marca, você não transmite."),
  );
}

function inputSettings(devices: readonly AudioDevice[], session: VoiceSession): HTMLElement[] {
  const state = session.state();
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
      h(
        "button",
        {
          class: `vc-test${testing ? " is-on" : ""}`,
          type: "button",
          disabled: state.micTest === "starting",
          onClick: () => session.toggleMicTest(),
        },
        state.micTest === "on" ? "Parar teste" : state.micTest === "starting" ? "Abrindo o microfone…" : "Testar microfone",
      ),
      h("small", { class: "vc-hint" }, testing ? "Você está se ouvindo como os outros te ouvem." : "Fale e escute como você chega para os outros."),
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
      h(
        "button",
        { class: "vc-test", type: "button", disabled: state.outputTest, onClick: () => session.testOutput() },
        state.outputTest ? "Tocando…" : "Testar saída",
      ),
      h("small", { class: "vc-hint" }, "Toca um som curto no dispositivo escolhido."),
    ),
  ];
}
