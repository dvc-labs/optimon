import test from 'node:test';
import assert from 'node:assert/strict';
import { TelemetryStore } from '../dist/telemetry.js';
import { queryAvailability, COVERAGE_GRACE_MS, GAP_THRESHOLD_MS } from '../dist/availability.js';
import { outagesEmbed, statsEmbed, uptimeEmbed } from '../dist/embeds.js';
import { config, snapshot } from './fixtures.mjs';

const MINUTE = 60_000;
const DAY = 86400_000;
const now = Date.parse('2026-10-26T12:00:00Z');
async function archive(t, times = []) {
  const store = await TelemetryStore.open(':memory:');
  t.after(() => store.close());
  store.recordMetrics(times.map((at) => ({ at, cpu: 5, memory: 10, temperature: 31 })));
  return store;
}

test('regular cadence stays fully covered across minute phases, drift and query times', async (t) => {
  const start = now - 7 * DAY;
  for (const spacing of [60_000, 61_000, 61_500, 62_000]) {
    for (const phase of [0, 29_999, 59_999]) {
      const times = [];
      for (let at = start + phase; at <= now; at += spacing) times.push(at);
      const store = await archive(t, times);
      // Exercise a young archive too: a minute-boundary phase error is much larger there.
      for (const queryAt of [
        times[3],
        times[3] + spacing - 1,
        times.at(-1),
        times.at(-1) + spacing - 1,
      ]) {
        for (const window of queryAvailability(store.db, queryAt).windows) {
          assert.equal(window.coveragePercent, 100, `${spacing} ms cadence, ${phase} ms phase`);
          assert.equal(window.gapCount, 0);
          assert.equal(window.missingMs, 0);
        }
      }
    }
  }
});

test('an empty archive has unknown coverage, not invented zero availability or an outage', async (t) => {
  const store = await archive(t);
  const result = queryAvailability(store.db, now);
  assert.equal(result.firstAt, null);
  assert.equal(result.lastAt, null);
  for (const window of result.windows) {
    assert.equal(window.coveragePercent, null);
    assert.equal(window.observedMs, 0);
    assert.equal(window.coveredMs, 0);
    assert.equal(window.missingMs, 0);
    assert.equal(window.gapCount, 0);
    assert.deepEqual(window.recentGaps, []);
  }
});

test('coverage starts at first observation, handles overlapping sample allowances and ignores future readings', async (t) => {
  const store = await archive(t, [now - 2 * MINUTE, now - 2 * MINUTE + 1000, now, now + MINUTE]);
  const result = queryAvailability(store.db, now);
  assert.equal(result.lastAt, now);
  for (const window of result.windows) {
    assert.equal(window.observedFrom, now - 2 * MINUTE);
    assert.equal(window.observedMs, 2 * MINUTE);
    assert.equal(window.coveredMs, COVERAGE_GRACE_MS + 1000);
    assert.equal(window.missingMs, 2 * MINUTE - COVERAGE_GRACE_MS - 1000);
    assert.equal(window.coveragePercent, 75.8);
    assert.equal(
      window.gapCount,
      0,
      'short missed samples affect coverage but are not extended gaps',
    );
  }
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 1);
  assert.equal(store.lastMetricAt(now), now);
});

test('a long gap crossing a window edge is clipped and uses its preceding real sample', async (t) => {
  const store = await archive(t, [now - 8 * DAY, now - 2 * DAY, now]);
  const result = queryAvailability(store.db, now);
  const week = result.windows[0];
  assert.equal(week.gapCount, 2);
  assert.equal(week.missingMs, 7 * DAY - COVERAGE_GRACE_MS);
  assert.equal(week.observedMs, 7 * DAY);
  assert.equal(week.coveredMs, COVERAGE_GRACE_MS);
  assert.equal(week.recentGaps[1].lastSeenAt, now - 8 * DAY);
  assert.equal(week.recentGaps[1].durationMs, 5 * DAY);
  assert.equal(week.recentGaps[0].resumedAt, now);
  assert.equal(result.windows[1].observedFrom, now - 8 * DAY);
});

test('the ongoing tail reduces coverage after the allowance but is listed only past the extended-gap threshold', async (t) => {
  const store = await archive(t, [now - GAP_THRESHOLD_MS]);
  const before = queryAvailability(store.db, now).windows[0];
  assert.equal(before.gapCount, 0);
  assert.equal(before.missingMs, GAP_THRESHOLD_MS - COVERAGE_GRACE_MS);
  const window = queryAvailability(store.db, now + 1).windows[0];
  assert.equal(window.gapCount, 1);
  assert.equal(window.recentGaps[0].resumedAt, null);
  assert.equal(window.missingMs, GAP_THRESHOLD_MS + 1 - COVERAGE_GRACE_MS);
});

