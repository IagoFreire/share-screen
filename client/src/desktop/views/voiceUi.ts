import "./voice.css";
import "./voicePanel.css";
import type { VoiceMember, VoiceRoomInfo } from "@screenshare-bot/shared";
import { avatar, h, icon } from "../dom.js";
import { listAudioDevices, type AudioDevice, type DeviceKind } from "../../voice/voiceDevices.js";
import { SPEAKING_LEVEL } from "../../voice/voiceLevel.js";
import type { VoiceSession } from "../../voice/voiceSession.js";
import { devicePanelContent, devicePanelKey, devicePanelLabel } from "./voiceSettings.js";
import { openUserVolumeMenu } from "./voiceUserMenu.js";

/**
 * The voice rooms in the desktop window: the "Salas de voz" section of the sidebar and
 * the voice dock above the user panel (microphone, headphones, their settings panels).
 * Both redraw from the session's state; who is talking, and the sensitivity meter, are
 * painted every frame instead, so speaking never rebuilds the DOM.
 */

/** How fast a speaking ring lets go: it fades over a few frames instead of flickering between syllables. */
const RING_FADE_PER_FRAME = 0.03;

const ICONS = {
  mic: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/></svg>`,
  micOff: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M15 11V5a3 3 0 0 0-5.94-.6L15 10.34V11zm4 0h-2c0 .74-.16 1.44-.45 2.07l1.48 1.48A6.96 6.96 0 0 0 19 11zM4.27 3 3 4.27l6 6V11a3 3 0 0 0 4.18 2.76l1.53 1.53A5 5 0 0 1 7 11H5a7 7 0 0 0 6 6.92V21h2v-3.08a6.9 6.9 0 0 0 2.97-1.06L19.73 21 21 19.73 4.27 3z"/></svg>`,
  headset: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3a9 9 0 0 0-9 9v7a2 2 0 0 0 2 2h3v-8H5v-1a7 7 0 0 1 14 0v1h-3v8h3a2 2 0 0 0 2-2v-7a9 9 0 0 0-9-9z"/></svg>`,
  headsetOff: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 5a7 7 0 0 1 7 7v1h-1.17l2.98 2.98V12a9 9 0 0 0-14.37-7.24l1.44 1.44A6.97 6.97 0 0 1 12 5zM3.27 2 2 3.27l2.24 2.24A8.96 8.96 0 0 0 3 12v7a2 2 0 0 0 2 2h3v-8H5v-1c0-1.2.3-2.33.83-3.32L16 18.85V21h2.15l2.58 2.58L22 22.31 3.27 2z"/></svg>`,
  hangup: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85a1 1 0 0 1-1.41-.02L.29 13.08a1 1 0 0 1 0-1.41C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67a1 1 0 0 1 0 1.41l-2.48 2.47a1 1 0 0 1-1.41.02 11.27 11.27 0 0 0-2.67-1.85 1 1 0 0 1-.56-.9v-3.1A15.09 15.09 0 0 0 12 9z"/></svg>`,
  chevron: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 14.5l5-5 5 5z"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg>`,
  wave: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 10h2v4H3zm4-3h2v10H7zm4-4h2v18h-2zm4 4h2v10h-2zm4 3h2v4h-2z"/></svg>`,
  speaker: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.47 4.47 0 0 0 2.5-4z"/></svg>`,
} as const;

/** replaceChildren that, like h(), skips the parts left out. */
function fill(target: HTMLElement, ...children: Array<Node | null>): void {
  target.replaceChildren(...children.filter((child): child is Node => child !== null));
}

export interface VoiceUi {
  /** The sidebar section; the host re-appends it after redrawing the channel list. */
  readonly roomsSection: HTMLElement;
  /** Sits right above the user panel. */
  readonly dock: HTMLElement;
  destroy(): void;
}

