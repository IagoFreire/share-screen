# App desktop (Janja)

O Janja é o app de Windows (Electron) para assistir, transmitir com simulcast e áudio por
app, e usar as salas de voz. Instaladores e atualizações saem das
[Releases do GitHub](https://github.com/IagoFreire/share-screen/releases).

## Como é montado

```
desktop/
├── src/main/            Processo principal (CommonJS)
│   ├── index.ts         Janela, IPC, bandeja, atualizações, instância única
│   ├── serverOrigin.ts  Escolhe o servidor: :8443 (Caddy em casa) ou o endereço sem porta (túnel)
│   ├── capture.ts       Lista telas/janelas e entrega a escolhida ao getDisplayMedia()
│   ├── audioHelper.ts   Inicia o audio-helper.exe e repassa PCM e status para a página
│   ├── auth/            Login por loopback e sessão guardada com safeStorage
│   ├── updates.ts       Estado do electron-updater para o botão da barra de título
│   ├── webSecurity.ts   CSP e lista de permissões da página
│   ├── navigation.ts    A janela só fica na origem do relay
│   └── tray.ts, appTray.ts, windowOptions.ts, appIdentity.ts
├── src/preload/         Expõe window.desktop (contrato em shared/src/desktopApi.ts)
├── native/audio-helper/ Helper em Rust (WASAPI process loopback)
├── static/              Ícone e página offline
└── scripts/             start.cjs, make-icon.cjs, build-audio-helper.cjs
```

A janela carrega `desktop.html` **do relay**, não de um arquivo local. Consequências:

- Mudanças na interface e no player (tudo em `client/src/`) chegam a todos quando o relay é
  reiniciado, sem nova versão do app.
- Mudanças no processo principal, no preload ou no helper exigem uma nova versão.
- O contrato `window.desktop` precisa ser compatível com versões antigas: recursos novos
  entram como opcionais (por exemplo `updates?`, que não existe antes da 0.6.0, e
  `appAudio.onStatus?`, que não existe antes da 0.7.0).

Ao abrir, o app pergunta aos servidores candidatos (`/api/config`, até 4 s) e usa o primeiro
que responder. Se nenhum responder, mostra `static/offline.html`. Se a página falhar depois e
outro candidato responder, o app reinicia nele.

## Login

1. O app abre a página de consentimento do Discord no navegador padrão, com escopo `identify`.
2. O Discord redireciona para `http://127.0.0.1:53134/callback`, onde o app escuta só durante
   o login (até 5 minutos).
3. O app manda o código para `POST /api/desktop/login`; o relay troca com o client secret e
   devolve uma sessão assinada de 30 dias.
4. A sessão é cifrada com `safeStorage` (DPAPI) em `%APPDATA%\ScreenShare\session.bin`.

A pasta de dados continua `ScreenShare` (nome antigo do app) para que logins e preferências
sobrevivam à troca de nome.

## Captura

O seletor do Chromium é substituído pelo do app: a página lista as fontes
(`desktop:get-sources`), a pessoa escolhe, e o processo principal entrega exatamente aquela
fonte na próxima chamada de `getDisplayMedia()`. Os modos de áudio são:

- **Por app** (padrão): o helper mistura todos os apps com som, menos os excluídos e o próprio
  Janja.
- **Sistema**: loopback do Chromium, usado quando o helper não está disponível.
- **Sem áudio**.

## Helper de áudio

`native/audio-helper` é um executável em Rust que usa o WASAPI process loopback (Windows 10
2004 ou mais novo). Ele abre uma captura por sessão de áudio permitida, mistura tudo em PCM
48 kHz estéreo `f32` e escreve blocos de 10 ms no stdout até o stdin fechar.

```
audio-helper sessions [--exclude-pid PID]                         # uma linha JSON com os apps tocando
audio-helper capture [--exclude a.exe,b.exe] [--exclude-pid PID]  # PCM no stdout
```

Pontos importantes:

- Nunca captura um processo cuja árvore contém um app excluído; senão capturar o
  `explorer.exe` traria o Discord junto.
- Se a captura de um processo raiz (um launcher como o Steam) fica muda por 3 s enquanto um
  filho toca, a raiz é trocada pelos filhos.
- `drift.rs` compensa a diferença entre o relógio da placa e o relógio do mixer.
- A varredura de processos roda numa thread própria e lê só nome e pai, para não atrasar a
  mistura com o PC carregado.
- Pelo stderr ele manda linhas `status {"apps":[...]}`, que chegam aos admins nas estatísticas
  como "Captura do apresentador".

### Build do helper

```powershell
rustup toolchain install stable-x86_64-pc-windows-gnu
winget search WinLibs        # instale um pacote BrechtSanders.WinLibs (MinGW-w64: dlltool e as)
npm run audio-helper --workspace=desktop
```

`scripts/build-audio-helper.cjs` acha sozinho o `cargo` do rustup e o MinGW do WinLibs
instalado pelo winget (ou use `MINGW_BIN`), roda `cargo test` e depois `cargo build --release`.
O resultado vai em `native/audio-helper/target/release/audio-helper.exe`.

## Gerar o instalador

```powershell
npm run dist --workspace=desktop
```

Compila o TypeScript, gera `build/icon.png` a partir de `static/janja.png`, compila o helper e
roda o `electron-builder` (NSIS, instalação por usuário, um clique). Saída em
`desktop/release/`: `Janja-Setup-X.Y.Z.exe`, o `.blockmap` e o `latest.yml`.

Se o terminal exportar `ELECTRON_RUN_AS_NODE=1` (terminais do VS Code), limpe a variável antes.

## Publicar uma versão

1. Suba a versão em `desktop/package.json` e na entrada do desktop no `package-lock.json`.
2. Gere o instalador (acima).
3. Crie a release no GitHub com os três arquivos:

   ```powershell
   gh release create vX.Y.Z desktop/release/Janja-Setup-X.Y.Z.exe `
     desktop/release/Janja-Setup-X.Y.Z.exe.blockmap desktop/release/latest.yml `
     --target main --title "Janja X.Y.Z" --notes-file notas.md
   ```

O `electron-updater` lê o `latest.yml` da release mais recente. O app procura atualização ao
abrir e pelo botão da barra de título; a atualização baixa sozinha e o botão fica verde.
**Reiniciar e instalar** encerra a live antes. O `appId` (`dev.iagofreire.screenshare`) não
pode mudar entre versões, senão o instalador novo não substitui o antigo.

## Bandeja e janela

- Fechar a janela esconde o app na bandeja; com live aberta, o ícone ganha um ponto "ao vivo".
- A bandeja tem **Encerrar transmissão**.
- `backgroundThrottling` fica desligado: com ele, minimizar a janela travava o decodificador e
  a live ficava atrasada ao voltar.
- Uma única instância: abrir de novo traz a janela existente para a frente.
