import test from 'node:test';
import assert from 'node:assert/strict';
import { ExternalHeartbeat } from '../dist/heartbeat.js';
import { safeError } from '../dist/log.js';
import { config } from './fixtures.mjs';

test('the external heartbeat is disabled by default and performs no requests', async () => {
  let calls = 0;
  const heartbeat = new ExternalHeartbeat(null, async () => {
    calls++;
    throw new Error('must not fetch');
  });
  await heartbeat.ping();
  assert.equal(config().heartbeatUrl, null);
  assert.deepEqual(heartbeat.status(), { enabled: false, lastSuccessAt: null, failures: 0 });
  assert.equal(calls, 0);
});

test('heartbeat requests use HTTPS, no redirects and a bounded abort signal without sending metrics', async () => {
  const url = 'https://example.invalid/ping/private-fixture?token=secret-fixture';
  assert.equal(config({ HEARTBEAT_URL: url }).heartbeatUrl, url);
  let calls = 0;
  let cancelled = false;
  const heartbeat = new ExternalHeartbeat(url, async (target, options) => {
    calls++;
    assert.equal(target, url);
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.body, undefined);
    assert.equal(options.signal.aborted, false);
    return {
      ok: true,
      status: 200,
      body: {
        cancel: async () => {
          cancelled = true;
        },
      },
    };
  });
  await heartbeat.ping();
  assert.equal(calls, 1);
  assert.equal(cancelled, true);
  assert.ok(heartbeat.status().lastSuccessAt);
  assert.equal(heartbeat.status().failures, 0);
  assert.ok(!JSON.stringify(heartbeat.status()).includes(url));
  heartbeat.stop();
  await heartbeat.ping();
  assert.equal(calls, 1);
});

test('invalid heartbeat configuration rejects safely without echoing a secret URL', () => {
  for (const url of [
    'http://example.invalid/secret',
    'https://user:password@example.invalid/secret',
    'https://example.invalid/secret#fragment',
    'not-a-url-with-a-secret',
  ]) {
    assert.throws(
      () => config({ HEARTBEAT_URL: url }),
      (error) => {
        assert.match(error.message, /HTTPS URL/);
        assert.ok(!error.message.includes(url));
        assert.ok(!error.message.includes('password'));
        return true;
      },
    );
  }
});

test('heartbeat rejections and network failures increment counters without exposing the endpoint', async () => {
  let attempt = 0;
  const secret = 'https://example.invalid/private-fixture';
  const heartbeat = new ExternalHeartbeat(secret, async () => {
    if (attempt++ === 0) return new Response(null, { status: 503 });
    throw new TypeError(`request failed for ${secret}`);
  });
  await assert.rejects(heartbeat.ping(), { name: 'HeartbeatRejected', status: 503 });
  await assert.rejects(heartbeat.ping(), (error) => {
    assert.ok(!JSON.stringify(safeError(error)).includes(secret));
    return true;
  });
  assert.equal(heartbeat.status().failures, 2);
  assert.equal(heartbeat.status().lastSuccessAt, null);
});

test('shutdown aborts an in-flight heartbeat without recording an outage-send failure', async () => {
  let signal;
  const heartbeat = new ExternalHeartbeat('https://example.invalid/fixture', async (_, options) => {
    signal = options.signal;
    return new Promise((_, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
    );
  });
  const pending = heartbeat.ping();
  heartbeat.stop();
  await pending;
  assert.equal(signal.aborted, true);
  assert.equal(heartbeat.status().failures, 0);
});
