# Optiplex

A small Discord companion for the optiplex home lab. **Version 0.1.0.**

- `/about` shows the bot version, features and uptime.
- One embed in `#optiplex` when the bot process connects to Discord.
- The bot posts snapshots every **15 minutes** in `#optiplex`: host uptime, CPU usage,
  memory, load averages, CPU package temperature and individual core temperatures.
- Consistent blue embeds, timestamps and a shared footer.

A bot start can also be a deployment or container restart. Notifications therefore
show **host uptime and bot uptime separately**. A bot running on optiplex cannot
report a power or internet outage while that server is offline.

## Setup

Set secrets in **Coolify runtime environment variables**, never Git:

| Variable | Purpose |
| --- | --- |
| `DISCORD_TOKEN` | Required bot token from Developer Portal → Bot. Secret. |
| `APPLICATION_ID` | `CLIENT_ID` is an optional alias for the same ID. |
| `GUILD_ID` | `x` |
| `CHANNEL_ID` | `x` |
| `HOST_NAME` | Display name; defaults to `optiplex`. |
| `STATS_INTERVAL_MINUTES` | Defaults to `15`; allowed range `1`–`1440`. |

The IDs are public identifiers, not credentials. The bot token is the only required
secret; startup messages and scheduled snapshots use the same bot and channel.
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
