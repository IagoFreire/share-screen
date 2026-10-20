import { h, icon } from "../dom.js";
import { ICONS } from "./shell.js";

/**
 * First-run screen. The login itself happens in the user's browser (see the desktop
 * main process's loopbackLogin.ts); this only starts it and reports how it went.
 */
export function renderLoginScreen(container: HTMLElement, onLogin: () => Promise<void>): void {
  const error = h("p", { class: "desk-login-error", role: "alert" });
  const button = h(
    "button",
    { class: "desk-login-btn", type: "button" },
    "Entrar com Discord",
  );

  button.addEventListener("click", () => {
    button.disabled = true;
    button.textContent = "Continue no navegador…";
    error.textContent = "";
    onLogin().catch((reason: unknown) => {
      error.textContent = reason instanceof Error ? reason.message : "Não foi possível entrar. Tente de novo.";
      button.disabled = false;
      button.textContent = "Entrar com Discord";
    });
  });

  container.replaceChildren(
    h(
      "main",
      { class: "desk-login" },
      h(
        "div",
        { class: "desk-login-card" },
        h("div", { class: "desk-login-mark" }, icon(ICONS.app)),
        h("h1", { class: "desk-login-title" }, "Bem-vindo ao ScreenShare"),
        h(
          "p",
          { class: "desk-login-text" },
          "Entre com sua conta do Discord para assistir e transmitir lives no seu canal de voz.",
        ),
        button,
        error,
        h("p", { class: "desk-login-note" }, "O login abre no seu navegador e você volta para cá em seguida."),
      ),
    ),
  );
}
