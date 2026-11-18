<img src="assets/icon.svg" width="64" height="64" alt="">

# Bambu Controller

A small self-hosted web app to monitor and control **Bambu Lab printers in LAN-only mode**:
no cloud, no account, just your printers.

- 🔐 Login with local accounts (scrypt-hashed passwords, HTTP-only session cookies)
- ➕ Add printers by SSDP discovery or manually (IP, serial, access code)
- 📋 Printer list with live status, progress and temperatures
- 📷 Live camera view: JPEG stream (A1 / P1) or RTSPS via ffmpeg (X1 / H2 / P2S)
- 🌡 Nozzle (incl. dual nozzle on H2D), bed and chamber temperatures
- 🌀 Part / aux / chamber fans · 💡 lights · ⚡ speed levels (silent → ludicrous)
- ⏯ Pause / resume / stop · 🕹 jog X/Y/Z, home, extrude / retract
- 🧵 AMS units and trays (color, type, remaining, humidity), load / unload
- ⚠ HMS health alerts with lookup links
- 📁 Storage browser over FTPS: upload, download, delete, start a print from a `.3mf`
- ⌨ G-code console and command log, firmware info, raw status JSON

The protocol details were recovered by reverse engineering the LanBu Android app; see
[docs/PROTOCOL.md](docs/PROTOCOL.md).

## Printer setup

On the printer: **Settings → Network → LAN Only Mode** on (and **Developer Mode** on newer
firmware). Note the **access code**. On X1-series printers also enable **LAN Mode Liveview**
for the camera.

## Running

Requires **Node.js 24+** (TypeScript runs natively, with no build step for the server) and **ffmpeg**
for RTSPS cameras.

```bash
npm install
npm run build      # build the frontend into web/dist
npm start          # http://localhost:8080
```

On first visit you create the admin account.

### Docker

```bash
docker compose up -d --build
```

The compose file uses host networking so SSDP discovery can see the printers. Data (SQLite DB)
lives in `./data`.

### Development

```bash
npm run dev            # API on :8080 (auto-restart) + Vite on :5173
npm run fake-printer   # simulated P1S on 127.0.0.1 (serial 01P00A000000001, code 12345678)
npm run check          # type-check server and frontend
```

### Configuration (environment variables)

| Variable | Default | |
|---|---|---|
| `PORT` / `HOST` | `8080` / `0.0.0.0` | listen address |
| `DATA_DIR` | `./data` | SQLite database location |
| `FFMPEG_PATH` | `ffmpeg` | ffmpeg binary for RTSPS cameras |
| `COOKIE_SECURE` | `false` | set `true` when served over HTTPS |
| `TRUST_PROXY` | `false` | set `true` behind a reverse proxy |
| `SESSION_TTL_DAYS` | `30` | session lifetime |

## Security notes

- Access codes are stored in the SQLite database in plain text (they are needed to talk to
  the printer). Protect the data directory. They are never sent to the browser.
- Printers use self-signed certificates; TLS is used but the certificate is not pinned.
- Every user has full control over every printer. Don't expose the app to the internet
  without a reverse proxy with HTTPS.
