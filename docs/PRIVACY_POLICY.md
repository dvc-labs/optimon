# Optimon Privacy Policy

**Effective 16 November 2026**

Dave Van Cauwenberghe (dvc.labs, Belgium) is the controller for personal data processed by the
official Optimon Discord bot and public optiplex dashboard. This policy covers those services.
Independent operators of the open-source code are responsible for their own deployments.

## What Optimon processes and why

- **Discord commands.** Discord sends Optimon the slash command, its options, and the Discord user,
  server, channel and interaction identifiers needed to handle it. Optimon uses these to respond,
  check access to owner controls and enforce cooldowns. The bot does not read ordinary Discord chat
  or direct messages.
- **Discord configuration.** The operator configures a server and reporting channel by their Discord
  IDs and can configure a Discord user ID to authorize owner controls.
- **Command audit records.** When Optimon handles a recognized command in its configured server, it
  records the command name, Discord user, server, channel and interaction IDs, start and completion
  times, duration and outcome. This includes denied and failed commands. The audit log does not store
  command options, chat content or credentials. It helps the operator diagnose failures, investigate
  abuse and verify the use of owner controls.
- **Host monitoring.** Optimon collects hardware and performance readings from the monitored server.
  These include CPU and memory usage, temperatures, uptime and, when enabled, disk capacity. Optimon
  posts readings and alerts in Discord and publishes selected aggregate readings and history on its
  public dashboard. The public dashboard does not receive Discord user IDs or command audit records.
- **Dashboard visits.** The dashboard application does not set cookies or run tracking or analytics
  scripts. Cloudflare processes request metadata, such as IP address and request information, to
  deliver and protect the site. A reverse proxy may also keep ordinary access logs.
- **Contact requests.** If you email the operator, they use your email address and the information
  you provide to respond, verify your request when needed and keep a record of its resolution.

Where the GDPR applies, Optimon relies on legitimate interests in providing, securing and diagnosing
the service and responding to requests. The operator also processes data as needed to meet legal
obligations, including responding to privacy requests where required by law.

## Who can see the data

- Discord handles command delivery, responses, reports and alerts. Normal command replies are visible
  in the channel where the command is used. Scheduled posts are visible to people with access to the
  reporting channel. The bot's audit command is restricted to the configured owner and replies
  privately. Discord handles its own data under the [Discord Privacy Policy](https://discord.com/privacy).
- The command audit database and its backups are private to the operator and authorized
  infrastructure providers. If remote backups are enabled, database snapshots may be stored with a
  backup provider such as Cloudflare R2.
- Cloudflare delivers the dashboard and may process network metadata for it. If an external uptime
  check is enabled, its provider receives a heartbeat request without Discord user records or host
  readings. See the [Cloudflare Privacy Policy](https://www.cloudflare.com/privacypolicy/).

Providers may process data outside the European Economic Area. Where required, transfers use an
applicable adequacy decision or safeguards such as standard contractual clauses. You can contact the
operator for information on applicable safeguards. Optimon does not sell personal data or use Discord
user data for advertising. The operator may disclose data when legally required.

## Storage and retention

- **Command audit records** are stored in a private SQLite database. The live database prunes them
  after 90 days by default. Retention is configurable, including a setting that disables automatic
  expiry. The operator retains audit data only as long as needed for the purposes above, subject to
  legal obligations and valid deletion requests.
- **Backups** may contain older audit records until the relevant backup expires, is replaced or is
  deleted. Backup retention is managed separately from live audit expiry.
- **Host metric history** has no automatic expiry. Dashboard infrastructure logs follow the relevant
  service's rotation or retention settings. Contact correspondence is kept as long as needed to
  resolve the request and meet applicable legal obligations.

## Your rights and how to request deletion

Email [hello@davevancauwenberghe.be](mailto:hello@davevancauwenberghe.be) with the subject “Optimon
privacy request.” For a Discord data request, include your Discord user ID so the operator can locate
the records. The operator may ask you to verify that the account is yours. Avoid posting your request
or account information in a public issue.

Depending on applicable law, you can request access to, correction of or deletion of your personal
data, ask for processing to be restricted, object to processing, or request a portable copy where
that right applies. The operator will promptly delete the Discord data they hold on a verified user
request unless the law requires keeping it. You can also lodge a complaint with your local data
protection authority, including the [Belgian Data Protection
Authority](https://www.gegevensbeschermingsautoriteit.be/burger/acties/klacht-indienen).

Optimon follows Discord's minimum-age rules. A parent or guardian who believes a child below the
applicable minimum age has provided data can use the same contact address to request deletion.

Changes to this policy will be published here with an updated effective date. See also the [Optimon
Terms of Service](TERMS_OF_SERVICE.md).
