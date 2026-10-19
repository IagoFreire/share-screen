# App desktop — Plano 1: programa base (login, canal, layout A, transmitir e assistir)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Um app Electron para Windows em que a pessoa entra com o Discord, o app acha o canal de voz dela, mostra as lives no layout "Clássico Discord" e permite assistir e transmitir (uma camada de vídeo, áudio do sistema inteiro).

**Architecture:** O Electron é uma casca fina: o processo principal cuida de janela sem moldura, seletor de fontes (`desktopCapturer` + `setDisplayMediaRequestHandler`), login OAuth por loopback, bandeja e sessão guardada com `safeStorage`. A interface é uma **nova página Vite `client/desktop.html`**, servida pelo mesmo servidor de hoje (`https://share.iagofreire.dev/desktop.html`) e carregada pela janela do Electron. Assim ela reaproveita direto os módulos de `client/src`, sem duplicar. O servidor ganha sessão assinada, login do desktop, detecção de canal de voz e `join` com identidade verificada.

**Tech Stack:** Electron (estável atual, ≥ 37), TypeScript, Vite (multi-página já existente), Express + `ws`, Vitest (novo), WebCodecs.

**Spec:** `docs/superpowers/specs/2026-10-19-desktop-app-design.md`

**Fora deste plano (planos seguintes):** 2 — áudio por aplicativo (módulo nativo WASAPI); 3 — simulcast + seletor de qualidade; 4 — instalador NSIS + atualização automática pelas Releases.

## Global Constraints

- Plataforma: Windows. Electron com `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`; preload expõe só a API `window.desktop` definida na Task 8.
- A janela só navega dentro da origem do servidor configurado; qualquer outro link abre no navegador padrão.
- Origem padrão do servidor: `https://share.iagofreire.dev`; variável `SCREENSHARE_SERVER` sobrescreve (dev: `http://localhost:5173`).
- `client_secret` do Discord nunca sai do servidor. Sessões são assinadas com `SESSION_SECRET` (≥ 32 caracteres) do `.env` da raiz.
- Redirect do OAuth do desktop: `http://127.0.0.1:53134/callback` (cadastrar no Developer Portal → OAuth2 → Redirects). Escopo: `identify`.
- `present.html`, `watch.html` e a Activity continuam funcionando sem mudança de comportamento.
- Textos da interface em pt-BR, com acentos. Código, nomes e comentários em inglês, no estilo do repositório.
- Paleta (spec, "Visual"): `#1e1f22` `#2b2d31` `#313338` `#383a40` `#404249`, blurple `#5865f2`, verde `#23a55a`, vermelho `#f23f43`, texto `#f2f3f5` `#b5bac1` `#80848e`; fonte `"Segoe UI Variable", "Segoe UI", system-ui`.
- **Git:** a árvore tem mudanças do Iago não commitadas (incl. `relay.ts`, `watch.ts`, `App.ts`). Não commitar nada antes de essas mudanças estarem commitadas pelo Iago; sempre `git add` com caminhos explícitos.
- Comandos: `npm test` (Vitest, raiz) e `npm run typecheck` (raiz) precisam passar ao fim de cada task.

## Review Focus

1. **Login abandonado ou repetido** (navegador fechado, callback aberto duas vezes, `state` diferente, porta 53134 ocupada) → o app mostra erro claro e permite tentar de novo; nunca fica preso em "Entrando…". *Teste na Task 10.*
2. **Sessão expirada/inválida no `join`** → o servidor responde `error` com `code: "invalid-session"` e o app volta para a tela de login, sem loop de reconexão. *Testes nas Tasks 5 e 11.*
3. **Falha na consulta de canal** (429, bot sem permissão, rede) → mantém o último canal conhecido em vez de piscar "fora do canal". *Teste na Task 11.*
4. **Sair do canal de voz estando ao vivo** → aviso com opção de encerrar; não encerra sozinho. *Teste na Task 12.*
5. **Janela/tela capturada fechada no meio da live** (track `ended`) → encerra a transmissão e o painel volta ao estado "Transmitir". *Teste na Task 6.*

---

### Task 1: Vitest no monorepo

**Files:**
- Modify: `package.json` (raiz) — script `"test": "vitest run"`, devDependency `vitest`
- Create: `vitest.config.ts` (raiz) — `test.include: ["{shared,server,client,desktop}/src/**/*.test.ts"]`, alias `@screenshare-bot/shared` → `shared/src/index.ts` (igual ao `client/vite.config.ts`)
- Test: `shared/src/protocol.test.ts`

