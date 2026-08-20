// Imported here rather than <link>ed from index.html on purpose: Discord's Activity
// proxy caches stable stylesheet URLs and keeps serving a stale copy. Riding along with
// this module makes the CSS update whenever the JS does, and Vite content-hashes it in
// production builds. (Dev responses are additionally marked no-store; see vite.config.ts.)
import "./ui/app.css";
import { bootstrapDiscordSdk } from "./discord/sdkBootstrap.js";
import { mountApp } from "./ui/App.js";

async function main(): Promise<void> {
  const statusEl = document.querySelector<HTMLParagraphElement>("#status");
  const setStatus = (text: string) => {
    if (statusEl) statusEl.textContent = text;
  };

  setStatus("Conectando ao Discord...");

  try {
    const auth = await bootstrapDiscordSdk();

    // Room id is derived from the voice channel the Activity was launched in, so
    // everyone in the same call lands in the same room automatically. Falls back
    // to a fixed room when running outside Discord (plain browser tab) for local dev.
    const roomId = auth.channelId ?? "dev-local-room";
    const wsProtocol = window.location.protocol === "https:" ? "wss" : "ws";
    const wsUrl = `${wsProtocol}://${window.location.host}/ws`;

    mountApp({ roomId, wsUrl, userId: auth.userId, guildId: auth.guildId, setStatus });
  } catch (error) {
    console.error("Failed to bootstrap Discord SDK:", error);
    setStatus("Falha ao conectar ao Discord. Veja o console para detalhes.");
  }
}

void main();
