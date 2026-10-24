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
Trend history is bounded to 1440 compact samples and 24 hours, with a writable named
volume at `/app/data`. Only timestamps and aggregate CPU, RAM and CPU temperature
readings are stored; there are no credentials, Discord messages or user IDs in the
history format. The image initializes the directory for its non-root user with mode
0700; history files are written with mode 0600. The versioned input format is checked
and capped at 1 MiB before parsing. Saves use a file in the same directory, fsync and
atomic rename, followed by a directory sync. Invalid or unsupported history stops
startup without replacing the file. Later write failures are logged safely and
shown as degraded storage in owner diagnostics while monitoring continues.
Use one writer per history volume and keep its permissions private. Retained
history survives container replacement when the same volume is attached; it is
local to the deployment server and is not a backup. Back it up before moving
servers or deleting storage. Command cooldown state is bounded too. Reporting
pauses, thermal state and counters remain temporary process state.
Dependencies and bot code must still be trusted: read-only mounts and containers
do not make arbitrary code safe. Missing readings are shown as unavailable.

Keep the host, Docker, base image and dependencies updated. Review Dependabot PRs
and rebuild/redeploy to pick up image updates. This process is a monitor, not a
firewall, intrusion detector, outage-alert guarantee or replacement for backups.
