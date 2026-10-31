import type { ActiveBroadcast } from "@screenshare-bot/shared";
import { ICON_EYE } from "./icons.js";

/**
 * The broadcast list, shared by the in-Activity viewer (App.ts) and the browser-tab
 * viewer (watch.ts): how a viewer picks which broadcast to watch, and for an admin, a
 * view of every broadcast on the relay.
 *
 * What a list contains is decided by the server (see request-active-broadcasts in
 * relay.ts): an admin's spans every room, everyone else's only their own channel. This
 * module just draws what arrives and reports which row was picked -- switching streams
 * or rooms stays with the host page, since each owns its own pipelines.
 */

export const BROADCASTS_PANEL_HTML = `
  <div class="broadcasts-panel" id="broadcasts-panel" style="display: none">
    <div class="broadcasts-head">
      <span class="broadcasts-title"><span class="broadcasts-title-text">Transmissões ativas</span><span class="broadcasts-count"></span></span>
      <button class="broadcasts-close" type="button" title="Fechar">&times;</button>
    </div>
    <div id="broadcasts-list"></div>
  </div>
`;

/**
 * Polls while open rather than having the server push: broadcasts start and stop in
 * other rooms entirely, so there's no local event to hang an update on, and the
 * alternative is the server tracking which sockets have a panel showing.
 */
const POLL_INTERVAL_MS = 5000;

/**
 * Discord's default-avatar palette, minus red: red is reserved for the live dot, and
 * an avatar in the same red would swallow it.
 */
const AVATAR_COLORS = ["#5865f2", "#3ba55c", "#faa61a", "#eb459f", "#747f8d"];

/** What the host is currently showing, read fresh on every render. */
export interface BroadcastsPanelContext {
  roomId: string;
  /** Null while the viewer watches nothing (see "Sair da live" in watchView.ts). */
  selectedSlot: number | null;
  isAdmin: boolean;
  /** The local viewer's Discord id, or "" when unknown (marks their own broadcast). */
  userId: string;
}

export interface BroadcastsPanelOptions {
  /** The element created from BROADCASTS_PANEL_HTML. */
  panel: HTMLElement;
  context: () => BroadcastsPanelContext;
  /** Asks the server for the list; the reply arrives as an "active-broadcasts" message. */
  requestList: () => void;
  /** A row was picked. The panel has already closed itself. */
  onPick: (broadcast: ActiveBroadcast) => void;
  /** Open/closed changed, so the host can restyle the button that toggles it. */
  onOpenChange: () => void;
}

export interface BroadcastsPanel {
  readonly isOpen: boolean;
  toggle: () => void;
  close: () => void;
  /** Draws a list the server sent. Ignored while closed. */
  show: (broadcasts: ActiveBroadcast[]) => void;
  /** Re-requests the list right away when open, e.g. because a local broadcast changed. */
  refresh: () => void;
}

export function createBroadcastsPanel(options: BroadcastsPanelOptions): BroadcastsPanel {
  const { panel, context, requestList, onPick, onOpenChange } = options;
  const titleText = panel.querySelector<HTMLSpanElement>(".broadcasts-title-text")!;
  const count = panel.querySelector<HTMLSpanElement>(".broadcasts-count")!;
  const list = panel.querySelector<HTMLDivElement>("#broadcasts-list")!;

  let isOpen = false;
  let pollTimer: ReturnType<typeof setInterval> | undefined;

  function open(): void {
    isOpen = true;
    panel.style.display = "";
    // The server scopes a non-admin's list to this channel, so say so.
    titleText.textContent = context().isAdmin ? "Transmissões ativas" : "Transmissões neste canal";
    count.textContent = "";
    list.textContent = "Carregando...";
    requestList();
    pollTimer = setInterval(requestList, POLL_INTERVAL_MS);
    onOpenChange();
  }

  function close(): void {
    if (!isOpen) return;
    isOpen = false;
    if (pollTimer !== undefined) clearInterval(pollTimer);
    pollTimer = undefined;
    panel.style.display = "none";
    onOpenChange();
  }

  function show(broadcasts: ActiveBroadcast[]): void {
    if (!isOpen) return;
    count.textContent = broadcasts.length > 0 ? String(broadcasts.length) : "";

    if (broadcasts.length === 0) {
      const empty = document.createElement("p");
      empty.className = "broadcasts-empty";
      empty.textContent = "Nenhuma transmissão ativa no momento.";
      list.replaceChildren(empty);
      return;
    }

    const ctx = context();
    list.replaceChildren(
      ...broadcasts.map((broadcast) =>
        renderRow(broadcast, ctx, () => {
          close();
          onPick(broadcast);
        }),
      ),
    );
  }

  panel.querySelector<HTMLButtonElement>(".broadcasts-close")!.addEventListener("click", close);

  return {
    get isOpen() {
      return isOpen;
    },
    toggle: () => (isOpen ? close() : open()),
    close,
    show,
    refresh: () => {
      if (isOpen) requestList();
    },
  };
}

