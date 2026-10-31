import "./updateControl.css";
import type { DesktopUpdates, UpdateStatus } from "@screenshare-bot/shared";
import { h, icon } from "../dom.js";

/**
 * The title bar's update button, like Discord's: it turns green once an update has
 * downloaded, and opens a small panel with the installed version, "Procurar
 * atualizações", the download's progress and "Reiniciar e instalar". The work itself
 * is the main process's (desktop/src/main/updates.ts).
 */

const DOWNLOAD_ICON = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M11 4h2v8.17l3.59-3.58L18 10l-6 6-6-6 1.41-1.41L11 12.17zM5 18h14v2H5z"/></svg>`;

function describe(status: UpdateStatus): string {
  switch (status.state) {
    case "idle":
      return "Veja se já tem uma versão nova da Janja.";
    case "checking":
      return "Procurando atualizações…";
    case "up-to-date":
      return "Você está na versão mais recente.";
    case "downloading":
      return `Baixando a versão ${status.version}… ${status.percent}%`;
    case "ready":
      return `A versão ${status.version} já baixou. Reinicie para instalar; se estiver transmitindo, a live acaba.`;
    case "unsupported":
      return "Atualizações só funcionam no app instalado.";
    case "error":
      return status.message;
  }
}

function buttonLabel(status: UpdateStatus): string {
  if (status.state === "ready") return "Atualização pronta: reiniciar e instalar";
  if (status.state === "downloading") return `Baixando atualização (${status.percent}%)`;
  return "Verificar atualizações";
}

export function createUpdateControl(updates: DesktopUpdates): HTMLElement {
  let version = "";
  let status: UpdateStatus = { state: "idle" };
  let open = false;

  const button = h(
    "button",
    { class: "desk-winbtn desk-update-btn", type: "button", "aria-haspopup": "dialog", onClick: () => setOpen(!open) },
    icon(DOWNLOAD_ICON),
  );
  const panel = h("div", { class: "desk-update-panel", role: "dialog", "aria-label": "Atualizações", hidden: true });
  const root = h("div", { class: "desk-update" }, button, panel);

  function check(): void {
    updates.check().catch((error: unknown) => console.error("Update check failed:", error));
  }

  function action(): HTMLElement | null {
    switch (status.state) {
      case "unsupported":
        return null;
      case "ready":
        return h("button", { class: "desk-update-action is-ready", type: "button", onClick: () => updates.install() }, "Reiniciar e instalar");
      case "checking":
      case "downloading":
        return h("button", { class: "desk-update-action", type: "button", disabled: true }, status.state === "checking" ? "Procurando…" : "Baixando…");
      default:
        return h("button", { class: "desk-update-action", type: "button", onClick: check }, "Procurar atualizações");
    }
  }

  function progressBar(percent: number): HTMLElement {
    const fill = h("span", { class: "desk-update-bar-fill" });
    fill.style.transform = `scaleX(${percent / 100})`;
    return h("div", { class: "desk-update-bar", role: "progressbar", "aria-valuenow": String(percent), "aria-valuemin": "0", "aria-valuemax": "100" }, fill);
  }

  function render(): void {
    const label = buttonLabel(status);
    button.title = label;
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-expanded", open ? "true" : "false");
    root.classList.toggle("is-ready", status.state === "ready");
    root.classList.toggle("is-busy", status.state === "checking" || status.state === "downloading");
    panel.hidden = !open;
    if (!open) return;
    panel.replaceChildren(
      h(
        "div",
        { class: "desk-update-head" },
        h("strong", {}, "Atualizações"),
        version ? h("span", { class: "desk-update-version" }, `versão ${version}`) : null,
      ),
      h("p", { class: "desk-update-text", role: "status" }, describe(status)),
      status.state === "downloading" ? progressBar(status.percent) : "",
      action() ?? "",
    );
  }

  function setOpen(next: boolean): void {
    open = next;
    render();
  }

  document.addEventListener("mousedown", (event) => {
    if (open && !root.contains(event.target as Node)) setOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (open && event.key === "Escape") setOpen(false);
  });
  updates.onStatus((next) => {
    status = next;
    render();
  });
  updates
    .getState()
    .then((state) => {
      version = state.version;
      status = state.status;
      render();
    })
    .catch((error: unknown) => console.error("Failed to read the update state:", error));

  render();
  return root;
}
