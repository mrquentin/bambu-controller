# Security Review — Bambu Controller

Date: 2026-11-18 | Reviewer: Claude (automated audit + fixes) — **pending human sign-off**
Scope: full repository (server, web UI, Docker image, CI), deployment as a self-hosted LAN app.
Method: security-hardening checklist (secrets, dependencies, code, auth, data protection, scanning,
infrastructure, monitoring, incident response), verified against a real Bambu Lab X1C on the LAN.

## Threat model (summary)

- **Assets:** printer access codes (full control of the printers), user accounts, physical safety
  (heaters, motion), print files and timelapses.
- **Actors:** other devices/users on the LAN; anyone who can reach the web UI if it is exposed
  beyond the LAN; malicious packages in the supply chain.
- **Trust boundaries:** browser ↔ app (HTTP/HTTPS), app ↔ printers (MQTT/FTPS/RTSPS/TLS socket),
  app ↔ host (data volume, ffmpeg child process).

## Vulnerabilities found

| ID | Severity | Description | Location |
|----|----------|-------------|----------|
| V1 | High | `@fastify/static` < 9: path traversal / route-guard bypass (4 advisories) | dependency |
| V2 | High | `basic-ftp` < 6: listing-parser DoS, crashes on malformed responses | dependency |
| V3 | High | Printer TLS certificates were not verified (`rejectUnauthorized: false`) → a LAN attacker could impersonate a printer and capture its access code | `server/bambu/*` |
| V4 | Medium | Printer access codes stored in plain text in SQLite | `server/db.ts` |
| V5 | Medium | No Content-Security-Policy; streaming responses (SSE, camera, video) bypassed the security headers | `server/index.ts` |
| V6 | Medium | Rate limiting only on login; no per-account lockout | `server/routes/auth.ts` |
| V7 | Medium | Weak password policy (8 chars, no complexity) | `server/routes/auth.ts` |
| V8 | Medium | Printer host could be any address → SSRF / internal port probing via the app | `server/routes/printers.ts` |
| V9 | Medium | Upload accepted any file type/name; partial uploads left on the printer | `server/routes/printers.ts` |
| V10 | Low | First-run setup race (two concurrent requests could create two admins) | `server/routes/auth.ts` |
| V11 | Low | 5xx errors returned internal error messages | `server/index.ts` |
| V12 | Low | Sessions had no idle timeout and could not be listed/revoked | `server/auth.ts` |
| V13 | Low | No security audit trail | — |
| V14 | Low | Container: unpinned base image, no healthcheck, writable root FS, npm/yarn shipped at runtime | `Dockerfile`, compose |
| V15 | Low | Semgrep: AES-GCM decipher without explicit auth-tag length | `server/secrets.ts` |
| V16 | Low | Supply chain: no CI, no Dependabot, mutable action tags, no release-age delay | repo |
| V17 | Low | Invalid file paths returned 500/502 instead of 400 | `server/bambu/ftps.ts` |

## Vulnerabilities fixed