export function createVoiceUi(session: VoiceSession): VoiceUi {
  let creating = false;
  let popover: DeviceKind | null = null;
  /** What the open device panel was drawn from; it's only rebuilt when that changes. */
  let shownPanel = "";
  let devices: Record<DeviceKind, AudioDevice[]> = { input: [], output: [] };
  let frame = 0;
  /** Closes the open "Volume do usuário" menu, if any. */
  let closeUserMenu: (() => void) | null = null;
  /** The open device panel's box; see redrawPanel. */
  let panelBox: HTMLElement | null = null;

  // The name field and the device panel outlive the redraws around them: someone joining
  // a room elsewhere must not steal the focus or close a device list mid-pick.
  const nameInput = h("input", {
    class: "vc-create-input",
    type: "text",
    maxlength: "40",
    placeholder: "Nome da sala",
    "aria-label": "Nome da nova sala",
  });
  const createBox = h(
    "div",
    { class: "vc-create", hidden: true },
    nameInput,
    h("small", { class: "vc-hint" }, "Enter cria e entra · Esc cancela"),
  );
  const roomList = h("div");
  const roomsSection = h(
    "section",
    { class: "vc-rooms", "aria-label": "Salas de voz" },
    h(
      "div",
      { class: "vc-rooms-head" },
      h("span", { class: "vc-rooms-title" }, "Salas de voz"),
      h(
        "button",
        {
          class: "vc-add",
          type: "button",
          title: "Criar sala",
          "aria-label": "Criar sala",
          onClick: () => setCreating(!creating),
        },
        icon(ICONS.plus),
      ),
    ),
    createBox,
    roomList,
  );
  const panelSlot = h("div");
  const dockBody = h("div");
  const dock = h("section", { class: "vc-dock", "aria-label": "Voz" }, panelSlot, dockBody);

  nameInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      setCreating(false);
    } else if (event.key === "Enter" && nameInput.value.trim()) {
      session.createRoom(nameInput.value);
      setCreating(false);
    }
  });

  function setCreating(next: boolean): void {
    creating = next;
    createBox.hidden = !next;
    nameInput.value = "";
    if (next) nameInput.focus();
    renderRooms();
  }

  function memberRow(member: VoiceMember, here: boolean): HTMLElement {
    const content = [
      avatar(member.name, member.avatarUrl, member.userId, "vc-avatar"),
      h("span", { class: "vc-member-name" }, member.name),
      member.deafened ? icon(ICONS.headsetOff, "vc-flag") : member.muted ? icon(ICONS.micOff, "vc-flag") : null,
    ];
    // Seats are numbered per room, and only the room you're in is heard: other rooms
    // get no speaking ring rather than someone else's.
    const levelSlot = here ? String(member.slot) : undefined;
    if (member.userId === session.state().userId) {
      return h("div", { class: "vc-member", "data-level-slot": levelSlot }, ...content);
    }
    const row = h(
      "button",
      { class: "vc-member is-other", type: "button", title: `Volume de ${member.name}`, "data-level-slot": levelSlot },
      ...content,
    );
    row.addEventListener("click", () => {
      closeUserMenu?.();
      closeUserMenu = openUserVolumeMenu(row, member, session, () => {
        closeUserMenu = null;
      });
    });
    return row;
  }

  function roomRow(room: VoiceRoomInfo, here: boolean): HTMLElement {
    return h(
      "div",
      { class: `vc-room${here ? " is-here" : ""}` },
      h(
        "button",
        {
          class: "vc-room-head",
          type: "button",
          title: here ? "Você está nesta sala" : `Entrar em ${room.name}`,
          "aria-current": here ? "true" : undefined,
          onClick: () => {
            if (!here) session.joinRoom(room.id);
          },
        },
        icon(ICONS.speaker, "vc-room-icon"),
        h("span", { class: "vc-room-name" }, room.name),
      ),
      room.members.length > 0
        ? h("div", { class: "vc-members" }, ...room.members.map((member) => memberRow(member, here)))
        : null,
    );
  }

  function renderRooms(): void {
    const state = session.state();
    // In the server's order, like Discord's channels: joining one doesn't move it.
    fill(
      roomList,
      ...state.rooms.map((room) => roomRow(room, room.id === state.roomId)),
      state.connected ? null : h("p", { class: "vc-empty" }, "Conectando à voz…"),
      state.error ? h("p", { class: "vc-error", role: "alert" }, state.error) : null,
    );
  }

  function setPopover(next: DeviceKind | null): void {
    // The mic test belongs to the microphone's panel: closing that ends it, as in Discord.
    if (popover === "input" && next !== "input" && session.state().micTest !== "off") session.toggleMicTest();
    popover = next;
    render();
    if (popover) {
      void listAudioDevices()
        .then((found) => {
          devices = found;
          render();
        })
        .catch((error) => console.error("Failed to list audio devices:", error));
    }
  }

  function controlPair(kind: DeviceKind, off: boolean, label: string, svg: string, onClick: () => void): HTMLElement {
    const options = kind === "input" ? "Opções de entrada" : "Opções de saída";
    return h(
      "div",
      { class: `vc-pair${off ? " is-off" : ""}${popover === kind ? " is-open" : ""}` },
      h("button", { class: "vc-ctl", type: "button", title: label, "aria-label": label, "aria-pressed": off ? "true" : "false", onClick }, icon(svg)),
      h(
        "button",
        {
          class: "vc-chevron",
          type: "button",
          title: options,
          "aria-label": options,
          "aria-expanded": popover === kind ? "true" : "false",
          onClick: () => setPopover(popover === kind ? null : kind),
        },
        icon(ICONS.chevron),
      ),
    );
  }

  /**
   * The open panel's box is made once per opening, so its rise animation plays once;
   * later redraws (a test starting, devices listed) only swap what's inside it and hand
   * the focus back to the same control.
   */
  function redrawPanel(): void {
    if (popover === null) {
      panelBox = null;
      fill(panelSlot, null);
      return;
    }
    if (panelBox?.dataset.kind !== popover) {
      panelBox = h("div", { class: "vc-popover", role: "dialog", "aria-label": devicePanelLabel(popover), "data-kind": popover });
      fill(panelSlot, panelBox);
    }
    const focused = panelBox.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.focusKey : undefined;
    panelBox.replaceChildren(...devicePanelContent(popover, devices[popover], session));
    if (focused) {
      [...panelBox.querySelectorAll<HTMLElement>("[data-focus-key]")].find((element) => element.dataset.focusKey === focused)?.focus();
    }
  }

  function renderDock(): void {
    const state = session.state();
    const room = state.rooms.find((candidate) => candidate.id === state.roomId);
    const micOff = state.muted || state.deafened;
    const panel = popover === null ? "" : devicePanelKey(popover, devices[popover], session);
    if (panel !== shownPanel) {
      shownPanel = panel;
      redrawPanel();
    }
    fill(
      dockBody,
      room
        ? h(
            "div",
            { class: "vc-live" },
            h("span", { class: "vc-live-dot", "aria-hidden": "true" }),
            h("span", { class: "vc-live-text" }, h("strong", {}, "Voz conectada"), h("small", {}, room.name)),
            state.noiseActive ? h("span", { class: "vc-noise-tag", title: "Cancelamento de ruído ligado (RNNoise)" }, "RNNoise") : null,
            h(
              "button",
              { class: "vc-hangup", type: "button", title: "Sair da sala", "aria-label": "Sair da sala", onClick: () => session.leaveRoom() },
              icon(ICONS.hangup),
            ),
          )
        : null,
      state.micError ? h("p", { class: "vc-error", role: "alert" }, state.micError) : null,
      h(
        "div",
        { class: "vc-controls" },
        controlPair("input", micOff, micOff ? "Ativar microfone" : "Silenciar microfone", micOff ? ICONS.micOff : ICONS.mic, () => session.toggleMute()),
        controlPair("output", state.deafened, state.deafened ? "Ativar áudio" : "Desativar áudio", state.deafened ? ICONS.headsetOff : ICONS.headset, () => session.toggleDeafen()),
        h(
          "button",
          {
            class: `vc-ctl vc-noise${state.noiseSuppression ? " is-on" : ""}`,
            type: "button",
            title: state.noiseSuppression ? "Cancelamento de ruído: ligado" : "Cancelamento de ruído: desligado",
            "aria-label": "Cancelamento de ruído",
            "aria-pressed": state.noiseSuppression ? "true" : "false",
            onClick: () => session.setNoiseSuppression(!state.noiseSuppression),
          },
          icon(ICONS.wave),
        ),
      ),
    );
  }

  function render(): void {
    renderRooms();
    renderDock();
  }

  /** How lit each seat's ring was last frame, keyed by seat. */
  const shownLevels = new Map<string, number>();

  /** Paints who's talking and the sensitivity meter, every frame, without touching the DOM tree. */
  function paintLevels(): void {
    for (const row of roomsSection.querySelectorAll<HTMLElement>("[data-level-slot]")) {
      const slot = row.dataset.levelSlot ?? "";
      const level = Math.max(session.levelOf(Number(slot)), (shownLevels.get(slot) ?? 0) - RING_FADE_PER_FRAME);
      shownLevels.set(slot, level);
      row.classList.toggle("is-speaking", level > SPEAKING_LEVEL);
    }
    const input = session.inputLevel().toFixed(3);
    for (const bar of dock.querySelectorAll<HTMLElement>("[data-input-level]")) bar.style.setProperty("--level", input);
    frame = requestAnimationFrame(paintLevels);
  }

  function onOutsideClick(event: MouseEvent): void {
    if (popover && !dock.contains(event.target as Node)) setPopover(null);
  }

  session.onChange(render);
  document.addEventListener("mousedown", onOutsideClick);
  render();
  frame = requestAnimationFrame(paintLevels);

  return {
    roomsSection,
    dock,
    destroy() {
      cancelAnimationFrame(frame);
      closeUserMenu?.();
      document.removeEventListener("mousedown", onOutsideClick);
    },
  };
}
