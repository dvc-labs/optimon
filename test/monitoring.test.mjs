import test from 'node:test';
import assert from 'node:assert/strict';
import { MetricsCache, SNAPSHOT_CACHE_MS, ThermalWatch } from '../dist/monitoring.js';
import { Cooldown, ReportControls } from '../dist/controls.js';
import { snapshot } from './fixtures.mjs';

test('concurrent metrics requests share a read and expire at the cache boundary', async () => {
  let now = snapshot().capturedAt.getTime();
  let reads = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const cache = new MetricsCache(async () => {
    reads++;
    if (reads === 1) await gate;
    return snapshot({ capturedAt: new Date(now) });
  }, () => now);
  const first = cache.getSnapshot();
  const second = cache.getSnapshot();
  assert.equal(reads, 1);
  release();
  assert.equal(await first, await second);
  now += SNAPSHOT_CACHE_MS - 1;
  assert.equal(await cache.getSnapshot(), cache.last);
  assert.equal(reads, 1);
  now++;
  await cache.getSnapshot();
  assert.equal(reads, 2);
  now -= 5000;
  await cache.getSnapshot();
  assert.equal(reads, 3, 'a backwards clock must not return a future-dated snapshot');
});

test('failed collections can be retried instead of poisoning the metrics cache', async () => {
  let reads = 0;
  const result = snapshot();
  const cache = new MetricsCache(async () => {
    if (++reads === 1) throw new Error('fixture failure');
    return result;
  });
  await assert.rejects(cache.getSnapshot(), /fixture failure/);
  assert.equal(cache.last, null);
  assert.equal(await cache.getSnapshot(), result);
});

function temperatures() {
  let at = snapshot().capturedAt.getTime();
  return (value, gap = 60_000) => {
    at += gap;
    return snapshot({ capturedAt: new Date(at), temperatures: value === null ? [] : [
      { label: 'Package id 0', celsius: value - 5 }, { label: 'Core 2', celsius: value },
    ] });
  };
}

test('thermal warnings use the hottest CPU sensor and hysteresis rather than one-off spikes', () => {
  const next = temperatures();
  const watch = new ThermalWatch();
  assert.equal(watch.observe(next(81)), null);
  assert.equal(watch.observe(next(79)), null);
  assert.equal(watch.observe(next(80)), null);
  assert.equal(watch.observe(next(80)), 'hot');
  watch.confirm('hot');
  assert.equal(watch.active, true);
  assert.equal(watch.observe(next(95)), null);
  assert.equal(watch.observe(next(95)), null, 'a confirmed warning must not repeat every minute');
  assert.equal(watch.observe(next(75)), null);
  assert.equal(watch.observe(next(76)), null, 'middle-band readings interrupt consecutive recovery');
  assert.equal(watch.observe(next(74)), null);
  assert.equal(watch.observe(next(75)), 'recovered');
  watch.confirm('recovered');
  assert.equal(watch.active, false);
  assert.equal(watch.observe(next(74)), null);
  assert.equal(watch.observe(next(74)), null);
});

test('missing, duplicate and widely separated readings cannot create a thermal transition', () => {
  const next = temperatures();
  const watch = new ThermalWatch();
  const first = next(85);
  assert.equal(watch.observe(first), null);
  assert.equal(watch.observe(first), null, 'a cached timestamp counts once');
  assert.equal(watch.observe(next(null)), null);
  assert.equal(watch.observe(next(85)), null);
  assert.equal(watch.observe(next(85, 180_000)), null, 'a gap resets the streak');
  assert.equal(watch.observe(next(85, -60_000)), null, 'a backwards timestamp resets the streak');
  assert.equal(watch.observe(next(85)), 'hot');
  watch.confirm('hot');
  assert.equal(watch.observe(next(null)), null);
  assert.equal(watch.active, true, 'an unreadable sensor is not evidence of recovery');
});

test('failed thermal delivery stays unconfirmed and can retry on the next sample', () => {
  const next = temperatures();
  const watch = new ThermalWatch();
  assert.equal(watch.observe(next(85)), null);
  assert.equal(watch.observe(next(85)), 'hot');
  // Simulate failed delivery by withholding confirm().
  assert.equal(watch.active, false);
  assert.equal(watch.observe(next(85)), 'hot');
  watch.confirm('hot');
  assert.equal(watch.observe(next(70)), null);
  assert.equal(watch.observe(next(70)), 'recovered');
  assert.equal(watch.observe(next(70)), 'recovered');
  watch.confirm('recovered');
  assert.equal(watch.observe(next(70)), null);
});

test('report pauses are temporary, bounded and independent of report counters', () => {
  const reports = new ReportControls();
  assert.equal(reports.pause(5, 1000), 301000);
  assert.equal(reports.isPaused(300999), true);
  assert.equal(reports.isPaused(301000), false);
  assert.equal(reports.status(301000).pausedUntil, null);
  for (const value of [0, 4, 1441, 1.5, NaN]) assert.throws(() => reports.pause(value));
  reports.lastReportAt = 500;
  reports.failures = 2;
  reports.pause(1440);
  reports.resume();
  assert.deepEqual(reports.status(), { pausedUntil: null, lastReportAt: 500, failures: 2 });
  assert.deepEqual(new ReportControls().status(), { pausedUntil: null, lastReportAt: null, failures: 0 });
});

test('cooldowns expire per user and bound their user map', () => {
  const cooldown = new Cooldown(10_000, 2);
  assert.equal(cooldown.take('a', 1000), 0);
  assert.equal(cooldown.take('a', 2000), 9000);
  assert.equal(cooldown.take('b', 2000), 0);
  assert.equal(cooldown.take('c', 3000), 0);
  assert.equal(cooldown.take('b', 3000), 9000);
  assert.equal(cooldown.take('a', 3000), 0, 'the oldest entry is evicted at capacity');
  assert.equal(cooldown.take('a', 13000), 0);
});