| ID | Fix applied | Verified |
|----|-------------|----------|
| V1, V2 | Upgraded to `@fastify/static@10.1.11`, `basic-ftp@6.2.6` (+ `@fastify/multipart@10.1.9`); all deps pinned to exact versions | `npm audit`: 0 vulnerabilities |
| V3 | All four TLS clients (MQTT, FTPS, camera socket, ffmpeg RTSPS) verify the chain against the Bambu "BBL CA" (extracted from LanBu, valid to 2032) and require certificate CN = printer serial. Per-printer opt-out for models with a different CA (default on) | Real X1C connects on all services; wrong serial → "Printer certificate is for … expected …" |
| V4 | AES-256-GCM encryption at rest (`APP_SECRET` or generated `data/secret.key`, 0600); existing rows migrated automatically | DB shows `enc:v1:…`; printer still connects after restart |
| V5 | Strict CSP (`script-src 'self'`, no inline scripts, `frame-ancestors 'none'`, …), COOP/CORP, Permissions-Policy, no-referrer, HSTS when HTTPS; headers set on the raw response so streams get them; `Cache-Control: no-store` on API | Headers present on `/`, API and media stream responses |
| V6 | Global API rate limit (600/min/IP), 10/min on credential endpoints; per-IP exponential lockout + per-account lockout (5 failures → 15 min), tracked for unknown names too (no user enumeration) | 6th attempt → 429 even with the right password |
| V7 | ≥10 chars with 3 of 4 classes or a 16+ char passphrase; common passwords and username-containing passwords rejected | Policy cases tested |
| V8 | Printer hosts must resolve to private/loopback/link-local/CGNAT ranges (`ALLOW_PUBLIC_PRINTER_HOSTS=true` to override) | `8.8.8.8` rejected |
| V9 | Only `.3mf` / `.gcode`; filenames normalized (no separators/control chars/leading dot, ≤200 chars); partial files deleted on failure; safe `Content-Disposition` | `.html` upload rejected |
| V10 | Conditional `INSERT … WHERE NOT EXISTS` | Code review |
| V11 | Error handler returns "Internal server error" for 5xx, details only in logs; cookies/authorization redacted from logs | Code review |
| V12 | Idle timeout (72 h, sliding) + absolute 30 days; Settings lists sessions with revoke / "sign out others"; password change rotates the token and signs out all other sessions | Session list verified |
| V13 | `audit_log` table (90-day retention) + structured log mirror: logins/failures/lockouts, setup, password changes, users, printers, commands (incl. G-code), uploads/deletes/downloads, print starts; Settings → Security log | Entries verified |
| V14 | Base image pinned by version + digest, `apk upgrade`, npm/yarn/corepack removed, non-root, `HEALTHCHECK`; compose: `read_only`, `cap_drop: ALL`, `no-new-privileges`, pids/mem limits, `APP_SECRET` required | Container healthy, uid 1000, CapEff 0, root FS read-only |
| V15 | `authTagLength: 16` on cipher and decipher | Existing ciphertext still decrypts |
| V16 | GitHub Actions CI (audit, type check, build, SBOM, gitleaks, Trivy) with SHA-pinned actions and least-privilege permissions; Dependabot (npm, Docker, Actions) with 7-day cooldown; `.npmrc` `min-release-age=7`, `save-exact` | Semgrep re-check |
| V17 | Path validation errors carry status 400 | `/../etc` → 400 |

## Accepted risks

| Risk | Justification | Mitigations | Review date |
|------|---------------|-------------|-------------|
| All users are administrators (no RBAC) | Small household/workshop tool; every user is trusted to operate printers | Audit log of every action; per-user sessions revocable | 2027-05-18 |
| No MFA | LAN-only deployment; adds a dependency and recovery flow | Strong password policy, lockout, rate limits; put a reverse proxy with SSO/MFA in front if exposed | 2027-05-18 |
| Plain HTTP by default | LAN appliance; certificates are deployment-specific | Built-in HTTPS (`TLS_CERT_FILE`/`TLS_KEY_FILE`) or reverse proxy; startup warning; `COOKIE_SECURE` + HSTS when enabled | 2027-05-18 |
| Raw G-code console | Intended power-user feature; equivalent to physical control | Authenticated, CSRF-protected, every command audited | 2027-05-18 |
| Per-printer "verify certificate" opt-out | Some models may use a CA other than "BBL CA" | Default on; opt-out is explicit and audited; `PRINTER_EXTRA_CA_FILE` to add CAs instead | 2027-05-18 |
| Access code visible in ffmpeg's command line (`ps`) on the host | ffmpeg has no other way to receive RTSP credentials | Runs as non-root in an isolated container; only local host users could see it | 2027-05-18 |
| `secret.key` stored next to the DB when `APP_SECRET` is unset | Zero-config local installs | Docker compose requires `APP_SECRET` (kept outside the volume) | 2027-05-18 |
| Account lockout can be triggered by others (DoS) | Standard trade-off of lockout | 15-min window, IP-based throttling first, lockouts audited | 2027-05-18 |
| Semgrep `insecure-object-assign` in `scripts/fake-printer.ts` | Dev-only simulator, not in the Docker image | — | — |
| Encryption at rest of the DB file as a whole | Only the secret (access codes) is sensitive; usernames/hashes are low value | Owner-only file permissions, `secure_delete` | 2027-05-18 |

