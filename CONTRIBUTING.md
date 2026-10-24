# Contributing

Keep changes small and explain the resulting behaviour in a pull request.

1. Use Node.js 24.x (24.22.1 or newer) and run `npm ci --ignore-scripts --engine-strict`.
2. Copy `.env.example` to `.env` only if testing with your own Discord application.
   Never reuse production credentials in CI or commit secrets.
3. Run `npm test` and `npm run check`. Add focused tests for changed parsing,
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
