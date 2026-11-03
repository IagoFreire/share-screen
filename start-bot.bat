@echo off
rem Production mode: builds once, then runs the relay -- which also serves the built
rem site, so there is no Vite here -- and the tunnel pointed at it (port 3001). Nothing
rem watches files, so editing code can't restart the server or reload anyone's tab
rem mid-live. To ship a code change: close the server window and run this again.
rem For hot-reload development, use start-bot-dev.bat instead.
rem
rem BOT_EXPOSE=direto in .env serves the site straight from this PC instead of through
rem the Cloudflare Tunnel: Caddy serves PUBLIC_ORIGIN's port (the router forwards it
rem here; see Caddyfile.home) with a certificate it gets through Cloudflare DNS, and
rem server/src/ops/ddnsCli.ts points the hostname at this home's IP on every start.
rem Without it, the tunnel is used as before.

cd /d "%~dp0"

set "EXPOSE=tunel"
if exist .env for /f "usebackq tokens=1,* delims==" %%a in (`findstr /b /c:"BOT_EXPOSE=" .env`) do set "EXPOSE=%%b"
if /i "%EXPOSE%"=="direto" (
  where caddy >nul 2>&1
  if errorlevel 1 (
    echo BOT_EXPOSE=direto precisa do Caddy. Instale com: winget install CaddyServer.Caddy
    echo Depois feche esta janela, abra outra e rode de novo.
    pause
    exit /b 1
  )
  caddy list-modules | findstr /c:"dns.providers.cloudflare" >nul
  if errorlevel 1 (
    echo O Caddy instalado nao tem o plugin do Cloudflare, que tira o certificado pelo DNS.
    echo Rode uma vez: caddy add-package github.com/caddy-dns/cloudflare
    pause
    exit /b 1
  )
  tasklist /fi "imagename eq caddy.exe" | find /i "caddy.exe" >nul
  if not errorlevel 1 (
    echo O Caddy ja esta rodando em outra janela. Feche as janelas antigas do bot e rode de novo.
    pause
    exit /b 1
  )
)

rem Either one still running means the old bot windows are open. The server would fail
rem on the busy port, and two cloudflared instances of the same tunnel would split the
rem traffic between the old and the new origin -- random failures for everyone.
netstat -ano | findstr /R /C:":3001 .*LISTENING" >nul
if not errorlevel 1 (
  echo A porta 3001 ja esta em uso. Feche as janelas antigas do bot e rode de novo.
  pause
  exit /b 1
)
powershell -NoProfile -Command "if (Get-CimInstance Win32_Process -Filter 'Name=''cloudflared.exe''' | Where-Object { $_.CommandLine -like '*screenshare-bot*' }) { exit 1 }"
if errorlevel 1 (
  echo O tunel do bot ja esta rodando em outra janela. Feche as janelas antigas do bot e rode de novo.
  pause
  exit /b 1
)
rem The same split happens when the bot is still up on another PC: the tunnel is the same
rem everywhere, and nothing on this machine shows it. So ask the public address whether a
rem bot already answers there. Any failure to ask (no internet, tunnel down) lets it start.
powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072; $cfg = Join-Path $env:USERPROFILE '.cloudflared\screenshare-bot.yml'; if (-not (Test-Path $cfg)) { exit 0 }; $m = Select-String -Path $cfg -Pattern 'hostname:\s*(\S+)' | Select-Object -First 1; if (-not $m) { exit 0 }; $url = 'https://' + $m.Matches[0].Groups[1].Value.Trim([char]34, [char]39) + '/'; try { if ((Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 10).StatusCode -eq 200) { exit 1 } } catch { }; exit 0"
if errorlevel 1 (
  echo O bot ja esta no ar em outro computador: o endereco publico respondeu. Feche as janelas do bot la e rode de novo.
  pause
  exit /b 1
)

echo Compilando a versao de producao...
call npm run build
if errorlevel 1 (
  echo.
  echo A compilacao falhou, veja os erros acima. Nada foi iniciado.
  pause
  exit /b 1
)

if /i "%EXPOSE%"=="direto" goto direct

start "ScreenShare - server" cmd /k "set NODE_ENV=production&& npm start --workspace=server"
start "ScreenShare - tunnel" cmd /k "cloudflared tunnel --config %USERPROFILE%\.cloudflared\screenshare-bot.yml run screenshare-bot"
exit /b 0

:direct
rem The hostname must point here before Caddy asks Let's Encrypt for the certificate.
echo Apontando o endereco publico para este PC...
node server\dist\ops\ddnsCli.js
if errorlevel 1 (
  echo.
  echo Nao foi possivel atualizar o DNS, veja o erro acima. Nada foi iniciado.
  pause
  exit /b 1
)
start "ScreenShare - server" cmd /k "set NODE_ENV=production&& npm start --workspace=server"
start "ScreenShare - caddy" cmd /k "caddy run --config Caddyfile.home --adapter caddyfile --envfile .env"
rem The home IP is fixed, so the start-up update above is enough. On a changing IP, also run
rem "node server\dist\ops\ddnsCli.js --watch", which follows it every 2 minutes.