- [ ] **Step 1: Escrever teste de fumaça** `encodeFrame/decodeFrame round-trips header and payload`: codifica `{slot: 2, type: FrameType.Video, timestamp: 1234.5, clock: 7, keyFrame: true}` com payload `[1,2,3]` e espera os mesmos campos e payload de volta.
- [ ] **Step 2:** `npm i -D vitest -w .` e criar config.
- [ ] **Step 3:** `npm test` → PASS (1 teste).
- [ ] **Step 4: Commit** `chore: add vitest to the monorepo`

### Task 2: Sessão assinada no servidor

**Files:**
- Create: `server/src/auth/session.ts`, `server/src/auth/session.test.ts`
- Modify: `server/src/config.ts` — `sessionSecret: process.env.SESSION_SECRET ?? ""`, `desktopRedirectUri: process.env.DESKTOP_REDIRECT_URI ?? "http://127.0.0.1:53134/callback"`; `assertSessionConfigured()` lança se `sessionSecret.length < 32`
- Modify: `docs/DEPLOY.md` — documentar `SESSION_SECRET` e o redirect do desktop

**Interfaces — Produces:**
- `createSessionToken(userId: string, nowMs: number, secret: string): string` — formato `base64url(JSON {uid, exp}) + "." + base64url(HMAC-SHA256)`; `exp = nowMs + SESSION_TTL_MS` (30 dias, constante exportada)
- `verifySessionToken(token: string, nowMs: number, secret: string): string | null` — `userId` ou `null`

- [ ] **Step 1: Testes:** `round-trips the user id`; `rejects an expired token` (now = exp + 1); `rejects a tampered payload` (troca um caractere do payload); `rejects a token signed with another secret`; `rejects garbage` (`""`, `"a.b"`, `"x"`) → todos `null`, nunca lança.
- [ ] **Step 2:** `npm test -- session` → FAIL (módulo não existe).
- [ ] **Step 3:** Implementar com `node:crypto` (`createHmac`, comparação com `timingSafeEqual`).
- [ ] **Step 4:** `npm test -- session` → PASS.
- [ ] **Step 5: Commit** `feat(server): signed desktop sessions`

### Task 3: Login do desktop no servidor

**Files:**
- Modify: `server/src/auth/discordOAuth.ts` — `exchangeCodeForToken(code: string, redirectUri: string = REDIRECT_URI)`; novo `fetchDiscordUser(accessToken: string): Promise<DiscordUser>` (`GET https://discord.com/api/v10/users/@me`)
- Create: `server/src/routes/desktopRoutes.ts`, `server/src/routes/desktopRoutes.test.ts`
- Modify: `server/src/app.ts` — `app.use("/api/desktop", createDesktopRouter(deps))` antes do `express.static`
- Modify: `shared/src/protocol.ts` — tipos `DesktopUser`, `DesktopLoginResponse`

**Interfaces — Produces:**
- `interface DesktopUser { id: string; username: string; globalName: string | null; avatarUrl: string | null }` (avatar: `https://cdn.discordapp.com/avatars/{id}/{hash}.png?size=64`)
- `interface DesktopLoginResponse { session: string; user: DesktopUser }`
- `createDesktopRouter(deps: DesktopRouterDeps): Router` com `deps = { exchangeCode, fetchUser, locateVoice, now, secret }` (injeção para testes; `locateVoice` vem da Task 4)
- `POST /api/desktop/login` body `{ code: string }` → 200 `DesktopLoginResponse`; 400 sem `code`; 502 se o Discord falhar
- Middleware `requireSession` → coloca `res.locals.userId`; 401 `{ error: "invalid-session" }` sem/má sessão (`Authorization: Bearer <token>`)

- [ ] **Step 1: Testes** (`app.listen(0)` + `fetch`): `login returns a verifiable session for the Discord user`; `login rejects a missing code with 400`; `login maps a Discord failure to 502`; `requireSession rejects a bad bearer with 401 invalid-session`.
- [ ] **Step 2:** rodar → FAIL.
- [ ] **Step 3:** Implementar. O exchange usa `config.desktopRedirectUri`.
- [ ] **Step 4:** rodar → PASS; `npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(server): desktop OAuth login endpoint`

### Task 4: Detecção do canal de voz

