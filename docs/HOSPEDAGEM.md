# Hospedagem em casa (produção atual)

A produção roda num PC de casa com o `start-bot.bat`. O antigo caminho em AWS Lightsail está
em [DEPLOY.md](DEPLOY.md), e o workflow do GitHub Actions (`.github/workflows/deploy.yml`) só
roda manualmente, então um push na `main` não publica nada.

## Atualizar a produção

```powershell
git pull
start-bot.bat
```

O script:

1. Recusa iniciar se a porta 3001 estiver ocupada, se o túnel do bot já estiver rodando, ou se
   o endereço público já responder (o bot está no ar em outro PC).
2. Roda `npm run build`. Se falhar, nada é iniciado.
3. Abre a janela do servidor (`NODE_ENV=production`, `node dist/index.js`, que também serve
   `client/dist`) e a do túnel ou do Caddy.

Nada observa arquivos: editar código não reinicia o servidor nem recarrega a tela de ninguém
no meio da live. Para aplicar uma mudança, feche as janelas do bot e rode o script de novo.
Isso derruba as lives em andamento, porque as salas vivem na memória.

Como o Janja carrega a interface do relay, reiniciar o `start-bot.bat` também atualiza a
interface do app para todos. Mudanças no processo do Electron ou no helper de áudio precisam de
nova versão do app ([APP-DESKTOP.md](APP-DESKTOP.md#publicar-uma-versão)).

## Dois modos de expor o relay

Escolhido por `BOT_EXPOSE` no `.env`.

### `tunel` (padrão): Cloudflare Tunnel

O `cloudflared` conecta o túnel nomeado `screenshare-bot` (config em
`%USERPROFILE%\.cloudflared\screenshare-bot.yml`) e o hostname público aponta para
`localhost:3001`. Não precisa abrir porta no roteador nem ter IP público. A configuração do
túnel está na seção 0 de [DEPLOY.md](DEPLOY.md) (lá o túnel aponta para o Vite do dev; em
produção aponte para `:3001`).

### `direto`: Caddy na porta do endereço

Remove o salto pela Cloudflare. Requisitos:

- IPv4 público (não CGNAT).
- A porta de `PUBLIC_ORIGIN` (por exemplo `https://share.iagofreire.dev:8443`, a primeira que o
  Janja tenta) redirecionada no roteador para este PC, e o `caddy.exe` liberado no firewall.
- Caddy com o plugin da Cloudflare:

  ```powershell
  winget install CaddyServer.Caddy
  caddy add-package github.com/caddy-dns/cloudflare
  ```

- `CLOUDFLARE_API_TOKEN` e `CLOUDFLARE_ZONE_ID` no `.env`.

Nesse modo o `start-bot.bat` roda `node server\dist\ops\ddnsCli.js`, que aponta o hostname para
o IP de casa (registro A, sem proxy da Cloudflare, TTL 60; na primeira vez troca o CNAME do
túnel). Depois sobe o Caddy com `Caddyfile.home`. Sem as portas 80 e 443 abertas, o certificado
Let's Encrypt sai pelo desafio DNS-01, com o mesmo token. Se o IP de casa mudar com frequência,
rode também `node server\dist\ops\ddnsCli.js --watch`, que confere a cada 2 minutos.

Para voltar ao túnel:

```powershell
# no .env: BOT_EXPOSE=tunel
cloudflared tunnel route dns --overwrite-dns screenshare-bot share.iagofreire.dev
```

O Janja funciona nos dois modos: ele tenta `:8443` primeiro e depois o endereço sem porta.

## Problemas comuns

### Dois relays no mesmo endereço

Sintoma: a Activity fica cinza com "Failed to load module script ... MIME type text/html", ou
espectadores não veem uma live que existe.

Causa: o bot está rodando em dois PCs. Duas conexões do mesmo túnel dividem o tráfego, então o
`index.html` vem de um relay e o JavaScript do outro (cujo fallback responde `index.html`). Como
as salas ficam na memória, pessoas também caem em relays diferentes.

O que fazer: feche o bot em um dos PCs. Para confirmar, busque o endereço público umas dez vezes
e compare o `Last-Modified` e o nome do `main-*.js` no `index.html`. O `start-bot.bat` já se
recusa a subir quando o endereço público responde, mas isso não pega um bot iniciado depois.

### Outro programa na porta 8443

O Windows deixa dois processos escutarem na mesma porta, e as conexões podem ir para o outro
programa. Se o certificado mostrado não for o da Let's Encrypt, procure quem mais escuta na
porta (`netstat -ano | findstr :8443`).

### Tela branca na Activity

Proxy injetando `X-Frame-Options` ou `frame-ancestors`, ou o túnel apontando para uma porta
onde nada escuta. Veja [CONFIGURACAO.md](CONFIGURACAO.md#cuidados-com-proxy).

## Banda

A saída é espectadores x bitrate da camada que cada um recebe. Em 1080p60 por espectador:
Equilibrada 6 Mbps, Alta 9 Mbps, Máxima 12 Mbps. O simulcast custa upload ao apresentador
(cerca de 9,7 Mbps em 1080p60 Equilibrada com as três camadas), mas camadas que ninguém assiste
são pausadas. Na prática o limite costuma ser o upload de quem transmite, não o do servidor.
