// Fingerprinted by Vite, like desktop/main.ts's sound, so a changed image is never served stale.
import janjaUrl from "../../../assets/janja.png";
import { h } from "../dom.js";

/**
 * First-run screen. The login itself happens in the user's browser (see the desktop
 * main process's loopbackLogin.ts); this only starts it and reports how it went.
 */
export function renderLoginScreen(container: HTMLElement, onLogin: () => Promise<void>, onCancel: () => void): void {
  const error = h("p", { class: "desk-login-error", role: "alert" });
  const button = h(
    "button",
    { class: "desk-login-btn", type: "button" },
    "Entrar com Discord",
  );
  // Closing the browser tab leaves the login waiting for a redirect that never comes;
  // this gives the user a way out instead of a button locked until the timeout.
  const cancel = h("button", { class: "desk-login-cancel", type: "button", hidden: true }, "Cancelar e tentar de novo");
  cancel.addEventListener("click", onCancel);

  button.addEventListener("click", () => {
    button.disabled = true;
    button.textContent = "Continue no navegador…";
    cancel.hidden = false;
    error.textContent = "";
    onLogin().catch((reason: unknown) => {
      error.textContent = reason instanceof Error ? reason.message : "Não foi possível entrar. Tente de novo.";
      button.disabled = false;
      button.textContent = "Entrar com Discord";
      cancel.hidden = true;
    });
  });

  container.replaceChildren(
    h(
      "main",
      { class: "desk-login" },
      h(
        "div",
        { class: "desk-login-card" },
        h("img", { class: "desk-login-mark", src: janjaUrl, alt: "" }),
        h("h1", { class: "desk-login-title" }, "Bem-vindo à Janja"),
        h(
          "p",
          { class: "desk-login-text" },
          "Entre com sua conta do Discord para assistir e transmitir lives no seu canal de voz.",
        ),
        button,
        cancel,
        error,
        h("p", { class: "desk-login-note" }, "O login abre no seu navegador e você volta para cá em seguida."),
      ),
    ),
  );
}
