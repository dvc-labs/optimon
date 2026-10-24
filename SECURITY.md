# Security

Security fixes target the latest release on `main`; the supported version is 0.2.x.

Report vulnerabilities privately using this repository's **Security → Report a
vulnerability** option if enabled. Otherwise contact the repository owner through
an existing private contact route. Do not post bot tokens, host
credentials or detailed exploit instructions in a public issue.

## Credentials and access

- `DISCORD_TOKEN` is a secret. Store it as a Coolify runtime
  variable. `.env` files are excluded from Git and the Docker build context.
- If a credential is exposed, reset the bot token,
  update Coolify and redeploy. Removing a leaked value from a commit is not revocation.
- Discord IDs are public identifiers. The bot does not require a client secret,
  Administrator permission, privileged Gateway intents or Manage Webhooks permission.
- Startup and scheduled reports use the bot's configured guild and channel.
  The destination is checked before each send. Messages disable automatic mentions.
- All commands require the configured guild. Owner commands additionally require
  an exact match against the optional `ADMIN_ID`; missing configuration denies
  access. Discord roles, Administrator and command overrides cannot bypass this
  check. Owner replies are ephemeral. Forced snapshots go only to the configured
  reporting channel, with a separate global cooldown.
- Owner controls affect this bot's reporting, not the host. There is no shell
  execution, shutdown/restart command, arbitrary URL fetch or user-selected file read.
- Runtime error logs contain selected error identifiers, not raw Discord errors,
  request bodies, authorization headers or request URLs.

## Host metrics

The Compose service runs as a non-root user with all Linux capabilities dropped,
no-new-privileges, a read-only root filesystem, bounded CPU/memory/process counts,
and rotating Docker logs. It has no published ports, host networking, host PID
namespace, Docker socket, or mount of the host root filesystem.

It can read four selected `/proc` counters and the Intel `coretemp` sensor
directory through read-only bind mounts. These reveal aggregate hardware/usage
information; treat the Discord reporting channel as visible to its members.
Public command responses also expose aggregate metrics in the channel where they
are invoked, and the bot's activity exposes a CPU/RAM/temperature summary. Restrict
command and channel access in Discord if those readings should be private.
Trend history is bounded to 1440 compact samples and 24 hours in process memory;
it is not written to a database or volume and is lost on restart. Command cooldown
state is bounded too. Reporting pauses and counters are temporary process state.
Dependencies and bot code must still be trusted: read-only mounts and containers
do not make arbitrary code safe. Missing readings are shown as unavailable.

Keep the host, Docker, base image and dependencies updated. Review Dependabot PRs
and rebuild/redeploy to pick up image updates. This process is a monitor, not a
firewall, intrusion detector, outage-alert guarantee or replacement for backups.
