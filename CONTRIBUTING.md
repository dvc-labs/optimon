# Contributing

Keep changes small and explain the resulting behaviour in a pull request.

1. Use Node.js 24.x (24.17 or newer) and run `npm ci --ignore-scripts`.
2. Copy `.env.example` to `.env` only if testing with your own Discord application.
   Never reuse production credentials in CI or commit secrets.
3. Run `npm test` and `npm run check`. Add focused tests for changed parsing,
   scheduling, delivery or security behaviour.
4. For a release, update `package.json`, its lockfile and the README version.
   The bot's version and shared footer are derived from `package.json`.

Preserve the shared embed builder, explicit host/bot uptime distinction, optional
webhook behaviour and least-privilege deployment. Never add public ports, a Docker
socket mount or privileged mode just to collect a metric. Document additional
host reads and permissions before proposing them.