**Files:**
- Create: `server/src/auth/voiceLocator.ts`, `server/src/auth/voiceLocator.test.ts`
- Modify: `server/src/routes/desktopRoutes.ts` — `GET /api/desktop/voice`
- Modify: `shared/src/protocol.ts` — `VoiceLocation`

**Interfaces — Produces:**
- `interface VoiceLocation { guildId: string; guildName: string | null; guildIconUrl: string | null; channelId: string; channelName: string | null }`
- `createVoiceLocator(deps: { fetchJson: (path: string) => Promise<{ status: number; body: unknown }>; now: () => number }): { locate(userId: string): Promise<VoiceLocation | null> }`
  - Guildas do bot: `GET /users/@me/guilds` (token do bot), cache de **5 min**.
  - Para cada guilda: `GET /guilds/{g}/voice-states/{user}`; 200 com `channel_id` → achou; 404 → não está nessa guilda; outro status → **lança** `VoiceLookupError` (o chamador decide manter o último valor).
  - Cache do resultado por usuário: **5 s** (protege o rate limit quando o app consulta seguido).
  - Nomes via `resolveGuildName`/`resolveChannelName` já existentes.
- `GET /api/desktop/voice` (com `requireSession`) → 200 `{ location: VoiceLocation | null }`; 503 `{ error: "voice-lookup-failed" }` em `VoiceLookupError`.

- [ ] **Step 1: Testes:** `finds the guild where the user is in voice`; `returns null when every guild answers 404`; `throws VoiceLookupError on 429 or 403`; `caches bot guilds for 5 minutes` (conta chamadas a `/users/@me/guilds` com `now` avançando 4 e 6 min); `caches a user's result for 5 seconds`.
- [ ] **Step 2:** FAIL → **Step 3:** implementar → **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(server): locate a user's voice channel for the desktop app`

### Task 5: `join` com identidade verificada

**Files:**
- Modify: `shared/src/protocol.ts` — `join` ganha `session?: string | null`; `error` ganha `code?: "invalid-session"`
- Create: `server/src/ws/joinIdentity.ts`, `server/src/ws/joinIdentity.test.ts`
- Modify: `server/src/ws/relay.ts` (`handleJoin`) — usar `resolveJoinIdentity` antes de qualquer outra checagem

**Interfaces — Produces:**
- `resolveJoinIdentity(message: { userId: string | null; session?: string | null }, verify: (token: string) => string | null): { ok: true; userId: string | null; verified: boolean } | { ok: false }`
  - sem `session` → `{ ok: true, userId: message.userId, verified: false }` (caminho atual, inalterado)
  - `session` válida → `{ ok: true, userId: <do token>, verified: true }` (ignora `message.userId`)
  - `session` inválida → `{ ok: false }` → relay envia `{ kind: "error", message: "Sessão expirada. Entre de novo.", code: "invalid-session" }` e não entra na sala

- [ ] **Step 1: Testes** dos três casos + `a valid session overrides a spoofed userId`.
- [ ] **Step 2:** FAIL → **Step 3:** implementar e ligar no `handleJoin` → **Step 4:** PASS + typecheck.
- [ ] **Step 5: Commit** `feat(server): verified identity on join for desktop sessions`

### Task 6: Extrair a sessão de transmissão do `present.ts`

**Files:**
- Create: `client/src/session/presenterSession.ts`, `client/src/session/presenterSession.test.ts`
- Modify: `client/src/present.ts` — passa a usar `createPresenterSession`; UI e comportamento iguais

**Interfaces — Produces:**
```ts
export interface PresenterSessionDeps {
  sendFrame(header: FrameHeader, payload: Uint8Array): void;
  sendControl(message: ControlMessage): void;
  capture(quality: QualityPreset): Promise<CaptureStreams>;          // present.ts: startScreenCapture
  startVideo: typeof startVideoEncodePipeline;
  startAudio: typeof startAudioEncodePipeline;
  presenterId: string | null;
}
export interface PresenterSession {
  readonly isPresenting: boolean;
  start(quality: QualityPreset): Promise<{ hasAudio: boolean }>;
  stop(): void;                                   // idempotente; envia stop-presenting só se estava ao vivo
  handleControl(message: ControlMessage): boolean; // trata presenting-started, request-keyframe, request-stop-presenting
  onEnded(listener: () => void): void;            // chamado quando a fonte termina sozinha (track "ended")
}
export function createPresenterSession(deps: PresenterSessionDeps): PresenterSession;
```

