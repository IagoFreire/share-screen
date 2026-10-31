import type { RoomViewer, StreamInfo } from "@screenshare-bot/shared";
import { ICON_PEOPLE } from "./icons.js";
import { avatarColor, shortId } from "./broadcastsPanel.js";

/**
 * Who is in the room: a button in the player's overlay bar and the list it opens, with
 * each person's name and what they are doing. Shared by the Activity, watch.html and
 * the desktop app's player. The list is asked for while it is open (request-viewers),
 * like the broadcast list, so the relay never pushes names nobody is looking at.
 */

/** Same cadence as the broadcast list's poll. */
const POLL_INTERVAL_MS = 5000;

/** What the host is currently showing, read fresh on every render. */
export interface ViewersContext {
  streams: StreamInfo[];
  selectedSlot: number | null;
  /** This user's id, "" when unknown. */
  userId: string;
}

export interface ViewerEntry {
  key: string;
  name: string;
  initial: string;
  color: string;
  detail: string;
}

function activityOf(viewer: RoomViewer, isPresenter: boolean, ctx: ViewersContext): string {
  if (isPresenter) return "Transmitindo";
  // The relay leaves a viewer on its default slot when nothing is live there.
  if (!ctx.streams.some((stream) => stream.slot === viewer.slot)) return "Não está assistindo";
  if (ctx.streams.length < 2) return "Assistindo";
  return viewer.slot === ctx.selectedSlot ? "Assistindo esta live" : "Assistindo outra live";
}

/** The rows the list shows: whoever is broadcasting first, everyone else in join order. */
export function viewerEntries(viewers: RoomViewer[], ctx: ViewersContext): ViewerEntry[] {
  const presenterIds = new Set(ctx.streams.map((stream) => stream.presenterId));
  const rows = viewers.map((viewer, index) => {
    const isPresenter = viewer.userId !== null && presenterIds.has(viewer.userId);
    const shownName = viewer.name ?? (viewer.userId ? shortId(viewer.userId) : "Anônimo");
    const isSelf = viewer.userId !== null && viewer.userId === ctx.userId;
    const entry: ViewerEntry = {
      key: viewer.userId ?? `anonymous-${index}`,
      name: isSelf ? `${shownName} (você)` : shownName,
      initial: viewer.name ? (Array.from(viewer.name.trim())[0] ?? "?").toUpperCase() : "?",
      color: avatarColor(viewer.userId),
      detail: activityOf(viewer, isPresenter, ctx),
    };
    return { entry, isPresenter };
  });
  return [...rows.filter((row) => row.isPresenter), ...rows.filter((row) => !row.isPresenter)].map((row) => row.entry);
}

export interface ViewersMenuOptions {
  /** Asks the server for the list; the reply arrives as a "viewers" message. */
  requestList: () => void;
  context: () => ViewersContext;
}

export interface ViewersMenu {
  /** Goes in the player's overlay bar. */
  element: HTMLElement;
  readonly isOpen: boolean;
  show(viewers: RoomViewer[]): void;
  /** Someone joined or left: asks again now rather than on the next poll. */
  refresh(): void;
  close(): void;
}

export function createViewersMenu(options: ViewersMenuOptions): ViewersMenu {
  const element = document.createElement("div");
  element.className = "viewers-menu";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "icon-btn";
  button.title = "Quem está na sala";
  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-expanded", "false");
  button.innerHTML = ICON_PEOPLE;

  const popup = document.createElement("div");
  popup.className = "viewers-pop";
  popup.setAttribute("role", "dialog");
  popup.setAttribute("aria-label", "Quem está na sala");
  popup.hidden = true;

  const head = document.createElement("div");
  head.className = "viewers-head";
  const title = document.createElement("span");
  title.textContent = "Na sala";
  const count = document.createElement("span");
  count.className = "viewers-count";
  head.append(title, count);

  const list = document.createElement("ul");
  list.className = "viewers-list";
  popup.append(head, list);
  element.append(button, popup);

  let pollTimer: ReturnType<typeof setInterval> | undefined;

  function onOutside(event: MouseEvent): void {
    if (!element.contains(event.target as Node)) close();
  }

  function open(): void {
    count.textContent = "";
    list.replaceChildren(message("Carregando…"));
    popup.hidden = false;
    button.setAttribute("aria-expanded", "true");
    button.classList.add("is-active");
    document.addEventListener("click", onOutside, true);
    options.requestList();
    pollTimer = setInterval(options.requestList, POLL_INTERVAL_MS);
  }

  function close(): void {
    popup.hidden = true;
    button.setAttribute("aria-expanded", "false");
    button.classList.remove("is-active");
    document.removeEventListener("click", onOutside, true);
    clearInterval(pollTimer);
    pollTimer = undefined;
  }

  function show(viewers: RoomViewer[]): void {
    if (popup.hidden) return;
    const entries = viewerEntries(viewers, options.context());
    count.textContent = String(entries.length);
    list.replaceChildren(...(entries.length > 0 ? entries.map(renderRow) : [message("Ninguém por aqui.")]));
  }

  button.addEventListener("click", () => (popup.hidden ? open() : close()));

  return {
    element,
    get isOpen() {
      return !popup.hidden;
    },
    show,
    refresh() {
      if (!popup.hidden) options.requestList();
    },
    close,
  };
}

function message(text: string): HTMLLIElement {
  const item = document.createElement("li");
  item.className = "viewers-empty";
  item.textContent = text;
  return item;
}

function renderRow(entry: ViewerEntry): HTMLLIElement {
  const row = document.createElement("li");
  row.className = "viewer-row";

  const avatar = document.createElement("span");
  avatar.className = "viewer-avatar";
  avatar.textContent = entry.initial;
  avatar.style.setProperty("--avatar", entry.color);
  avatar.setAttribute("aria-hidden", "true");

  const text = document.createElement("span");
  text.className = "viewer-text";
  const name = document.createElement("span");
  name.className = "viewer-name";
  name.textContent = entry.name;
  const detail = document.createElement("span");
  detail.className = "viewer-detail";
  detail.textContent = entry.detail;
  text.append(name, detail);

  row.append(avatar, text);
  return row;
}
