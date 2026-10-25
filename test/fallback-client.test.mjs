import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

let instance = 0;
async function client(t, fetcher) {
  const scheduled = new Map();
  const elements = new Map();
  const listeners = new Map();
  const destinations = [];
  let next = 0;
  const element = (id) => {
    if (!elements.has(id))
      elements.set(id, {
        hidden: true,
        disabled: false,
        textContent: '',
        innerHTML: '',
        listeners: new Map(),
        addEventListener(name, fn) {
          this.listeners.set(name, fn);
        },
        showModal() {},
        close() {},
      });
    return elements.get(id);
  };
  const document = {
    hidden: false,
    getElementById: element,
    addEventListener: (name, fn) => listeners.set(name, fn),
  };
  const originals = new Map(
    ['document', 'window'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
  );
  globalThis.document = document;
  globalThis.window = {
    location: { replace: (path) => destinations.push(path) },
    addEventListener: (name, fn) => listeners.set(name, fn),
  };
  t.after(() => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  t.mock.method(globalThis, 'setTimeout', (fn, ms) => {
    scheduled.set(++next, { fn, ms });
    return next;
  });
  t.mock.method(globalThis, 'clearTimeout', (id) => scheduled.delete(id));
  t.mock.method(globalThis, 'fetch', fetcher);
  const path = new URL('../web/availability.js', import.meta.url).href;
  const source = (
    await readFile(new URL('../fallback/fallback.js', import.meta.url), 'utf8')
  ).replace('/assets/availability.js?v=__ASSET_VERSION__', path);
  await import(
    `data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${++instance}`
  );
  return {
    element,
    document,
    scheduled,
    listeners,
    destinations,
    check: () => element('retry').listeners.get('click')(),
  };
}

test('the real fallback client polls without cookies and returns home only after a fresh sample', async (t) => {
  let response = { status: { state: 'stale', ageSeconds: 900 }, data: { schema: 1 } };
  let fallback = false;
  const calls = [];
  const ui = await client(t, async (path, options) => {
    calls.push({ path, options });
    return new Response(JSON.stringify(response), {
      headers: fallback ? { 'X-Optimon-Fallback': '1' } : {},
    });
  });
  assert.equal(ui.element('retry').hidden, false);
  assert.equal(ui.element('refresh').hidden, true);
  assert.equal(ui.element('privacy-open').hidden, false);
  assert.ok([...ui.scheduled.values()].some((timer) => timer.ms === 30_000));
  const automatic = [...ui.scheduled.values()].find((timer) => timer.ms === 30_000);
  await automatic.fn();
  assert.deepEqual(ui.destinations, []);
  response = { status: { state: 'live', ageSeconds: 0 }, data: { schema: 1 } };
  fallback = true;
  await ui.check();
  assert.deepEqual(ui.destinations, [], 'an offline-origin response is never live');
  fallback = false;
  await ui.check();
  assert.deepEqual(ui.destinations, ['/']);
  for (const call of calls) {
    assert.equal(call.path, '/api/live');
    assert.equal(call.options.credentials, 'omit');
    assert.equal(call.options.cache, 'no-store');
    assert.equal(call.options.redirect, 'error');
  }
});

test('the fallback client bounds requests, avoids overlapping checks and stops while hidden', async (t) => {
  let resolve;
  let calls = 0;
  let signal;
  const ui = await client(t, (_path, options) => {
    calls++;
    signal = options.signal;
    return new Promise((done) => {
      resolve = done;
    });
  });
  const pending = ui.check();
  await ui.check();
  assert.equal(calls, 1);
  assert.equal(ui.element('retry').disabled, true);
  assert.ok([...ui.scheduled.values()].some((timer) => timer.ms === 8000));
  ui.document.hidden = true;
  ui.listeners.get('visibilitychange')();
  assert.equal(signal.aborted, true);
  await ui.check();
  assert.equal(calls, 1);
  resolve(new Response('{"status":{"state":"live","ageSeconds":0},"data":{"schema":1}}'));
  await pending;
  assert.deepEqual(ui.destinations, []);
  assert.equal(ui.scheduled.size, 0);
});

test('failed recovery checks show a safe message and keep the retry available', async (t) => {
  const ui = await client(t, async () => {
    throw new Error('private-network-detail');
  });
  await ui.check();
  assert.equal(ui.element('retry').disabled, false);
  assert.ok(ui.element('retry-status').textContent.includes('Checking again in 30 seconds'));
  assert.ok(!ui.element('retry-status').textContent.includes('private-network-detail'));
  assert.ok([...ui.scheduled.values()].some((timer) => timer.ms === 30_000));
});
