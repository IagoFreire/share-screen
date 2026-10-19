# App desktop (Electron) para transmitir e assistir — design

Data: 2026-10-19 · Repositório: `IagoFreire/share-screen` (público)

## Intenção

Hoje quem transmite abre uma aba no navegador (`present.html`) e quem assiste usa a Activity dentro do Discord
(ou `watch.html`). O Iago quer um **programa para Windows** que dê mais controle sobre a transmissão do que o
navegador permite. As duas coisas que motivam o programa:

1. **Tirar aplicativos do áudio da live.** O caso principal é o Discord: ao compartilhar a tela inteira, o
   áudio do sistema inclui as vozes da chamada e quem está assistindo se ouve de volta. O navegador não
   consegue separar áudio por aplicativo; um programa nativo consegue (é o que o próprio Discord faz).
2. **Quem assiste escolhe a qualidade** (resolução e fps) que quer receber, para que quem tem internet fraca
   não trave e quem tem internet boa continue vendo em alta qualidade.

O programa também serve para **assistir**. A aba do navegador e a Activity **continuam funcionando** como hoje.

## Objetivos

- App Electron para Windows que **transmite e assiste**, falando com o mesmo servidor/relay de hoje.
- Login com Discord uma vez; o app **detecta sozinho** em qual canal de voz a pessoa está.
- Janela de **Transmitir** com escolha de tela/janela, qualidade máxima e **lista de apps para tirar do áudio**.
- **Simulcast**: quem transmite pelo app envia até 3 versões do vídeo; cada espectador recebe só a que escolheu.
- **Seletor de qualidade** no player — no app, na Activity e no `watch.html`.
- Visual inspirado no Discord, bonito e elegante (ver "Visual").
- Distribuição pelas **Releases do GitHub** com atualização automática.

## Não-objetivos

- macOS e Linux.
- Conectar o bot ao gateway do Discord / mostrar todos os canais de voz e membros (decisão do Iago: só
  canais com alguém ao vivo).
- Microfone, webcam, gravação, chat.
- Áudio por aplicativo na aba do navegador (continua impossível lá).
- Simulcast a partir da aba do navegador (ver "Decisões que tomei").

## Anti-objetivos (falharia mesmo "funcionando")

- O som do Discord (ou do próprio app) vazar para a live e causar retorno.
- Quebrar a Activity, o `watch.html` ou o `present.html` para quem não instalar o app.
- Aumentar o custo de saída do servidor: cada espectador continua recebendo **uma** versão só.
- Visual com cara de template genérico ou destoando do Discord.

## O que o Iago decidiu

| Assunto | Decisão |
|---|---|
| Plataforma | Programa Windows em Electron |
| Funções | Transmitir **e** assistir no app; aba do navegador continua funcionando |
| Qualidade | Quem **assiste** escolhe; feito por **simulcast** (quem transmite envia várias versões) |
| Entrada na chamada | Login com Discord uma vez; app detecta o canal de voz sozinho |
| Layout principal | **Opção A — Clássico Discord** |
| Janela de Transmitir | **Opção 1 — tudo numa janela** |
| Lateral | Mostra **só canais com alguém ao vivo** (bot não fica online no gateway) |
| Distribuição | **GitHub Releases** |

Mockups aprovados: `.superpowers/brainstorm/514-1792427178/content/layout.html` (opção A) e
`transmit-modal.html` (opção 1 + seletor de qualidade do espectador).

## Contexto do código atual (para quem for construir)

- Monorepo npm workspaces: `shared/` (protocolo e constantes), `server/` (Express + `ws`, relay de frames),
  `client/` (Vite; `index.html` = Activity, `present.html` = transmitir no navegador, `watch.html` = assistir
  no navegador).
- Vídeo é codificado no cliente com **WebCodecs** (H.264 preferido) e enviado por WebSocket como frames
  binários (`shared/src/protocol.ts`, cabeçalho fixo de 15 bytes; o byte `flags` só usa o bit 0). O servidor
  só repassa; não transcodifica.
- Uma sala = um canal de voz (`roomId` = id do canal). Várias pessoas podem transmitir na mesma sala (cada
  uma num `slot`); o espectador escolhe uma (`select-stream`).
