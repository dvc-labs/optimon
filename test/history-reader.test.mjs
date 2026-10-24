import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArchiveReader, QUERY_CACHE_MS } from '../dist/history-reader.js';
import { HISTORY_WINDOWS } from '../dist/history.js';
import { TelemetryStore } from '../dist/telemetry.js';

async function fixture(t, create = true) {
  const directory = await mkdtemp(join(tmpdir(), 'optiplex-query-'));
  let now = Date.now();
  const path = join(directory, 'optiplex.sqlite');
  const store = create ? await TelemetryStore.open(path) : null;
  const reader = new ArchiveReader(path, () => now);
  t.after(async () => {
    await reader.close();
    store?.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    store,
    reader,
    path,
    now: () => now,
    advance: () => {
      now += QUERY_CACHE_MS;
    },
  };
}
const point = (at, cpu = 10) => ({ at, cpu, memory: 20, temperature: 30 });

test('concurrent queries coalesce, cached results are isolated and new data appears after the TTL', async (t) => {
  const f = await fixture(t);
  f.store.recordMetrics([point(f.now())]);
  const [a, b] = await Promise.all([f.reader.summary(60), f.reader.summary(60)]);
  assert.equal(a.count, 1);
  a.cpu.mean = 999;
  assert.equal(b.cpu.mean, 10);
  f.store.recordMetrics([point(f.now() - 1, 20)]);
  assert.equal((await f.reader.summary(60)).count, 1);
  f.advance();
  const refreshed = await f.reader.summary(60);
  assert.equal(refreshed.count, 2);
  assert.equal(refreshed.cpu.mean, 15);
});
test('all allowed windows and comparisons have a fixed cache/queue bound', async (t) => {
  const f = await fixture(t);
  f.store.recordMetrics([point(f.now())]);
  const requests = HISTORY_WINDOWS.flatMap((m) => [f.reader.summary(m), f.reader.compare(m)]);
  assert.equal(f.reader.pending.size, 12);
  await Promise.all(requests);
  assert.equal(f.reader.cache.size, 12);
  assert.equal(f.reader.pending.size, 0);
  await assert.rejects(f.reader.summary(42), { name: 'UnsupportedHistoryWindow' });
});
test('the query worker cannot mark an active command interrupted or modify the writer state', async (t) => {
  const f = await fixture(t);
  f.store.startCommand({
    id: '123',
    command: 'stats',
    actorId: '456',
    guildId: '789',
    channelId: null,
    startedAt: f.now(),
  });
  await f.reader.summary(60);
  assert.equal(f.store.recentCommands()[0].outcome, 'started');
  assert.equal(f.store.db.prepare('PRAGMA user_version').get().user_version, 1);
  f.store.recordMetrics([point(f.now())]);
  assert.equal((await f.reader.compare(60)).current.count, 1);
});
test('cold year-long comparisons allow main-thread timers to run while SQLite scans the archive', async (t) => {
  const f = await fixture(t);
  // More than a year at one sample/minute; setup is outside the responsiveness check.
  f.store.db
    .prepare(
      `WITH RECURSIVE samples(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM samples WHERE n<599999)
 INSERT INTO metrics(at,cpu,memory,temperature) SELECT ?-n*60000,n%100,25,30 FROM samples`,
    )
    .run(f.now());
  await f.reader.summary(60); // Warm up the worker, leaving the year-long cache cold.
  let ticks = 0;
  const timer = setInterval(() => {
    ticks++;
  }, 1);
  let result;
  try {
    result = await f.reader.compare(525600);
  } finally {
    clearInterval(timer);
  }
  assert.ok(ticks > 0, 'the Discord event loop must remain responsive during a cold query');
  assert.equal(result.current.count + result.previous.count, 600000);
  assert.equal(result.current.cpu.graph.length, 24);
});
test('worker startup failures are redacted and the next query can start a fresh worker', async (t) => {
  const f = await fixture(t, false);
  await assert.rejects(f.reader.summary(60), (error) => {
    assert.equal(error.name, 'ArchiveReaderUnavailable');
    assert.ok(!error.message.includes(f.path));
    return true;
  });
  const writer = await TelemetryStore.open(f.path);
  try {
    writer.recordMetrics([point(f.now())]);
    assert.equal((await f.reader.summary(60)).count, 1);
  } finally {
    await f.reader.close();
    writer.close();
  }
});
test('closing the reader rejects pending work, prevents new queries and terminates the worker', async (t) => {
  const f = await fixture(t);
  const pending = assert.rejects(f.reader.summary(525600), { name: 'ArchiveReaderClosed' });
  await f.reader.close();
  await pending;
  await assert.rejects(f.reader.summary(60), { name: 'ArchiveReaderClosed' });
  assert.equal(f.reader.worker, null);
});
