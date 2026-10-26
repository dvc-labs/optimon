# Optimon

[![CI](https://github.com/dvc-labs/optimon/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/dvc-labs/optimon/actions/workflows/ci.yml)
[![Version](https://img.shields.io/github/package-json/v/dvc-labs/optimon)](package.json)
[![License: MIT](https://img.shields.io/github/license/dvc-labs/optimon)](LICENSE)
[![Node.js 24.x](https://img.shields.io/badge/node.js-24.x-339933?logo=nodedotjs&logoColor=white)](package.json)
[![discord.js](https://img.shields.io/github/package-json/dependency-version/dvc-labs/optimon/discord.js?logo=discord&logoColor=white)](https://discord.js.org)
[![TypeScript](https://img.shields.io/github/package-json/dependency-version/dvc-labs/optimon/dev/typescript?logo=typescript&logoColor=white)](https://www.typescriptlang.org)

A Discord companion and public web dashboard for the optiplex home lab. **Version 0.3.2.**

- One contextual startup embed, then host snapshots every **30 minutes**.
- Live CPU (including per-core, I/O wait and steal), RAM breakdown, **swap**, uptime, load and Intel CPU temperatures.
- **All CPU/RAM/temperature sample history retained on disk**, comparisons, Discord latency checks and a playful server mood.
- A live Discord activity showing temperature, CPU and RAM use.
- Sustained-temperature warnings and recovery notices in the reporting channel.
- Optional owner controls with private replies. All embeds share the release footer.
- Responsive dashboard with live readings, 1h–365d/all-time charts and social previews.
- The public container reads only a metrics export, with no Discord secrets or private database.
- Optional same-address VPS fallback when the home server is off; see [deployment steps](FALLBACK.md).
- Seven/thirty-day monitoring coverage and derived gaps, with sampling independent of Discord connectivity.
- Optional root filesystem capacity and sustained disk-space alerts through an empty read-only bind mount.

## Commands

| Command | What it does |
| --- | --- |
| `/about` | Bot version, features and reporting schedule. |
| `/stats` | Host snapshot, including swap usage. |
| `/uptime` | Host/bot uptimes, boot/start times and 7/30-day monitoring coverage. |
| `/outages days:7` | Recent monitoring gaps and sample coverage over 7 or 30 days. |
| `/history hours:1` | CPU, RAM and temperature trends: 1h, 6h, 24h, 7d, 30d or 365d. |
| `/compare hours:24` | Compare averages and recorded coverage with the preceding window. |
| `/ping` | Discord heartbeat and API acknowledgement latency. |
| `/vibe` | The tiny Dell's current mood, based on actual readings. |
| `/help` | A command and sampling guide. |
| `/diagnostics` | Private resources, storage, report delivery, dashboard export health and Discord session status. |
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
| `DASHBOARD_PUBLIC_URL` | HTTPS dashboard origin; required by both home Compose services, and used for `/about` and `/help` links. Optional only when running the bot outside Compose. |
| `DISK_ALERTS_ENABLED` | `true` by default; alerts operate only when disk metrics are mounted/readable. |

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

Sampling, SQLite writes and public exports begin **before Discord login**. Initial
login and command-registration failures retry in-process with delays of 1, 2, 4,
8, 16, 32 and then 60 seconds; established gateway reconnections remain managed by
discord.js. Unfinished setup keeps waiting across gateway disconnects and resumes
even when the recovered session emits no new `ClientReady` event. Each failed initial login is retried with a fresh client, since the SDK destroys failed clients. Reports and alerts are sent only while Discord is ready. Setup failures
do not stop monitoring. Disconnect/resume events use redacted structured logs.
`/diagnostics` separates live/history export success times and failure counts. A
failed first history read or file write retries on the next sample; the five-minute
history interval starts only after successful publication.

### Monitoring gaps and availability

`/outages` and `/uptime`, plus the dashboard, derive gaps from the existing timestamp
archive in the read-only worker. No schema migration or new outage table is needed.
A gap exceeds **210 seconds** between archived samples, or from the last sample to
query time. Missing duration begins **90 seconds** after the preceding sample and
is clipped to the selected window; only the five most recent extended gaps are returned.

Availability means **estimated monitoring coverage**, not independently measured
host uptime. It uses elapsed time since the later of the window start and the
archive's first reading. Each sample covers up to the next **90 seconds**, allowing
for the one-second CPU collection window and normal scheduler drift. Time beyond
that allowance until the next sample (or query time for the ongoing tail) is missing.
Coverage is `(observed time − missing time) / observed time`; a healthy 61–62-second
cadence therefore stays at 100% regardless of its position within a clock minute.
Shorter delays beyond 90 seconds reduce coverage even when they do not qualify for
the separate list of gaps over 210 seconds. The first sample alone has no elapsed
interval yet, so its percentage is unknown. Earlier unobserved time is not declared
downtime. All-null periodic samples still establish that monitoring ran; missing
samples can also result from failed archive writes. Queries exclude future-dated
rows. Clock corrections and periodic sampling limit accuracy. Chart notes report
raw sample counts without treating one sample as one minute of uptime.

Startup compares the last archived timestamp with the first new sample and the
current `/proc/stat` boot time. It can suggest a reboot during that interval or a
monitor restart on an already-running host; it cannot prove a deployment or exact
power-off duration. `/proc/stat` provides **current boot time**, not a historical
boot count. Historical gaps cannot retrospectively be assigned a cause.

The dashboard labels availability with its history-export time (normally within
five minutes). These summaries are historical, and cannot keep observing a host
after it goes off. The always-on observer/ten-minute offline timer remains deferred.

### Additional live metrics

The existing `/proc/stat` and `/proc/meminfo` mounts supply per-core CPU busy,
I/O wait, steal, runnable tasks (threads), boot time and memory counters. Load per logical
CPU is derived from the existing load/CPU readings. Per-core export is bounded at
128 rows. A decreasing/invalid I/O wait counter becomes unavailable, not zero.
Memory categories overlap and must not be added as independent slices. These new
details are live-only; the durable archive remains CPU busy, memory percentage and
hottest CPU temperature, with its existing retention and backup format.

### Optional root filesystem space and disk alerts

The default `compose.yaml` needs no new host paths. To enable disk metrics, prepare
an **empty directory on the root filesystem** on **optiplex**:

```bash
sudo install -d -o root -g root -m 0555 /var/lib/optimon-disk
findmnt -T / -o SOURCE,FSTYPE,TARGET
findmnt -T /var/lib/optimon-disk -o SOURCE,FSTYPE,TARGET
sudo ls -A /var/lib/optimon-disk
```

Both `findmnt` commands must identify the same filesystem; the final command should
print nothing. If `/var/lib` is on a separate filesystem, prepare a different empty
directory on `/` and set `DISK_HOST_PATH` accordingly. Do not bind `/`, a directory
containing files, block devices or the Docker socket.

In the **existing home Coolify resource**, change the Compose location to
`/compose.disk.yaml`. It is a standalone variant, not an override file. Set
`DISK_HOST_PATH=/var/lib/optimon-disk`, available at build time and runtime, reload
the definition and redeploy. Keep the existing resource, services, credentials,
volumes, TLS path and tunnel. Missing sources fail deployment rather than being
created. To return to the default, select `/compose.yaml` and redeploy.

The variant adds only `HOST_DISK_PATH=/host-metrics/disk` and one read-only bind.
The collector verifies that this is a dedicated mount point and an empty directory,
then uses `statfs`; it never reads host files. It reports filesystem capacity,
used blocks and space available to an unprivileged process. Percent used follows
`df` semantics (`used / (used + available)`), excluding reserved blocks. This is
filesystem capacity, not SMART health or physical SSD temperature. An unreadable
mount reports unavailable and cannot trigger a false recovery.

Two consecutive background samples at **90%** or above trigger a disk warning;
two at **85%** or below trigger recovery. Missing samples, duplicates or long gaps
cannot establish a transition. Failed sends are retried on subsequent samples.
Pausing reports leaves disk/thermal alerts active; `DISK_ALERTS_ENABLED=false`
disables disk notices. CI exercises a real read-only empty-directory bind under
the non-root runtime restrictions. Verify the filesystem choice on optiplex;
CI cannot establish where a particular host directory resides.

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
The container health check now measures a fresh **sampling loop**, independently
of Discord. A Discord outage therefore does not make the working sampler unhealthy;
the external heartbeat remains the combined bot/Discord check described above.

## Development

The runtime remains on Node 24. The [official Node.js schedule](https://github.com/nodejs/Release/blob/main/schedule.json)
lists its Maintenance LTS start as 20 October 2026 and support end as 30 April 2028;
Node 26's Active LTS transition is scheduled for 28 October 2026. A runtime-major
upgrade is separate from this release.

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
