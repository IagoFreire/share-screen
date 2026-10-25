import type { DesktopApi, DesktopUser } from "@screenshare-bot/shared";
import type { LiveAudience } from "../broadcast.js";
// Fingerprinted by Vite, like desktop/main.ts's sound, so a changed image is never served stale.
import janjaUrl from "../../../assets/janja.png";
import { avatar, h, icon, initials } from "../dom.js";
import type { SidebarChannel, SidebarServer } from "../sidebarModel.js";
import type { VoiceState } from "../voicePoller.js";

/**
 * The static pieces of the "Clássico Discord" layout. Each render function rebuilds its
 * own container from plain data; the player area is left alone so the video never
 * restarts because the sidebar changed.
 */

/** What the app is called on screen (the desktop main process says the same, appIdentity.ts). */
const APP_NAME = "Janja";

export const ICONS = {
  speaker: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M11.4 3.2a1 1 0 0 1 1.6.8v16a1 1 0 0 1-1.6.8L6.7 17H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h2.7l4.7-3.8zM15.5 8.5a1 1 0 0 1 1.4 0 5 5 0 0 1 0 7 1 1 0 0 1-1.4-1.4 3 3 0 0 0 0-4.2 1 1 0 0 1 0-1.4zm2.8-2.8a1 1 0 0 1 1.4 0 9 9 0 0 1 0 12.6 1 1 0 0 1-1.4-1.4 7 7 0 0 0 0-9.8 1 1 0 0 1 0-1.4z"/></svg>`,
  screen: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-6v2h3v2H7v-2h3v-2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm0 2v10h16V6H4z"/></svg>`,
  logout: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 3h9a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-9v-2h9V5h-9V3zm1.6 4.4L13 6l6 6-6 6-1.4-1.4 3.6-3.6H3v-2h12.2l-3.6-3.6z" transform="matrix(-1 0 0 1 24 0)"/></svg>`,
  leave: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21 3H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H3V5h18v14zM9.41 15.95 12 13.36l2.59 2.59L16 14.54l-2.59-2.59L16 9.36l-1.41-1.41L12 10.54 9.41 7.95 8 9.36l2.59 2.59L8 14.54z"/></svg>`,
  minimize: `<svg viewBox="0 0 12 12"><rect x="1" y="5.5" width="10" height="1" fill="currentColor"/></svg>`,
  maximize: `<svg viewBox="0 0 12 12"><rect x="1.5" y="1.5" width="9" height="9" fill="none" stroke="currentColor"/></svg>`,
  close: `<svg viewBox="0 0 12 12"><path d="M1.5 1.5l9 9m0-9-9 9" stroke="currentColor" stroke-width="1.1"/></svg>`,
} as const;

export function titleBar(controls: DesktopApi["windowControls"] | null): HTMLElement {
  const button = (label: string, svg: string, onClick: () => void, extraClass = "") =>
    h("button", { class: `desk-winbtn ${extraClass}`, type: "button", "aria-label": label, title: label, onClick }, icon(svg));

  return h(
    "header",
    { class: "desk-titlebar" },
    h("img", { class: "desk-titlebar-mark", src: janjaUrl, alt: "" }),
    h("span", { class: "desk-titlebar-name" }, APP_NAME),
    controls &&
      h(
        "div",
        { class: "desk-winbtns" },
        button("Minimizar", ICONS.minimize, () => controls.minimize()),
        button("Maximizar", ICONS.maximize, () => controls.toggleMaximize()),
        button("Fechar", ICONS.close, () => controls.close(), "is-close"),
      ),
  );
}

export function renderRail(
  container: HTMLElement,
  servers: SidebarServer[],
  selectedGuildId: string | null,
  onSelect: (guildId: string | null) => void,
): void {
  container.replaceChildren(
    ...servers.map((server) => {
      const isSelected = server.guildId === selectedGuildId;
      const live = server.channels.some((channel) => channel.presenters.length > 0);
      const face = server.iconUrl
        ? h("img", { class: "desk-rail-face", src: server.iconUrl, alt: "" })
        : h("span", { class: "desk-rail-face is-initials" }, initials(server.name));
      return h(
        "button",
        {
          class: `desk-rail-item${isSelected ? " is-selected" : ""}`,
          type: "button",
          title: server.name,
          "aria-label": server.name,
          "aria-current": isSelected ? "true" : undefined,
          onClick: () => onSelect(server.guildId),
        },
        face,
        live && h("span", { class: "desk-rail-live", "aria-hidden": "true" }),
      );
    }),
  );
}

export interface ChannelListOptions {
  /** The broadcast on screen, highlighted in the list. */
  watching: { roomId: string; slot: number } | null;
  /** The logged-in user: their own live never opens by itself, only from here. */
  selfUserId: string;
  onPick(channel: SidebarChannel, slot: number): void;
}