- [ ] **Step 1: Testes** (pipelines e captura falsos): `start sends start-presenting with the audio params`; `video frames carry the slot from presenting-started and an increasing clock`; `request-keyframe reaches the video pipeline`; `stop is idempotent and sends stop-presenting once`; **`a source that ends stops the session and notifies onEnded`** (Review Focus 5); `start without an audio track reports hasAudio false`.
- [ ] **Step 2:** FAIL → **Step 3:** extrair do `present.ts` (o alerta "bater na porta" e o status de UI ficam no `present.ts`) → **Step 4:** PASS + typecheck.
- [ ] **Step 5:** Fumaça manual: `npm run dev:server` + `npm run dev:client`, abrir `present.html?room=teste` e `watch.html?room=teste`, transmitir, ver vídeo e áudio, parar.
- [ ] **Step 6: Commit** `refactor(client): extract presenter session from present.ts`

### Task 7: `watch.ts` vira uma visão montável

**Files:**
- Create: `client/src/watchView.ts` — o corpo atual de `main()` do `watch.ts`, parametrizado
- Modify: `client/src/watch.ts` — só lê os parâmetros da URL e chama `mountWatchView`

**Interfaces — Produces:**
```ts
export interface WatchViewOptions {
  root: HTMLElement;
  wsUrl: string;
  roomId: string;
  userId: string | null;
  guildId: string | null;
  session?: string | null;          // enviado no join (Task 5)
  embedded?: boolean;               // esconde o painel/botão de transmissões e não mexe na URL da janela
  onActiveBroadcasts?: (list: ActiveBroadcast[]) => void;
  onJoined?: (info: { isAdmin: boolean }) => void;
  onSessionInvalid?: () => void;    // error com code "invalid-session"
}
export interface WatchView {
  openBroadcast(broadcast: ActiveBroadcast): Promise<void>;
  requestBroadcasts(): void;
  destroy(): void;                  // fecha o WsClient, para pipelines, remove listeners do document/window
}
export function mountWatchView(options: WatchViewOptions): WatchView;
```

- [ ] **Step 1:** Extrair sem mudar comportamento do `watch.html` (com `embedded` falso, `syncAddressToRoom` e painel continuam como hoje).
- [ ] **Step 2:** `npm run typecheck` → PASS.
- [ ] **Step 3:** Fumaça manual igual à da Task 6, incluindo troca de transmissão pelo painel e tela cheia.
- [ ] **Step 4: Commit** `refactor(client): make the watch page a mountable view`

### Task 8: Workspace `desktop/` — janela, navegação travada e API do preload

**Files:**
- Modify: `package.json` (raiz) — adicionar `"desktop"` a `workspaces`; script `"dev:desktop": "npm run dev --workspace=desktop"`
- Create: `desktop/package.json` (`main: "dist/main/index.js"`, scripts `build: tsc -p tsconfig.json`, `dev: npm run build && electron .`), `desktop/tsconfig.json` (CommonJS, Node)
- Create: `desktop/src/main/index.ts` — `BrowserWindow` sem moldura (`frame: false`, `backgroundColor: "#313338"`, `minWidth: 940`, `minHeight: 560`), carrega `${serverOrigin}/desktop.html`; `did-fail-load` → carrega `desktop/static/offline.html` (local) com botão "Tentar de novo"
- Create: `desktop/src/main/serverOrigin.ts`, `desktop/src/main/navigation.ts` (+ `.test.ts`)
- Create: `desktop/src/preload/index.ts`
- Create: `shared/src/desktopApi.ts` (exportado em `shared/src/index.ts`)

