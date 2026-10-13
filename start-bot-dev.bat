@echo off
rem Development mode: relay with auto-restart, Vite with hot reload, and the tunnel
rem pointed at Vite. Saving a file restarts the server or reloads open tabs, which
rem ends every live in progress -- use start-bot.bat when people are actually streaming.
rem Each one gets its own window; close a window to stop that process.

cd /d "%~dp0"

start "ScreenShare - server (dev)" cmd /k "npm run dev:server"
start "ScreenShare - client (dev)" cmd /k "npm run dev:client"
start "ScreenShare - tunnel (dev)" cmd /k "cloudflared tunnel --config %USERPROFILE%\.cloudflared\screenshare-bot-dev.yml run screenshare-bot"
