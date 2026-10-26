import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';

let instance = 0;
const MINUTE = 60_000;
function reading(ageSeconds = 0, overrides = {}) {
  const at = Date.now() - ageSeconds * 1000;
  return {
    status: { state: ageSeconds > 180 ? 'stale' : 'live', ageSeconds },
    data: {
      schema: 1,
      version: '0.3.1',
      generatedAt: at,
      historyGeneratedAt: at,
      thermalWarnC: 80,
      thermalRecoverC: 75,
      live: {
        capturedAt: at,
        hostUptime: 3600,
        botUptime: 600,
        cpuPercent: 4.2,
        cores: 6,
        memory: { used: 1024 ** 3, total: 8 * 1024 ** 3, available: 7 * 1024 ** 3, percent: 12.5 },
        swap: null,
        load: [0.1, 0.2, 0.3],
        temperatures: [{ label: 'Package id 0', celsius: 31 }],
        ...overrides,
      },
      history: { firstAt: at - 10 * MINUTE },
    },
  };
}
function history(at) {
  const aggregate = { count: 2, min: 4, mean: 4.5, max: 5 };
  return {
    generatedAt: at,
    firstAt: at - 10 * MINUTE,
    lastAt: at,
    windows: [
      {
        key: 'all',
        from: at - 10 * MINUTE,
        to: at + 1,
        count: 2,
        cpu: aggregate,
        memory: aggregate,
        temperature: aggregate,
        points: [0, 1].map((i) => ({
          at: at - i * MINUTE,
          cpu: 4 + i,
          memory: 12,
          temperature: 31,
        })),
      },
    ],
  };
}

/** Run the actual entry module: imports, polling, status changes and history rendering. */
async function client(t, fetcher) {
  const scheduled = new Map();
  const intervals = new Map();
  const elements = new Map();
  let sequence = 0;
  let now = 1000;
  const node = () => ({
    hidden: false,
    textContent: '',
    dataset: {},
    style: {},
    children: [],
    parentElement: { toggleAttribute() {} },
    clientWidth: 640,
    clientHeight: 280,
    addEventListener() {},
    setAttribute() {},
    toggleAttribute() {},
    replaceChildren(...children) {
      this.children = children;
    },
    append(...children) {
      this.children.push(...children);
    },
    showModal() {},
    close() {},
    contains() {
      return false;
    },
  });
  const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) elements.set(match[1], node());
  const element = (id) => {
    assert.ok(elements.has(id), `dashboard element ${id} exists in the real HTML`);
    return elements.get(id);
  };
  const document = {
    hidden: false,
    body: { dataset: {} },
    getElementById: element,
    querySelectorAll: () => [],
    addEventListener() {},
    createElement: node,
    createElementNS: node,
  };
  const globals = {
    document,
    window: { addEventListener() {} },
    ResizeObserver: class {
      observe() {}
    },
    requestAnimationFrame() {},
    cancelAnimationFrame() {},
  };
  const originals = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  Object.assign(globalThis, globals);
  t.after(() => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  t.mock.method(globalThis, 'setTimeout', (fn, ms) => {
    scheduled.set(++sequence, { fn, ms });
    return sequence;
  });
  t.mock.method(globalThis, 'clearTimeout', (id) => scheduled.delete(id));
  t.mock.method(globalThis, 'setInterval', (fn, ms) => {
    intervals.set(++sequence, { fn, ms });
    return sequence;
  });
  t.mock.method(performance, 'now', () => now);
  t.mock.method(globalThis, 'fetch', fetcher);
  let source = await readFile(new URL('../web/dashboard.js', import.meta.url), 'utf8');
  for (const file of ['chart-model.js', 'availability.js'])
    source = source.replace(
      `./${file}?v=__ASSET_VERSION__`,
      new URL(`../web/${file}`, import.meta.url).href,
    );
  source += '\n//# sourceURL=optimon-dashboard-client.js';
  await import(
    `data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${++instance}`
  );
  await setImmediate();
  return {
    element,
    document,
    async poll() {
      const timer = [...scheduled].find(([, timer]) => timer.ms === 30_000);
      assert.ok(timer, 'the real client scheduled its next poll');
      scheduled.delete(timer[0]);
      await timer[1].fn();
    },
    tick(ms) {
      now += ms;
      for (const timer of intervals.values()) timer.fn();
    },
  };
}

test('a new visitor with a three-day-old export sees labelled stale readings and loaded history', async (t) => {
  const payload = reading(3 * 86400);
  let historyCalls = 0;
  const ui = await client(t, async (path) => {
    if (path === '/api/history') historyCalls++;
    return Response.json(path === '/api/history' ? history(payload.data.generatedAt) : payload);
  });
  assert.equal(ui.document.body.dataset.state, 'stale');
  assert.equal(ui.element('verdict').textContent, 'No fresh readings.');
  assert.match(ui.element('reading-age').textContent, /Last recorded readings.*3 days ago/);
  assert.equal(ui.element('reading-age').hidden, false);
  assert.equal(ui.element('current-readings').hidden, false);
  assert.equal(historyCalls, 1);
  assert.ok(ui.element('table-body').children.length > 0, 'history renders after the stale state');
});

