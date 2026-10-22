# Security

Security fixes target the latest release on `main`; the initial supported version is 0.1.x.

Report vulnerabilities privately using this repository's **Security → Report a
vulnerability** option if enabled. Otherwise contact the repository owner through
an existing private contact route. Do not post bot tokens, webhook URLs, host
credentials or detailed exploit instructions in a public issue.

## Credentials and access

- `DISCORD_TOKEN` and `WEBHOOK_URL` are secrets. Store them as Coolify runtime
  variables. `.env` files are excluded from Git and the Docker build context.
- If a credential is exposed, reset the bot token or delete/recreate the webhook,
  update Coolify and redeploy. Removing a leaked value from a commit is not revocation.
- Discord IDs are public identifiers. The bot does not require a client secret,
  Administrator permission, privileged Gateway intents or Manage Webhooks permission.
- The webhook must belong to the configured guild and channel. Its destination
  is checked before reports are posted. Messages disable automatic mentions.
- Runtime error logs contain selected error identifiers, not raw Discord errors,
  request bodies, authorization headers or webhook URLs.

## Host metrics

The Compose service runs as a non-root user with all Linux capabilities dropped,
no-new-privileges, a read-only root filesystem, bounded CPU/memory/process counts,
and rotating Docker logs. It has no published ports, host networking, host PID
namespace, Docker socket, or mount of the host root filesystem.

It can read four selected `/proc` counters and the Intel `coretemp` sensor
directory through read-only bind mounts. These reveal aggregate hardware/usage
information; treat the Discord reporting channel as visible to its members.
Dependencies and bot code must still be trusted: read-only mounts and containers
do not make arbitrary code safe. Missing readings are shown as unavailable.

Keep the host, Docker, base image and dependencies updated. Review Dependabot PRs
and rebuild/redeploy to pick up image updates. This process is a monitor, not a
firewall, intrusion detector, outage-alert guarantee or replacement for backups.
