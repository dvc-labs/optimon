// Run in the VPS-only image: no network, writable filesystem, private volume or credentials.
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createFallback, loadFallbackConfig } from './dist/fallback-server.js';

assert.equal(process.getuid(), 1000);
for (const path of [
  '/app/data',
  '/app/public-data',
  '/app/node_modules',
  '/app/dist/telemetry.js',
  '/app/dist/dashboard-data.js',
  '/app/dist/config.js',
  '/app/scripts',
  '/app/deploy',
])
  await assert.rejects(access(path), { code: 'ENOENT' });
assert.equal(process.env.DISCORD_TOKEN, undefined);
assert.equal(process.env.ADMIN_ID, undefined);
const server = await createFallback(loadFallbackConfig({ FALLBACK_PORT: '0' }));
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
try {
  const html = await (await fetch(base)).text();
  assert.ok(html.includes('optiplex is currently unreachable.'));
  assert.ok(html.includes('fallback-assets/fallback.js'));
  const response = await fetch(base + '/api/live');
  assert.equal(response.status, 503);
  assert.equal((await response.json()).data, null);
  assert.equal((await fetch(base + '/healthz')).status, 200);
  assert.equal((await fetch(base + '/assets/fonts/league-spartan-bold.woff2')).status, 200);
  // Docker healthchecks launch a second Node process inside the same memory/PID cgroup.
  const probe = spawn(process.execPath, ['dist/fallback-healthcheck.js'], {
    env: { ...process.env, FALLBACK_PORT: String(server.address().port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const [code] = await once(probe, 'exit');
  assert.equal(code, 0, 'the real health probe must fit alongside the running server');
  console.log(
    'VPS fallback: branding, absent metrics, real health probe and isolated 64 MiB container passed.',
  );
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
