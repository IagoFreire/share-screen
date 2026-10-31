// Player styles come from the shared stylesheet; desktop.css lays the app around it.
// Imported from JS for the same cache-busting reason as main.ts.
import "../ui/app.css";
import "./desktop.css";
// Fingerprinted by Vite, like present.ts's copy, so a changed sound is never served stale.
import doorKnockUrl from "../../assets/DoorKnock.mp3";
import type { DesktopApi, StoredLogin } from "@screenshare-bot/shared";
import { startDesktopBroadcast, type LiveAudience } from "./broadcast.js";
import { h } from "./dom.js";
import { relayWsUrl, startDesktopApp, voiceWsUrl, type DesktopApp } from "./desktopApp.js";
import { createLiveController } from "./liveController.js";
import { renderLoginScreen } from "./views/loginScreen.js";
import { titleBar } from "./views/shell.js";
import { confirmDialog, openTransmitModal } from "./views/transmitModal.js";
import { createVoiceUi } from "./views/voiceUi.js";
import { startVoiceSession } from "../voice/voiceSession.js";
import { askVote } from "../ui/votePoll.js";
import { browserVoteMemory } from "../ui/voteMemory.js";

/** Electron keeps localStorage in the app's data folder, so this outlives restarts. */
const voteMemory = browserVoteMemory();

/**
 * Entry point for desktop.html -- the page the Janja desktop app (Electron)
 * loads into its window. Outside the app there is no `window.desktop` bridge, so the
 * page only says where it belongs.
 */

function startLoggedIn(api: DesktopApi, content: HTMLElement, login: StoredLogin): void {
  let audience: LiveAudience | null = null;
  /** One element, rewound per alert -- see present.ts's playAlertChime. */
  let alertAudio: HTMLAudioElement | null = null;
  // Assigned right below; the hooks only run after the app has started.
  let app: DesktopApp | null = null;

  function playKnock(): void {
    alertAudio ??= new Audio(doorKnockUrl);
    alertAudio.currentTime = 0;
    alertAudio.play().catch((error: unknown) => console.error("Failed to play alert sound:", error));
    if (document.hidden) api.notify("Alguém bateu na porta", "Abra a Janja para ver.");
  }

  const live = createLiveController({
    startBroadcast: (sourceId, quality, target, audio) =>
      startDesktopBroadcast(sourceId, quality, target, {
        wsUrl: relayWsUrl(),
        userId: login.user.id,
        session: login.session,
        audio,
        appAudio: api.appAudio,
        selectSource: (id, options) => api.selectSource(id, options),
        onAudience: (next) => {
          audience = next;
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

  const voiceRooms = startVoiceSession({
    url: voiceWsUrl(),
    session: login.session,
    name: login.user.globalName ?? login.user.username,
    avatarUrl: login.user.avatarUrl,
    onSessionInvalid: () => app?.logOut(),
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
        onGoLive: (sourceId, quality, audio) => live.goLive(sourceId, quality, { roomId: channelId, guildId }, audio),
      });
    },
    isLive: () => live.isLive,
    audience: () => (live.isLive ? audience : null),
    beforeLogout: () => {
      live.end();
      voiceRooms.close();
      voteMemory.forget(login.user.id); // the next login answers the poll again
    },
    voiceRooms: createVoiceUi(voiceRooms),
  });

  live.onChange(() => {
    if (!live.isLive) audience = null;
    app?.refreshUserPanel();
  });
  app.onVoiceChange((voice) => void live.onVoiceState(voice));
  api.onEndLiveRequested(() => live.end());
}

async function boot(api: DesktopApi, content: HTMLElement): Promise<void> {
  const stored = await api.getStoredLogin().catch(() => null);

  // The poll runs until a user gets through once (ui/voteMemory.ts); logging out makes
  // them answer again. A Lula vote closes the window, which quits the app.
  if (!stored || !voteMemory.hasPassed(stored.user.id)) {
    if ((await askVote(content, { noun: "a Janja" })) === "lula") {
      api.windowControls.close();
      return;
    }
    if (stored) voteMemory.remember(stored.user.id);
  }

  if (stored) {
    startLoggedIn(api, content, stored);
    return;
  }
  renderLoginScreen(
    content,
    async () => {
      const login = await api.login();
      voteMemory.remember(login.user.id); // answered the poll just before logging in
      startLoggedIn(api, content, login);
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
    content.replaceChildren(h("p", { class: "desk-outside" }, "Abra esta página pelo app Janja."));
    return;
  }
  void boot(api, content);
}

main();
