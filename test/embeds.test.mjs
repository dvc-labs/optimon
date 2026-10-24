import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aboutEmbed,
  helpEmbed,
  historyEmbed,
  pingEmbed,
  uptimeEmbed,
  vibeEmbed,
  diagnosticsEmbed,
  thermalEmbed,
  statsEmbed,
  auditEmbed,
  comparisonEmbed,
  FOOTER,
  BRAND_COLOR,
} from '../dist/embeds.js';
import { THERMAL_WARN_C, THERMAL_RECOVER_C } from '../dist/monitoring.js';
import { config, snapshot, historySummary, telemetryStatus } from './fixtures.mjs';

test('every v0.2 embed has the release footer, a timestamp and Discord-valid field lengths', () => {
  const cfg = config();
  const data = snapshot();
  const summary = historySummary();
  const embeds = [
    aboutEmbed(cfg),
    helpEmbed(),
    historyEmbed(summary),
    auditEmbed([]),
    comparisonEmbed({ current: summary, previous: summary }),
    pingEmbed(42, 57),
    uptimeEmbed(data, cfg),
    vibeEmbed(data),
    statsEmbed(data, cfg),
    thermalEmbed('hot', data),
    thermalEmbed('recovered', data),
    diagnosticsEmbed(data, cfg, {
      rss: 100 * 1024 ** 2,
      heapUsed: 20 * 1024 ** 2,
      heapTotal: 30 * 1024 ** 2,
      gatewayMs: 42,
      now: data.capturedAt.getTime() + 2000,
      reports: { pausedUntil: null, lastReportAt: null, failures: 0 },
      historyStorage: telemetryStatus({ lastSavedAt: data.capturedAt.getTime() }),
    }),
  ];
  assert.match(FOOTER, /v0\.2\.3/);
  for (const embed of embeds) {
    const payload = embed.toJSON();
    assert.equal(payload.footer.text, FOOTER);
    assert.ok(payload.timestamp);
    assert.ok(payload.title.length <= 256);
    assert.ok(payload.description.length <= 4096);
    assert.ok(payload.fields.length <= 25);
    let length =
      payload.title.length +
      payload.description.length +
      payload.footer.text.length +
      payload.author.name.length;
    for (const field of payload.fields) {
      assert.ok(field.name.length <= 256);
      assert.ok(field.value.length >= 1 && field.value.length <= 1024);
      length += field.name.length + field.value.length;
    }
    assert.ok(length <= 6000);
    assert.ok(!JSON.stringify(payload).includes(cfg.token));
    assert.ok(!JSON.stringify(payload).includes(cfg.adminId));
  }
});

test('uptime estimates keep host boot and bot start separate', () => {
  const data = snapshot();
  const result = uptimeEmbed(data, config()).toJSON();
  const field = (name) => result.fields.find((item) => item.name === name).value;
  assert.equal(field('Host uptime'), '1d 1h 0m');
  assert.equal(field('Bot uptime'), '0h 0m');
  assert.match(
    field('Estimated host boot'),
    new RegExp(String(Math.floor(data.capturedAt.getTime() / 1000 - 90000))),
  );
  assert.match(
    field('Estimated bot start'),
    new RegExp(String(Math.floor(data.capturedAt.getTime() / 1000 - 30))),
  );
  assert.equal(
    uptimeEmbed(snapshot({ hostUptime: null }), config())
      .toJSON()
      .fields.find((item) => item.name === 'Estimated host boot').value,
    'Unavailable',
  );
});

test('fun and ping commands remain honest when telemetry or Discord heartbeats are unavailable', () => {
  const unavailable = snapshot({ cpuPercent: null, memory: null, swap: null, temperatures: [] });
  assert.match(vibeEmbed(unavailable).toJSON().description, /sensors/);
  assert.match(pingEmbed(-1, 2).toJSON().fields[0].value, /Waiting/);
  const swap = (data) =>
    statsEmbed(data, config())
      .toJSON()
      .fields.find((field) => field.name === 'Host swap').value;
  assert.equal(swap(unavailable), 'Unavailable');
  assert.equal(
    swap(snapshot({ swap: { total: 0, free: 0, used: 0, percent: 0 } })),
    'Not configured',
  );
  assert.equal(swap(snapshot()), '0.00 GiB / 4.00 GiB in use');
});

