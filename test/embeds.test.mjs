import test from 'node:test';
import assert from 'node:assert/strict';
import { aboutEmbed, helpEmbed, historyEmbed, pingEmbed, uptimeEmbed, vibeEmbed,
  diagnosticsEmbed, thermalEmbed, statsEmbed, FOOTER } from '../dist/embeds.js';
import { History } from '../dist/history.js';
import { config, snapshot } from './fixtures.mjs';

test('every v0.2 embed has the release footer, a timestamp and Discord-valid field lengths', () => {
  const cfg = config();
  const data = snapshot();
  const history = new History();
  history.record(data);
  const embeds = [aboutEmbed(cfg), helpEmbed(), historyEmbed(history.summary(1440, data.capturedAt.getTime())),
    pingEmbed(42, 57), uptimeEmbed(data, cfg), vibeEmbed(data), statsEmbed(data, cfg),
    thermalEmbed('hot', data), thermalEmbed('recovered', data), diagnosticsEmbed(data, cfg, {
      rss: 100 * 1024 ** 2, heapUsed: 20 * 1024 ** 2, heapTotal: 30 * 1024 ** 2,
      gatewayMs: 42, historySize: 100, now: data.capturedAt.getTime() + 2000,
      reports: { pausedUntil: null, lastReportAt: null, failures: 0 },
    })];
  assert.match(FOOTER, /v0\.2\.0/);
  for (const embed of embeds) {
    const payload = embed.toJSON();
    assert.equal(payload.footer.text, FOOTER);
    assert.ok(payload.timestamp);
    assert.ok(payload.title.length <= 256);
    assert.ok(payload.description.length <= 4096);
    assert.ok(payload.fields.length <= 25);
    let length = payload.title.length + payload.description.length + payload.footer.text.length + payload.author.name.length;
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
  assert.match(field('Estimated host boot'), new RegExp(String(Math.floor(data.capturedAt.getTime() / 1000 - 90000))));
  assert.match(field('Estimated bot start'), new RegExp(String(Math.floor(data.capturedAt.getTime() / 1000 - 30))));
  assert.equal(uptimeEmbed(snapshot({ hostUptime: null }), config()).toJSON().fields
    .find((item) => item.name === 'Estimated host boot').value, 'Unavailable');
});

test('fun and ping commands remain honest when telemetry or Discord heartbeats are unavailable', () => {
  const unavailable = snapshot({ cpuPercent: null, memory: null, swap: null, temperatures: [] });
  assert.match(vibeEmbed(unavailable).toJSON().description, /sensors/);
  assert.match(pingEmbed(-1, 2).toJSON().fields[0].value, /Waiting/);
  const swap = (data) => statsEmbed(data, config()).toJSON().fields.find((field) => field.name === 'Host swap').value;
  assert.equal(swap(unavailable), 'Unavailable');
  assert.equal(swap(snapshot({ swap: { total: 0, free: 0, used: 0, percent: 0 } })), 'Not configured');
  assert.equal(swap(snapshot()), '0.00 GiB / 4.00 GiB in use');
});
