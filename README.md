# Optiplex

A small Discord companion for the optiplex home lab. **Version 0.1.0.**

- `/about` shows the bot version, features and uptime.
- One embed in `#optiplex` when the bot process connects to Discord.
- Optional webhook snapshots every **15 minutes**: host uptime, CPU usage,
  memory, load averages, CPU package temperature and individual core temperatures.
- Consistent blue embeds, timestamps and a shared `Optiplex • v0.1.0 • dvc.labs` footer.

A bot start can also be a deployment or container restart. Notifications therefore
show **host uptime and bot uptime separately**. A bot running on optiplex cannot
report a power or internet outage while that server is offline.

## Setup

Follow **[the Discord and Coolify setup guide](docs/setup.md)**. Deploy the repository
with the **Docker Compose** build strategy on the **optiplex** server, using
`compose.yaml`. The selected read-only host mounts are required for host metrics.
The bot uses outbound Discord connections; no domain, public port, Cloudflare
Tunnel or running Coolify proxy is required.

Set secrets in **Coolify runtime environment variables**, never Git:

| Variable | Purpose |
| --- | --- |
| `DISCORD_TOKEN` | Required bot token from Developer Portal → Bot. Secret. |
| `WEBHOOK_URL` | Optional channel webhook URL. Secret. Blank disables scheduled reports. |
| `APPLICATION_ID` | `1562643787510063217`; `CLIENT_ID` is an optional alias for the same ID. |
| `GUILD_ID` | `1562082957022204006` |
| `CHANNEL_ID` | `1562960345860153444` |
| `HOST_NAME` | Display name; defaults to `optiplex`. |
| `STATS_INTERVAL_MINUTES` | Defaults to `15`; allowed range `1`–`1440`. |

The IDs are public identifiers, not credentials. No Discord client secret is needed.
The first scheduled report arrives after one full interval. This is a snapshot,
not a fifteen-minute average; CPU usage is explicitly labelled as a one-second sample.

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

Local starts need readable host metric paths; see the setup guide. Tests use
fixtures and mocked Discord delivery and do not need credentials or send messages.
Run only one deployed instance for this bot token to avoid duplicate notifications.

## Project

`src/` contains the bot and collectors; `test/` contains regression tests.
`Dockerfile` builds the non-root runtime, and `compose.yaml` supplies bounded
resources, log rotation, read-only mounts and a local health check without an HTTP server.

See [SECURITY.md](SECURITY.md) and [CONTRIBUTING.md](CONTRIBUTING.md).
Licensed under the existing [MIT license](LICENSE).
