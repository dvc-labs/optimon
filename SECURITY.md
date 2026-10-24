# Security

Security fixes target the latest release on `main`; the supported version is 0.2.x.

Report vulnerabilities privately using this repository's **Security → Report a
vulnerability** option if enabled. Otherwise contact the repository owner through
an existing private contact route. Do not post bot tokens, host
credentials or detailed exploit instructions in a public issue.

## Credentials and access

- `DISCORD_TOKEN` and optional `HEARTBEAT_URL` are secrets. Store it as a Coolify runtime
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
  execution, shutdown/restart command, command-selected URL fetch or user-selected file read.
  The optional administrator-configured HTTPS heartbeat sends no metrics, refuses
  redirects and has a five-second timeout. Never share its ping URL publicly.
- Runtime error logs contain selected error identifiers, not raw Discord errors,
  request bodies, authorization headers or request URLs. A blocked-backup log may
  name the artifact by basename and give a recovery action; it omits absolute paths.

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
The writable local volume at `/app/data` retains all timestamped CPU/RAM/temperature
samples indefinitely. Recognized guild slash-command metadata has a default
90-day live retention window, configurable with `AUDIT_RETENTION_DAYS` (`0` keeps all).
Audit records
include interaction, user, guild and channel IDs, command name, start/completion
times, duration and outcome; **no arguments, message contents or credentials**.
Denied and failed commands are recorded too. `/audit` requires the exact `ADMIN_ID`
and replies privately. Limit who can read the volume, backups and Discord channel.

The image creates the data directory with mode 0700; databases, backups and
quarantined files use mode 0600. SQLite uses WAL, full synchronous commits, a
250 ms busy timeout, versioned transactional schema creation and transactional,
idempotent legacy migration. Keep the database on local storage, not a network
share, with one bot writer. The failed-write retry buffer is bounded to 1440 readings.
No metric rows are
automatically deleted. A read-only worker executes aggregate history queries in
WAL read transactions, with a bounded 60-second cache and a 10-second request
deadline; it receives no bot token. Timed-out workers are terminated before a
replacement is allowed to start.
The old RAM history and JSON writer have been removed, while the bounded read-only
legacy importer remains for skipped upgrades.

Corrupt databases/legacy files are quarantined without logging their contents, then
monitoring starts with a fresh archive and a visible recovery warning. This does
not repair or recover the corrupt data. Unsupported schemas and unreadable/unsafe
paths stop startup. Runtime save/audit failures are logged safely and exposed in
diagnostics. Extended storage failure may lose new readings or audit records;
exhausting the bounded sample retry buffer increments a visible drop counter.

Use `npm run backup` to create a consistent standalone SQLite snapshot, validated
before promotion and retaining
one verified previous generation. See [BACKUPS.md](BACKUPS.md) for offline restore.
Back up externally before moving servers; a raw copy of the live main file can miss
committed WAL data. Volumes are not backups. Protect backup access and retain them
according to your own privacy needs. The writer enables `PRAGMA secure_delete=ON`
before future audit deletions, so deleted table cells and freed pages are zeroed.
In WAL mode, those scrubbed pages reach the main file when checkpointed. This does
not retroactively scrub leftovers from earlier deletes. Older WAL frames, backup
copies and filesystem snapshots can retain prior IDs; retention is not a claim of
secure erasure from SSD media or every historical copy.
Command cooldowns, reporting pauses, thermal
state and process counters remain temporary process state.
Dependencies and bot code must still be trusted: read-only mounts and containers
do not make arbitrary code safe. Missing readings are shown as unavailable.

Keep the host, Docker, base image and dependencies updated. Review Dependabot PRs
and rebuild/redeploy to pick up image updates. This process is a monitor, not a
firewall, intrusion detector, outage-alert guarantee or replacement for backups.
