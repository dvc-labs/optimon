# Discord and Coolify setup

## 1. Prepare the Discord application

Open [Discord Developer Portal](https://discord.com/developers/applications) and
select your **Optiplex** application, ID `1562643787510063217`.

1. Under **Bot**, create the bot user if necessary and set its name to **Optiplex**.
2. Use **Reset Token** if you need a new bot token. Save it directly in your
   password manager or Coolify as `DISCORD_TOKEN`; do not post it in Discord,
   GitHub, screenshots, issues or chat.
3. Keep **Requires OAuth2 Code Grant** disabled. This is a Gateway bot, not an
   OAuth login website. It needs no client secret or redirect URI.
4. Keep **Presence Intent**, **Server Members Intent** and **Message Content
   Intent** disabled. The implementation requests only the non-privileged
   `Guilds` intent.
5. Under **Installation**, enable **Guild Install**. User Install is unnecessary.
   Use the `bot` and `applications.commands` scopes.
6. Request only **View Channels**, **Send Messages** and **Embed Links**.
   Do not grant Administrator or Manage Webhooks. Keep the **Interactions Endpoint
   URL** empty so command interactions arrive through the bot's Gateway connection.

You can keep **Public Bot** disabled if only the application owner/team should
install it. Use the manual invite below if the portal does not provide a default
install link for a private bot.

Install it into your labs server using this link, signed in as an account allowed
to manage that server:

[Install Optiplex in dvc.labs](https://discord.com/oauth2/authorize?client_id=1562643787510063217&scope=bot%20applications.commands&permissions=19456&guild_id=1562082957022204006&disable_guild_select=true&integration_type=0)

The permission bitfield `19456` is View Channel + Send Messages + Embed Links.

In the `#optiplex` channel (`1562960345860153444`), check channel/category overrides
allow the bot those permissions. Members who should use `/about` need permission
to use application commands. The bot creates/updates its own **guild-scoped**
`/about` command on startup; no manual command registration step is needed.

## 2. Create the stats webhook

In the Discord desktop/web app:

1. Open **Server Settings → Integrations → Webhooks → New Webhook** (or the
   channel's **Edit Channel → Integrations** page).
2. Name it **Optiplex** and select **#optiplex**.
3. Copy the webhook URL into the Coolify runtime variable `WEBHOOK_URL`.

The person creating it needs Manage Webhooks; the bot itself does not. The URL
contains a secret token and permits posting as the webhook. The bot checks its
guild/channel before sending metrics. Keep its URL separate from the bot token.

Leaving `WEBHOOK_URL` blank is supported: `/about` and startup notifications still
work, while scheduled snapshots are disabled. A configured webhook must be an
HTTPS `discord.com/api/webhooks/...` URL without additional query parameters.

## 3. Check the host temperature directory

Run **on optiplex**, not on the VPS:

```bash
ls -d /sys/devices/platform/coretemp.0/hwmon
sensors
```

The first path is the default read-only sensor source in `compose.yaml`. The bot
reads Intel `coretemp` sysfs readings directly, so the host's `sensors` binary does
not need to be copied into the container or invoked with sudo.

If the driver uses another path, locate it:

```bash
find /sys/devices/platform -maxdepth 3 -type d -path '*/coretemp.*/hwmon'
```

Set `CORETEMP_HOST_PATH` in Coolify to the returned **parent hwmon directory**,
for example `/sys/devices/platform/coretemp.0/hwmon`, then reload the Compose
definition. Do not bind only a `hwmonN` symlink from `/sys/class/hwmon`; its target
may be outside that mount. Do not enable privileged mode to work around a sensor
path or permission error.

Missing bind sources fail deployment rather than creating directories on the
host. If a mounted reading becomes unavailable, the bot reports `Unavailable` for
that metric and continues responding to `/about`.

## 4. Create the Coolify application

After merging this PR, in your existing Coolify dashboard:

1. Open your project and environment, then **New Resource**.
2. Choose the GitHub App/repository source or **Public Repository**.
3. Select `https://github.com/dvc-labs/optiplex`, branch **main**.
4. Select the **optiplex** deployment server/destination. Deploying on the VPS
   would monitor the VPS because the host mounts come from the deployment server.
5. Select the **Docker Compose / Compose** build strategy, base directory `/`,
   and Compose location `/compose.yaml`. Load/reload its configuration.
6. Keep **Domains** empty. Do not add host port mappings. The bot opens outbound
   HTTPS/WebSocket connections to Discord and requires no inbound HTTP endpoint.
   The stopped proxy on optiplex can remain stopped.
7. Disable preview deployments and run **one instance** with this bot token.
   Use stop/start replacement when changing versions; overlapping old/new copies
   would both post startup notifications and scheduled reports.

Keep the Compose build strategy: a plain Dockerfile deployment without these
mounts cannot read the intended host counters. Do not add the bot to the VPS's
resource or replace the existing Coolify installation.

## 5. Set runtime environment variables

In this application's **Environment Variables**, set the following. Keep the
token and webhook URL as secret/runtime values and leave build-time injection
disabled. No application secrets are required by GitHub Actions.

```dotenv
DISCORD_TOKEN=<your bot token>
APPLICATION_ID=1562643787510063217
GUILD_ID=1562082957022204006
CHANNEL_ID=1562960345860153444
WEBHOOK_URL=<your #optiplex webhook URL, or leave blank>
HOST_NAME=optiplex
STATS_INTERVAL_MINUTES=15
```

`APPLICATION_ID` and `CLIENT_ID` are the same identifier. Only `APPLICATION_ID`
is needed. `CLIENT_ID` is accepted as an alias; if both are set, they must match.
The **bot token** comes from the Bot tab, not the General Information public key
and not the OAuth2 client secret.

The host paths and the small Node.js memory limit are already in the Compose
definition. Set `CORETEMP_HOST_PATH` only if the default path is different on this
host. Save the variables and reload the Compose configuration before deployment
if Coolify requests it. Never commit a populated `.env` file.

## 6. Deploy and verify

1. Select **Deploy**. The image builds TypeScript and runs as the non-root `node`
   user, with a read-only filesystem and temporary `/tmp` storage.
2. Runtime logs should include `ready` and `reportsEnabled: true` when the webhook
   is set. `/about` should appear in your labs server.
3. `#optiplex` receives **Optiplex monitor is online**, with separate host and bot
   uptimes. Ordinary Gateway reconnects do not post another startup notification;
   a new process/container does.
4. After **15 minutes**, the webhook posts the first host snapshot. Future reports
   are scheduled after the previous report finishes, so slow requests do not overlap.
5. Check the Docker health status in Coolify. It uses a fresh local heartbeat and
   Discord readiness, without exposing an HTTP health port.

Reports show CPU busy percentage sampled for one second, load averages over
1/5/15 minutes, memory used/available, host/bot uptime, CPU package and individual
core temperatures. Memory usage is `MemTotal - MemAvailable`, rather than treating
all reclaimable cache as used. `GiB` uses binary units, and sysfs temperature
values are converted from millidegrees Celsius. A CPU reading of 80 °C or more
changes the snapshot accent to amber; it does not ping anyone or send extra alerts.

The standard footer on `/about`, startup and scheduled embeds is
`Optiplex • v0.1.0 • dvc.labs`. The live version comes from `package.json`.

There is no inbound firewall/router/DNS change to make for this bot. Startup
notification success is not proof of a host reboot. A monitor on optiplex cannot
send a message while optiplex has lost power or internet; an external observer
on the VPS would be needed for reliable offline alerts later.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `/about` missing | Correct application/guild IDs, invite includes `applications.commands`, bot belongs to the guild, and initialization logs show no error. Reopen Discord if it cached an older command list. |
| `configuration_error` | The named setting is absent/invalid. Do not paste its secret value into an issue. |
| `login_failed` | Use the Bot token, update Coolify after resetting it, and redeploy. |
| Discord code `50013` | Check the bot role and `#optiplex` channel/category permissions. |
| `startup_notification_failed` | Verify `CHANNEL_ID`, the guild and View/Send/Embed permissions. `/about` can remain available while you correct it. |
| `WebhookTargetMismatch` | Recreate/select a webhook for the configured guild and `#optiplex` channel. |
| Webhook HTTP `401`, `403` or `404` | Verify/recreate its URL, update Coolify, redeploy. Raw error objects and URLs are deliberately not logged. |
| No scheduled reports | Check `WEBHOOK_URL`, wait a full interval and inspect `stats_report_failed` logs. |
| Missing temperatures or deployment mount error | Check `CORETEMP_HOST_PATH` on optiplex and use the supplied Compose mounts. |
| CPU/memory show unavailable | Ensure deployment uses Compose on optiplex with all four `/proc` file mounts. The bot never silently substitutes container metrics. |
| Duplicate messages | Stop any preview/duplicate resource and use one deployed process for this token. |

## Local development

For a Linux development machine with Intel coretemp, after `npm ci`, configuring
`.env` and `npm run build`:

```bash
HOST_PROC_PATH=/proc \
TEMP_SENSOR_PATH=/sys/devices/platform/coretemp.0/hwmon \
npm start
```

On macOS, the slash command and startup notification can be developed, but Linux
host metrics will show unavailable. Use a separate test Discord application/token
and channel so local runs do not duplicate production notifications.

To run through Docker Compose on the intended Linux host:

```bash
cp .env.example .env
# Edit .env locally; do not print or commit the secrets.
docker compose up -d --build
docker compose ps
docker compose logs --tail 50 optiplex
```

The Dockerfile/Compose build and actual sensor mounts must be checked on a Docker
host; unit tests do not simulate kernel namespaces. Automated tests use fixtures
and mocked delivery and never authenticate to Discord.

## References

- [Discord OAuth2 and bot installation](https://docs.discord.com/developers/topics/oauth2)
- [Discord Gateway and intents](https://docs.discord.com/developers/events/gateway)
- [Discord application commands](https://docs.discord.com/developers/interactions/application-commands)
- [Discord webhook resource](https://docs.discord.com/developers/resources/webhook)
- [Coolify Docker Compose deployments](https://coolify.io/docs/applications/builds/docker-compose)
- [Linux hardware-monitoring sysfs interface](https://www.kernel.org/doc/Documentation/hwmon/sysfs-interface)
