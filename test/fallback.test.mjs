import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFallback, loadFallbackConfig } from '../dist/fallback-server.js';
import { createDashboard } from '../dist/dashboard-server.js';
import { loadDashboardConfig } from '../dist/dashboard-config.js';
import { handleRequest } from '../deploy/worker.mjs';
import { hasFreshReading, isFallbackResponse } from '../web/availability.js';

const env = {
  DASHBOARD_PUBLIC_URL: 'https://dashboard.test',
  FALLBACK_ORIGIN: 'https://fallback.test',
  ORIGIN_TIMEOUT_MS: '100',
};
const get = (path = '/', init) => new Request(env.DASHBOARD_PUBLIC_URL + path, init);
const fallbackResponse = (body = 'fallback page', status = 200, headers = {}) =>
  new Response(body, { status, headers: { 'X-Optimon-Origin': 'fallback', ...headers } });

async function listen(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => close(server));
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
  server.closeAllConnections();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
}

test('the VPS serves matching self-hosted branding, valid assets and an uncacheable offline page', async (t) => {
  const config = loadFallbackConfig({
    DASHBOARD_PUBLIC_URL: env.DASHBOARD_PUBLIC_URL,
    FALLBACK_PORT: '0',
  });
  const base = await listen(t, await createFallback(config));
  const response = await fetch(base);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-optimon-origin'), 'fallback');
  assert.equal(response.headers.get('x-optimon-fallback'), '1');
  assert.ok(response.headers.get('content-security-policy').includes("script-src 'self'"));
  assert.ok(!response.headers.get('content-security-policy').includes('unsafe-inline'));
  assert.ok(html.includes('optiplex is currently unreachable.'));
  assert.ok(html.includes('href="https://dashboard.test/"'));
  assert.ok(html.includes('summary_large_image'));
  assert.ok(!html.includes('__ASSET_VERSION__'));
  assert.ok(!html.includes('__PUBLIC_URL__'));
  assert.ok(!html.includes('0°C'));
  const paths = [...html.matchAll(/(?:href|src)="((?:\/assets\/|\/fallback-assets\/)[^"]+)"/g)].map(
    (m) => m[1],
  );
  assert.ok(paths.length >= 5);
  for (const path of paths) {
    const asset = await fetch(base + path);
    assert.equal(asset.status, 200, path);
    assert.ok((await asset.arrayBuffer()).byteLength > 0);
  }
  const css = await (await fetch(base + '/assets/dashboard.css')).text();
  assert.ok(css.includes("font-family: 'League Spartan'"));
  assert.ok(css.includes('letter-spacing: -0.082em'));
  assert.ok(css.includes('--paper: #000000'));
  for (const match of css.matchAll(/url\('([^']+)'\)/g))
    assert.equal((await fetch(new URL(match[1], base + '/assets/dashboard.css'))).status, 200);
  const font = await (await fetch(base + '/assets/fonts/league-spartan-bold.woff2')).arrayBuffer();
  assert.deepEqual(Buffer.from(font), await readFile('web/fonts/league-spartan-bold.woff2'));
  const conditional = await fetch(base, {
    headers: { 'If-None-Match': response.headers.get('etag') },
  });
  assert.equal(conditional.status, 200, 'offline HTML must never become an online-page 304');
  const head = await fetch(base, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});

test('fallback health is separate from absent metrics and no private path or method is served', async (t) => {
  const base = await listen(t, await createFallback(loadFallbackConfig({ FALLBACK_PORT: '0' })));
  assert.deepEqual(await (await fetch(base + '/healthz')).json(), { ok: true, mode: 'fallback' });
  for (const path of ['/api/live', '/api/metrics', '/api/history']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const data = await response.json();
    assert.equal(data.data, null);
    assert.equal(data.status.state, 'unavailable');
    assert.equal(hasFreshReading(data), false);
  }
  for (const path of [
    '/.env',
    '/api/audit',
    '/metrics.json',
    '/optiplex.sqlite',
    '/%2e%2e/private.sqlite',
  ])
    assert.equal((await fetch(base + path)).status, 404, path);
  const post = await fetch(base, { method: 'POST', body: 'not accepted' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, HEAD');
  assert.equal(loadFallbackConfig({}).host, '127.0.0.1');
  for (const invalid of [
    { FALLBACK_PORT: '-1' },
    { FALLBACK_BIND: 'hostname' },
    { DASHBOARD_PUBLIC_URL: 'http://example.com' },
  ])
    assert.throws(() => loadFallbackConfig(invalid));
});

test('the Worker passes healthy home responses and validators without forwarding visitor credentials', async () => {
  const calls = [];
  const response = await handleRequest(
    get('/api/live', {
      headers: {
        Cookie: 'session=private',
        Authorization: 'Bearer private',
        'If-None-Match': '"home"',
      },
    }),
    env,
    async (request) => {
      calls.push(request);
      return new Response('{"home":true}', {
        headers: { 'Cache-Control': 'no-store', 'Set-Cookie': 'unexpected=1' },
      });
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://dashboard.test/api/live');
  assert.equal(calls[0].redirect, 'manual');
  assert.equal(calls[0].headers.get('cookie'), null);
  assert.equal(calls[0].headers.get('authorization'), null);
  assert.equal(calls[0].headers.get('accept-encoding'), 'identity');
  assert.equal(calls[0].headers.get('if-none-match'), '"home"');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(isFallbackResponse(response), false);
  assert.equal(await response.text(), '{"home":true}');
  for (const status of [304, 404, 429]) {
    let count = 0;
    const passed = await handleRequest(get('/assets/dashboard.css'), env, async () => {
      count++;
      return new Response(null, { status });
    });
    assert.equal(passed.status, status);
    assert.equal(count, 1);
  }
});

test('decoded upstream bytes are not returned with stale compression or length headers', async () => {
  const response = await handleRequest(
    get('/assets/dashboard.css'),
    env,
    async () =>
      new Response('body { color: white; }', {
        headers: {
          'Content-Type': 'text/css',
          'Content-Encoding': 'gzip',
          'Content-Length': '10',
          Connection: 'keep-alive',
          'Keep-Alive': 'timeout=5',
        },
      }),
  );
  assert.equal(await response.text(), 'body { color: white; }');
  for (const name of ['content-encoding', 'content-length', 'connection', 'keep-alive'])
    assert.equal(response.headers.get(name), null);
});

test('gateway errors fall back at the same public URL and remove the home HTML validator', async () => {
  for (const status of [500, 502, 503, 504, 530]) {
    const calls = [];
    const request = get('/?v=old', { headers: { 'If-None-Match': '"old-home-page"' } });
    const response = await handleRequest(request, env, async (next) => {
      calls.push(next);
      return calls.length === 1 ? new Response('upstream failed', { status }) : fallbackResponse();
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'fallback page');
    assert.equal(calls[1].url, 'https://fallback.test/?v=old');
    assert.equal(calls[1].headers.get('if-none-match'), null);
    assert.equal(request.url, 'https://dashboard.test/?v=old');
    assert.equal(response.headers.get('location'), null);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(isFallbackResponse(response), true);
  }
});

test('a healthy home app waiting for its first export stays on its own dashboard', async () => {
  let calls = 0;
  const response = await handleRequest(get('/api/live'), env, async () => {
    calls++;
    return new Response('{"status":{"state":"unavailable"},"data":null}', {
      status: 503,
      headers: { 'X-Optimon-Origin': 'dashboard', 'Content-Type': 'application/json' },
    });
  });
  assert.equal(response.status, 503);
  assert.equal(calls, 1);
  assert.equal(isFallbackResponse(response), false);
});

test('connection failures, header timeouts and stalled response bodies are bounded', async () => {
  for (const failure of ['connection', 'headers', 'body', 'oversized']) {
    let calls = 0;
    let aborted = false;
    const response = await handleRequest(get(), env, async (request) => {
      calls++;
      if (calls > 1) return fallbackResponse();
      request.signal.addEventListener('abort', () => {
        aborted = true;
      });
      if (failure === 'connection') throw new Error('private diagnostic must not escape');
      if (failure === 'headers') return new Promise(() => {});
      if (failure === 'body') return new Response(new ReadableStream({ start() {} }));
      return new Response('x', { headers: { 'Content-Length': '1048577' } });
    });
    assert.equal(response.status, 200, failure);
    assert.equal(await response.text(), 'fallback page', failure);
    assert.equal(aborted, true, failure);
    assert.equal(calls, 2, failure);
  }
});

test('fallback-specific assets always use the VPS, including while home is recovering', async () => {
  const calls = [];
  const response = await handleRequest(
    get('/fallback-assets/fallback.js?v=version'),
    env,
    async (request) => {
      calls.push(request.url);
      return fallbackResponse('script', 200, {
        'Cache-Control': 'public, max-age=31536000, immutable',
      });
    },
  );
  assert.deepEqual(calls, ['https://fallback.test/fallback-assets/fallback.js?v=version']);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'script');
});

test('invalid configuration, unsafe requests and both origins down fail closed without raw errors', async () => {
  const never = () => {
    throw new Error('must not fetch');
  };
  for (const invalid of [
    {},
    { ...env, FALLBACK_ORIGIN: env.DASHBOARD_PUBLIC_URL },
    { ...env, FALLBACK_ORIGIN: 'https://dashboard.test:8443' },
    { ...env, FALLBACK_ORIGIN: 'http://fallback.test' },
    { ...env, FALLBACK_ORIGIN: 'https://user:secret@fallback.test' },
    { ...env, ORIGIN_TIMEOUT_MS: 'Infinity' },
    { ...env, ORIGIN_TIMEOUT_MS: '100000' },
  ])
    assert.equal((await handleRequest(get(), invalid, never)).status, 503);
  for (const path of ['/.env', '/api/audit', '/%2e%2e/private.sqlite'])
    assert.equal((await handleRequest(get(path), env, never)).status, 404);
  assert.equal((await handleRequest(new Request('https://other.test/'), env, never)).status, 404);
  const httpsOnly = await handleRequest(
    new Request('http://dashboard.test/?view=current'),
    env,
    never,
  );
  assert.equal(httpsOnly.status, 308);
  assert.equal(httpsOnly.headers.get('location'), 'https://dashboard.test/?view=current');
  assert.equal(
    (await handleRequest(get('/', { method: 'POST', body: 'ignored' }), env, never)).status,
    405,
  );
  const failed = await handleRequest(get('/api/live'), env, () => {
    throw new Error('secret');
  });
  assert.equal(failed.status, 503);
  assert.equal((await failed.json()).data, null);
  const head = await handleRequest(get('/', { method: 'HEAD' }), env, () => {
    throw new Error('secret');
  });
  assert.equal(head.status, 503);
  assert.equal(await head.text(), '');
  const unexpected = await handleRequest(get(), env, async (request) =>
    new URL(request.url).hostname === 'dashboard.test'
      ? new Response('bad gateway', { status: 502 })
      : new Response('wrong app or challenge page'),
  );
  assert.equal(unexpected.status, 503);
  assert.ok(!(await unexpected.text()).includes('wrong app'));
});

test('recovery requires a fresh real sample, not just a reachable web server', () => {
  const live = { status: { state: 'live', ageSeconds: 1 }, data: { schema: 1 } };
  assert.equal(hasFreshReading(live), true);
  for (const payload of [
    null,
    {},
    { data: null },
    { ...live, status: { state: 'stale', ageSeconds: 300 } },
    { ...live, status: { state: 'live', ageSeconds: 181 } },
    { ...live, status: { state: 'live', ageSeconds: NaN } },
  ])
    assert.equal(hasFreshReading(payload), false);
});

test('real home and VPS HTTP services fail over and recover behind the same Worker request URL', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'optimon-failover-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    join(directory, 'metrics.json'),
    JSON.stringify({
      schema: 1,
      version: '0.3.1',
      generatedAt: Date.now(),
      thermalWarnC: 80,
      thermalRecoverC: 75,
      history: null,
      live: {
        capturedAt: Date.now(),
        hostUptime: 100,
        botUptime: 30,
        cpuPercent: 0,
        cores: 6,
        memory: null,
        swap: null,
        load: [0, 0, 0],
        temperatures: [],
      },
    }),
  );
  const home = await createDashboard(loadDashboardConfig({ PUBLIC_DATA_PATH: directory }));
  let homeUrl = await listen(t, home);
  const fallbackUrl = await listen(t, await createFallback(loadFallbackConfig({})));
  const bridge = (request) => {
    const url = new URL(request.url);
    const target =
      (url.hostname === 'dashboard.test' ? homeUrl : fallbackUrl) + url.pathname + url.search;
    return fetch(new Request(target, request));
  };
  const config = { ...env, ORIGIN_TIMEOUT_MS: '1000' };
  let response = await handleRequest(get('/api/live'), config, bridge);
  let data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(hasFreshReading(data), true);
  assert.equal(data.data.live.cpuPercent, 0, 'a measured zero is a valid sample');
  await close(home);
  response = await handleRequest(get(), config, bridge);
  assert.equal(response.status, 200);
  assert.ok((await response.text()).includes('optiplex is currently unreachable.'));
  response = await handleRequest(get('/api/live'), config, bridge);
  assert.equal(response.status, 503);
  assert.equal(isFallbackResponse(response), true);
  assert.equal((await response.json()).data, null, 'an outage is not a zero-valued sample');
  homeUrl = await listen(t, home);
  response = await handleRequest(get('/api/live'), config, bridge);
  data = await response.json();
  assert.equal(hasFreshReading(data), true);
  assert.equal(isFallbackResponse(response), false);
  response = await handleRequest(get(), config, bridge);
  assert.ok((await response.text()).includes('Loading the latest reading.'));
});
