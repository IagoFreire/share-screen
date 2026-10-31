import type { VoiceMember } from "@screenshare-bot/shared";
import { avatar, h } from "../dom.js";
import type { VoiceSession } from "../../voice/voiceSession.js";
import { volumeSlider } from "./voiceControls.js";

/**
 * Discord's "Volume do usuário": clicking someone in a room opens this beside the
 * sidebar, with how loud they play for this user (0-200%). It lives on <body>, so the
 * room list redrawing underneath doesn't close it.
 */

const GAP_PX = 8;

/** Opens the menu next to `anchor`; returns what closes it. */
export function openUserVolumeMenu(anchor: HTMLElement, member: VoiceMember, session: VoiceSession, onClose: () => void): () => void {
  const menu = h(
    "div",
    { class: "vc-usermenu", role: "dialog", "aria-label": `Volume de ${member.name}` },
    h(
      "div",
      { class: "vc-usermenu-head" },
      avatar(member.name, member.avatarUrl, member.userId, "vc-avatar"),
      h("strong", { class: "vc-usermenu-name" }, member.name),
    ),
    volumeSlider({
      label: "Volume do usuário",
      value: session.userVolume(member.userId),
      onInput: (volume) => session.setUserVolume(member.userId, volume),
    }),
    h("small", { class: "vc-hint" }, "Só muda como você ouve essa pessoa."),
  );
  document.body.append(menu);

  // Beside the row, kept inside the window.
  const row = anchor.getBoundingClientRect();
  menu.style.left = `${Math.max(GAP_PX, Math.min(row.right + GAP_PX, window.innerWidth - menu.offsetWidth - GAP_PX))}px`;
  menu.style.top = `${Math.max(GAP_PX, Math.min(row.top, window.innerHeight - menu.offsetHeight - GAP_PX))}px`;
  menu.querySelector<HTMLInputElement>("input")?.focus();

  let closed = false;
  function close(): void {
    if (closed) return;
    closed = true;
    menu.remove();
    document.removeEventListener("mousedown", onPointer, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", close);
    onClose();
  }
  function onPointer(event: MouseEvent): void {
    if (!menu.contains(event.target as Node)) close();
  }
  function onKey(event: KeyboardEvent): void {
    if (event.key === "Escape") close();
  }

  document.addEventListener("mousedown", onPointer, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", close);
  return close;
}