**Interfaces — Produces:**
- `resolveServerOrigin(env: Record<string, string | undefined>): string` → `env.SCREENSHARE_SERVER` sem barra final, ou `"https://share.iagofreire.dev"`
- `isAllowedNavigation(url: string, serverOrigin: string): boolean` → só mesma origem (compara `new URL(...).origin`; URL inválida → `false`)
- `shared/src/desktopApi.ts`:
```ts
export interface DesktopSource { id: string; name: string; kind: "screen" | "window"; thumbnailDataUrl: string; iconDataUrl: string | null }
export interface StoredLogin { session: string; user: DesktopUser }
export interface DesktopApi {
  getSources(): Promise<DesktopSource[]>;
  selectSource(id: string): Promise<void>;          // vale para o PRÓXIMO getDisplayMedia
  login(): Promise<StoredLogin>;                    // rejeita com Error(message em pt-BR)
  getStoredLogin(): Promise<StoredLogin | null>;
  logout(): Promise<void>;
  setLive(live: boolean): void;                     // bandeja (Task 13)
  notify(title: string, body: string): void;        // notificação do Windows (Task 13)
  onEndLiveRequested(listener: () => void): void;   // menu da bandeja (Task 13)
  windowControls: { minimize(): void; toggleMaximize(): void; close(): void };
}
declare global { interface Window { desktop?: DesktopApi } }
```
- Canais IPC com prefixo `desktop:`; o main valida tipos de cada argumento e confere `event.senderFrame.url` com `isAllowedNavigation`.

- [ ] **Step 1: Testes:** `resolveServerOrigin` (padrão, override, barra final); `isAllowedNavigation` (mesma origem ok; outro host, `http` vs `https`, URL inválida → `false`).
- [ ] **Step 2:** FAIL → **Step 3:** implementar (métodos de fonte/login/bandeja podem ficar como stubs que rejeitam com "ainda não disponível" até as Tasks 9, 10 e 13) → **Step 4:** PASS.
- [ ] **Step 5:** `npm run dev:desktop` com `SCREENSHARE_SERVER=http://localhost:5173` abre a janela sem moldura (antes de existir `desktop.html`, mostra 404 ou a página offline, nunca tela branca).
- [ ] **Step 6: Commit** `feat(desktop): Electron shell with locked navigation and preload API`

### Task 9: Fontes de captura e áudio do sistema

**Files:**
- Create: `desktop/src/main/capture.ts`, `desktop/src/main/capture.test.ts`
- Modify: `desktop/src/main/index.ts`, `desktop/src/preload/index.ts`

**Interfaces — Produces:**
- `toDesktopSource(source: Electron.DesktopCapturerSource): DesktopSource` (`kind` pelo prefixo do id `screen:`/`window:`; miniatura 320×180)
- `createSourceSelection(): { set(id: string): void; take(): string | null }` — `take` devolve e limpa (uso único)
- `setDisplayMediaRequestHandler`: pega `take()`; sem seleção → `callback({})` (nega); com seleção → `{ video: <source>, audio: "loopback" }`. O plano 2 troca o `"loopback"` pelo áudio por app.

- [ ] **Step 1: Testes:** `maps screen and window sources`; `a selection is used once`; `no selection denies the request`.
- [ ] **Step 2:** FAIL → **Step 3:** implementar → **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(desktop): source picker plumbing and system audio loopback`

### Task 10: Login OAuth por loopback

**Files:**
- Create: `desktop/src/main/auth/loopbackLogin.ts`, `desktop/src/main/auth/loopbackLogin.test.ts`, `desktop/src/main/auth/sessionStore.ts`, `desktop/src/main/auth/sessionStore.test.ts`

**Interfaces — Produces:**
- `buildAuthorizeUrl(clientId: string, state: string): string` → `https://discord.com/oauth2/authorize?client_id=…&response_type=code&scope=identify&redirect_uri=http%3A%2F%2F127.0.0.1%3A53134%2Fcallback&state=…`
- `parseCallback(url: string, expectedState: string): { code: string } | { error: "state-mismatch" | "denied" | "missing-code" }`
- `runLoopbackLogin(deps: { openExternal(url: string): Promise<void>; fetchClientId(): Promise<string>; exchange(code: string): Promise<DesktopLoginResponse>; timeoutMs: number }): Promise<DesktopLoginResponse>` — servidor HTTP em `127.0.0.1:53134` só durante o login; responde ao navegador com página curta "Pronto! Pode voltar ao ScreenShare."; fecha o servidor em qualquer saída; `timeoutMs` = 5 min.
- Erros com mensagem pt-BR: porta ocupada → "A porta 53134 está em uso. Feche outro login em andamento e tente de novo."; timeout → "O login não foi concluído. Tente de novo."; state errado/negado → "Login cancelado."
- `createSessionStore(deps: { filePath: string; encrypt(s: string): Buffer; decrypt(b: Buffer): string }): { load(): Promise<StoredLogin | null>; save(l: StoredLogin): Promise<void>; clear(): Promise<void> }` — arquivo ilegível/corrompido → `load` devolve `null`.

