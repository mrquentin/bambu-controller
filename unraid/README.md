# Bambu Controller – Unraid template

Unraid Community Applications template for **[Bambu Controller](https://github.com/mrquentin/bambu-controller)**:
a self-hosted web app to monitor and control Bambu Lab 3D printers in LAN Only Mode (no cloud, no account).

| | |
|---|---|
| Template | [`bambu-controller.xml`](bambu-controller.xml) |
| Image | `ghcr.io/mrquentin/bambu-controller:latest` (amd64 + arm64) |
| Network | `host` (needed for SSDP printer discovery on UDP 2021/1990) |
| Web UI | `http://[server]:8080/` |
| Support | [GitHub Issues](https://github.com/mrquentin/bambu-controller/issues) |

## Installation

**From Community Applications:** search for *Bambu Controller* in the **Apps** tab and click **Install**.

**Manually** (before the template is listed in CA, or to test changes):

1. *Docker* tab → **Add Container**.
2. In **Template**, paste
   `https://raw.githubusercontent.com/mrquentin/bambu-controller/main/unraid/bambu-controller.xml`
   — or add `https://github.com/mrquentin/bambu-controller` under *Docker → Template repositories*
   and pick *bambu-controller* from the list.
3. Set **APP_SECRET** (see below) and click **Apply**.

Before the first start, if `/mnt/user/appdata/bambu-controller` already exists with another owner:

```sh
chown -R 99:100 /mnt/user/appdata/bambu-controller
```

On each printer, enable **LAN Only Mode** (plus **Developer Mode** on recent firmware; on X1-series
printers also **LAN Mode Liveview**). Open the web UI, create the first account and add the printers —
they are discovered automatically.

## Configuration

| Name | Type | Target | Default | Shown | Description |
|---|---|---|---|---|---|
| Appdata | Path | `/data` | `/mnt/user/appdata/bambu-controller` | always | Database (accounts, printers, audit log). Must be writable by `99:100`. |
| APP_SECRET | Variable (masked) | `APP_SECRET` | — (**required**) | always | Encrypts printer access codes at rest. 16+ chars, e.g. `openssl rand -base64 32`. **Keep a copy.** |
| Web UI port | Variable | `PORT` | `8080` | always | Listening port (host networking — change it here if 8080 is taken). |
| Secure cookies (HTTPS) | Variable | `COOKIE_SECURE` | `false` | advanced | `true` when served over HTTPS via a reverse proxy. Enables Secure cookies and HSTS. |
| Trust reverse proxy | Variable | `TRUST_PROXY` | `false` | advanced | `true` behind a reverse proxy so rate limiting / audit log see real client IPs. |
| Session idle timeout (hours) | Variable | `SESSION_IDLE_HOURS` | `72` | advanced | Sign out sessions unused for this long. |
| Session lifetime (days) | Variable | `SESSION_TTL_DAYS` | `30` | advanced | Maximum session lifetime. |
| Allow printers outside the LAN | Variable | `ALLOW_PUBLIC_PRINTER_HOSTS` | `false` | advanced | Allow non-private printer addresses (e.g. routed VPN). |
| Push notification contact | Variable | `VAPID_SUBJECT` | project URL | advanced | `mailto:` or `https:` contact for browser push services. |
| Audit log retention (days) | Variable | `AUDIT_RETENTION_DAYS` | `90` | advanced | How long security events are kept. |
| Log level | Variable | `LOG_LEVEL` | `info` | advanced | `info`, `warn`, `error` or `debug`. |

The template also applies container hardening through *Extra Parameters*:
`--user 99:100 --read-only --tmpfs /tmp:size=64m --cap-drop=ALL --security-opt no-new-privileges:true --pids-limit 256 --memory 1g`.

## Support

- Bugs and questions: <https://github.com/mrquentin/bambu-controller/issues>
- Project and full documentation: <https://github.com/mrquentin/bambu-controller#readme>
- Security issues: report privately to the maintainer, not in public issues.

## License

[MIT](../LICENSE) © 2026 MrQuentinet