## Tools run

| Tool | Result | Date |
|------|--------|------|
| gitleaks 8.x (git history + working tree) | No leaks (only the simulator's dummy code `12345678`) | 2026-11-18 |
| grep secret patterns (`sk-`, `AKIA`, `ghp_`, private keys, passwords) | Clean | 2026-11-18 |
| npm audit | 4 (2 high) → **0** after upgrades | 2026-11-18 |
| npm sbom (CycloneDX 1.5) | 95 components | 2026-11-18 |
| semgrep `--config=auto` | 13 findings → 9 fixed, 4 accepted (see above) | 2026-11-18 |
| trivy image (Alpine 3.24.4 + node_modules) | 0 critical / high / medium | 2026-11-18 |
| trivy config (Dockerfile) | 0 misconfigurations | 2026-11-18 |
| Live tests against X1C | MQTT, FTPS, camera, RTSPS with cert verification; negative tests for cert mismatch, SSRF, upload type, path traversal, lockout, rate limit | 2026-11-18 |

## Deployment readiness

- [x] All critical/high resolved
- [x] All scans clean (remaining findings accepted above)
- [x] Secrets audit passed
- [x] Auth audit passed
- [x] Monitoring configured (audit log + structured logs; see below)
- [ ] **Human sign-off:** reviewer has verified the fixes and accepts the residual risks above
  — Name: ________________ Date: ____________

## Monitoring

The app writes JSON logs (pino) to stdout. Security events are logged with an `audit` object
(`level 30` success, `level 40` failure/blocked) and stored in the `audit_log` table
(Settings → Security log). Suggested alerts if you ship logs to a collector (Loki/Grafana, etc.):

| Signal | Query idea | Threshold |
|--------|-----------|-----------|
| Brute force | `audit.action="auth.login" and audit.outcome!="success"` | > 10 / 5 min |
| Lockouts | `audit.detail.lockout=true` or `outcome="blocked"` | any |
| Rate limiting | `msg="rate limit exceeded"` | > 5 / 5 min |
| Account changes | `audit.action=~"user\\..*|auth.password_change"` | any (notify) |
| Printer config | `audit.action=~"printer\\.(add|update|delete)"` | any (notify) |
| Server errors | `level>=50` | > 5 / 5 min |
| Container health | Docker health status `unhealthy` | any |

## Incident response (runbook)

1. **Detect** — alert or suspicious entry in Settings → Security log (unknown IP, logins at odd
   hours, unexpected G-code or print starts).
2. **Contain** — Settings → Active sessions → *Sign out other sessions*; delete unknown users;
   stop the container if the printer is being driven (`docker compose stop`). Power off / pause
   the printer if it is moving or heating unexpectedly.
3. **Eradicate** — change all account passwords. **Rotate printer access codes**: toggle LAN Only
   Mode off/on on the printer (generates a new code), then update it in *Edit printer*. If the
   database or `APP_SECRET` leaked, rotate `APP_SECRET` too (re-enter access codes afterwards).
4. **Recover** — update the image (`docker compose build --pull`), review the audit log for the
   whole window, restore `data/` from a backup if it was tampered with.
5. **Post-incident** — record timeline and root cause, add missing alerts, re-run this review.

Backups: the whole state is the `data/` directory (SQLite DB + `secret.key` when `APP_SECRET`
is unset). Back it up while the app is stopped, or use `sqlite3 .backup`; keep `APP_SECRET`
separately — the DB is useless without it.
