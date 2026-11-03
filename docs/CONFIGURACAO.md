# Configuração

Toda a configuração fica num único `.env` na **raiz do repositório** (copie `.env.example`).
O servidor carrega esse arquivo pelo caminho absoluto (`server/src/config.ts`), então funciona
mesmo quando o processo roda com `cwd` em `server/`. O Vite lê o mesmo arquivo (`envDir`).

O `.env` está no `.gitignore`. Nunca o publique; se ele vazar (até num print), troque o
client secret, o token do bot, o `SESSION_SECRET` e o token da Cloudflare.

## Variáveis

### Servidor

| Variável | Padrão | Uso |
|---|---|---|
| `PORT` | `3001` | Porta HTTP e WebSocket do relay |
| `PUBLIC_ORIGIN` | `http://localhost:<PORT>` | Endereço público. No modo `direto` é também o endereço do site no Caddy e de onde o DDNS tira o hostname |
| `NODE_ENV` | `development` | `production` no `start-bot.bat` |

### Discord

| Variável | Obrigatória | Uso |
|---|---|---|
| `DISCORD_CLIENT_ID` | Sim | ID do app. O cliente busca em `GET /api/config`, então trocar só exige reiniciar o servidor |
| `DISCORD_CLIENT_SECRET` | Sim | Troca do código OAuth por token (`POST /api/token` e login do Janja). Nunca vai para o navegador |
| `DISCORD_BOT_TOKEN` | Não, mas recomendado | Confere se quem entra numa sala está mesmo no canal de voz, resolve nomes de servidor/canal/usuário nas listas e localiza o canal de voz do usuário do Janja. Sem ele, o Janja não acha canais |
| `ADMIN_USER_IDS` | Não | IDs de usuário do Discord separados por vírgula. Veja [recursos de admin](GUIA-DE-USO.md#recursos-de-admin) |

A verificação de canal de voz **falha aberta**: se o token estiver errado ou o bot sem
permissão, a entrada é permitida e o motivo vai para o log. Só uma resposta 2xx dizendo que
a pessoa está em outro canal recusa a entrada.

### App desktop

| Variável | Padrão | Uso |
|---|---|---|
| `SESSION_SECRET` | vazio | Assina as sessões do Janja (HMAC-SHA256, 30 dias). Mínimo de 32 caracteres. Sem ele o login do Janja responde 503, mas a Activity continua funcionando. Trocar desloga todo mundo |
| `DESKTOP_REDIRECT_URI` | `http://127.0.0.1:53134/callback` | Redirect do OAuth do Janja. Precisa bater com a porta em que o app escuta e com o cadastro no Developer Portal |

Para gerar um segredo:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

### Ajustes do relay

| Variável | Padrão | Uso |
|---|---|---|
| `TARGET_VIDEO_BITRATE_KBPS` | `6000` | Referência de bitrate de vídeo |
| `MAX_CONCURRENT_ROOMS` | `2` | Salas (canais de voz) com gente ao mesmo tempo |
| `MAX_VIEWERS_PER_ROOM` | `10` | Espectadores por sala; o excedente recebe `room-full` |

Os limites existem para manter memória e banda de saída (espectadores x bitrate) sob controle.
As tabelas de bitrate por resolução ficam em `shared/src/constants.ts`.

### Hospedagem em casa

| Variável | Uso |
|---|---|
| `BOT_EXPOSE` | Vazio ou `tunel`: Cloudflare Tunnel. `direto`: Caddy na porta de `PUBLIC_ORIGIN` mais DDNS |
| `CLOUDFLARE_API_TOKEN` | Token com permissão "Edit zone DNS" limitado à zona. Usado pelo DDNS e pelo desafio DNS-01 do Caddy |
| `CLOUDFLARE_ZONE_ID` | ID da zona (página Overview do domínio) |
| `PUBLIC_HOSTNAME` | Opcional: hostname do DDNS quando for diferente do de `PUBLIC_ORIGIN` |

Detalhes em [HOSPEDAGEM.md](HOSPEDAGEM.md).

### Variáveis do Janja (processo do Electron)

| Variável | Uso |
|---|---|
| `SCREENSHARE_SERVER` | Aponta o app para um único servidor, por exemplo `http://localhost:5173` em dev. Sem ela o app tenta `https://share.iagofreire.dev:8443` e depois `https://share.iagofreire.dev` |
| `MINGW_BIN` | Pasta `bin` do MinGW-w64 para compilar o helper de áudio, se não estiver no lugar padrão do WinLibs |

## Discord Developer Portal

1. **Activities**: habilite a Activity do app.
2. **Activities → URL Mappings**: o prefixo `/` aponta para o domínio público do relay (por
   exemplo `share.iagofreire.dev`). A Activity carrega pelo proxy do Discord
   (`<client-id>.discordsays.com`).
3. **OAuth2 → Redirects**: cadastre `https://127.0.0.1` (Activity) e
   `http://127.0.0.1:53134/callback` (Janja).
4. **Bot**: crie o bot, copie o token para `DISCORD_BOT_TOKEN` e adicione o bot aos servidores
   onde as lives vão rodar. Ele não usa gateway; só chama a API REST. Ele precisa ver os canais
   de voz (**View Channels** e **Connect**) para consultar os estados de voz.

Escopos usados: a Activity pede `identify`, `guilds` e `applications.commands`; o Janja pede só
`identify`.

## Cuidados com proxy

Não coloque na frente do relay um proxy que injete `X-Frame-Options: SAMEORIGIN` ou um
`frame-ancestors` conflitante: isso quebra o iframe da Activity. O Caddy terminando o TLS no
próprio domínio, ou o Cloudflare Tunnel, funcionam.
