import test from 'node:test';
import assert from 'node:assert/strict';
import { historyGraph, isHistoryPoint, pointFromSnapshot } from '../dist/history.js';
import { snapshot } from './fixtures.mjs';

test('periodic snapshots become compact readings rounded to one decimal', () => {
  const data = snapshot({
    cpuPercent: 12.345,
    memory: { percent: 23.456 },
    temperatures: [{ celsius: 31.234 }, { celsius: 40.156 }],
  });
  assert.deepEqual(pointFromSnapshot(data), {
    at: data.capturedAt.getTime(),
    cpu: 12.3,
    memory: 23.5,
    temperature: 40.2,
  });
  assert.equal(data.cpuPercent, 12.345, 'thermal/live data is not modified');
});
test('missing metrics stay null and invalid snapshots do not reach storage', () => {
  const data = snapshot({ cpuPercent: null, memory: null, temperatures: [] });
  assert.equal(pointFromSnapshot(data).cpu, null);
  for (const value of [
    snapshot({ capturedAt: new Date('invalid') }),
    snapshot({ cpuPercent: Infinity }),
    snapshot({ cpuPercent: 101 }),
  ])
    assert.equal(pointFromSnapshot(value), null);
});
test('history input validates timestamps and finite metric ranges', () => {
  const valid = pointFromSnapshot(snapshot());
  assert.equal(isHistoryPoint(valid), true);
  for (const invalid of [
    null,
    {},
    { ...valid, at: -1 },
    { ...valid, at: 1.5 },
    { ...valid, cpu: NaN },
    { ...valid, memory: 101 },
    { ...valid, temperature: 151 },
  ])
    assert.equal(isHistoryPoint(invalid), false);
});
test('fixed-scale graphs retain gaps, zero values and saturated temperatures', () => {
  assert.equal(historyGraph([null, 0, 25, 50, 100, 150, -20]), '·▁▃▅██▁');
});
