import {
  buildQualityPreset,
  TARGET_AUDIO_BITRATE_KBPS_DEFAULT,
  type BitrateLevelKey,
  type DesktopApi,
  type DesktopSource,
  type FramerateKey,
  type QualityPreset,
  type ResolutionKey,
} from "@screenshare-bot/shared";
import { h, icon } from "../dom.js";
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

function uploadEstimate(quality: QualityPreset): string {
  const mbps = (quality.bitrateKbps + TARGET_AUDIO_BITRATE_KBPS_DEFAULT) / 1000;
  return `~${mbps.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} Mbps de upload por espectador`;
}

export interface TransmitModalOptions {
  channelName: string;
  onGoLive(sourceId: string, quality: QualityPreset): Promise<void>;
}

export function openTransmitModal(api: DesktopApi, options: TransmitModalOptions): void {
  let choice = loadChoice();
  let sources: DesktopSource[] = [];
  let tab: DesktopSource["kind"] = "screen";
  let selectedId: string | null = null;
  let busy = false;

  const grid = h("div", { class: "desk-src-grid", role: "listbox", "aria-label": "Fontes de captura" });
  const tabs = h("div", { class: "desk-tabs", role: "tablist" });
  const qualityBox = h("div", { class: "desk-quality" });
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
        h(
          "div",
          { class: "desk-audio-row" },
          icon(ICONS.speaker, "desk-audio-icon"),
          h(
            "span",
            { class: "desk-audio-text" },
            h("strong", {}, "Som do computador"),
            h("small", {}, "Inclui tudo o que toca no PC, inclusive o Discord. Escolher apps vem na próxima versão."),
          ),
        ),
      ),
    ),
    h("footer", { class: "desk-modal-foot" }, error, h("span", { class: "desk-spacer" }), cancelButton, goLiveButton),
  );
  const backdrop = h("div", { class: "desk-backdrop" }, dialog);

  function close(): void {
    document.removeEventListener("keydown", onKeydown);
    backdrop.remove();
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
    estimate.textContent = uploadEstimate(buildQualityPreset(choice.resolution, choice.fps, choice.bitrate));
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
      .onGoLive(selectedId, buildQualityPreset(choice.resolution, choice.fps, choice.bitrate))
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
  syncGoLive();
  document.body.append(backdrop);
  goLiveButton.focus();

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
