// Player styles come from the shared stylesheet; desktop.css lays the app around it.
// Imported from JS for the same cache-busting reason as main.ts.
import "../ui/app.css";
import "./desktop.css";
// Fingerprinted by Vite, like present.ts's copy, so a changed sound is never served stale.
import doorKnockUrl from "../../assets/DoorKnock.mp3";
import type { DesktopApi, StoredLogin } from "@screenshare-bot/shared";
import { startDesktopBroadcast } from "./broadcast.js";
import { h } from "./dom.js";
import { relayWsUrl, startDesktopApp, type DesktopApp } from "./desktopApp.js";
import { createLiveController } from "./liveController.js";
import { renderLoginScreen } from "./views/loginScreen.js";
import { titleBar } from "./views/shell.js";
import { confirmDialog, openTransmitModal } from "./views/transmitModal.js";

/**
 * Entry point for desktop.html -- the page the ScreenShare desktop app (Electron)
 * loads into its window. Outside the app there is no `window.desktop` bridge, so the
 * page only says where it belongs.
 */

function startLoggedIn(api: DesktopApi, content: HTMLElement, login: StoredLogin): void {
  let viewerCount: number | null = null;
  /** One element, rewound per alert -- see present.ts's playAlertChime. */
  let alertAudio: HTMLAudioElement | null = null;
  // Assigned right below; the hooks only run after the app has started.
  let app: DesktopApp | null = null;

  function playKnock(): void {
    alertAudio ??= new Audio(doorKnockUrl);
    alertAudio.currentTime = 0;
    alertAudio.play().catch((error: unknown) => console.error("Failed to play alert sound:", error));
    if (document.hidden) api.notify("Alguém bateu na porta", "Abra o ScreenShare para ver.");
  }

  const live = createLiveController({
    startBroadcast: (sourceId, quality, target) =>
      startDesktopBroadcast(sourceId, quality, target, {
        wsUrl: relayWsUrl(),
        userId: login.user.id,
        session: login.session,
        selectSource: (id) => api.selectSource(id),
        onViewerCount: (count) => {
          viewerCount = count;
          app?.refreshUserPanel();
        },
        onAlert: playKnock,
        onInterrupted: (message) => api.notify("Sua transmissão parou", message),
      }),
    setLive: (isLive) => api.setLive(isLive),
    confirmLeave: () =>
      confirmDialog({
        title: "Você saiu do canal de voz",
        text: "Sua transmissão continua no ar para quem está no canal. Quer encerrar agora?",
        confirmLabel: "Encerrar transmissão",
        cancelLabel: "Continuar transmitindo",
      }),
  });

  app = startDesktopApp(content, api, login, {
    onTransmit: () => {
      if (live.isLive) {
        live.end();
        return;
      }
      const voice = app?.voice();
      if (voice?.status !== "in-channel") return;
      const { channelId, guildId, channelName } = voice.location;
      openTransmitModal(api, {
        channelName: channelName ?? "canal de voz",
        onGoLive: (sourceId, quality) => live.goLive(sourceId, quality, { roomId: channelId, guildId }),
      });
    },
    isLive: () => live.isLive,
    viewerCount: () => (live.isLive ? viewerCount : null),
  });

  live.onChange(() => {
    if (!live.isLive) viewerCount = null;
    app?.refreshUserPanel();
  });
  app.onVoiceChange((voice) => void live.onVoiceState(voice));
  api.onEndLiveRequested(() => live.end());
}

async function boot(api: DesktopApi, content: HTMLElement): Promise<void> {
  const stored = await api.getStoredLogin().catch(() => null);
  if (stored) {
    startLoggedIn(api, content, stored);
    return;
  }
  renderLoginScreen(
    content,
    async () => {
      startLoggedIn(api, content, await api.login());
    },
    () => void api.cancelLogin(),
  );
}

function main(): void {
  const root = document.querySelector<HTMLDivElement>("#app");
  if (!root) throw new Error("#app root element not found.");
  document.body.classList.add("desktop");

  const api = window.desktop ?? null;
  const content = h("div", { class: "desk-content" });
  root.replaceChildren(titleBar(api?.windowControls ?? null), content);

  if (!api) {
    content.replaceChildren(h("p", { class: "desk-outside" }, "Abra esta página pelo app ScreenShare."));
    return;
  }
  void boot(api, content);
}

main();