- O servidor já tem: contagem de espectadores, lista de transmissões ativas (admin vê todas as salas; os
  demais só a sua), encerrar transmissão (admin), alerta "bater na porta" (`play-alert`, som
  `DoorKnock.mp3`), resolução de nomes via token do bot (`server/src/auth/discordNames.ts`) e checagem de
  "pessoa está no canal de voz" via REST (`verifyMember.ts`).
- O bot **não** se conecta ao gateway; só usa a REST API com o token do bot.
- Qualidade hoje: `RESOLUTIONS`/`BITRATE_KBPS`/`buildQualityPreset` em `shared/src/constants.ts`
  (480p/720p/1080p × 30/60 × três níveis).
- **Produção roda no PC do Iago** via `start-bot.bat` + túnel cloudflared (porta 3001), lendo o `.env` da
  raiz do repositório — é lá que entram os segredos novos (chave de assinatura da sessão, redirect do
  OAuth). O `.github/workflows/deploy.yml` (Lightsail) está obsoleto; não contar com ele nem mexer nele
  neste trabalho.
- O código de controle de qualidade de 13/10 (sink-wants, pausa em aba oculta) se perdeu; não há versão a
  recuperar.

## Como funciona

### 1. Estrutura

- Novo workspace **`desktop/`** no monorepo: processo principal do Electron, preload, e renderer em Vite que
  **reaproveita** os módulos de `client/src` (captura, pipelines de encode, playback, `WsClient`, painel de
  transmissões) e `shared/`. Duplicar código do cliente é o que se quer evitar.
- Um **módulo nativo** para o áudio por aplicativo (seção 4).
- Segurança do Electron: `contextIsolation`, `sandbox`, sem `nodeIntegration` no renderer, preload expondo
  uma API mínima e tipada, IPC validado no processo principal, CSP no renderer.

### 2. Login e detecção do canal

- Botão **"Entrar com Discord"** abre o navegador padrão no OAuth2 do Discord (escopos `identify` e
  `guilds`). O retorno chega ao app (redirect de loopback ou protocolo próprio — escolha do construtor; o
  redirect precisa ser cadastrado no Developer Portal).
- A troca do `code` por token acontece **no servidor** (o `client_secret` nunca vai para o app). O servidor
  devolve ao app uma **sessão própria** ligada ao `userId` verificado. O app guarda a sessão com
  `safeStorage` e não pede login de novo.
- Ao entrar numa sala pelo app, o `join` carrega essa sessão, e o servidor usa o `userId` **verificado** em
  vez do que o cliente declara.
- Detecção do canal: endpoint no servidor que, para os servidores em comum entre o usuário e o bot, consulta
  `GET /guilds/{guild}/voice-states/{user}` e devolve o canal atual. O app consulta periodicamente (e ao
  ganhar foco) e reage a mudanças: entrou num canal → mostra; saiu → avisa e, se estiver ao vivo, pergunta se
  quer encerrar. Cuidar do rate limit da API do Discord (cache da lista de servidores do bot, intervalo
  razoável).

### 3. Janela principal (opção A — Clássico Discord)

- Janela sem moldura do Windows, com **barra de título própria** escura (minimizar, maximizar, fechar).
- **Trilho à esquerda**: ícones dos servidores em comum com o bot.
- **Lateral de canais** do servidor selecionado: o **canal em que você está** (sempre, mesmo sem ninguém ao
  vivo) e os canais com **alguém ao vivo** que você pode ver. Abaixo de cada canal, quem está transmitindo,
  com a etiqueta vermelha **AO VIVO**. Regra de visibilidade igual à de hoje: usuário comum vê só o próprio
  canal; admin vê todos.
- **Centro**: a live que você está assistindo, com cabeçalho (canal · quem), contador de espectadores e
  controles sobrepostos: **seletor de qualidade**, volume, tela cheia.
- **Painel do usuário** embaixo à esquerda: avatar, nome, "Em 🔊 canal" e o botão **Transmitir**. Ao vivo,
  vira "Encerrar transmissão" com indicador de upload.
- Estado vazio quando você não está em canal de voz: explicar que é preciso entrar num canal de voz de um
  servidor onde o bot está.

### 4. Janela de Transmitir (opção 1 — tudo numa janela)

