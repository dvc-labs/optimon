# Optiplex

A small Discord companion for the optiplex home lab. **Version 0.2.1.**

- One embed when the bot connects, then host snapshots every **15 minutes**.
- Live CPU, RAM, **swap**, uptime, load averages and Intel CPU temperatures.
- Up to **24 hours of persistent trends**, Discord latency checks and a playful server mood.
- A live Discord activity showing temperature, CPU and RAM use.
- Sustained-temperature warnings and recovery notices in the reporting channel.
- Optional owner controls with private replies. All embeds share the release footer.

A bot start can also be a deployment or container restart. Notifications therefore
show **host uptime and bot uptime separately**. A bot running on optiplex cannot
report a power or internet outage while that server is offline.

## Commands

| Command | What it does |
| --- | --- |
| `/about` | Bot version, features and reporting schedule. |
| `/stats` | Host snapshot, including swap usage. |
| `/uptime` | Host/bot uptimes and estimated boot/start times. |
| `/history hours:1` | CPU, RAM and temperature trends; choose `1`, `6` or `24` hours. |
| `/ping` | Discord heartbeat and API acknowledgement latency. |
| `/vibe` | The tiny Dell's current mood, based on actual readings. |
| `/help` | A command and sampling guide. |
| `/diagnostics` | Private bot RAM/heap usage, snapshot freshness and reporting status. |
| `/snapshot` | Post a snapshot to the configured reporting channel now. |
| `/pause minutes:60` | Pause scheduled reports for 5–1440 minutes; default `60`. |
| `/resume` | Resume reports at the next normal reporting tick. |

## Setup

Set secrets in **Coolify runtime environment variables**, never Git:

| Variable | Purpose |
| --- | --- |
| `DISCORD_TOKEN` | Required bot token from Developer Portal → Bot. Secret. |
| `APPLICATION_ID` | `CLIENT_ID` is an optional alias for the same ID. |
| `GUILD_ID` | Discord server ID for command registration and report delivery. |
| `CHANNEL_ID` | Reporting channel ID within that server. |
| `ADMIN_ID` | Optional **Discord user ID** allowed to use owner controls; blank disables them. |
| `HOST_NAME` | Display name; defaults to `optiplex`. |
| `STATS_INTERVAL_MINUTES` | Defaults to `15`; allowed range `1`–`1440`. |
| `THERMAL_ALERTS_ENABLED` | `true` by default; set `false` to disable thermal notices. |

## Sampling and alerts

Background samples run about once a minute. Interactive commands share a snapshot
cache of up to **15 seconds** and do not add extra history samples. History stores
at most **1440 samples / 24 hours**, saved after each background sample and restored
after restarts, with min/average/peak readings and
24 time buckets. Gaps stay visible; graphs use a fixed 0–100 scale and temperatures
above 100 °C saturate the graph while their exact values remain in the summary.
These are periodic samples, not continuous measurements or interval averages.

## Persistent history

The `history-data` named volume stores `/app/data/history.json`: timestamps, CPU
usage, RAM usage and the hottest CPU temperature. Saves replace the file atomically;
the format and file size are checked before loading. `/diagnostics` shows storage
health and the last successful save. Temporary save failures keep monitoring running
and retry with the retained history on the next sample. Invalid or unreadable files
stop startup without overwriting the data; restore a valid backup or move the file
aside before starting fresh.

To upgrade from v0.2.0: **reload the Compose definition in the existing Coolify
resource**, confirm a volume targets `/app/data`, then redeploy. No new secrets are
needed. Test with `/diagnostics`, restart the container, then check `/history`;
recent samples should still be present. The first upgrade starts a new file because
v0.2.0 did not save its in-memory readings. Offline periods remain gaps.

Keep the same volume across deployments. Deleting it removes history; back it up
if needed. Only metric history persists: pauses, thermal state and process counters
still reset on restart. The container root filesystem stays read-only.

The hottest Intel CPU sensor triggers a warning after **two consecutive samples
at or above 80 °C**, and a recovery notice after **two at or below 75 °C**. One
notice is sent per confirmed transition; failed delivery can retry on the next
sample. Missing sensors and long sampling gaps interrupt the streak. Alerts do
not ping anyone. The warning is an early heads-up, not the CPU's damage threshold.

## Development

Local starts need readable host metric paths: set `HOST_PROC_PATH=/proc` and
`TEMP_SENSOR_PATH=/sys/devices/platform/coretemp.0/hwmon` on a Linux host. In Docker,
`compose.yaml` supplies selected read-only counters; `CORETEMP_HOST_PATH` can override
the host sensor source. Keep the parent `hwmon` directory mounted so changing
`hwmonN` numbering is handled. Tests use fixtures and mocked Discord delivery;
they do not need credentials or send messages.
Local history defaults to `./data/history.json`; `HISTORY_FILE` can override it with
an absolute path. `data/` is excluded from Git and the Docker build context.
Run only one deployed instance per bot token and history volume.
