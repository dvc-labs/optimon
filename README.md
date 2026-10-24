# Optiplex

A small Discord companion for the optiplex home lab. **Version 0.2.0.**

- One embed when the bot connects, then host snapshots every **15 minutes**.
- Live CPU, RAM, **swap**, uptime, load averages and Intel CPU temperatures.
- Up to **24 hours of trends**, Discord latency checks and a playful server mood.
- A live Discord activity showing temperature, CPU and RAM use.
- Sustained-temperature warnings and recovery notices in the reporting channel.
- Optional owner controls with private replies. All embeds share the release footer.

A bot start can also be a deployment or container restart. Notifications therefore
show **host uptime and bot uptime separately**. A bot running on optiplex cannot
report a power or internet outage while that server is offline.

## Commands

Commands are registered in the configured guild at startup.

| Command | What it does |
| --- | --- |
| `/about` | Bot version, features and reporting schedule. |
| `/optiplex stats` | Host snapshot, including swap usage. |
| `/optiplex uptime` | Host/bot uptimes and estimated boot/start times. |
| `/optiplex history hours:1` | CPU, RAM and temperature trends; choose `1`, `6` or `24` hours. |
| `/optiplex ping` | Discord heartbeat and API acknowledgement latency. |
| `/optiplex vibe` | The tiny Dell's current mood, based on actual readings. |
| `/optiplex help` | A command and sampling guide. |
| `/optiplex-admin diagnostics` | Private bot RAM/heap usage, snapshot freshness and reporting status. |
| `/optiplex-admin snapshot` | Post a snapshot to the configured reporting channel now. |
| `/optiplex-admin pause minutes:60` | Pause scheduled reports for 5–1440 minutes; default `60`. |
| `/optiplex-admin resume` | Resume reports at the next normal reporting tick. |

Public commands reply in the channel where they are used. Owner replies are always
private; the explicit `snapshot` action posts publicly to the reporting channel.
Commands have a **10-second per-user cooldown**; forced posts also have a global
**60-second cooldown**. No command runs shell commands or controls the host.

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

The IDs are public identifiers, not credentials. The bot token is the only required
secret; startup messages and scheduled snapshots use the same bot and channel.
The first scheduled report arrives after one full interval. This is a snapshot,
not a fifteen-minute average; CPU usage is explicitly labelled as a one-second sample.

For `ADMIN_ID`, enable Discord **User Settings → Advanced → Developer Mode**, then
right-click your profile and select **Copy User ID**. It must be your user ID,
not a role, application or guild ID. The bot checks this exact ID on every owner
command; Discord Administrator alone does not authorize it. Discord initially
restricts the owner command group to administrators. If your owner account is not
an administrator, grant that user access under **Server Settings → Integrations →
Optiplex → Commands** as well.

The existing Discord application works: use the `bot` and `applications.commands`
installation scopes, with **View Channel**, **Send Messages** and **Embed Links**
in the reporting channel. No Administrator permission or privileged intents are
required. On Coolify, reload the Compose definition, add the runtime variables and
redeploy. To upgrade from v0.1.0, `ADMIN_ID` is the only new value to supply if you
want owner controls; existing metrics mounts and resource limits stay the same.

## Sampling and alerts

Background samples run about once a minute. Interactive commands share a snapshot
cache of up to **15 seconds** and do not add extra history samples. History stores
at most **1440 samples / 24 hours in memory**, with min/average/peak readings and
24 time buckets. Gaps stay visible; graphs use a fixed 0–100 scale and temperatures
above 100 °C saturate the graph while their exact values remain in the summary.
These are periodic samples, not continuous measurements or interval averages.

The hottest Intel CPU sensor triggers a warning after **two consecutive samples
at or above 80 °C**, and a recovery notice after **two at or below 75 °C**. One
notice is sent per confirmed transition; failed delivery can retry on the next
sample. Missing sensors and long sampling gaps interrupt the streak. Alerts do
not ping anyone. The warning is an early heads-up, not the CPU's damage threshold.

Pausing affects scheduled reports; **sampling and thermal alerts continue**, and
you can still request a snapshot. An already-sending message may finish. History,
pauses and diagnostic counters reset when the bot restarts. A restart also resets
thermal state, so an ongoing hot condition may produce a fresh warning.

## Development

Use Node.js **24.17 or newer within the 24.x line**:

```bash
npm ci --ignore-scripts
cp .env.example .env
# Fill .env locally, then:
npm test
npm run check
npm start
```

Local starts need readable host metric paths: set `HOST_PROC_PATH=/proc` and
`TEMP_SENSOR_PATH=/sys/devices/platform/coretemp.0/hwmon` on a Linux host. In Docker,
`compose.yaml` supplies selected read-only counters; `CORETEMP_HOST_PATH` can override
the host sensor source. Keep the parent `hwmon` directory mounted so changing
`hwmonN` numbering is handled. Tests use fixtures and mocked Discord delivery;
they do not need credentials or send messages.
Run only one deployed instance for this bot token to avoid duplicate notifications.

## Project

`src/` contains the bot and collectors; `test/` contains regression tests.
`Dockerfile` builds the non-root runtime, and `compose.yaml` supplies bounded
resources, log rotation, read-only mounts and a local health check without an HTTP server.

See [SECURITY.md](SECURITY.md) and [CONTRIBUTING.md](CONTRIBUTING.md).
Licensed under the existing [MIT license](LICENSE).
