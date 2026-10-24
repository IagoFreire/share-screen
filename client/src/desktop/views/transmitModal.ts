import {
  AUDIO_QUALITY_DEFAULT,
  AUDIO_QUALITY_PRESETS,
  buildQualityPreset,
  planLayers,
  type AudioApp,
  type AudioQualityKey,
  type BitrateLevelKey,
  type DesktopApi,
  type DesktopSource,
  type FramerateKey,
  type QualityPreset,
  type ResolutionKey,
} from "@screenshare-bot/shared";
import { h, icon } from "../dom.js";
import type { AudioChoice } from "../liveController.js";
import { ICONS } from "./shell.js";

/**
 * "Transmitir" -- the all-in-one go-live dialog (option 1 of the approved mockups):
 * what to share on the left, quality and audio on the right, one button to go live.
 * Per-app audio and the viewer-selectable quality layers come in later plans.
 */

/** Same key and shape as present.ts, so both remember one choice. */
const QUALITY_STORAGE_KEY = "screenshare-bot:quality";

interface QualityChoice {
  resolution: ResolutionKey;
  fps: FramerateKey;
  bitrate: BitrateLevelKey;
}

const DEFAULT_CHOICE: QualityChoice = { resolution: "1080p", fps: 60, bitrate: "balanced" };
const RESOLUTION_OPTIONS: ResolutionKey[] = ["480p", "720p", "1080p"];
const FPS_OPTIONS: FramerateKey[] = [30, 60];
const BITRATE_OPTIONS: Array<{ key: BitrateLevelKey; label: string }> = [
  { key: "balanced", label: "Equilibrada" },
  { key: "high", label: "Alta" },
  { key: "max", label: "Máxima" },
];

function loadChoice(): QualityChoice {
  try {
    const saved = JSON.parse(localStorage.getItem(QUALITY_STORAGE_KEY) ?? "{}") as Partial<QualityChoice>;
    return {
      resolution: RESOLUTION_OPTIONS.includes(saved.resolution as ResolutionKey)
        ? (saved.resolution as ResolutionKey)
        : DEFAULT_CHOICE.resolution,
      fps: saved.fps === 30 || saved.fps === 60 ? saved.fps : DEFAULT_CHOICE.fps,
      bitrate: BITRATE_OPTIONS.some((option) => option.key === saved.bitrate)
        ? (saved.bitrate as BitrateLevelKey)
        : DEFAULT_CHOICE.bitrate,
    };
  } catch {
    return DEFAULT_CHOICE;
  }
}

function saveChoice(choice: QualityChoice): void {
  try {
    localStorage.setItem(QUALITY_STORAGE_KEY, JSON.stringify(choice));
  } catch {
    // Storage unavailable: the choice just isn't remembered.
  }
}

/** Upload for every simulcast version and the sound together, and which versions viewers can pick. */
function uploadEstimate(quality: QualityPreset, audioKbps: number): string {
  const layers = planLayers(quality);
  const totalKbps = layers.reduce((sum, layer) => sum + layer.bitrateKbps, audioKbps);
  const mbps = (totalKbps / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 });
  const versions = layers.map((layer) => `${layer.height}p${layer.framerate}`);
  const choice =
    versions.length > 1
      ? `quem assiste escolhe entre ${versions.slice(0, -1).join(", ")} e ${versions[versions.length - 1]}`
      : "uma versão só";
  return `~${mbps} Mbps de upload · ${choice}`;
}

/** Remembers whether the last live carried sound. */
const AUDIO_STORAGE_KEY = "screenshare-bot:desktop-audio";

