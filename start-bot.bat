@echo off
rem Production mode: builds once, then runs the relay -- which also serves the built
rem site, so there is no Vite here -- and the tunnel pointed at it (port 3001). Nothing
rem watches files, so editing code can't restart the server or reload anyone's tab
rem mid-live. To ship a code change: close the server window and run this again.
rem For hot-reload development, use start-bot-dev.bat instead.

cd /d "%~dp0"

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

echo Compilando a versao de producao...
call npm run build
if errorlevel 1 (
  echo.
  echo A compilacao falhou, veja os erros acima. Nada foi iniciado.
  pause
  exit /b 1
)

start "ScreenShare - server" cmd /k "set NODE_ENV=production&& npm start --workspace=server"
start "ScreenShare - tunnel" cmd /k "cloudflared tunnel --config %USERPROFILE%\.cloudflared\screenshare-bot.yml run screenshare-bot"