export function renderChannels(head: HTMLElement, list: HTMLElement, server: SidebarServer | null, options: ChannelListOptions): void {
  head.replaceChildren(h("h2", { class: "desk-sidebar-title" }, server?.name ?? APP_NAME));
  if (!server) {
    list.replaceChildren(h("p", { class: "desk-sidebar-hint" }, "Nenhum canal com transmissão por aqui."));
    return;
  }

  list.replaceChildren(
    h("p", { class: "desk-category" }, "Canais de voz"),
    ...server.channels.map((channel) =>
      h(
        "div",
        { class: `desk-channel${channel.isMine ? " is-mine" : ""}` },
        h(
          "div",
          { class: "desk-channel-row" },
          icon(ICONS.speaker, "desk-channel-icon"),
          h("span", { class: "desk-channel-name" }, channel.name),
          channel.isMine && h("span", { class: "desk-channel-here", title: "Você está neste canal" }, "você"),
        ),
        ...channel.presenters.map((presenter) => {
          const isSelf = presenter.userId === options.selfUserId;
          const isWatching =
            options.watching?.roomId === channel.channelId && options.watching.slot === presenter.slot;
          return h(
            "button",
            {
              class: `desk-presenter${isWatching ? " is-watching" : ""}`,
              type: "button",
              title: isSelf ? "Ver sua live (enquanto estiver aberta, ela usa sua internet)" : `Assistir ${presenter.name}`,
              onClick: () => options.onPick(channel, presenter.slot),
            },
            avatar(presenter.name, null, presenter.userId ?? presenter.name, "desk-presenter-avatar"),
            h("span", { class: "desk-presenter-name" }, isSelf ? `${presenter.name} (você)` : presenter.name),
            h("span", { class: "desk-live" }, "AO VIVO"),
          );
        }),
      ),
    ),
  );
}

export interface UserPanelOptions {
  user: DesktopUser;
  voice: VoiceState;
  isLive: boolean;
  /** Who receives your live; null until the relay says. */
  audience: LiveAudience | null;
  onTransmit(): void;
  onLogout(): void;
}

function voiceLabel(voice: VoiceState): string {
  if (voice.status === "in-channel") return `Em 🔊 ${voice.location.channelName ?? "canal de voz"}`;
  if (voice.status === "not-in-voice") return "Fora de canal de voz";
  return "Procurando seu canal…";
}

/** A live nobody watches sends nothing until someone opens it (see audience-changed). */
function liveLabel(audience: LiveAudience): string {
  if (audience.watchers > 0) return `Ao vivo · ${audience.watchers} assistindo`;
  return audience.videoWatchers > 0 ? "Ao vivo · só você assistindo" : "Pausada: ninguém assistindo";
}

export function renderUserPanel(container: HTMLElement, options: UserPanelOptions): void {
  const name = options.user.globalName ?? options.user.username;
  const inVoice = options.voice.status === "in-channel";
  const transmitLabel = options.isLive ? "Encerrar transmissão" : "Transmitir";
  const audience = options.isLive ? options.audience : null;
  const isPausedLive = audience !== null && audience.watchers === 0 && audience.videoWatchers === 0;

  container.replaceChildren(
    h(
      "div",
      { class: "desk-user" },
      h(
        "span",
        { class: "desk-user-avatar-wrap" },
        avatar(name, options.user.avatarUrl, options.user.id, "desk-user-avatar"),
        h("span", { class: `desk-user-dot${inVoice ? " is-online" : ""}`, "aria-hidden": "true" }),
      ),
      h(
        "span",
        { class: "desk-user-text" },
        h("span", { class: "desk-user-name" }, name),
        h(
          "span",
          {
            class: "desk-user-status",
            title: isPausedLive ? "Sua live não gasta sua internet enquanto ninguém assiste. Volta sozinha quando alguém abrir." : undefined,
          },
          audience !== null ? liveLabel(audience) : voiceLabel(options.voice),
        ),
      ),
      h(
        "button",
        { class: "desk-icon-btn", type: "button", title: "Sair da conta", "aria-label": "Sair da conta", onClick: options.onLogout },
        icon(ICONS.logout),
      ),
    ),
    h(
      "button",
      {
        class: `desk-transmit${options.isLive ? " is-live" : ""}`,
        type: "button",
        disabled: !inVoice && !options.isLive,
        title: inVoice || options.isLive ? transmitLabel : "Entre em um canal de voz para transmitir",
        onClick: options.onTransmit,
      },
      icon(ICONS.screen),
      transmitLabel,
    ),
  );
}

export function emptyState(title: string, text: string): HTMLElement {
  return h(
    "div",
    { class: "desk-empty" },
    h("div", { class: "desk-empty-art" }, icon(ICONS.speaker)),
    h("h3", { class: "desk-empty-title" }, title),
    h("p", { class: "desk-empty-text" }, text),
  );
}

/** The broadcast on screen, and how to stop receiving it ("Sair da live"). */
export interface MainHeaderWatching {
  name: string;
  onLeave(): void;
}

export function renderMainHeader(
  container: HTMLElement,
  voice: VoiceState,
  watching: MainHeaderWatching | null,
): void {
  if (voice.status !== "in-channel") {
    container.replaceChildren(h("span", { class: "desk-main-title" }, APP_NAME));
    return;
  }
  const title = [
    icon(ICONS.speaker, "desk-main-icon"),
    h("span", { class: "desk-main-title" }, voice.location.channelName ?? "Canal de voz"),
  ];
  const watchingParts = watching
    ? [
        h("span", { class: "desk-main-divider", "aria-hidden": "true" }),
        h("span", { class: "desk-main-sub" }, `assistindo ${watching.name}`),
        h("span", { class: "desk-live desk-main-live" }, "AO VIVO"),
        h(
          "button",
          { class: "desk-leave", type: "button", title: "Parar de assistir esta live", onClick: watching.onLeave },
          icon(ICONS.leave),
          "Sair da live",
        ),
      ]
    : [];
  container.replaceChildren(...title, ...watchingParts);
}