function loadAudioChoice(): boolean {
  try {
    return localStorage.getItem(AUDIO_STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

function saveAudioChoice(audio: boolean): void {
  try {
    localStorage.setItem(AUDIO_STORAGE_KEY, audio ? "on" : "off");
  } catch {
    // Storage unavailable: the choice just isn't remembered.
  }
}

/** "Qualidade do som": see AUDIO_QUALITY_PRESETS for what each one encodes at. */
const AUDIO_QUALITY_STORAGE_KEY = "screenshare-bot:audio-quality";
const AUDIO_QUALITY_OPTIONS: Array<{ key: AudioQualityKey; label: string; hint: string }> = [
  { key: "light", label: "Leve", hint: "menos internet e processador, bom para PC mais fraco" },
  { key: "normal", label: "Normal", hint: "bom para voz e jogo" },
  { key: "high", label: "Alta", hint: "melhor para música" },
];

function loadAudioQuality(): AudioQualityKey {
  try {
    const saved = localStorage.getItem(AUDIO_QUALITY_STORAGE_KEY);
    return AUDIO_QUALITY_OPTIONS.find((option) => option.key === saved)?.key ?? AUDIO_QUALITY_DEFAULT;
  } catch {
    return AUDIO_QUALITY_DEFAULT;
  }
}

function saveAudioQuality(quality: AudioQualityKey): void {
  try {
    localStorage.setItem(AUDIO_QUALITY_STORAGE_KEY, quality);
  } catch {
    // Storage unavailable: the choice just isn't remembered.
  }
}

/** Apps the user switched off, by lowercased executable name. */
const EXCLUDED_APPS_STORAGE_KEY = "screenshare-bot:excluded-apps";
/** Discord's builds start out excluded: its call echoing into the live is why this list exists. */
const DEFAULT_EXCLUDED_APPS = ["discord.exe", "discordptb.exe", "discordcanary.exe"];
/** How often the app list (and its meters) refreshes while the dialog is open. */
const APPS_POLL_INTERVAL_MS = 1500;

function loadExcludedApps(): Set<string> {
  try {
    const saved = JSON.parse(localStorage.getItem(EXCLUDED_APPS_STORAGE_KEY) ?? "null") as unknown;
    if (Array.isArray(saved)) return new Set(saved.filter((entry): entry is string => typeof entry === "string"));
  } catch {
    // Unreadable: fall back to the default.
  }
  return new Set(DEFAULT_EXCLUDED_APPS);
}

function saveExcludedApps(excluded: Set<string>): void {
  try {
    localStorage.setItem(EXCLUDED_APPS_STORAGE_KEY, JSON.stringify([...excluded]));
  } catch {
    // Storage unavailable: the choice just isn't remembered.
  }
}

/** Friendlier names for apps people are likely to see in the list. */
const KNOWN_APP_NAMES: Record<string, string> = {
  "discord.exe": "Discord",
  "discordptb.exe": "Discord PTB",
  "discordcanary.exe": "Discord Canary",
  "msedge.exe": "Microsoft Edge",
  "chrome.exe": "Google Chrome",
  "brave.exe": "Brave",
  "firefox.exe": "Firefox",
  "opera.exe": "Opera",
  "spotify.exe": "Spotify",
  "steam.exe": "Steam",
  "shellexperiencehost.exe": "Sons do Windows",
};

/** "Spotify.exe" -> "Spotify"; unknown apps show their executable name without ".exe". */
function appLabel(exe: string): string {
  return KNOWN_APP_NAMES[exe.toLowerCase()] ?? exe.replace(/\.exe$/i, "");
}

export interface TransmitModalOptions {
  channelName: string;
  onGoLive(sourceId: string, quality: QualityPreset, audio: AudioChoice): Promise<void>;
}

export function openTransmitModal(api: DesktopApi, options: TransmitModalOptions): void {
  let choice = loadChoice();
  let audio = loadAudioChoice();
  let audioQuality = loadAudioQuality();
  let excluded = loadExcludedApps();
  /** Null until the first answer from the audio helper. */
  let apps: AudioApp[] | null = null;
  /** The helper isn't there or failed: the live takes the whole system mix instead. */
  let appsUnavailable = false;
  let appsTimer: ReturnType<typeof setInterval> | null = null;
  let sources: DesktopSource[] = [];
  let tab: DesktopSource["kind"] = "screen";
  let selectedId: string | null = null;
  let busy = false;

  const grid = h("div", { class: "desk-src-grid", role: "listbox", "aria-label": "Fontes de captura" });
  const tabs = h("div", { class: "desk-tabs", role: "tablist" });
  const qualityBox = h("div", { class: "desk-quality" });
  const audioBox = h("div", { class: "desk-audio" });
  const estimate = h("p", { class: "desk-estimate" });
  const error = h("p", { class: "desk-modal-error", role: "alert" });
  const goLiveButton = h("button", { class: "desk-btn-primary", type: "button" }, "Entrar ao vivo");
  const cancelButton = h("button", { class: "desk-btn-ghost", type: "button" }, "Cancelar");

  const dialog = h(
    "div",
    { class: "desk-modal", role: "dialog", "aria-modal": "true", "aria-label": "Transmitir" },
    h(
      "div",
      { class: "desk-modal-grid" },
      h(
        "section",
        { class: "desk-modal-sources" },
        h(
          "header",
          { class: "desk-modal-head" },
          h("h2", { class: "desk-modal-title" }, `Transmitir em 🔊 ${options.channelName}`),
          h("p", { class: "desk-modal-sub" }, "Escolha o que o pessoal vai ver"),
        ),
        tabs,
        grid,
      ),
      h(
        "section",
        { class: "desk-modal-settings" },
        qualityBox,
        estimate,
        h("p", { class: "desk-label" }, "Áudio da live"),
        audioBox,
      ),
    ),
    h("footer", { class: "desk-modal-foot" }, error, h("span", { class: "desk-spacer" }), cancelButton, goLiveButton),
  );
  const backdrop = h("div", { class: "desk-backdrop" }, dialog);

  function close(): void {
    document.removeEventListener("keydown", onKeydown);
    if (appsTimer) clearInterval(appsTimer);
    backdrop.remove();
  }

  function refreshApps(): void {
    api.appAudio
      .listApps()
      .then((list) => {
        apps = list;
        renderAudio();
      })
      .catch(() => {
        appsUnavailable = true;
        if (appsTimer) clearInterval(appsTimer);
        renderAudio();
      });
  }

  function audioChoice(): AudioChoice {
    if (!audio) return { mode: "off" };
    if (appsUnavailable) return { mode: "system", quality: audioQuality };
    return { mode: "apps", exclude: [...excluded], quality: audioQuality };
  }

  function toggleApp(exe: string): void {
    const key = exe.toLowerCase();
    const next = new Set(excluded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    excluded = next;
    saveExcludedApps(excluded);
    renderAudio();
  }

  function appRow(app: AudioApp): HTMLElement {
    const included = !excluded.has(app.exe.toLowerCase());
    const fill = h("span", { class: "desk-meter-fill" });
    // Peaks of normal program audio sit well below 1; scale so the bar actually moves.
    fill.style.transform = `scaleX(${Math.min(1, app.peak * 2).toFixed(3)})`;
    return h(
      "div",
      { class: `desk-app${included ? "" : " is-out"}` },
      h("span", { class: "desk-app-icon", "aria-hidden": "true" }, appLabel(app.exe).slice(0, 1).toUpperCase()),
      h("span", { class: "desk-app-name", title: app.exe }, appLabel(app.exe)),
      included ? h("span", { class: "desk-meter" }, fill) : h("small", { class: "desk-app-out" }, "fora da live"),
      h(
        "button",
        {
          class: `desk-switch desk-switch-small${included ? " is-on" : ""}`,
          type: "button",
          role: "switch",
          "aria-checked": included ? "true" : "false",
          "aria-label": `${appLabel(app.exe)} na live`,
          onClick: () => toggleApp(app.exe),
        },
        h("span", { class: "desk-switch-knob" }),
      ),
    );
  }

  function renderAppList(): HTMLElement {
    if (appsUnavailable) {
      return h("p", { class: "desk-audio-note" }, "A escolha por app não está disponível neste PC: vai o som do computador inteiro.");
    }
    if (apps === null) return h("p", { class: "desk-audio-note" }, "Procurando apps com som…");

    const playing = new Set(apps.map((app) => app.exe.toLowerCase()));
    const alwaysOut = [...excluded].filter((exe) => !playing.has(exe)).map(appLabel);
    return h(
      "div",
      { class: "desk-apps" },
      apps.length ? h("div", { class: "desk-app-list" }, ...apps.map(appRow)) : h("p", { class: "desk-audio-note" }, "Nenhum app tocando som agora."),
      alwaysOut.length > 0 && h("p", { class: "desk-audio-note" }, `Sempre fora da live: ${alwaysOut.join(", ")}.`),
      h("p", { class: "desk-audio-note" }, "Apps que começarem a tocar depois entram na live, menos os desligados."),
    );
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape" && !busy) close();
  }

  function chip<T>(label: string, value: T, current: T, onPick: (value: T) => void): HTMLButtonElement {
    const isOn = value === current;
    return h(
      "button",
      { class: `desk-chip${isOn ? " is-on" : ""}`, type: "button", "aria-pressed": isOn ? "true" : "false", onClick: () => onPick(value) },
      label,
    );
  }

  function setChoice(patch: Partial<QualityChoice>): void {
    choice = { ...choice, ...patch };
    saveChoice(choice);
    renderQuality();
  }

  function renderQuality(): void {
    qualityBox.replaceChildren(
      h("p", { class: "desk-label" }, "Qualidade"),
      h("div", { class: "desk-chips" }, ...RESOLUTION_OPTIONS.map((r) => chip(r, r, choice.resolution, (resolution) => setChoice({ resolution })))),
      h("div", { class: "desk-chips" }, ...FPS_OPTIONS.map((f) => chip(`${f} fps`, f, choice.fps, (fps) => setChoice({ fps })))),
      h("div", { class: "desk-chips" }, ...BITRATE_OPTIONS.map((b) => chip(b.label, b.key, choice.bitrate, (bitrate) => setChoice({ bitrate })))),
    );
    renderEstimate();
  }

  function renderEstimate(): void {
    const audioKbps = audio ? AUDIO_QUALITY_PRESETS[audioQuality].bitrateKbps : 0;
    estimate.textContent = uploadEstimate(buildQualityPreset(choice.resolution, choice.fps, choice.bitrate), audioKbps);
  }

  function renderAudioQuality(): HTMLElement {
    const picked = AUDIO_QUALITY_OPTIONS.find((option) => option.key === audioQuality)!;
    const pick = (quality: AudioQualityKey) => {
      audioQuality = quality;
      saveAudioQuality(quality);
      renderAudio();
    };
    return h(
      "div",
      { class: "desk-audio-quality" },
      h("p", { class: "desk-label" }, "Qualidade do som"),
      h("div", { class: "desk-chips" }, ...AUDIO_QUALITY_OPTIONS.map((option) => chip(option.label, option.key, audioQuality, pick))),
      h("p", { class: "desk-audio-note" }, `${AUDIO_QUALITY_PRESETS[audioQuality].bitrateKbps} kbps · ${picked.hint}`),
    );
  }

  function renderAudio(): void {
    const toggle = h(
      "button",
      {
        class: `desk-switch${audio ? " is-on" : ""}`,
        type: "button",
        role: "switch",
        "aria-checked": audio ? "true" : "false",
        "aria-label": "Transmitir o som do computador",
        onClick: () => {
          audio = !audio;
          saveAudioChoice(audio);
          renderAudio();
        },
      },
      h("span", { class: "desk-switch-knob" }),
    );
    const header = h(
      "div",
      { class: `desk-audio-row${audio ? "" : " is-muted"}` },
      icon(ICONS.speaker, "desk-audio-icon"),
      h(
        "span",
        { class: "desk-audio-text" },
        h("strong", {}, "Som dos apps"),
        h("small", {}, audio ? "Desligue os apps que não devem tocar na live." : "Desligado: a live vai sem som."),
      ),
      toggle,
    );
    audioBox.replaceChildren(...(audio ? [header, renderAudioQuality(), renderAppList()] : [header]));
    renderEstimate();
  }

  function renderTabs(): void {
    const tabButton = (kind: DesktopSource["kind"], label: string) =>
      h(
        "button",
        {
          class: `desk-tab${tab === kind ? " is-on" : ""}`,
          type: "button",
          role: "tab",
          "aria-selected": tab === kind ? "true" : "false",
          onClick: () => {
            tab = kind;
            renderTabs();
            renderSources();
          },
        },
        label,
      );
    tabs.replaceChildren(tabButton("screen", "Telas"), tabButton("window", "Janelas"));
  }

  function renderSources(): void {
    const visible = sources.filter((source) => source.kind === tab);
    if (visible.length === 0) {
      grid.replaceChildren(h("p", { class: "desk-src-empty" }, sources.length ? "Nada para mostrar aqui." : "Carregando…"));
      return;
    }
    grid.replaceChildren(
      ...visible.map((source) =>
        h(
          "button",
          {
            class: `desk-src${source.id === selectedId ? " is-on" : ""}`,
            type: "button",
            role: "option",
            "aria-selected": source.id === selectedId ? "true" : "false",
            title: source.name,
            onClick: () => {
              selectedId = source.id;
              renderSources();
              syncGoLive();
            },
          },
          h("img", { class: "desk-src-thumb", src: source.thumbnailDataUrl, alt: "" }),
          h(
            "span",
            { class: "desk-src-label" },
            source.iconDataUrl ? h("img", { class: "desk-src-icon", src: source.iconDataUrl, alt: "" }) : icon(ICONS.screen, "desk-src-icon"),
            h("span", { class: "desk-src-name" }, source.name),
          ),
        ),
      ),
    );
  }

  function syncGoLive(): void {
    goLiveButton.disabled = busy || selectedId === null;
    goLiveButton.textContent = busy ? "Entrando ao vivo…" : "Entrar ao vivo";
    cancelButton.disabled = busy;
  }

  goLiveButton.addEventListener("click", () => {
    if (!selectedId || busy) return;
    busy = true;
    error.textContent = "";
    syncGoLive();
    options
      .onGoLive(selectedId, buildQualityPreset(choice.resolution, choice.fps, choice.bitrate), audioChoice())
      .then(close)
      .catch((reason: unknown) => {
        busy = false;
        error.textContent = reason instanceof Error ? reason.message : "Não foi possível entrar ao vivo.";
        syncGoLive();
      });
  });
  cancelButton.addEventListener("click", close);
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop && !busy) close();
  });
  document.addEventListener("keydown", onKeydown);

  renderTabs();
  renderSources();
  renderQuality();
  renderAudio();
  syncGoLive();
  document.body.append(backdrop);
  goLiveButton.focus();
  refreshApps();
  appsTimer = setInterval(refreshApps, APPS_POLL_INTERVAL_MS);

  api
    .getSources()
    .then((list) => {
      sources = list;
      selectedId = list.find((source) => source.kind === "screen")?.id ?? null;
      renderSources();
      syncGoLive();
    })
    .catch(() => {
      error.textContent = "Não foi possível listar telas e janelas.";
    });
}

/** A small yes/no dialog in the same style; resolves true for the confirm button. */
export function confirmDialog(options: { title: string; text: string; confirmLabel: string; cancelLabel: string }): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (answer: boolean) => {
      backdrop.remove();
      resolve(answer);
    };
    const confirmButton = h("button", { class: "desk-btn-danger", type: "button", onClick: () => finish(true) }, options.confirmLabel);
    const backdrop = h(
      "div",
      { class: "desk-backdrop" },
      h(
        "div",
        { class: "desk-modal desk-modal-small", role: "alertdialog", "aria-modal": "true", "aria-label": options.title },
        h("header", { class: "desk-modal-head" }, h("h2", { class: "desk-modal-title" }, options.title), h("p", { class: "desk-modal-sub" }, options.text)),
        h(
          "footer",
          { class: "desk-modal-foot" },
          h("span", { class: "desk-spacer" }),
          h("button", { class: "desk-btn-ghost", type: "button", onClick: () => finish(false) }, options.cancelLabel),
          confirmButton,
        ),
      ),
    );
    document.body.append(backdrop);
    confirmButton.focus();
  });
}