test('an open tab turns stale as readings age even if the next export never arrives', async (t) => {
  const payload = reading();
  const ui = await client(t, async (path) =>
    Response.json(path === '/api/history' ? history(payload.data.generatedAt) : payload),
  );
  assert.equal(ui.document.body.dataset.state, 'live');
  ui.tick(190_000);
  assert.equal(ui.document.body.dataset.state, 'stale');
  assert.match(ui.element('reading-age').textContent, /Last recorded readings/);
  assert.equal(ui.element('reading-age').hidden, false);
  assert.match(ui.element('detail').textContent, /last one arrived 3 minutes ago/);
});

test('one failed poll labels cached readings as reconnecting and a good poll clears the warning', async (t) => {
  const payload = reading();
  let failed = false;
  const ui = await client(t, async (path) => {
    if (path === '/api/live' && failed)
      return Response.json({ data: null }, { status: 503, headers: { 'X-Optimon-Fallback': '1' } });
    return Response.json(path === '/api/history' ? history(payload.data.generatedAt) : payload);
  });
  failed = true;
  await ui.poll();
  assert.equal(ui.document.body.dataset.state, 'reconnecting');
  assert.equal(ui.element('current-readings').hidden, false);
  assert.equal(ui.element('temperature-readings').hidden, false);
  assert.equal(ui.element('offline-readings').hidden, true);
  assert.equal(ui.element('reading-age').hidden, false);
  assert.match(ui.element('reading-age').textContent, /Last recorded readings/);
  assert.equal(ui.element('notice').hidden, false);
  failed = false;
  await ui.poll();
  assert.equal(ui.document.body.dataset.state, 'live');
  assert.equal(ui.element('reading-age').hidden, true);
  assert.equal(ui.element('notice').hidden, true);
});

test('repeated failures hide current readings, retain history and recover cleanly through stale data', async (t) => {
  let payload = reading();
  let failed = false;
  const ui = await client(t, async (path) => {
    if (path === '/api/live' && failed) throw new Error('unreachable');
    return Response.json(path === '/api/history' ? history(payload.data.generatedAt) : payload);
  });
  const table = [...ui.element('table-body').children];
  failed = true;
  await ui.poll();
  await ui.poll();
  assert.equal(ui.document.body.dataset.state, 'unavailable');
  assert.equal(ui.element('verdict').textContent, 'Can’t load readings right now.');
  assert.ok(!ui.element('detail').textContent.includes('home server is unreachable'));
  assert.equal(ui.element('current-readings').hidden, true);
  assert.equal(ui.element('temperature-readings').hidden, true);
  assert.equal(ui.element('offline-readings').hidden, false);
  assert.deepEqual(ui.element('table-body').children, table, 'cached history stays on screen');
  failed = false;
  payload = reading(3 * 86400);
  await ui.poll();
  assert.equal(ui.document.body.dataset.state, 'stale');
  assert.equal(ui.element('verdict').textContent, 'No fresh readings.');
  assert.equal(ui.element('current-readings').hidden, false);
  assert.equal(ui.element('temperature-readings').hidden, false);
  assert.equal(ui.element('offline-readings').hidden, true);
  assert.match(ui.element('reading-age').textContent, /3 days ago/);
  payload = reading();
  await ui.poll();
  assert.equal(ui.document.body.dataset.state, 'live');
  assert.equal(ui.element('reading-age').hidden, true);
});

test('unreadable metrics display dashes while a measured zero remains a real reading', async (t) => {
  let payload = reading(0, { cpuPercent: null, memory: null, temperatures: [] });
  const ui = await client(t, async (path) =>
    Response.json(path === '/api/history' ? history(payload.data.generatedAt) : payload),
  );
  for (const id of ['cpu-value', 'memory-value', 'temp-value'])
    assert.equal(ui.element(id).textContent, '–');
  assert.match(ui.element('memory-context').textContent, /Not reported/);
  payload = reading(0, { cpuPercent: 0 });
  await ui.poll();
  assert.equal(ui.element('cpu-value').textContent, '0.0');
});

test('a new visitor without any successful response immediately sees unavailable readings', async (t) => {
  const ui = await client(t, async () => Response.json({ data: null }, { status: 503 }));
  assert.equal(ui.document.body.dataset.state, 'unavailable');
  assert.equal(ui.element('verdict').textContent, 'Can’t load readings right now.');
  assert.equal(ui.element('current-readings').hidden, true);
  assert.ok(!ui.element('announce').textContent.includes('home server is unreachable'));
  assert.equal(ui.element('temperature-readings').hidden, true);
  assert.equal(ui.element('offline-readings').hidden, false);
});