- [ ] **Step 1: Testes:** `buildAuthorizeUrl` exato; `parseCallback` (ok, state errado, `error=access_denied`, sem code); **`runLoopbackLogin times out and frees the port`**; **`a second callback after success is ignored`**; **`port in use rejects with the pt-BR message`** (Review Focus 1); `sessionStore round-trips and returns null on corrupt file`.
- [ ] **Step 2:** FAIL → **Step 3:** implementar; ligar no IPC (`login` usa `shell.openExternal`, `GET {server}/api/config`, `POST {server}/api/desktop/login`, `safeStorage`) → **Step 4:** PASS.
- [ ] **Step 5:** Cadastrar `http://127.0.0.1:53134/callback` no Developer Portal e testar o login de verdade.
- [ ] **Step 6: Commit** `feat(desktop): Discord login via loopback redirect`

### Task 11: Página `desktop.html` — login, canal de voz, lateral e player

**Files:**
- Modify: `client/vite.config.ts` — entrada `desktop: "desktop.html"`
- Create: `client/desktop.html`, `client/src/desktop/main.ts`, `client/src/desktop/desktop.css`
- Create: `client/src/desktop/sidebarModel.ts` (+ `.test.ts`), `client/src/desktop/voicePoller.ts` (+ `.test.ts`)
- Create: `client/src/desktop/views/titleBar.ts`, `views/loginScreen.ts`, `views/serverRail.ts`, `views/channelList.ts`, `views/userPanel.ts`, `views/emptyState.ts`

**Interfaces — Consumes:** `window.desktop` (Task 8), `GET /api/desktop/voice` (Task 4), `mountWatchView` (Task 7).
**Interfaces — Produces:**
- `buildSidebarModel(input: { location: VoiceLocation | null; broadcasts: ActiveBroadcast[] }): SidebarServer[]`
  - `SidebarServer { guildId; name; iconUrl; channels: SidebarChannel[] }`, `SidebarChannel { channelId; name; isMine: boolean; presenters: { slot; userId; name }[] }`
  - Seu canal aparece sempre (mesmo sem lives), marcado `isMine`; outros canais só se tiverem broadcast (a lista do servidor já respeita admin/não-admin); seu servidor primeiro.
- `createVoicePoller(deps: { fetchVoice(): Promise<Response>; intervalMs: number; onChange(state: VoiceState): void; onSessionInvalid(): void }): { start(): void; stop(): void; refresh(): void }` com `VoiceState = { status: "unknown" } | { status: "in-channel"; location: VoiceLocation } | { status: "not-in-voice" }`; `intervalMs` = **15 000**; `refresh()` também no `focus` da janela.
  - 503/erro de rede → **mantém o último estado** (Review Focus 3); 401 → `onSessionInvalid()`.
- Layout A conforme `.superpowers/brainstorm/514-1792427178/content/layout.html`: barra de título (usa `windowControls`, `-webkit-app-region: drag`), trilho de servidores, lista de canais com etiqueta **AO VIVO**, área central com `mountWatchView({ embedded: true, session, … })` no seu canal, painel do usuário com avatar/nome/"Em 🔊 canal" e botão **Transmitir** (abre a Task 12). Clicar num presenter de outro canal (admin) chama `watchView.openBroadcast`.
- Estado vazio sem canal: "Entre em um canal de voz de um servidor onde o bot está para ver e transmitir lives."
- Tela de login: botão "Entrar com Discord", erro exibido abaixo.
- `onSessionInvalid` (poller ou watch view) → `desktop.logout()` e volta para a tela de login (Review Focus 2).
- Fora do Electron (`window.desktop` ausente), `desktop.html` mostra "Abra esta página pelo app ScreenShare."

- [ ] **Step 1: Testes:** `sidebarModel` (seu canal sem lives aparece; canal alheio sem broadcast some; presenters agrupados por canal; seu servidor primeiro); `voicePoller` (**keeps the last location on 503**; 401 chama `onSessionInvalid`; muda para `not-in-voice` quando `location` é `null`).
- [ ] **Step 2:** FAIL → **Step 3:** implementar modelo, poller e views → **Step 4:** PASS + typecheck.
- [ ] **Step 5:** Fumaça no app: login → canal detectado → uma live aberta pela `present.html` aparece com AO VIVO e toca no centro; sair do canal no Discord mostra o estado vazio em até 15 s.
- [ ] **Step 6: Commit** `feat(desktop): Discord-style main window with voice detection and embedded player`

