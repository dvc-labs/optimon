import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, stat, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { spawnSync, spawn } from 'node:child_process';
import { request as https } from 'node:https';
import { TelemetryStore } from '../dist/telemetry.js';
import { ArchiveReader } from '../dist/history-reader.js';
import { DashboardPublisher } from '../dist/dashboard-publisher.js';
import { queryDashboard } from '../dist/dashboard-query.js';
import {
  parsePublicData,
  PUBLIC_BUCKETS,
  PUBLIC_FILE_LIMIT,
  PUBLIC_HISTORY_MS,
} from '../dist/dashboard-data.js';
import { createDashboard } from '../dist/dashboard-server.js';
import { loadDashboardConfig } from '../dist/dashboard-config.js';
import { snapshot } from './fixtures.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'optiplex-public-'));
  const dataPath = join(directory, 'public');
  const database = join(directory, 'private.sqlite');
  let now = Date.now();
  const store = await TelemetryStore.open(database);
  const publisher = new DashboardPublisher(
    dataPath,
    async () => queryDashboard(store.db, now),
    () => now,
  );
  const sample = () => snapshot({ capturedAt: new Date(now) });
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    dataPath,
    database,
    store,
    publisher,
    sample,
    now: () => now,
    advance: (ms) => {
      now += ms;
    },
  };
}
async function serve(t, f, overrides = {}) {
  const config = {
    ...loadDashboardConfig({ PUBLIC_DATA_PATH: f.dataPath, DASHBOARD_PORT: '0' }),
    host: '127.0.0.1',
    ...overrides,
  };
  const server = await createDashboard(config, f.now);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return { server, url: `http://127.0.0.1:${server.address().port}`, config };
}
test('public projection excludes audit IDs, credentials, addresses and unknown nested fields', async (t) => {
  const f = await fixture(t);
  const secret = 'DO-NOT-PUBLISH-actor-1562643787510063219';
  f.store.startCommand({
    id: 'audit-secret',
    command: 'audit',
    actorId: secret,
    guildId: 'guild-secret',
    channelId: 'channel-secret',
    startedAt: f.now(),
  });
  f.store.recordMetrics([{ at: f.now(), cpu: 10, memory: 20, temperature: 30 }]);
  await f.publisher.publish({
    ...f.sample(),
    token: 'private-token',
    address: '192.168.1.184',
    actorId: secret,
    memory: { ...f.sample().memory, actorId: secret },
    temperatures: [
      { label: 'Core 0', celsius: 31, actorId: secret },
      { label: secret, celsius: 30 },
    ],
  });
  const files = await readdir(f.dataPath);
  assert.deepEqual(files.sort(), ['history.json', 'metrics.json']);
  for (const file of files) {
    const value = await readFile(join(f.dataPath, file), 'utf8');
    for (const marker of [
      secret,
      'private-token',
      '192.168.1.184',
      'guild-secret',
      'channel-secret',
      'actorId',
      'commands',
    ])
      assert.ok(!value.includes(marker), `${file} leaked ${marker}`);
    assert.equal((await stat(join(f.dataPath, file))).mode & 0o777, 0o640);
  }
  assert.ok(
    (await stat(join(f.dataPath, 'metrics.json'))).size < 2048,
    'live updates must not rewrite the history payload',
  );
  const raw = JSON.parse(await readFile(join(f.dataPath, 'metrics.json'), 'utf8'));
  raw.private = 'secret';
  raw.live.secret = 'hidden';
  assert.equal(parsePublicData(raw).private, undefined);
  assert.equal(parsePublicData(raw).live.secret, undefined);
  raw.live.cpuPercent = 101;
  assert.throws(() => parsePublicData(raw));
});
test('public archive keeps bounded chart points, missing buckets and all-time data older than a year', async (t) => {
  const f = await fixture(t);
  f.store.recordMetrics([
    { at: f.now() - 800 * 86400_000, cpu: 80, memory: 70, temperature: 40 },
    { at: f.now() - 120_000, cpu: 10, memory: 20, temperature: 30 },
    { at: f.now() - 60_000, cpu: null, memory: 30, temperature: null },
  ]);
  const result = queryDashboard(f.store.db, f.now());
  assert.equal(result.totalSamples, 3);
  assert.equal(result.windows.length, 7);
  assert.equal(result.windows.find((w) => w.key === '365d').count, 2);
  assert.equal(result.windows.at(-1).count, 3);
  const hour = result.windows[0];
  assert.equal(hour.cpu.mean, 10);
  assert.equal(hour.memory.mean, 25);
  assert.equal(hour.cpu.count, 1);
  for (const window of result.windows) assert.equal(window.points.length, PUBLIC_BUCKETS);
  assert.ok(hour.points.some((p) => p.cpu === null));
  assert.ok(hour.points.some((p) => p.cpu === 10));
  assert.equal(result.firstAt, f.now() - 800 * 86400_000);
});
test('public history runs in the query worker and coalesces with a fixed cache entry', async (t) => {
  const f = await fixture(t);
  const reader = new ArchiveReader(f.database, f.now);
  t.after(() => reader.close());
  f.store.recordMetrics([{ at: f.now(), cpu: 10, memory: 20, temperature: 30 }]);
  const [a, b] = await Promise.all([reader.dashboard(), reader.dashboard()]);
  assert.equal(a.totalSamples, 1);
  a.windows[0].cpu.mean = 99;
  assert.equal(b.windows[0].cpu.mean, 10);
  assert.equal(reader.pending.size, 0);
  assert.equal(reader.cache.size, 1);
});
test('history refresh is five-minute bounded and failure still publishes current live readings', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const p = new DashboardPublisher(
    f.dataPath,
    async () => {
      calls++;
      throw new Error('archive unavailable');
    },
    f.now,
  );
  await assert.rejects(p.publish(f.sample()));
  assert.equal(
    JSON.parse(await readFile(join(f.dataPath, 'metrics.json'), 'utf8')).live.capturedAt,
    f.now(),
  );
  f.advance(60_000);
  await p.publish(f.sample());
  assert.equal(calls, 1);
  f.advance(PUBLIC_HISTORY_MS);
  await assert.rejects(p.publish(f.sample()));
  assert.equal(calls, 2);
});
test('HTTP API reconstructs an allowlist and does not serve private files or arbitrary routes', async (t) => {
  const f = await fixture(t);
  await f.publisher.publish(f.sample());
  const privateId = 'PRIVATE-IDENTIFIER-12345';
  const file = join(f.dataPath, 'metrics.json');
  const raw = JSON.parse(await readFile(file, 'utf8'));
  raw.actorId = privateId;
  raw.live.token = privateId;
  await writeFile(file, JSON.stringify(raw));
  const { url } = await serve(t, f);
  const response = await fetch(`${url}/api/metrics`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  const body = await response.text();
  assert.ok(!body.includes(privateId));
  assert.ok(!body.includes('actorId'));
  assert.equal(JSON.parse(body).status.state, 'live');
  for (const path of [
    '/api/audit',
    '/__preview',
    '/metrics.json',
    '/history.json',
    '/private.sqlite',
    '/.env',
    '/../private.sqlite',
    '/%2e%2e/private.sqlite',
    '//etc/passwd',
    '/assets/../private.sqlite',
  ])
    assert.equal((await fetch(url + path)).status, 404, path);
  const blocked = await fetch(`${url}/api/metrics`, { method: 'POST', body: 'anything' });
  assert.equal(blocked.status, 405);
  assert.equal(blocked.headers.get('allow'), 'GET, HEAD');
  const head = await fetch(url, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});
test('missing exports return 503, retained values become stale, and an invalid export cannot replace validated data', async (t) => {
  const f = await fixture(t);
  const { url } = await serve(t, f);
  assert.equal((await fetch(`${url}/api/metrics`)).status, 503);
  await f.publisher.publish(f.sample());
  f.advance(5001);
  assert.equal((await (await fetch(`${url}/api/metrics`)).json()).status.state, 'live');
  await writeFile(join(f.dataPath, 'metrics.json'), 'broken');
  f.advance(180_001);
  const stale = await (await fetch(`${url}/api/metrics`)).json();
  assert.equal(stale.status.state, 'stale');
  assert.equal(stale.data.live.cpuPercent, 5);
});
test('oversized or symlinked exports fail without following a path outside the public volume', async (t) => {
  const f = await fixture(t);
  await f.publisher.publish(f.sample());
  await writeFile(join(f.dataPath, 'metrics.json'), ' '.repeat(PUBLIC_FILE_LIMIT + 1));
  let endpoint = await serve(t, f);
  assert.equal((await fetch(`${endpoint.url}/api/metrics`)).status, 503);
  await rm(join(f.dataPath, 'metrics.json'));
  await symlink(f.database, join(f.dataPath, 'metrics.json'));
  endpoint = await serve(t, f);
  assert.equal((await fetch(`${endpoint.url}/api/metrics`)).status, 503);
});
test('HTML includes escaped canonical/social URLs, usable assets, CSP and a real 1200x630 PNG', async (t) => {
  const f = await fixture(t);
  const { url } = await serve(t, f);
  const response = await fetch(url);
  const html = await response.text();
  assert.ok(html.includes('https://dashboard.davevancauwenberghe.be/assets/preview.png'));
  assert.ok(!html.includes('__PUBLIC_URL__'));
  assert.ok(html.includes('summary_large_image'));
  assert.ok(html.includes('width=device-width'));
  assert.ok(!html.includes('manifest'));
  assert.ok(response.headers.get('content-security-policy').includes("script-src 'self'"));
  assert.ok(!response.headers.get('content-security-policy').includes('unsafe-inline'));
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.ok(response.headers.get('x-robots-tag').includes('noindex'));
  const png = Buffer.from(await (await fetch(`${url}/assets/preview.png`)).arrayBuffer());
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
  for (const path of [
    '/assets/dashboard.css',
    '/assets/dashboard.js',
    '/favicon.svg',
    '/robots.txt',
    '/healthz',
  ])
    assert.equal((await fetch(url + path)).status, 200);
});
test('dashboard configuration rejects incomplete TLS and unsafe canonical URLs', () => {
  for (const url of [
    'http://example.com',
    'https://user:secret@example.com',
    'https://example.com/path',
    'https://example.com/?x=1',
  ])
    assert.throws(() => loadDashboardConfig({ DASHBOARD_PUBLIC_URL: url }));
  assert.throws(() => loadDashboardConfig({ DASHBOARD_TLS_CERT: '/only-cert.pem' }));
  assert.throws(() => loadDashboardConfig({ PUBLIC_DATA_PATH: 'relative' }));
  assert.throws(() => loadDashboardConfig({ DASHBOARD_PORT: 'NaN' }));
});
test('HTTPS and the healthcheck verify the origin certificate hostname and trust chain', async (t) => {
  const f = await fixture(t);
  await f.publisher.publish(f.sample());
  const cert = join(f.directory, 'cert.pem'),
    key = join(f.directory, 'key.pem');
  const generated = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '1',
      '-subj',
      '/CN=dashboard.test',
      '-addext',
      'subjectAltName=DNS:dashboard.test',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(generated.status, 0, generated.stderr);
  const { server } = await serve(t, f, {
    tls: { cert, key, ca: cert },
    publicUrl: 'https://dashboard.test',
  });
  const request = (servername) =>
    new Promise((resolve, reject) => {
      const req = https(
        {
          hostname: '127.0.0.1',
          port: server.address().port,
          path: '/healthz',
          servername,
          ca: undefined,
        },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      req.on('error', reject);
      req.end();
    });
  await assert.rejects(request('dashboard.test'));
  const ca = await readFile(cert);
  const status = await new Promise((resolve, reject) => {
    const req = https(
      {
        hostname: '127.0.0.1',
        port: server.address().port,
        path: '/healthz',
        servername: 'dashboard.test',
        ca,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 200);
  await assert.rejects(
    new Promise((resolve, reject) => {
      const req = https(
        {
          hostname: '127.0.0.1',
          port: server.address().port,
          path: '/healthz',
          servername: 'wrong.test',
          ca,
        },
        (res) => {
          res.resume();
          resolve();
        },
      );
      req.on('error', reject);
      req.end();
    }),
  );
  const child = spawn(process.execPath, ['dist/dashboard-healthcheck.js'], {
    cwd: resolve('.'),
    env: {
      PATH: process.env.PATH,
      DASHBOARD_PUBLIC_URL: 'https://dashboard.test',
      DASHBOARD_PORT: String(server.address().port),
      PUBLIC_DATA_PATH: f.dataPath,
      DASHBOARD_TLS_CERT: cert,
      DASHBOARD_TLS_KEY: key,
      DASHBOARD_TLS_CA: cert,
    },
    stdio: 'pipe',
  });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0);
});