test('a healthy home app waiting for its first export keeps the no-readings message across polls', async (t) => {
  let payload = null;
  const ui = await client(t, async (path) => {
    if (!payload)
      return Response.json(
        { status: { state: 'unavailable' }, data: null },
        { status: 503, headers: { 'X-Optimon-Origin': 'dashboard' } },
      );
    return Response.json(path === '/api/history' ? history(payload.data.generatedAt) : payload);
  });
  for (let i = 0; i < 3; i++) {
    assert.equal(ui.document.body.dataset.state, 'unavailable');
    assert.equal(ui.element('verdict').textContent, 'No readings yet.');
    assert.match(ui.element('detail').textContent, /dashboard is responding/);
    assert.equal(ui.element('current-readings').hidden, true);
    await ui.poll();
  }
  payload = reading();
  await ui.poll();
  assert.equal(ui.document.body.dataset.state, 'live');
  assert.equal(ui.element('current-readings').hidden, false);
});

test('only a fallback-marked response attributes an outage to home, and later network errors clear that claim', async (t) => {
  const payload = reading();
  let mode = 'live';
  const ui = await client(t, async (path) => {
    if (path === '/api/live') {
      if (mode === 'network') throw new TypeError('Failed to fetch');
      if (mode === 'fallback')
        return Response.json(
          { status: { state: 'unavailable' }, data: null },
          { status: 503, headers: { 'X-Optimon-Fallback': '1' } },
        );
    }
    return Response.json(path === '/api/history' ? history(payload.data.generatedAt) : payload);
  });
  mode = 'fallback';
  await ui.poll();
  assert.equal(ui.element('verdict').textContent, 'Reconnecting…');
  await ui.poll();
  assert.equal(ui.element('verdict').textContent, 'optiplex is currently unreachable.');
  assert.match(ui.element('announce').textContent, /home server is unreachable/);
  mode = 'network';
  await ui.poll();
  assert.equal(ui.element('verdict').textContent, 'Can’t load readings right now.');
  assert.ok(!ui.element('announce').textContent.includes('home server is unreachable'));
  assert.equal(ui.element('current-readings').hidden, true);
  assert.ok(!ui.element('notice').textContent.includes('connection was lost'));
  mode = 'live';
  await ui.poll();
  assert.equal(ui.document.body.dataset.state, 'live');
  assert.equal(ui.element('current-readings').hidden, false);
});

test('new live details preserve measured zero, unknown per-core values and optional disk visibility', async (t) => {
  let payload = reading(0, {
    cpuDetails: {
      iowaitPercent: 0,
      stealPercent: null,
      perCore: [
        { id: 0, percent: 0 },
        { id: 1, percent: null },
      ],
    },
    runnableTasks: 0,
    memoryBreakdown: { free: 0 },
    disk: { used: 0, available: 10 * 1024 ** 3, total: 10 * 1024 ** 3, percent: 0 },
  });
  const ui = await client(t, async (path) =>
    Response.json(path === '/api/history' ? history(payload.data.generatedAt) : payload),
  );
  assert.equal(ui.element('row-disk').hidden, false);
  assert.equal(ui.element('disk-value').textContent, '0.0');
  assert.match(ui.element('cpu-detail-note').textContent, /I\/O wait 0.0%.*Steal not reported/);
  const cores = ui.element('cpu-core-rows').children;
  assert.equal(cores[0].children[1].textContent, '0.0%');
  assert.equal(cores[1].children[1].textContent, 'not reported');
  assert.match(ui.element('process-note').textContent, /^0 runnable tasks/);
  assert.equal(ui.element('memory-detail-rows').children[0].children[1].textContent, '0.0 MiB');
  payload = reading(0, { disk: null });
  await ui.poll();
  assert.equal(ui.element('row-disk').hidden, true);
});

test('availability renders observed coverage and dated monitoring gaps as historical data', async (t) => {
  const payload = reading();
  const at = payload.data.generatedAt;
  const archive = history(at);
  archive.availability = {
    generatedAt: at,
    firstAt: at - 3600_000,
    lastAt: at,
    windows: [7, 30].map((days) => ({
      days,
      observedFrom: at - 3600_000,
      coveragePercent: 50,
      recordedMinutes: 30,
      expectedMinutes: 60,
      gapCount: 1,
      recentGaps: [
        { lastSeenAt: at - 3600_000, resumedAt: at - 30 * MINUTE, durationMs: 29 * MINUTE },
      ],
    })),
  };
  const ui = await client(t, async (path) =>
    Response.json(path === '/api/history' ? archive : payload),
  );
  assert.equal(ui.element('availability-7').textContent, '50.0%');
  assert.match(ui.element('availability-30-note').textContent, /30 of 60 observed minutes/);
  assert.match(ui.element('availability-updated').textContent, /^Archive summary as of/);
  assert.match(ui.element('gap-list').children[0].textContent, /next reading.*29\smin missing/);
});
