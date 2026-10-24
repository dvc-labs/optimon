import test from 'node:test';
import assert from 'node:assert/strict';
import { History, HISTORY_LIMIT, HISTORY_MS, isHistoryPoint } from '../dist/history.js';
import { snapshot } from './fixtures.mjs';

const now = snapshot().capturedAt.getTime();
function at(agoMinutes, overrides = {}) {
  return snapshot({ capturedAt: new Date(now - agoMinutes * 60_000), ...overrides });
}

test('history windows show sampled averages and leave missing time buckets visible', () => {
  const history = new History();
  history.record(at(120, { cpuPercent: 99 }));
  history.record(at(59, { cpuPercent: 0 }));
  history.record(at(1, { cpuPercent: 100 }));
  const hour = history.summary(60, now);
  assert.equal(hour.count, 2);
  assert.equal(hour.cpu.count, 2);
  assert.equal(hour.cpu.min, 0);
  assert.equal(hour.cpu.max, 100);
  assert.equal(hour.cpu.mean, 50);
  assert.equal(hour.cpu.graph, `▁${'·'.repeat(22)}█`);
  assert.equal(hour.firstAt, now - 59 * 60_000);
  assert.equal(hour.lastAt, now - 60_000);
  assert.equal(history.summary(360, now).count, 3);
  assert.throws(() => history.summary(30, now));
});

test('missing metric samples are not graphed as zeros and duplicates are ignored', () => {
  const history = new History();
  const missing = at(2, { cpuPercent: null, memory: null, temperatures: [] });
  history.record(missing);
  history.record(missing);
  let result = history.summary(60, now);
  assert.equal(result.count, 1);
  assert.equal(result.cpu, null);
  assert.equal(result.memory, null);
  assert.equal(result.temperature, null);
  history.record(
    at(1, {
      cpuPercent: 50,
      temperatures: [
        { label: 'Package id 0', celsius: 80 },
        { label: 'Core 3', celsius: 110 },
      ],
    }),
  );
  result = history.summary(60, now);
  assert.equal(result.count, 2);
  assert.equal(result.cpu.count, 1);
  assert.equal(result.cpu.mean, 50);
  assert.equal(
    result.temperature.max,
    110,
    'actual temperatures above the graph ceiling remain exact',
  );
  assert.equal(result.temperature.graph.at(-1), '█');
});

test('history retention is capped by count and time, and a clock reset removes future points', () => {
  const history = new History();
  for (let i = 0; i <= HISTORY_LIMIT; i++) {
    history.record(snapshot({ capturedAt: new Date(now + i * 1000) }));
  }
  assert.equal(history.size, HISTORY_LIMIT);
  const later = now + HISTORY_MS + HISTORY_LIMIT * 1000 + 1;
  history.record(snapshot({ capturedAt: new Date(later) }));
  assert.equal(history.size, 1);
  history.record(snapshot({ capturedAt: new Date(now) }));
  assert.equal(history.size, 1);
  assert.equal(history.summary(60, now).lastAt, now);
  history.record(snapshot({ capturedAt: new Date(NaN) }));
  assert.equal(history.size, 1);
  assert.equal(
    new History().summary(1440, now).count,
    0,
    'restart begins without historical samples',
  );
});

test('restoration keeps recent readings, deduplicates and leaves offline periods as gaps', () => {
  const history = new History();
  const point = (agoMinutes, cpu) => ({
    at: now - agoMinutes * 60_000,
    cpu,
    memory: 25,
    temperature: 31,
  });
  history.restore([point(1, 20), point(2000, 99), point(-1, 99), point(59, 10), point(1, 30)], now);
  const result = history.summary(60, now);
  assert.equal(result.count, 2);
  assert.equal(result.cpu.mean, 20);
  assert.equal(result.firstAt, now - 59 * 60_000);
  assert.equal(result.lastAt, now - 60_000);
  assert.equal(result.cpu.graph.slice(1, -1), '·'.repeat(22));
  const exported = history.exportPoints(now);
  exported[0].cpu = 99;
  assert.equal(history.summary(60, now).cpu.min, 10, 'exported data cannot mutate live history');
  assert.deepEqual(history.exportPoints(now + HISTORY_MS + 1), []);
  history.restore(
    Array.from({ length: HISTORY_LIMIT + 10 }, (_, i) => ({
      ...point(1, 50),
      at: now - 10000 + i,
    })),
    now,
  );
  assert.equal(history.size, HISTORY_LIMIT);
});

test('stored readings require finite, bounded metrics while preserving missing values', () => {
  const valid = { at: now, cpu: 0, memory: 100, temperature: -30 };
  assert.equal(isHistoryPoint(valid), true);
  assert.equal(isHistoryPoint({ at: now, cpu: null, memory: null, temperature: null }), true);
  for (const invalid of [
    null,
    {},
    { ...valid, at: NaN },
    { ...valid, at: -1 },
    { ...valid, at: 1.5 },
    { ...valid, cpu: 101 },
    { ...valid, memory: Infinity },
    { ...valid, temperature: 151 },
    { ...valid, temperature: '31' },
  ]) {
    assert.equal(isHistoryPoint(invalid), false);
  }
});