test('owner diagnostics distinguish retained history from transient process state and report failed saves', () => {
  const data = snapshot();
  const details = {
    rss: 100 * 1024 ** 2,
    heapUsed: 20 * 1024 ** 2,
    heapTotal: 30 * 1024 ** 2,
    gatewayMs: 42,
    now: data.capturedAt.getTime(),
    reports: { pausedUntil: null, lastReportAt: null, failures: 0 },
    historyStorage: telemetryStatus({ healthy: false, lastSavedAt: null }),
  };
  const degraded = diagnosticsEmbed(data, config(), details).toJSON();
  assert.match(degraded.description, /persisted history/);
  assert.match(
    degraded.fields.find((field) => field.name === 'History queries').value,
    /Read-only worker/,
  );
  const status = degraded.fields.find((field) => field.name === 'History storage').value;
  assert.match(status, /Degraded/);
  assert.match(status, /None yet/);
  const healthy = diagnosticsEmbed(data, config(), {
    ...details,
    historyStorage: telemetryStatus({ lastSavedAt: details.now }),
  }).toJSON();
  assert.match(healthy.fields.find((field) => field.name === 'History storage').value, /Healthy/);
});

test('history and help explain persistence and offline gaps instead of claiming a restart resets history', () => {
  const result = historyEmbed(historySummary({ minutes: 60 })).toJSON();
  const coverage = result.fields.find((field) => field.name === 'Recorded coverage').value;
  assert.match(coverage, /survives restarts/);
  assert.match(coverage, /Offline periods appear as gaps/);
  assert.match(JSON.stringify(helpEmbed().toJSON()), /history stays on disk/);
});

test('stats colour, server mood, thermal notices and diagnostics share the alert thresholds', () => {
  const hot = snapshot({ temperatures: [{ label: 'Package id 0', celsius: THERMAL_WARN_C }] });
  const below = snapshot({
    temperatures: [{ label: 'Package id 0', celsius: THERMAL_WARN_C - 0.1 }],
  });
  assert.notEqual(statsEmbed(hot, config()).toJSON().color, BRAND_COLOR);
  assert.equal(statsEmbed(below, config()).toJSON().color, BRAND_COLOR);
  assert.match(vibeEmbed(hot).toJSON().description, /Toasty/);
  assert.doesNotMatch(vibeEmbed(below).toJSON().description, /Toasty/);
  assert.match(thermalEmbed('hot', hot).toJSON().description, new RegExp(`${THERMAL_WARN_C} °C`));
  assert.match(
    thermalEmbed('recovered', below).toJSON().description,
    new RegExp(`${THERMAL_RECOVER_C} °C`),
  );
});

test('a full audit page fits one Discord embed and excludes command arguments', () => {
  const entries = Array.from({ length: 20 }, (_, index) => ({
    command: 'diagnostics',
    outcome: 'interrupted',
    actorId: '1562643787510063218',
    startedAt: Date.now() - index * 60_000,
    finishedAt: Date.now(),
    durationMs: 123456,
    arguments: 'private-fixture-never-display',
  }));
  const payload = auditEmbed(entries).toJSON();
  assert.equal(payload.fields.length, 20);
  assert.ok(!JSON.stringify(payload).includes('private-fixture-never-display'));
  const length =
    payload.title.length +
    payload.description.length +
    payload.footer.text.length +
    payload.author.name.length +
    payload.fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0);
  assert.ok(length <= 6000);
});

test('long windows use days and comparison increases have explicit positive deltas', () => {
  const previous = historySummary({ minutes: 525600 });
  const current = historySummary({ minutes: 525600, cpu: { ...previous.cpu, mean: 8 } });
  assert.equal(historyEmbed(current).toJSON().title, 'Optiplex · Last 365d');
  const result = comparisonEmbed({ current, previous }).toJSON();
  assert.equal(result.title, 'Optiplex · Compare 365d windows');
  assert.match(
    result.fields.find((f) => f.name === 'CPU busy').value,
    /Δ \+3\.0 percentage points/,
  );
  current.cpu.mean = 2;
  assert.match(comparisonEmbed({ current, previous }).toJSON().fields[0].value, /Δ -3\.0/);
});