/**
 * Keeps the toggle button in step with the room: always there for an admin (their list
 * spans the whole relay), otherwise only once something is live here. Returns whether
 * it's visible, so the host can close a panel whose button just disappeared.
 */
export function syncBroadcastsButton(
  button: HTMLButtonElement,
  state: { isAdmin: boolean; streamCount: number; isOpen: boolean },
): boolean {
  const visible = state.isAdmin || state.streamCount > 0;
  button.style.display = visible ? "" : "none";
  button.classList.toggle("is-active", state.isOpen);
  button.title = state.isAdmin ? "Transmissões ativas" : "Escolher transmissão";
  // With no tabs on the player, this badge is what tells a viewer there's a choice.
  button.dataset.count = state.streamCount > 1 ? String(state.streamCount) : "";
  return visible;
}

/** Short, stable stand-in when a snowflake has no resolved name (see discordNames.ts). */
export function shortId(id: string): string {
  return `…${id.slice(-4)}`;
}

/** Same presenter, same colour, on every refresh and in every room. */
export function avatarColor(id: string | null): string {
  if (!id) return AVATAR_COLORS[AVATAR_COLORS.length - 1]!;
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length]!;
}

function textSpan(className: string, text: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = text;
  return span;
}

/** Avatar, who is live, where (server › channel), and how many are watching. */
function renderRow(broadcast: ActiveBroadcast, ctx: BroadcastsPanelContext, pick: () => void): HTMLButtonElement {
  const isCurrent = broadcast.roomId === ctx.roomId && broadcast.slot === ctx.selectedSlot;

  // Names come from the bot token and are absent whenever it can't see that server,
  // so every part falls back to a short id -- a row must never render blank.
  //
  // `||` rather than `??` throughout: Discord can hand back an empty string, which
  // `??` would happily keep, leaving nothing to display.
  const name =
    broadcast.presenterName ||
    (broadcast.presenterId ? `Usuário ${shortId(broadcast.presenterId)}` : "Transmissão");
  const isOwn = ctx.userId !== "" && broadcast.presenterId === ctx.userId;
  const who = isOwn ? `${name} (você)` : name;
  // Rooms are voice channels, so no "#" -- in Discord that marks a text channel.
  const channel = broadcast.channelName || `Canal ${shortId(broadcast.roomId)}`;
  const server = broadcast.guildName || (broadcast.guildId ? `Servidor ${shortId(broadcast.guildId)}` : null);

  const row = document.createElement("button");
  row.type = "button";
  row.className = "broadcast-row";
  row.classList.toggle("is-current", isCurrent);
  row.title = [who, server, channel].filter(Boolean).join(", ");
  row.addEventListener("click", pick);

  // Array.from so a name starting with an emoji keeps the whole character.
  const avatar = textSpan("broadcast-avatar", (Array.from(name.trim())[0] ?? "?").toUpperCase());
  avatar.style.setProperty("--avatar", avatarColor(broadcast.presenterId));
  avatar.setAttribute("aria-hidden", "true");

  const text = document.createElement("span");
  text.className = "broadcast-text";
  text.append(textSpan("broadcast-name", who));

  // Only an admin's list spans rooms. Everyone else only ever sees this channel, where
  // the same server › channel line on every row would just be noise.
  if (ctx.isAdmin) {
    const where = document.createElement("span");
    where.className = "broadcast-where";
    if (server) {
      const separator = textSpan("broadcast-sep", "›");
      separator.setAttribute("aria-hidden", "true");
      where.append(textSpan("broadcast-server", server), separator);
    }
    where.append(textSpan("broadcast-channel", channel));
    text.append(where);
  }

  const meta = document.createElement("span");
  meta.className = "broadcast-meta";
  if (isCurrent) {
    meta.textContent = "Assistindo";
  } else {
    // Static markup from icons.ts; the count is appended as a text node.
    meta.innerHTML = ICON_EYE;
    meta.append(String(broadcast.viewerCount));
    meta.title = broadcast.viewerCount === 1 ? "1 espectador" : `${broadcast.viewerCount} espectadores`;
  }

  row.append(avatar, text, meta);
  return row;
}
