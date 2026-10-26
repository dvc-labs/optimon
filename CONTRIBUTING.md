# Contributing

Keep changes small and explain the resulting behaviour in a pull request.

1. Use Node.js 24.x (24.22.1 or newer) and run `npm ci --ignore-scripts --engine-strict`.
2. Copy `.env.example` to `.env` only if testing with your own Discord application.
   Never reuse production credentials in CI or commit secrets.
3. Run `npm test`, `npm run check`, `npm run lint` and `npm run format:check`.
   Use `npm run format` for Prettier formatting. Oxlint uses TypeScript 7 type-aware
   promise rules; intentionally discarded promises still need a rejection handler.
   Browser/Worker code in `web/`, `fallback/` and `deploy/` also uses explicit `no-undef` checks.
   Add focused tests for changed parsing,
   scheduling, delivery, thermal transitions or security behaviour. Test denied
   owner access, unavailable sensors and failed delivery without real Discord calls.
4. For a release, update `package.json`, its lockfile and the README version.
   The bot's version and shared footer are derived from `package.json`.

Preserve the shared embed builder, explicit host/bot uptime distinction, delivery
through the bot and least-privilege deployment. Never add public ports, a Docker
socket mount or privileged mode just to collect a metric. Document additional
host reads and permissions before proposing them.

Keep command acknowledgement ahead of slow metric collection, use the snapshot
cache, and record history only from background samples. Owner commands must check
both guild and `ADMIN_ID` before accessing telemetry or changing state. Never
trust Discord roles or default command visibility as the authorization check.

Runtime upgrades must keep the Docker images, package engine range, CI and
`@types/node` on the same supported LTS major. Keep TypeScript's optional native
compiler package available during installation; dev tools are pruned from the
runtime image. CI audits development dependencies as well as runtime packages
and imports the compiled commands inside the actual runtime image without credentials.

SQLite retains every metric sample on the local data volume. Live command records
expire after the configured retention period (90 days by default, 0 disables expiry).
Keep schema versions and imports transactional and idempotent; migration must
survive process termination before and after commit. Use WAL, full synchronous
commits and a bounded busy timeout. Do not move storage onto network filesystems
or load the unbounded archive into RAM. Execute heavy aggregate queries in the
read-only worker, bound queued requests with a deadline and clear timers on every
completion/error/close path. Terminate a retired worker before starting its
replacement. Cache bounded results briefly, and keep the failed-write retry
buffer capped. Show storage/delivery failures in owner diagnostics.

Test sampling before Discord readiness, login/setup retry cancellation, sampling → alert → delivery and shutdown ordering
with injected Discord/heartbeat delivery, never real services. Test SIGKILL recovery,
legacy migration, corrupt-data quarantine, audit authorization and outcomes, gaps
and comparison boundaries, and consistent live SQLite backups. Reject corrupt
snapshots before promotion,
keep one verified previous generation and test interrupted rotation. Keep recovery
instructions usable with the bot stopped; never restore over a live WAL writer. The container check
must reuse a local named volume between two non-root, read-only containers. Keep
raw storage paths, secrets and error contents out of Discord and logs. Preserve
unrelated application commands during registration; skip unchanged definitions.

For dashboard changes, run the privacy, HTTP and real-origin-TLS tests. Keep the
public data contract explicit on both sides: never export Config, process.env,
telemetry/audit status or SQL rows with SELECT *. The dashboard image must remain
independent of Discord credentials, SQLite and the private volume. New metrics
need a conscious public-data decision. Preserve chart gaps, timestamp-based stale
states, accessible controls and responsive layouts. Put chart arithmetic in
`web/chart-model.js` (no DOM, so `node --test` covers it) and register any new file under
`web/` in the asset map in `src/dashboard-assets.ts`. Keep database work in the
bounded read-only worker. The sample-data preview is development-only and clearly
labelled; production images must not include it. Build with `npm run build` before
`npm run dev`. Fonts are self-hosted from `web/fonts/`; do not add CDN scripts or fonts,
analytics, cookies or a service worker.

For public fallback changes, test primary failures and recovery, cold-start 503s,
timeouts during response bodies, same-origin navigation and missing metric handling.
Keep the VPS image free of private volumes and credentials. Use the shared public
asset loader for branding. `npm test` covers the plain Worker module and the actual
fallback browser module without Cloudflare credentials. CI also builds the VPS
image and runs it with no network, no writable filesystem and a 64 MiB limit.
Keep both VPS Compose modes aligned: the Apache variant differs only by its fixed
loopback port publication, which CI validates. Apache template certificate paths
are placeholders; validate the host's filled-in configuration before reloading.
The dashboard client tests execute the real browser entry module with a small DOM
stub: keep coverage of new visitors with stale exports, clock-based ageing,
temporary failed polls, offline transitions, history loading and recovery.

Keep `compose.disk.yaml` aligned with the default home Compose file: only its empty
read-only capacity mount and fixed container path differ. CI validates both modes
and measures a real bind-mounted filesystem without privileges. Test reserved
blocks, missing mounts, sustained alerts and failed delivery. Never substitute
container filesystem statistics when the requested host mount is absent.
Availability uses timestamp gaps and observed minute buckets, not claimed host
uptime or outage causes. Keep those queries bounded in the existing read-only
worker and preserve the schema/backup version when no stored representation changes.
