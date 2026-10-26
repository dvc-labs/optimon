import test from 'node:test';
import assert from 'node:assert/strict';
import { TelemetryStore } from '../dist/telemetry.js';
import { queryAvailability, GAP_THRESHOLD_MS } from '../dist/availability.js';
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

test('an empty archive has unknown coverage, not invented zero availability or an outage', async (t) => {
  const store = await archive(t);
  const result = queryAvailability(store.db, now);
  assert.equal(result.firstAt, null);
  assert.equal(result.lastAt, null);
  for (const window of result.windows) {
    assert.equal(window.coveragePercent, null);
    assert.equal(window.expectedMinutes, 0);
    assert.equal(window.gapCount, 0);
    assert.deepEqual(window.recentGaps, []);
  }
});

test('coverage starts at first observation, deduplicates minute buckets and ignores future readings', async (t) => {
  const store = await archive(t, [now - 2 * MINUTE, now - 2 * MINUTE + 1000, now, now + MINUTE]);
  const result = queryAvailability(store.db, now);
  assert.equal(result.lastAt, now);
  for (const window of result.windows) {
    assert.equal(window.observedFrom, now - 2 * MINUTE);
    assert.equal(window.expectedMinutes, 3);
    assert.equal(window.recordedMinutes, 2);
    assert.equal(window.coveragePercent, 66.7);
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
  assert.equal(week.missingMs, 7 * DAY - MINUTE);
  assert.equal(week.recentGaps[1].lastSeenAt, now - 8 * DAY);
  assert.equal(week.recentGaps[1].durationMs, 5 * DAY);
  assert.equal(week.recentGaps[0].resumedAt, now);
  assert.equal(result.windows[1].observedFrom, now - 8 * DAY);
});

test('the ongoing tail is included only past the gap threshold and duration excludes one expected interval', async (t) => {
  const store = await archive(t, [now - GAP_THRESHOLD_MS]);
  assert.equal(queryAvailability(store.db, now).windows[0].gapCount, 0);
  const window = queryAvailability(store.db, now + 1).windows[0];
  assert.equal(window.gapCount, 1);
  assert.equal(window.recentGaps[0].resumedAt, null);
  assert.equal(window.missingMs, GAP_THRESHOLD_MS + 1 - MINUTE);
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
