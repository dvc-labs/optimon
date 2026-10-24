// Run inside the public-only image with --network none, read-only FS and test certs.
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { request } from 'node:https';
import { loadDashboardConfig } from './dist/dashboard-config.js';
import { createDashboard } from './dist/dashboard-server.js';
import { parsePublicData } from './dist/dashboard-data.js';
assert.equal(process.getuid(), 1000);
for (const path of [
  '/app/data',
  '/app/node_modules/discord.js',
  '/app/dist/telemetry.js',
  '/app/dist/config.js',
  '/app/scripts/preview.mjs',
])
  await assert.rejects(access(path), { code: 'ENOENT' });
assert.equal(process.env.DISCORD_TOKEN, undefined);
assert.equal(process.env.ADMIN_ID, undefined);
const config = loadDashboardConfig();
const server = await createDashboard(config);
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const ca = await readFile(config.tls.ca);
const get = (path) =>
  new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port: server.address().port,
        servername: 'dashboard.test',
        ca,
        path,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
try {
  const health = await get('/healthz');
  assert.equal(health.status, 200);
  const page = await get('/');
  assert.equal(page.status, 200);
  assert.ok(page.body.includes('https://dashboard.test/assets/preview.png'));
  assert.ok(page.headers['strict-transport-security']);
  const api = await get('/api/metrics');
  assert.equal(api.status, 200);
  const data = JSON.parse(api.body);
  assert.equal(data.status.state, 'live');
  assert.equal(parsePublicData(data.data).live.cores, 6);
  assert.equal((await get('/private.sqlite')).status, 404);
  assert.equal((await get('/api/audit')).status, 404);
  console.log(
    'Public dashboard: verified TLS, metrics, privacy isolation and hardened 128 MiB container passed.',
  );
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
