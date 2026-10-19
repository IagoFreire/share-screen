// See main.ts: the stylesheet is imported from JS so Discord's proxy can't pin a
// stale copy of a never-changing stylesheet URL.
import "./ui/app.css";
import { mountWatchView } from "./watchView.js";

/**
 * Entry point for watch.html -- a plain browser tab opened from inside the Activity
 * (via App.ts's "assistir numa aba do navegador" button). The player itself lives in
 * watchView.ts, shared with the desktop app; this page only reads its URL parameters.
 */

function getParam(name: string): string | null {
  return new URLSearchParams(window.location.search).get(name);
}

function main(): void {
  const statusEl = document.querySelector<HTMLParagraphElement>("#status");
  const setPageStatus = (text: string) => {
    if (statusEl) statusEl.textContent = text;
  };

  const roomId = getParam("room");
  if (!roomId) {
    setPageStatus('Link invalido: falta o parametro "?room=...". Abra esta pagina pelo botao "Assistir numa aba do navegador" dentro da Activity.');
    return;
  }

  const root = document.querySelector<HTMLDivElement>("#app");
  if (!root) throw new Error("#app root element not found.");

  document.body.classList.add("viewer");

  const wsProtocol = window.location.protocol === "https:" ? "wss" : "ws";
  mountWatchView({
    root,
    wsUrl: `${wsProtocol}://${window.location.host}/ws`,
    roomId,
    userId: getParam("user"),
    guildId: getParam("guild"),
    onStatus: setPageStatus,
  });
}

main();
