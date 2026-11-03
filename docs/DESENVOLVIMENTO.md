# Desenvolvimento

## Pré-requisitos

- Node.js 22 ou mais novo e npm (o repositório é um npm workspace: `shared`, `server`,
  `client`, `desktop`).
- Chrome ou outro Chromium (WebCodecs e `MediaStreamTrackProcessor`).
- Para abrir dentro do Discord: um app no Developer Portal e um túnel HTTPS. Veja
  [CONFIGURACAO.md](CONFIGURACAO.md#discord-developer-portal).
- Para o helper de áudio do Janja: Rust (`rustup`, alvo `x86_64-pc-windows-gnu`) e MinGW-w64
  (WinLibs pelo winget). Veja [APP-DESKTOP.md](APP-DESKTOP.md#helper-de-áudio).

## Primeira vez

```powershell
npm install
copy .env.example .env
```

Preencha pelo menos `DISCORD_CLIENT_ID` e `DISCORD_CLIENT_SECRET`. Para testar o Janja, defina
também `SESSION_SECRET` (32+ caracteres) e `DISCORD_BOT_TOKEN`.

## Rodando

Em dois terminais:

```powershell
npm run dev:server   # relay em :3001, recarrega ao salvar (tsx watch)
npm run dev:client   # Vite em :5173, com proxy de /api, /ws e /voice para :3001
```

Sem o Discord, use as páginas direto (a sala é qualquer texto em `?room=`):

- Transmitir: `http://localhost:5173/present.html?room=teste`
- Assistir: `http://localhost:5173/watch.html?room=teste`
- Prévias estáticas da interface: `npm run previews` (abre `client/previews/`)

Dentro do Discord, a Activity precisa de HTTPS. Use um Cloudflare Tunnel apontando para o Vite
(`:5173`) e coloque o hostname do túnel no URL Mapping da Activity. O hostname também precisa
estar em `server.allowedHosts` de `client/vite.config.ts`, senão o Vite responde "Blocked
request". **Não use o ngrok gratuito**: a live passa toda pelo túnel e esgota a franquia em
minutos. O passo a passo do túnel está na seção 0 de [DEPLOY.md](DEPLOY.md).

### Janja em modo dev

```powershell
$env:SCREENSHARE_SERVER = "http://localhost:5173"
npm run dev:desktop
```

`scripts/start.cjs` remove o `ELECTRON_RUN_AS_NODE` que terminais do VS Code exportam (com ele,
o Electron vira Node puro e o app quebra ao iniciar). Se o Janja instalado estiver aberto, ele
segura a trava de instância única: rode o dev com outro perfil, por exemplo
`npx electron . --user-data-dir=C:\temp\janja-dev` dentro de `desktop/`.

## Testes e checagens

```powershell
npm test             # Vitest: arquivos *.test.ts de shared, server, client e desktop
npm run typecheck    # tsc em todos os workspaces
```

Os testes ficam ao lado do código (`foo.ts` → `foo.test.ts`). Hoje são 48 arquivos e 367
testes. O helper em Rust tem os próprios testes (`cargo test` em
`desktop/native/audio-helper`, que o build do helper também roda).

Os módulos do servidor recebem as dependências externas injetadas (por exemplo
`createDesktopRouter` e `createVoiceLocator`), e os testes rodam sem rede.

## Armadilhas conhecidas

- **Dev conversando com a produção sem você saber.** Se o `start-bot.bat` estiver rodando
  nesta máquina, ele ocupa a porta 3001 e o Vite do dev faz proxy para ele. Para testar sem
  mexer na produção, suba um relay em outra porta (`$env:PORT=3011; npx tsx src/index.ts`
  dentro de `server/`) e aponte o proxy do Vite para ela.
- **Cache do proxy da Activity.** O Discord guarda arquivos com URL estável. Por isso o CSS é
  importado pelo JS, os sons são importados (ganham hash) e o dev manda `no-store` em tudo
  (plugin em `vite.config.ts`). Se algo parecer velho na Activity, desconfie de cache ou de
  dois servidores ([HOSPEDAGEM.md](HOSPEDAGEM.md#dois-relays-no-mesmo-endereço)).
- **Processos órfãos.** Fechar o terminal do `npm run dev:*` pode deixar o Vite ou o `tsx`
  rodando e segurando a porta. Encerre pelo número da porta.
- **Testar `desktop.html` sem Electron nem login.** Rode um relay de teste com
  `SESSION_SECRET` de teste e `DISCORD_BOT_TOKEN=` vazio. Gere uma sessão assinando
  `{uid, exp}` como em `server/src/auth/session.ts`, e crie uma página HTML temporária que
  defina um `window.desktop` falso e carregue `/src/desktop/main.ts`.

## Convenções

- TypeScript estrito, módulos ES no servidor e no cliente (CommonJS no processo do Electron).
- Comentários e identificadores em inglês; textos da interface em pt-BR.
- Commits no formato `tipo: descrição` (`feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`).
- Quando mexer em `shared/src/protocol.ts`, mantenha compatibilidade com versões antigas do
  Janja (campos novos opcionais), porque o app instalado só atualiza quando a pessoa reinicia.
