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
- 📊 Print history and statistics per printer and overall: every job with its outcome,
  duration (pauses excluded) and layers; success rate and total print time
- ⌨ G-code console and command log, firmware info, raw status JSON
- 🔔 Push notifications (browser / installed app) when a print finishes, fails, pauses or raises an HMS alert

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

### Notifications

Settings → **Notifications** → *Enable on this device* turns on push notifications for that
browser or installed app, with per-event toggles (print finished, failed/cancelled, paused /
needs attention, HMS alerts, started) and a test button. Requirements:

- **HTTPS** (or `localhost`): browsers only allow push in a secure context. Use
  `TLS_CERT_FILE`/`TLS_KEY_FILE` or a reverse proxy with a valid certificate.
- **Outbound internet** from the server: notifications are delivered through the browser
  vendor's push service (Google FCM, Mozilla, Apple, Microsoft). Payloads are end-to-end
  encrypted; the push service only sees ciphertext. No third-party account is needed.
- **iPhone / iPad** (iOS 16.4+): add the app to the home screen first (Share → *Add to Home
  Screen*) and enable notifications from the installed app.

The server's VAPID key pair is generated on first use and stored encrypted in `data/vapid.key`.

### Docker

Images are published to the GitHub Container Registry for `linux/amd64` and `linux/arm64`:

```bash
echo "APP_SECRET=$(openssl rand -base64 32)" > .env   # encrypts printer access codes
docker compose up -d                                  # pulls ghcr.io/mrquentin/bambu-controller
```

Verify an image was built by this repository's release pipeline:

```bash
gh attestation verify oci://ghcr.io/mrquentin/bambu-controller:latest --repo mrquentin/bambu-controller
```

The compose file uses host networking so SSDP discovery can see the printers, and runs the
container hardened (read-only root filesystem, no capabilities, non-root user). Data (SQLite DB)
lives in `./data`; keep `.env` (the encryption key) outside of your backups of `./data`.

### Unraid

A Docker template is provided in [`unraid/bambu-controller.xml`](unraid/bambu-controller.xml).
In Unraid: **Docker → Add Container → Template:** paste the template URL
`https://raw.githubusercontent.com/mrquentin/bambu-controller/main/unraid/bambu-controller.xml`
(or add `https://github.com/mrquentin/bambu-controller` under *Docker → Template repositories*).

- Set **APP_SECRET** (e.g. `openssl rand -base64 32`) and keep a copy.
- The container runs hardened as `nobody:users` (99:100) with host networking (for discovery).
  If the appdata folder was created with another owner, fix it once:
  `chown -R 99:100 /mnt/user/appdata/bambu-controller` (the container log says so if needed).


```bash
npm run dev            # API on :8080 (auto-restart) + Vite on :5173
npm run fake-printer   # simulated P1S on 127.0.0.1 (serial 01P00A000000001, code 12345678);
                       # queues demo prints by itself (FAKE_AUTO_PRINT=0 to disable)
npm test               # unit + API tests
npm run check          # type-check server and frontend
```

### Contributing & releases

`main` is protected: every change goes through a pull request that must pass CI (tests, type
checks, build, dependency review, secret scan, image scan, CodeQL). PRs are squash-merged and
the **PR title must follow [Conventional Commits](https://www.conventionalcommits.org)** — it
becomes the commit on `main` and decides the next version:

| PR title | Release |
|---|---|
| `fix: …`, `perf: …`, `refactor: …`, `deps: …` | patch (`0.2.0 → 0.2.1`) |
| `feat: …` | minor (`0.2.1 → 0.3.0`) |
| `feat!: …` or `BREAKING CHANGE:` in the body | major |
| `docs:`, `test:`, `ci:`, `chore:`, `style:` | no release |

On merge, the release pipeline re-runs CI, lets semantic-release tag `vX.Y.Z` and publish the
GitHub Release, then builds, scans, pushes and attests the image. Repository policies
(rulesets, merge settings, Actions restrictions) are kept in
[`scripts/apply-repo-policies.sh`](scripts/apply-repo-policies.sh).

### Configuration (environment variables)

| Variable | Default | |
|---|---|---|
| `PORT` / `HOST` | `8080` / `0.0.0.0` | listen address |
| `DATA_DIR` | `./data` | SQLite database location |
| `APP_SECRET` | *(generated `data/secret.key`)* | key for encrypting printer access codes at rest (16+ chars) |
| `TLS_CERT_FILE` / `TLS_KEY_FILE` | — | serve HTTPS directly (enables secure cookies + HSTS) |
| `COOKIE_SECURE` | `false` | set `true` when HTTPS is terminated by a reverse proxy |
| `TRUST_PROXY` | `false` | set `true` behind a reverse proxy (correct client IPs) |
| `SESSION_TTL_DAYS` / `SESSION_IDLE_HOURS` | `30` / `72` | absolute / idle session lifetime |
| `RATE_LIMIT_PER_MINUTE` | `600` | API requests per minute per IP |
| `ALLOW_PUBLIC_PRINTER_HOSTS` | `false` | allow printer addresses outside private/LAN ranges |
| `PRINTER_EXTRA_CA_FILE` | — | extra CA (PEM) for printers not signed by the Bambu CA |
| `AUDIT_RETENTION_DAYS` | `90` | how long the security log is kept |
| `FFMPEG_PATH` | `ffmpeg` | ffmpeg binary for RTSPS cameras / AVI playback |
| `VAPID_SUBJECT` | `https://github.com/mrquentin/bambu-controller` | contact sent to browser push services (`mailto:you@example.com` or an `https:` URL) |

## Security

The app was hardened and reviewed; see [docs/SECURITY_REVIEW.md](docs/SECURITY_REVIEW.md)
for findings, fixes, accepted risks, monitoring and the incident-response runbook. Highlights:

- Printer connections verify the printer's certificate against Bambu Lab's CA and its serial
  number (can be disabled per printer for models with a different CA).
- Access codes are encrypted at rest (AES-256-GCM) and never sent to the browser.
- Strict CSP and security headers, CSRF protection, rate limiting, account lockout, password
  policy, idle session timeout, session revocation and a security audit log (Settings).
- Printer addresses are restricted to the local network; uploads are limited to `.3mf`/`.gcode`.
- Every user has full control over every printer. Don't expose the app to the internet
  without HTTPS (and ideally a reverse proxy with SSO/MFA in front).

Report security issues privately to the maintainer rather than in public issues.
