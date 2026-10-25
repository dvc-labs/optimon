# Optimon

[![CI](https://github.com/dvc-labs/optimon/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/dvc-labs/optimon/actions/workflows/ci.yml)
[![Version](https://img.shields.io/github/package-json/v/dvc-labs/optimon)](package.json)
[![License: MIT](https://img.shields.io/github/license/dvc-labs/optimon)](LICENSE)
[![Node.js 24.x](https://img.shields.io/badge/node.js-24.x-339933?logo=nodedotjs&logoColor=white)](package.json)
[![discord.js](https://img.shields.io/github/package-json/dependency-version/dvc-labs/optimon/discord.js?logo=discord&logoColor=white)](https://discord.js.org)
[![TypeScript](https://img.shields.io/github/package-json/dependency-version/dvc-labs/optimon/dev/typescript?logo=typescript&logoColor=white)](https://www.typescriptlang.org)

A Discord companion and public web dashboard for the optiplex home lab. **Version 0.3.1.**

**A note on names.** The project is called Optimon (it was Optiplex up to v0.3.0). `optiplex` is
the Dell OptiPlex machine it watches, so the host name, the `optiplex` Compose service, the
`optiplex.sqlite` database and backup files and the `/etc/optiplex-dashboard/tls` host path keep
that name. Renaming them would point a running deployment at a volume, database or certificate
directory that does not exist.

- One embed when the bot connects, then host snapshots every **30 minutes**.
- Live CPU, RAM, **swap**, uptime, load averages and Intel CPU temperatures.
- **All metric history retained on disk**, comparisons, Discord latency checks and a playful server mood.
- A live Discord activity showing temperature, CPU and RAM use.
- Sustained-temperature warnings and recovery notices in the reporting channel.
- Optional owner controls with private replies. All embeds share the release footer.
- Responsive dashboard with live readings, 1h–365d/all-time charts and social previews.
- The public container reads only a metrics export, with no Discord secrets or private database.
- Optional same-address VPS fallback when the home server is off; see [deployment steps](FALLBACK.md).

## Commands

| Command | What it does |
| --- | --- |
| `/about` | Bot version, features and reporting schedule. |
| `/stats` | Host snapshot, including swap usage. |
| `/uptime` | Host/bot uptimes and estimated boot/start times. |
| `/history hours:1` | CPU, RAM and temperature trends: 1h, 6h, 24h, 7d, 30d or 365d. |
| `/compare hours:24` | Compare averages and recorded coverage with the preceding window. |
| `/ping` | Discord heartbeat and API acknowledgement latency. |
| `/vibe` | The tiny Dell's current mood, based on actual readings. |
| `/help` | A command and sampling guide. |
| `/diagnostics` | Private bot RAM/heap usage, snapshot freshness and reporting status. |
| `/snapshot` | Post a snapshot to the configured reporting channel now. |
| `/pause minutes:60` | Pause scheduled reports for 5–1440 minutes; default `60`. |
| `/resume` | Resume reports at the next normal reporting tick. |
| `/audit limit:10` | Owner-only execution times, user IDs and outcomes; up to 20 records. |

## Setup

Set **Coolify runtime environment variables** before reloading Compose. The token and
all three public IDs are required explicitly; the Compose file has no personal ID defaults:

| Variable | Purpose |
| --- | --- |
| `DISCORD_TOKEN` | Required bot token from Developer Portal → Bot. Secret. |
| `APPLICATION_ID` | Required application ID. `CLIENT_ID` may be a matching alias. |
| `GUILD_ID` | Discord server ID for command registration and report delivery. |
| `CHANNEL_ID` | Reporting channel ID within that server. |
| `ADMIN_ID` | Optional **Discord user ID** allowed to use owner controls; blank disables them. |
| `AUDIT_RETENTION_DAYS` | Command records expire after `90` days; `0` keeps them indefinitely. |
| `HOST_NAME` | Display name; defaults to `optiplex`. |
| `STATS_INTERVAL_MINUTES` | Defaults to `30`; allowed range `1`–`1440`. |
| `THERMAL_ALERTS_ENABLED` | `true` by default; set `false` to disable thermal notices. |
| `HEARTBEAT_URL` | Optional secret HTTPS ping URL; blank disables external monitoring. |

## Sampling and alerts

Background samples run about once a minute. Interactive commands share a snapshot
cache of up to **15 seconds** and do not add extra history samples. History stores
**every background sample**, committed immediately and restored after restarts.
History queries run in a read-only worker with a **60-second result cache**; the
bot keeps no separate RAM history. A **10-second query deadline** retires a stuck
worker and permits a replacement on the next request. Queries show min/average/peak readings and
24 time buckets. Gaps stay visible; graphs use a fixed 0–100 scale and temperatures
above 100 °C saturate the graph while their exact values remain in the summary.
These are periodic samples, not continuous measurements or interval averages.

## Persistent history

The existing **local Docker volume** `history-data` stores `/app/data/optiplex.sqlite`.
SQLite WAL mode, full synchronous commits and a **250 ms busy timeout** support
concurrent readers without rewriting the whole archive every minute. Do not put
this database on NFS, SMB or another network filesystem. Run one bot instance per volume.

Command audit rows expire after **90 days** by default, checked at startup and
about hourly; background cleanup failures retry after 15 minutes. The writer
enables secure deletion for future pruning. Set `AUDIT_RETENTION_DAYS=0` before upgrading to retain them indefinitely.
Metrics remain indefinite. The legacy JSON reader stays available for skipped upgrades.

## Backups and recovery

In the bot container terminal, run `npm run backup` before R2/volume backups. It
validates the snapshot and keeps `optiplex.backup.sqlite` plus one verified previous
generation. Check a file with `npm run backup -- --verify /app/data/optiplex.backup.sqlite`.

> [!NOTE]
> See [backup and restore instructions](BACKUPS.md), including stopping the bot and
removing stale live WAL/SHM files safely before a restore. Same-volume copies do
not protect against SSD failure. Older R2 backups keep audit IDs until they expire.

## External outage monitoring

Optionally set `HEARTBEAT_URL` to a Healthchecks.io check or an Uptime Kuma push
monitor hosted **outside optiplex and your home network**. Configure a one-minute
expected interval and a grace period of about three minutes, plus notifications in
that service. The bot sends a bounded HTTPS GET after each usable background
sample while connected to Discord; no metrics are sent. Redirects are refused.
Pausing reports keeps these pings and thermal alerts running. Treat this as a
**bot + sampling + Discord availability check**: a Discord outage also stops pings.
Docker restarts an exited process; marking a running container unhealthy does not
restart it. This release adds no automatic hung-process watchdog. An independent
host/network check can distinguish a host outage from a Discord-only failure.

## Development

Local starts need readable host metric paths: set `HOST_PROC_PATH=/proc` and
`TEMP_SENSOR_PATH=/sys/devices/platform/coretemp.0/hwmon` on a Linux host. In Docker,
`compose.yaml` supplies selected read-only counters; `CORETEMP_HOST_PATH` can override
the host sensor source. Keep the parent `hwmon` directory mounted so changing
`hwmonN` numbering is handled. Tests use fixtures and mocked Discord delivery;
they do not need credentials or send messages.
Local storage defaults to `./data/optiplex.sqlite`; override with an absolute
`DATABASE_FILE`. `HISTORY_FILE` is only the legacy migration source. Compose fixes
both paths on `/app/data`. Data is excluded from Git and the Docker build context.
Run `npm ci --ignore-scripts --engine-strict`, `npm run check`, `npm run lint`,
`npm run format:check` and `npm test` on Node 24.22.1 or newer within the 24.x major.

---

> **AI-assisted development.** This project is developed with AI assistance: code, tests and
documentation are written with AI tools, including Claude (Anthropic) through Claude Code,
working with the maintainer. The maintainer sets the direction and decides what is merged,
and every change runs through the same automated checks in CI (type checking, lint,
formatting and tests). If you find a mistake, please open an issue.
