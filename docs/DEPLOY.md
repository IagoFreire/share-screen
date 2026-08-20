# Deploy: AWS Lightsail (Ubuntu, 1GB RAM)

## 0. Local dev tunnel (Cloudflare, not ngrok)

Discord only loads an Activity over HTTPS, so local development needs a public
tunnel. **Do not use ngrok's free tier**: every video frame of the screen share
travels through the tunnel, so a 1080p60 stream at ~6 Mbps exhausts its ~1 GB/month
allowance in roughly 20 minutes of a single viewer, after which it serves
`ERR_NGROK_725` (a 403 that surfaces in the Activity as a blank white page).
Cloudflare Tunnel has no such bandwidth cap.

One-time setup (already done on the current dev machine):

```bash
winget install --id Cloudflare.cloudflared
cloudflared tunnel login                       # only if ~/.cloudflared/cert.pem is absent
cloudflared tunnel create screenshare-bot
# NOTE: `route dns` reads the `tunnel:` key from ~/.cloudflared/config.yml if one
# exists, which silently points the CNAME at that other tunnel. Always pass an
# explicit --config so the record targets this project's tunnel.
cloudflared tunnel --config ~/.cloudflared/screenshare-bot.yml \
  route dns --overwrite-dns screenshare-bot share.iagofreire.dev
```

`~/.cloudflared/screenshare-bot.yml` (kept separate from any pre-existing
`config.yml` so this project starts/stops without touching other tunnels):

```yaml
tunnel: <tunnel-uuid>
credentials-file: C:\Users\<user>\.cloudflared\<tunnel-uuid>.json

ingress:
  # Vite dev server; it proxies /api and /ws through to the Express relay on :3001.
  - hostname: share.iagofreire.dev
    service: http://localhost:5173
  - service: http_status:404
```

### Starting a dev session (e.g. after a reboot)

Three processes, one terminal each. The DNS record and the Discord URL Mapping are
permanent -- only these need starting:

```powershell
npm run dev:server    # Express + WS relay on :3001
npm run dev:client    # Vite on :5173
cloudflared tunnel --config "$env:USERPROFILE\.cloudflared\screenshare-bot.yml" run screenshare-bot
```

The tunnel points at :5173, so the domain returns a connection error whenever Vite
isn't running.

To have the tunnel start on boot instead, install it as a Windows service from an
**elevated** shell:

```powershell
cloudflared --config "$env:USERPROFILE\.cloudflared\screenshare-bot.yml" service install
```

The tunnel hostname must also be listed in `client/vite.config.ts` under
`server.allowedHosts`, or Vite rejects the forwarded Host header with
"Blocked request". Point the Discord Developer Portal's **URL Mapping** at
`share.iagofreire.dev`; because this is a named tunnel the URL is stable, unlike
ngrok's randomly-generated one.

## Production

Production path is **bare systemd + Caddy, not Docker**. The Docker daemon's own
overhead (typically 100-300MB+ resident) competes with the relay process (~150-250MB
target) for too large a slice of a 1GB total budget. The Dockerfile in this repo is
kept for local dev parity and as a fallback if this ever moves to a larger instance.

## 1. Provision

- Ubuntu 22.04/24.04 LTS, 1GB RAM Lightsail bundle.
- Open ports 80/443 in the Lightsail networking tab firewall, and in `ufw` if enabled
  (`sudo ufw allow 80,443/tcp`).

## 2. Swap file (safety net)

1GB RAM is thin; a swap file is a crash backstop, not for routine use (kept low-priority
via `vm.swappiness` so the relay fails fast under real memory pressure rather than
degrading silently by thrashing disk).

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
sudo sysctl vm.swappiness=10
echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf
```

## 3. Node.js 22 LTS

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # expect v22.x
```

## 4. Deploy the code (GitHub Actions builds; the instance only runs)

The 1GB instance never builds. `vite build` + `tsc` would page into swap and take
minutes; `.github/workflows/deploy.yml` builds on a GitHub runner and rsyncs only the
compiled output (`server/dist`, `shared/dist`, `client/dist` plus the `package.json`
files needed to resolve runtime deps). The instance runs `npm ci --omit=dev`, which
installs only express/ws/dotenv and is cheap.

Prepare the target directory and the deploy user's access:

```bash
sudo useradd --system --home /opt/screenshare-bot --shell /usr/sbin/nologin screenshare
sudo mkdir -p /opt/screenshare-bot
# Deploy user (ubuntu) writes; the service user (screenshare) only reads.
sudo chown -R ubuntu:screenshare /opt/screenshare-bot
sudo chmod 750 /opt/screenshare-bot
```

Create `.env` **on the instance only** — it is gitignored and excluded from the rsync,
so it survives deploys and never reaches GitHub:

```bash
sudo -u ubuntu tee /opt/screenshare-bot/.env >/dev/null <<'EOF'
PORT=3001
PUBLIC_ORIGIN=https://share.iagofreire.dev
NODE_ENV=production
DISCORD_CLIENT_ID=...
DISCORD_CLIENT_SECRET=...
DISCORD_BOT_TOKEN=...
TARGET_VIDEO_BITRATE_KBPS=6000
MAX_CONCURRENT_ROOMS=2
MAX_VIEWERS_PER_ROOM=10
EOF
# Readable by the service user, not by the rest of the box.
sudo chown ubuntu:screenshare /opt/screenshare-bot/.env
sudo chmod 640 /opt/screenshare-bot/.env
```

Let the workflow restart the service without a TTY password prompt:

```bash
echo 'ubuntu ALL=(root) NOPASSWD: /usr/bin/systemctl restart screenshare-bot' \
  | sudo tee /etc/sudoers.d/screenshare-deploy
sudo chmod 440 /etc/sudoers.d/screenshare-deploy
sudo visudo -c   # verify before trusting it
```

The Express server serves the built client bundle directly (`client/dist`), so
there's only one process/port to run.

## 5. systemd service

`/etc/systemd/system/screenshare-bot.service`:

```ini
[Unit]
Description=ScreenShare Bot relay
After=network.target

[Service]
Type=simple
User=screenshare
WorkingDirectory=/opt/screenshare-bot
ExecStart=/usr/bin/node --max-old-space-size=256 server/dist/index.js
Restart=on-failure
RestartSec=3
MemoryMax=400M

[Install]
WantedBy=multi-user.target
```

Deliberately **no** `EnvironmentFile=`: `server/src/config.ts` already loads the repo-root
`.env` through dotenv. Declaring both means two parsers reading the same file with
different quoting rules, and since dotenv does not overwrite variables already present in
the environment, systemd's interpretation would silently win on any value they disagree
about (secrets containing `#` or quotes are the usual casualties).

`--max-old-space-size=256` caps V8's heap; `MemoryMax=400M` is a second, harder
backstop enforced by the systemd cgroup -- if the process somehow still grows past
that, systemd kills and restarts it (`Restart=on-failure`) instead of letting the
kernel OOM-killer pick an arbitrary process on the box.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now screenshare-bot
sudo systemctl status screenshare-bot
```

## 6. Caddy (TLS reverse proxy)

```bash
sudo apt-get install -y caddy   # see caddyserver.com/docs/install for the current repo setup
```

Copy this repo's `Caddyfile` to `/etc/caddy/Caddyfile`, replacing
`your-domain.example.com` with the real domain, then:

```bash
sudo systemctl reload caddy
```

**Do not** put a CDN/proxy (e.g. Cloudflare's orange-cloud proxy) in front unless you've
verified it doesn't inject `X-Frame-Options: SAMEORIGIN` or a conflicting
`frame-ancestors` CSP -- either breaks the Discord Activity iframe embed. Caddy
terminating TLS directly against your own domain is the safest default.

## 7. Point Discord's URL Mapping at the real origin

In the Developer Portal, update the Activity's URL Mapping to point at
`https://your-domain.example.com` (replacing the dev tunnel used in Phase 1).

## 8. Measure real throughput before finalizing bitrate

AWS doesn't publicly document sustained Mbps throughput for the smallest Lightsail
instances (only the ~2TB/month transfer *allowance*, a different number). Measure it
on the live instance and record the result + date below before trusting the
`TARGET_VIDEO_BITRATE_KBPS` default in `.env.example`:

```bash
# Option A: iperf3 against a public iperf3 server
sudo apt-get install -y iperf3
iperf3 -c <public-iperf3-server> -p 5201

# Option B: large-file download/upload test
curl -o /dev/null http://speedtest.tele2.net/1GB.zip
```

**Measured throughput:** _(fill in after running the test)_
**Date measured:** _(fill in)_

If sustained throughput can't comfortably cover `6 Mbps x <expected peak viewers>`,
lower `TARGET_VIDEO_BITRATE_KBPS` in `.env` (e.g. to `4000`) and restart the service.

### Bitrate levels chosen by the presenter

The present page offers a **Qualidade** selector (Equilibrada / Alta / Máxima) that
multiplies the per-resolution bitrate by 1x / 1.5x / 2x. It exists because the default
table targets typical screen content, which is not enough for high-motion game footage
(particle-heavy action especially) — that content degrades visibly at 6 Mbps.

Budget accordingly: the figures above assume **Equilibrada**. At 1080p60, *per viewer*:

| Level | Bitrate | 10-viewer peak egress |
|---|---|---|
| Equilibrada | 6 Mbps | ~61 Mbps |
| Alta | 9 Mbps | ~91 Mbps |
| Máxima | 12 Mbps | ~121 Mbps |

The ~2TB/month allowance drains proportionally faster: roughly 73h/month of continuous
10-viewer streaming at Equilibrada, but only ~37h at Máxima. With the typical 1-3
viewers there is far more headroom, and the presenter's own upload is usually the
binding constraint well before the instance's is.

## 9. Soak test

Real voice channel, real gaming session at 1080p60, 2-3 real viewers, extended
session (30-60 min). Watch for OOM restarts / memory creep:

```bash
watch -n 5 free -m
sudo systemctl status screenshare-bot   # check restart count over the session
```
