import "./votePoll.css";
// Fingerprinted by Vite, like the other assets, so a changed photo is never served stale.
import lulaUrl from "../../assets/poll-lula.png";
import flavioUrl from "../../assets/poll-flavio.png";
import urnaUrl from "../../assets/urna.mp3";
import { h } from "../desktop/dom.js";

/**
 * The "em quem você votou?" gate shown every time the desktop app or the Discord
 * Activity opens: a second-round duel screen. Nothing is stored or sent anywhere; the
 * answer only decides whether the app opens (Bolsonaro) or closes (Lula).
 */

export type Vote = "lula" | "bolsonaro";

export interface VotePollOptions {
  /** What opens or closes, as the screens say it: "a Janja", "a live". */
  noun: string;
}

/** The urna beep at a fifth of its recorded loudness. */
const URNA_VOLUME = 0.2;
/** How long the urna's "FIM" stays up before the app opens. */
const CONFIRM_MS = 1400;
/** Countdown shown before the app closes. */
const FAREWELL_SECONDS = 3;

interface Candidate {
  vote: Vote;
  name: string;
  party: string;
  number: string;
  photo: string;
}

const LULA: Candidate = { vote: "lula", name: "Lula", party: "PT", number: "13", photo: lulaUrl };
const FLAVIO: Candidate = { vote: "bolsonaro", name: "Flávio Bolsonaro", party: "PL", number: "22", photo: flavioUrl };

/** Shows the poll in `container`; resolves with the answer once its closing screen has played. */
export function askVote(container: HTMLElement, options: VotePollOptions): Promise<Vote> {
  return new Promise((resolve) => {
    let chosen = false;

    function side(candidate: Candidate): HTMLButtonElement {
      return h(
        "button",
        {
          class: `poll-side is-${candidate.vote}`,
          type: "button",
          "aria-label": `Votei em ${candidate.name}`,
          onClick: () => choose(candidate.vote),
        },
        h("span", { class: "poll-glow", "aria-hidden": "true" }),
        h("span", { class: "poll-number", "aria-hidden": "true" }, candidate.number),
        h("img", { class: "poll-photo", src: candidate.photo, alt: "" }),
        h(
          "span",
          { class: "poll-tag" },
          h("span", { class: "poll-name" }, candidate.name),
          h("span", { class: "poll-party" }, `${candidate.party} · ${candidate.number}`),
          h("span", { class: "poll-cta" }, "Votei nele"),
        ),
      );
    }

    const stage = h(
      "main",
      { class: "poll" },
      h(
        "header",
        { class: "poll-head" },
        h("p", { class: "poll-kicker" }, h("span", { class: "poll-dot", "aria-hidden": "true" }), "Eleições 2026 · 2º turno"),
        h("h1", { class: "poll-title" }, "Em quem você votou?"),
        h("p", { class: "poll-sub" }, `Responda para entrar n${options.noun}.`),
      ),
      h(
        "div",
        { class: "poll-duel" },
        side(LULA),
        h("span", { class: "poll-versus", "aria-hidden": "true" }, "×"),
        side(FLAVIO),
      ),
    );
    container.replaceChildren(stage);

    function choose(vote: Vote): void {
      if (chosen) return;
      chosen = true;
      playUrna();
      stage.classList.add(`is-chosen-${vote}`);
      if (vote === "bolsonaro") confirm();
      else farewell();
    }

    /**
     * The urna's end-of-vote beep (~1 s), on either answer. Both screens that follow
     * outlast it, and the click that cast the vote lets the page play sound.
     */
    function playUrna(): void {
      const beep = new Audio(urnaUrl);
      beep.volume = URNA_VOLUME;
      beep.play().catch((error: unknown) => console.error("Failed to play the urna sound:", error));
    }

    /** The urna's end screen, then the app. */
    function confirm(): void {
      stage.append(
        h(
          "div",
          { class: "poll-result is-bolsonaro", role: "status" },
          h("span", { class: "poll-urna-label" }, "Voto confirmado"),
          h("strong", { class: "poll-urna-fim" }, "FIM"),
        ),
      );
      setTimeout(() => resolve("bolsonaro"), CONFIRM_MS);
    }

    /** A short goodbye with a countdown, then the app closes. */
    function farewell(): void {
      const count = h("span", { class: "poll-count" }, String(FAREWELL_SECONDS));
      const noun = options.noun.charAt(0).toUpperCase() + options.noun.slice(1);
      stage.append(
        h(
          "div",
          { class: "poll-result is-lula", role: "status" },
          h("strong", { class: "poll-bye" }, "Aqui não, companheiro."),
          h("p", { class: "poll-bye-sub" }, `${noun} fecha em `, count, "…"),
        ),
      );
      let left = FAREWELL_SECONDS;
      const timer = setInterval(() => {
        left -= 1;
        count.textContent = String(left);
        if (left > 0) return;
        clearInterval(timer);
        resolve("lula");
      }, 1000);
    }
  });
}

/** askVote over the whole page, for hosts without a full-size container (the Activity). */
export async function askVoteFullScreen(options: VotePollOptions): Promise<Vote> {
  const host = h("div", { class: "poll-host" });
  document.body.append(host);
  try {
    return await askVote(host, options);
  } finally {
    host.remove();
  }
}