test('first observation has no invented elapsed interval and a late next reading cannot extend the allowance', async (t) => {
  const store = await archive(t, [now, now + DAY]);
  const first = queryAvailability(store.db, now).windows[0];
  assert.equal(first.observedMs, 0);
  assert.equal(first.coveragePercent, null);
  assert.match(outagesEmbed(first).toJSON().fields[0].value, /waiting for elapsed monitoring time/);
  const timely = queryAvailability(store.db, now + COVERAGE_GRACE_MS).windows[0];
  assert.equal(timely.coveragePercent, 100);
  assert.equal(timely.missingMs, 0);
  const late = queryAvailability(store.db, now + COVERAGE_GRACE_MS + 1).windows[0];
  assert.equal(late.coveredMs, COVERAGE_GRACE_MS);
  assert.equal(late.missingMs, 1);
  assert.equal(late.recentGaps.length, 0);
});

test('one-hour and six-hour interruptions in a week lower time coverage by their missing duration', async (t) => {
  const start = now - 7 * DAY;
  const gapStart = start + DAY;
  for (const [hours, expectedPercent] of [
    [1, 99.4],
    [6, 96.4],
  ]) {
    const gapEnd = gapStart + hours * 3600_000;
    const times = [];
    for (let at = start; at <= now; at += MINUTE)
      if (at <= gapStart || at >= gapEnd) times.push(at);
    const store = await archive(t, times);
    const week = queryAvailability(store.db, now).windows[0];
    const missing = hours * 3600_000 - COVERAGE_GRACE_MS;
    assert.equal(week.coveragePercent, expectedPercent);
    assert.equal(week.observedMs, 7 * DAY);
    assert.equal(week.missingMs, missing);
    assert.equal(week.coveredMs + week.missingMs, week.observedMs);
    assert.equal(week.gapCount, 1);
    assert.deepEqual(week.recentGaps, [
      { lastSeenAt: gapStart, resumedAt: gapEnd, durationMs: missing },
    ]);
    const description = outagesEmbed(week).toJSON().fields[0].value;
    assert.match(description, new RegExp(`${expectedPercent}%.*estimated monitoring coverage`));
    assert.doesNotMatch(description, /minute buckets|\d+\/\d+/);
  }
});

test('an observation before a window can cover its leading edge; an expired one leaves the whole window missing', async (t) => {
  const start = now - 7 * DAY;
  const near = await archive(t, [start - 30_000]);
  const partlyCovered = queryAvailability(near.db, now).windows[0];
  assert.equal(partlyCovered.coveredMs, COVERAGE_GRACE_MS - 30_000);
  assert.equal(partlyCovered.missingMs, 7 * DAY - partlyCovered.coveredMs);
  const old = await archive(t, [start - DAY]);
  const uncovered = queryAvailability(old.db, now).windows[0];
  assert.equal(uncovered.coveredMs, 0);
  assert.equal(uncovered.coveragePercent, 0);
  assert.equal(uncovered.missingMs, 7 * DAY);
  assert.equal(uncovered.recentGaps[0].durationMs, uncovered.missingMs);
});

test('recent gaps are bounded and availability does not publish the command audit', async (t) => {
  const store = await archive(
    t,
    Array.from({ length: 20 }, (_, i) => now - i * 10 * MINUTE),
  );
  store.startCommand({
    id: 'secret',
    command: 'about',
    actorId: 'private-actor',
    guildId: 'private-guild',
    channelId: null,
    startedAt: now,
  });
  const availability = queryAvailability(store.db, now);
  assert.equal(availability.windows[0].gapCount, 19);
  assert.equal(availability.windows[0].recentGaps.length, 5);
  assert.ok(!JSON.stringify(availability).includes('private-actor'));
  assert.match(outagesEmbed(availability.windows[0]).toJSON().description, /no cause is inferred/);
  const uptime = uptimeEmbed(snapshot(), config(), availability).toJSON();
  assert.match(
    uptime.fields.find((field) => field.name === '7-day monitoring availability').value,
    /sample coverage, not proven host uptime/,
  );
});

test('startup notices distinguish first start, monitor restart and a boot during an observed gap', () => {
  const reading = snapshot({ capturedAt: new Date(now) });
  const first = statsEmbed(reading, config(), true, {
    previousAt: null,
    firstAt: now,
    bootTime: now - DAY,
  }).toJSON();
  assert.equal(first.title, 'Optimon is online');
  assert.match(first.description, /first recorded start/);
  const restarted = statsEmbed(reading, config(), true, {
    previousAt: now - MINUTE,
    firstAt: now,
    bootTime: now - DAY,
  }).toJSON();
  assert.equal(restarted.title, 'Optimon · Monitor restarted');
  assert.match(restarted.description, /already-running host/);
  const rebooted = statsEmbed(reading, config(), true, {
    previousAt: now - 3 * 3600_000,
    firstAt: now,
    bootTime: now - MINUTE,
  }).toJSON();
  assert.equal(rebooted.title, 'Optimon · Monitoring resumed');
  assert.match(rebooted.description, /3h 0m.*reboot since the previous reading/);
  assert.match(rebooted.description, /does not prove/);
  const unknown = statsEmbed(reading, config(), true, {
    previousAt: now - DAY,
    firstAt: now,
    bootTime: null,
  }).toJSON();
  assert.match(unknown.description, /cause is unknown/);
});
