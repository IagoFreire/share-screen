import { randomBytes } from "node:crypto";
import http from "node:http";
import type { DesktopLoginResponse } from "@screenshare-bot/shared";
import { APP_NAME } from "../appIdentity";

/**
 * "Entrar com Discord" for the desktop app: Discord's consent page opens in the user's
 * own browser (already logged in there), and its redirect lands on a loopback port this
 * process listens on only for the duration of the login. The code is handed to the
 * relay, which holds the client secret and returns a signed session.
 */

/** Must match the redirect registered in the Developer Portal and the server's DESKTOP_REDIRECT_URI. */
export const LOGIN_PORT = 53134;
/** Long enough to read the consent page and log in to Discord in the browser first. */
export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

const STATE_BYTES = 24;

export interface LoopbackLoginDeps {
  openExternal(url: string): Promise<void>;
  fetchClientId(): Promise<string>;
  exchange(code: string): Promise<DesktopLoginResponse>;
  timeoutMs: number;
  /** Defaults to LOGIN_PORT; tests use their own. */
  port?: number;
  /** Aborted when the user gives up (closed the browser tab, clicked "Cancelar"). */
  signal?: AbortSignal;
}

export function buildAuthorizeUrl(clientId: string, state: string, port: number = LOGIN_PORT): string {
  const query = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    scope: "identify",
    redirect_uri: `http://127.0.0.1:${port}/callback`,
    state,
  });
  return `https://discord.com/oauth2/authorize?${query.toString()}`;
}

export type CallbackResult = { code: string } | { error: "state-mismatch" | "denied" | "missing-code" };

/** Reads Discord's redirect. The state check is what stops another page from injecting a code. */
export function parseCallback(requestUrl: string, expectedState: string): CallbackResult {
  const params = new URL(requestUrl, "http://127.0.0.1").searchParams;
  if (params.get("state") !== expectedState) return { error: "state-mismatch" };
  if (params.get("error")) return { error: "denied" };
  const code = params.get("code");
  return code ? { code } : { error: "missing-code" };
}

function browserPage(title: string, message: string): string {
  return `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>${APP_NAME}</title>
<body style="margin:0;display:grid;place-items:center;height:100vh;background:#313338;color:#f2f3f5;font-family:'Segoe UI',system-ui,sans-serif">
<main style="text-align:center"><h1 style="font-size:22px">${title}</h1><p style="color:#b5bac1">${message}</p></main></body></html>`;
}

export function runLoopbackLogin(deps: LoopbackLoginDeps): Promise<DesktopLoginResponse> {
  const port = deps.port ?? LOGIN_PORT;
  const state = randomBytes(STATE_BYTES).toString("base64url");

  return new Promise<DesktopLoginResponse>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const server = http.createServer((request, response) => {
      const url = request.url ?? "/";
      if (!url.startsWith("/callback")) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      if (settled) {
        response.end(browserPage("Pronto!", `Pode voltar para a ${APP_NAME}.`));
        return;
      }

      const result = parseCallback(url, state);
      if ("error" in result) {
        response.end(browserPage("Login cancelado", `Volte para a ${APP_NAME} para tentar de novo.`));
        finish(() => reject(new Error("Login cancelado.")));
        return;
      }

      response.end(browserPage("Pronto!", `Pode voltar para a ${APP_NAME}.`));
      finish(() => {
        deps.exchange(result.code).then(resolve, (error: unknown) => {
          console.error("Desktop login exchange failed:", error);
          reject(new Error("Não foi possível entrar com o Discord. Tente de novo."));
        });
      });
    });

    const onAbort = () => finish(() => reject(new Error("Login cancelado.")));
    if (deps.signal?.aborted) {
      reject(new Error("Login cancelado."));
      return;
    }
    deps.signal?.addEventListener("abort", onAbort, { once: true });

    function finish(then: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      deps.signal?.removeEventListener("abort", onAbort);
      server.close();
      // Browsers keep the callback connection alive; without this the port stays bound.
      server.closeAllConnections();
      then();
    }

    server.once("error", (error: NodeJS.ErrnoException) => {
      const message =
        error.code === "EADDRINUSE"
          ? `A porta ${port} está em uso. Feche outro login em andamento e tente de novo.`
          : "Não foi possível iniciar o login. Tente de novo.";
      finish(() => reject(new Error(message)));
    });

    server.listen(port, "127.0.0.1", () => {
      timer = setTimeout(
        () => finish(() => reject(new Error("O login não foi concluído. Tente de novo."))),
        deps.timeoutMs,
      );
      deps
        .fetchClientId()
        .then((clientId) => deps.openExternal(buildAuthorizeUrl(clientId, state, port)))
        .catch((error: unknown) => {
          console.error("Could not open the Discord login page:", error);
          finish(() => reject(new Error("Não foi possível abrir o login do Discord. Verifique a conexão.")));
        });
    });
  });
}
