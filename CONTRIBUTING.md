# Contributing

Keep changes small and explain the resulting behaviour in a pull request.

1. Use Node.js 24.x (24.22.1 or newer) and run `npm ci --ignore-scripts --engine-strict`.
2. Copy `.env.example` to `.env` only if testing with your own Discord application.
   Never reuse production credentials in CI or commit secrets.
3. Run `npm test`, `npm run check`, `npm run lint` and `npm run format:check`.
   Use `npm run format` for Prettier formatting. Oxlint uses TypeScript 7 type-aware
   promise rules; intentionally discarded promises still need a rejection handler. Add focused tests for changed parsing,
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

SQLite retains every sample and command audit record on the local data volume.
Keep schema versions and imports transactional and idempotent; migration must
survive process termination before and after commit. Use WAL, full synchronous
commits and a bounded busy timeout. Do not move storage onto network filesystems
or load the unbounded archive into RAM. Keep the recent cache and failed-write
retry buffer capped, and show storage/delivery failures in owner diagnostics.

Test post-ready sampling → alert → delivery, failure retries and shutdown ordering
with injected Discord/heartbeat delivery, never real services. Test SIGKILL recovery,
legacy migration, corrupt-data quarantine, audit authorization and outcomes, gaps
and comparison boundaries, and consistent live SQLite backups. The container check
must reuse a local named volume between two non-root, read-only containers. Keep
raw storage paths, secrets and error contents out of Discord and logs. Preserve
unrelated application commands during registration; skip unchanged definitions.