- **Esquerda**: abas *Telas* / *Janelas* com miniaturas e ícone do app (via `desktopCapturer`).
- **Direita**:
  - **Qualidade máxima**: 720p · 1080p · 1440p · Fonte; 30 · 60 fps; nível Equilibrada · Alta · Máxima
    (igual ao `present.html` de hoje). Aviso das versões que o pessoal vai poder escolher (ex.: "1080p60,
    720p30 ou 480p30").
  - **Áudio da live**: lista dos apps que têm sessão de áudio no Windows, com ícone, nome, medidor de volume
    e um interruptor para **tirar da live**. O **Discord** (Discord, PTB, Canary) vem **desligado** por
    padrão. O app **lembra** quais apps você tirou (pelo nome do executável). Apps que começam a tocar
    depois aparecem na lista e, se não estiverem excluídos, entram na live sozinhos.
  - O **som do próprio app** fica **sempre fora** da live (não aparece como opção), para não dar eco quando
    você assiste alguém enquanto transmite.
- **Rodapé**: estimativa de upload e **Entrar ao vivo**.

**Áudio por aplicativo — como fazer.** Windows tem captura de loopback **por processo** (WASAPI, ativação
`AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`). Cada captura aceita **um** processo (com sua árvore) em
modo *incluir* ou *excluir*. Como é preciso excluir pelo menos dois (Discord e o próprio app), o caminho é:
enumerar as sessões de áudio (`IAudioSessionManager2` + notificações de sessão nova), abrir uma captura em
modo **incluir** para cada processo permitido, **mixar** em 48 kHz estéreo e entregar ao renderer, que
alimenta o pipeline Opus já existente (`audioEncodePipeline.ts`). Medidores via `IAudioMeterInformation`.
Se a captura por processo não estiver disponível na máquina, cair para o áudio do sistema inteiro **com
aviso claro** na janela.

### 5. Simulcast e qualidade escolhida por quem assiste

- Quem transmite **pelo app** codifica até **3 camadas**: a escolhida (topo) + **720p30** + **480p30**,
  pulando as que forem iguais ou maiores que o topo (topo 720p30 → 720p30 + 480p30). Áudio é um só.
- Adicionar **1440p** e **Fonte** às tabelas de resolução/bitrate em `shared/src/constants.ts`.
- Protocolo: cada frame de vídeo identifica sua camada (o byte `flags` tem bits livres, ou outra forma —
  escolha do construtor, mantendo compatibilidade com quem só envia uma camada). `StreamInfo` anuncia as
  camadas disponíveis de cada transmissão.
- Servidor: cada espectador escolhe uma camada; o relay repassa **só aquela**. Troca de camada espera um
  keyframe da nova (pedir keyframe para aquela camada). Saída do servidor continua "espectadores × uma
  camada".
- Seletor no player: **Automático** (padrão) + camadas disponíveis. O automático desce rápido quando o
  espectador engasga (fila/backpressure/quadros perdidos) e sobe devagar. O seletor aparece igual no app, na
  Activity (`App.ts`) e no `watch.html`; para transmissões com uma camada só, fica escondido ou desabilitado.
- O que existe hoje de controle de qualidade é pouco: `contentHint = "motion"` fixo, descarte de quadros
  quando a fila do encoder enche (`ENCODER_QUEUE_DROP_THRESHOLD`) e backpressure no relay
  (`server/src/ws/backpressure.ts`). Isso continua valendo por camada. **Não existe** sink-wants nem
  suspensão de vídeo em aba oculta no código atual; a escolha de camada pelo espectador + "Automático"
  ocupa o lugar do sink-wants. Parar de codificar uma camada que ninguém está assistindo é uma otimização
  opcional (escolha do construtor).
- **Teto de bitrate por espectador**: a camada do topo segue a mesma lógica de hoje (tabela
  `BITRATE_KBPS` × nível Equilibrada/Alta/Máxima, que continua existindo na janela de Transmitir) e nunca
  passa do máximo atual (**12 Mbps**, o de 1080p60 "Máxima"), mesmo em 1440p/Fonte. As camadas 720p30 e
  480p30 usam o bitrate "Equilibrada". O servidor roda no PC do Iago, então a saída sai pela internet de
  casa dele; quem escolhe camadas menores alivia essa saída.

### 6. Assistir pelo app

- Mesmo player/pipeline do `watch.html`, dentro do layout A. Inclui contador de espectadores, troca entre
  transmissões do canal, e — para admin — encerrar a transmissão de alguém e o painel de todas as
  transmissões.
- Quando alguém usa o "bater na porta" em você enquanto transmite pelo app, o app toca o `DoorKnock.mp3`
  (e mostra notificação do Windows se estiver minimizado).

### 7. Bandeja do Windows

- Ao minimizar/fechar enquanto ao vivo, o app vai para a bandeja (perto do relógio) com ícone indicando
  "ao vivo". Menu: abrir, encerrar transmissão, sair.

### 8. Distribuição e atualização

- Instalador **NSIS** (electron-builder), publicado nas **Releases** de `IagoFreire/share-screen`.
- Atualização automática pelo electron-updater lendo as Releases (repo é público, não precisa token).
- Sem assinatura digital: o Windows mostra o aviso do SmartScreen na primeira instalação ("Mais
  informações" → "Executar assim mesmo"). Documentar isso no README.
- Endereço do servidor: padrão é o de produção (`PUBLIC_ORIGIN`); configurável nas configurações do app
  para desenvolvimento local.

## Visual

- Paleta do Discord escuro: fundos `#1e1f22` / `#2b2d31` / `#313338` / `#383a40`, destaque blurple
  `#5865f2`, verde `#23a55a`, vermelho ao vivo `#f23f43`, texto `#f2f3f5` / `#b5bac1` / `#80848e`.
- Hierarquia e detalhes do Discord: ícones de servidor que viram "squircle" ao passar o mouse/selecionar,
  categorias em caixa alta pequenas, etiqueta AO VIVO vermelha, controles sobrepostos ao vídeo com fundo
  translúcido, interruptores verdes, chips de seleção com borda blurple.
- Estados de hover/foco/ativo desenhados, transições curtas, nada de layout pulando.
- Fonte: Segoe UI Variable (nativa do Windows) — não dá para distribuir a fonte do Discord.
- Os mockups aprovados são a referência de layout; acabamento fica com o construtor.

## Riscos

- **Versão do Windows**: a captura de loopback por processo exige Windows 10 recente/Windows 11; confirmar a
  versão mínima e ter o fallback com aviso.
- **Placa de vídeo**: 3 encoders simultâneos (mais a captura). Placas modernas aguentam; em máquina fraca,
  permitir cair para menos camadas.
- **Upload de quem transmite**: ~9–10 Mbps em 1080p60 com três camadas (hoje ~6). Mostrar a estimativa.
- **Rate limit da API do Discord** na detecção de canal com muitos usuários.
- **SmartScreen** por falta de assinatura.

## Observação de segurança (fora do escopo, mas registrada)

Hoje o `join` confia no `userId` que o cliente declara, inclusive para decidir quem é admin
(`relay.ts`). O app passa a usar identidade verificada (sessão do OAuth). Fechar essa brecha também para a
Activity/navegador é um trabalho separado.

## Deixado para o construtor

- Linguagem do módulo nativo (C++ com node-addon-api ou Rust com napi-rs) — antes, procurar no npm algo
  pronto e mantido para loopback por processo.
- Forma do redirect do OAuth no app; formato da sessão do servidor.
- Como marcar a camada no frame e como anunciar camadas; heurística do "Automático".
- Bitrates de 1440p e "Fonte".
- Pipeline de build/release (ex.: GitHub Action ao criar tag `desktop-v*`).
- Organização dos arquivos do `desktop/` e quanto do `client/` extrair para módulos compartilhados.

## Decisões que tomei (para o Iago conferir)

1. A **aba do navegador continua enviando uma versão só** (sem simulcast); o seletor de qualidade fica
   escondido para essas transmissões. Mantém o `present.html` simples e sem risco.
2. O **som do próprio app sempre fica fora** da live.
3. O app **lembra** os apps excluídos; Discord vem excluído por padrão.
4. **Camadas fixas** 720p30 e 480p30 abaixo da qualidade escolhida.
5. **Automático** é o padrão do seletor de quem assiste.
6. Lateral: usuário comum vê só o próprio canal (mais os ao vivo nele); admin vê todos — mesma regra de hoje.
7. App vai para a **bandeja** quando minimizado ao vivo.
8. Recursos que a Activity já tem (várias lives por canal, contador, bater na porta, admin encerrar) vêm
   junto no app.
9. O nível **Equilibrada/Alta/Máxima** continua na janela de Transmitir; teto de 12 Mbps na camada do topo.
10. Assumi que o código de qualidade de 13/10 **se perdeu** (sem resposta sobre ele); o simulcast + Automático
    ocupa o lugar do sink-wants.
