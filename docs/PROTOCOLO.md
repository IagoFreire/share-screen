# Protocolo

A fonte de verdade é `shared/src/protocol.ts` (relay) e `shared/src/voice.ts` (salas de voz).
Este documento resume os dois e a API HTTP.

## Frame binário

Tudo que passa em `/ws` e `/voice` é um frame binário (mensagens de texto são ignoradas).
Campos multibyte em little-endian; o cabeçalho tem 15 bytes fixos.

| Offset | Tamanho | Campo | Descrição |
|---|---|---|---|
| 0 | 1 | `slot` | Live (no relay) ou assento (na sala de voz). O servidor sobrescreve |
| 1 | 1 | `type` | `0` vídeo, `1` áudio, `2` controle |
| 2 | 8 | `timestamp` | `float64`, ms. Tempo de captura, usado na sincronia A/V |
| 10 | 4 | `clock` | `uint32`, sequência por slot (e por camada no vídeo). Um buraco faz o player parar o decoder e pedir keyframe |
| 14 | 1 | `flags` | bit 0: keyframe; bits 1-2: camada do simulcast (0 = melhor) |
| 15 | N | payload | H.264 Annex B, Opus ou JSON UTF-8 (controle) |

Limite de 4 MB por mensagem no servidor.

## Mensagens de controle do relay (`/ws`)

Frames `type = 2` com um JSON `{ kind, ... }`. Direção: C = cliente, S = servidor,
P = apresentador.

### Entrada e estado

| `kind` | Direção | Campos e significado |
|---|---|---|
| `join` | C→S | `roomId`, `userId`, `guildId`; opcionais `session` (Janja: a identidade vem dela e uma sessão inválida é recusada), `presenterOnly` (só transmite), `watchNothing` (entra sem assistir), `hidden` (admin) |
| `joined` | S→C | `roomId`, `streams` (lives atuais), `viewerCount`, `isAdmin` |
| `room-full` | S→C | Sala no limite de espectadores |
| `error` | S→C | `message`; `code: "invalid-session"` quando o cliente deve refazer o login |
| `viewer-count` | S→C | `count` |
| `streams-changed` | S→C | Lista completa de lives, enviada a cada mudança |

`StreamInfo`: `slot`, `presenterId`, `audio` (`{sampleRate, channels}` ou `null`), `layers`
(`[{layer, height, framerate}]`, só no simulcast), `paused` e `gain`.

### Transmitir

| `kind` | Direção | Campos e significado |
|---|---|---|
| `start-presenting` | P→S | `presenterId`, `audio`, `layers` |
| `presenting-started` | S→P | `slot` atribuído |
| `stop-presenting` | P→S | Fim da live |
| `request-stop-presenting` | C→S→P | Encerrar a própria live; com `slot`, a de outra pessoa (só admin) |
| `audience-changed` | S→P | `watchers`, `videoWatchers` (decidem o envio) e `shownWatchers`, `shownVideoWatchers` (sem admins ocultos, para a interface) |
| `layers-in-use` | S→P | `layers` que alguém recebe; as outras são pausadas |
| `request-keyframe` | C→S→P | Pedido de keyframe; para o apresentador, `layer` diz qual encoder |
| `uplink-probe` / `uplink-probe-ack` | P→S→P | `id` inteiro. Mede a fila do upload |
| `presenter-audio-status` | P→S | Estado da captura por app (`{apps: [{exe, state}]}`) |
| `play-alert` | C→S→P | "Bater na porta" (só admin; com `slot` vindo do admin) |

### Assistir

| `kind` | Direção | Campos e significado |
|---|---|---|
| `select-stream` | C→S | `slot` ou `null` (não assistir nada); `preview: true` quando o apresentador abre a própria live |
| `select-layer` | C→S | Número da camada ou `"auto"` |
| `layer-changed` | S→C | `layer` atual e se veio do `auto` |
| `report-congestion` | C→S | Frames chegando cada vez mais atrasados; o `auto` desce |
| `set-video-enabled` | C→S | `enabled: false` = somente áudio |
| `viewing-paused` / `viewing-resumed` | S→C | A mesma pessoa abriu outra conexão / voltou a receber |
| `resume-viewing` | C→S | "Retomar aqui" |
| `request-viewers` / `viewers` | C→S / S→C | Lista de pessoas da sala (`userId`, `name`, `slot`) |
| `request-active-broadcasts` / `active-broadcasts` | C→S / S→C | Lista de lives com nomes resolvidos; a de um admin cobre o relay todo |

### Só admin

| `kind` | Direção | Campos e significado |
|---|---|---|
| `set-hidden` | C→S | `hidden`. Assistir sem aparecer em listas nem contagens |
| `set-stream-gain` | C→S | `slot`, `gain` (1 a 10). Guardado na live e repassado em `streams-changed` |
| `audio-status` | S→C | `slot`, `status`. Estado da captura do apresentador, para quem assiste aquela live |

O servidor confere o admin em cada uma dessas mensagens e ignora as de quem não é.

## Salas de voz (`/voice`)

Áudio: frames `type = 1`, Opus mono 48 kHz, 40 kbps, pacotes de até 4000 bytes. Controle:
frames `type = 2` com JSON.

| `kind` | Direção | Campos e significado |
|---|---|---|
| `hello` | C→S | Primeira mensagem: `session`, `name`, `avatarUrl` (só do CDN do Discord) |
| `welcome` | S→C | `userId`, `isAdmin` |
| `rooms` | S→C | Todas as salas (`id`, `name`, `members`) e `enabled`. Enviada a todos a cada mudança |
| `in-room` | S→C | `roomId` e `slot` (assento) desta conexão, ou `null` |
| `create-room` | C→S | `name` (até 40 caracteres). Cria e entra |
| `join-room` / `leave-room` | C→S | Entrar / sair |
| `set-state` | C→S | `muted`, `deafened` |
| `delete-room` | C→S | Só admin: fecha a sala |
| `set-enabled` | C→S | Só admin: liga/desliga as salas para todos (desligar fecha todas) |
| `error` | S→C | `message`; `code: "invalid-session"` |

Limites: 30 salas, 12 membros por sala.

## API HTTP

| Método e rota | Autenticação | Resposta |
|---|---|---|
| `GET /api/health` | Nenhuma | `{status: "ok"}` |
| `GET /api/config` | Nenhuma | `{clientId}` |
| `POST /api/token` | Nenhuma | Corpo `{code}` (da Activity). Responde `{access_token}`; 400 sem código, 502 se o Discord recusar |
| `POST /api/desktop/login` | Nenhuma | Corpo `{code}` (do loopback do Janja). Responde `{session, user}` |
| `GET /api/desktop/me` | `Authorization: Bearer <session>` | `{userId}`; 401 se inválida |
| `GET /api/desktop/voice` | `Authorization: Bearer <session>` | `{location}` (servidor e canal, ou `null`); 503 se o Discord falhou, para o app manter o último canal conhecido |

Sem `SESSION_SECRET`, todas as rotas `/api/desktop/*` respondem 503
`desktop-login-not-configured`. Qualquer outra rota serve `client/dist` (com fallback para
`index.html`).
