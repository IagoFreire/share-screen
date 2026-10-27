import "./votePoll.css";
// Fingerprinted by Vite, like the other desktop assets, so a changed photo is never served stale.
import lulaUrl from "../../../assets/poll-lula.png";
import flavioUrl from "../../../assets/poll-flavio.png";
import { h } from "../dom.js";

/**
 * The "em quem você votou?" gate the desktop app shows every time it opens: a
 * second-round duel screen. Nothing is stored or sent anywhere; the answer only
 * decides whether the app opens (Bolsonaro) or closes (Lula).
 */

export type Vote = "lula" | "bolsonaro";

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
export function askVote(container: HTMLElement): Promise<Vote> {
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
        h("p", { class: "poll-sub" }, "Responda para entrar na Janja."),
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
      stage.classList.add(`is-chosen-${vote}`);
      if (vote === "bolsonaro") confirm();
      else farewell();
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
      stage.append(
        h(
          "div",
          { class: "poll-result is-lula", role: "status" },
          h("strong", { class: "poll-bye" }, "Aqui não, companheiro."),
          h("p", { class: "poll-bye-sub" }, "A Janja fecha em ", count, "…"),
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
