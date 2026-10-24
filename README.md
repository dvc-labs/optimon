# Optiplex

A small Discord companion for the optiplex home lab. **Version 0.2.2.**

- One embed when the bot connects, then host snapshots every **15 minutes**.
- Live CPU, RAM, **swap**, uptime, load averages and Intel CPU temperatures.
- **All metric history retained on disk**, comparisons, Discord latency checks and a playful server mood.
- A live Discord activity showing temperature, CPU and RAM use.
- Sustained-temperature warnings and recovery notices in the reporting channel.
- Optional owner controls with private replies. All embeds share the release footer.

A bot start can also be a deployment or container restart. Notifications therefore
show **host uptime and bot uptime separately**. A bot running on optiplex cannot
report a power or internet outage while offline; an optional external heartbeat covers that gap.

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
| `HOST_NAME` | Display name; defaults to `optiplex`. |
| `STATS_INTERVAL_MINUTES` | Defaults to `15`; allowed range `1`–`1440`. |
| `THERMAL_ALERTS_ENABLED` | `true` by default; set `false` to disable thermal notices. |
| `HEARTBEAT_URL` | Optional secret HTTPS ping URL; blank disables external monitoring. |

## Sampling and alerts

Background samples run about once a minute. Interactive commands share a snapshot
cache of up to **15 seconds** and do not add extra history samples. History stores
**every background sample**, committed immediately and restored after restarts.
Only the recent RAM cache is capped at **1440 samples / 24 hours**. Queries show
min/average/peak readings and
24 time buckets. Gaps stay visible; graphs use a fixed 0–100 scale and temperatures
above 100 °C saturate the graph while their exact values remain in the summary.
These are periodic samples, not continuous measurements or interval averages.

## Persistent history

The existing **local Docker volume** `history-data` stores `/app/data/optiplex.sqlite`.
SQLite WAL mode, full synchronous commits and a **250 ms busy timeout** support
concurrent readers without rewriting the whole archive every minute. Do not put
this database on NFS, SMB or another network filesystem. Run one bot instance per volume.

## External outage monitoring

Optionally set `HEARTBEAT_URL` to a Healthchecks.io check or an Uptime Kuma push
monitor hosted **outside optiplex and your home network**. Configure a one-minute
expected interval and a grace period of about three minutes, plus notifications in
that service. The bot sends a bounded HTTPS GET after each usable background
sample while connected to Discord; no metrics are sent. Redirects are refused.
Pausing reports keeps these pings and thermal alerts running.

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