### Task 12: Janela de Transmitir e live pelo app

**Files:**
- Create: `client/src/desktop/views/transmitModal.ts`, `client/src/desktop/liveController.ts` (+ `.test.ts`)
- Modify: `client/src/desktop/views/userPanel.ts`, `client/src/desktop/main.ts`, `client/src/desktop/desktop.css`

**Interfaces — Consumes:** `createPresenterSession` (Task 6), `startScreenCapture` (captura atual; o Electron entrega a fonte escolhida), `window.desktop.getSources/selectSource/setLive/notify/onEndLiveRequested`, `VoiceState` (Task 11).
**Interfaces — Produces:**
- Modal conforme `transmit-modal.html`, opção 1: abas Telas/Janelas com miniaturas; qualidade com os presets **atuais** (`480p/720p/1080p`, `30/60`, `Equilibrada/Alta/Máxima`, mesma chave `localStorage` `screenshare-bot:quality` do `present.ts`); estimativa "~X Mbps de upload" a partir de `buildQualityPreset`; botão **Entrar ao vivo**. (1440p/Fonte e camadas vêm no plano 3; a lista de apps de áudio no plano 2 — aqui só a linha "Áudio: som do computador".)
- `createLiveController(deps: { session: PresenterSession; selectSource(id: string): Promise<void>; setLive(live: boolean): void; confirmLeave(): Promise<boolean> }): { goLive(sourceId: string, quality: QualityPreset): Promise<void>; end(): void; onVoiceState(state: VoiceState): Promise<void>; readonly isLive: boolean }`
  - `goLive` seleciona a fonte antes de `session.start`, depois `setLive(true)`
  - `end` → `session.stop()`, `setLive(false)`; também ligado a `session.onEnded` e a `desktop.onEndLiveRequested`
  - `onVoiceState`: ao vivo e `not-in-voice` ou canal diferente → `confirmLeave()`; `true` encerra; `false` mantém (Review Focus 4). Pergunta **uma vez** por saída.
- A transmissão usa **uma conexão `WsClient` própria** (como o `present.html`), `join` com `session`.
- "Bater na porta" (`play-alert`) toca `DoorKnock.mp3` e, com a janela minimizada, chama `desktop.notify("Alguém bateu na porta", "Abra o ScreenShare para ver.")`.
- Painel do usuário ao vivo: botão vira "Encerrar transmissão" (vermelho) e mostra o contador de espectadores.

- [ ] **Step 1: Testes:** `goLive selects the source before starting`; `end stops the session and clears live`; **`leaving the voice channel while live asks once and keeps streaming on "no"`**; `"yes" ends the live`; `voice changes while not live never ask`.
- [ ] **Step 2:** FAIL → **Step 3:** implementar → **Step 4:** PASS + typecheck.
- [ ] **Step 5:** Fumaça: transmitir uma janela pelo app; assistir pela Activity e pela `watch.html`; fechar a janela capturada encerra a live; bater na porta pela Activity toca o som no app.
- [ ] **Step 6: Commit** `feat(desktop): go live from the app`

### Task 13: Bandeja e notificações

**Files:**
- Create: `desktop/src/main/tray.ts`, `desktop/src/main/tray.test.ts`, `desktop/assets/tray-idle.png`, `desktop/assets/tray-live.png` (16×16 e 32×32)
- Modify: `desktop/src/main/index.ts`, `desktop/src/preload/index.ts`

**Interfaces — Produces:**
- `decideCloseAction(state: { live: boolean; quitting: boolean }): "hide-to-tray" | "close"` — ao vivo e sem "Sair" explícito → esconde na bandeja
- Menu da bandeja: "Abrir ScreenShare", "Encerrar transmissão" (só ao vivo; envia `desktop:end-live` para a página → `onEndLiveRequested`), "Sair" (se ao vivo, encerra antes de sair).
- `notify` usa `Notification` do Electron.

- [ ] **Step 1: Testes** de `decideCloseAction` (4 combinações).
- [ ] **Step 2:** FAIL → **Step 3:** implementar → **Step 4:** PASS.
- [ ] **Step 5:** Fumaça: ao vivo, fechar a janela → vai para a bandeja com ícone ao vivo; "Encerrar transmissão" pela bandeja encerra; "Sair" fecha tudo.
- [ ] **Step 6: Commit** `feat(desktop): tray while live and Windows notifications`
