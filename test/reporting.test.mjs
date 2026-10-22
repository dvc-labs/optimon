import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { aboutEmbed, statsEmbed, FOOTER } from '../dist/embeds.js';
import { loadConfig } from '../dist/config.js';
import { isHealthy } from '../dist/health.js';
import { scheduleReports } from '../dist/scheduler.js';
import { WebhookReporter } from '../dist/webhook.js';

const config = loadConfig({
  DISCORD_TOKEN: 'not-a-real-token', APPLICATION_ID: '1562643787510063217',
  GUILD_ID: '1562082957022204006', CHANNEL_ID: '1562960345860153444',
  WEBHOOK_URL: `https://discord.com/api/webhooks/1562960345860153444/${'x'.repeat(60)}`,
});
const snapshot = {
  capturedAt: new Date('2026-10-23T00:00:00Z'), hostUptime: 90000, botUptime: 30,
  cpuPercent: 5, cores: 6, memory: { total: 8 * 1024 ** 3, used: 1024 ** 3, available: 7 * 1024 ** 3, percent: 12.5 },
  load: [0.1, 0.2, 0.3], temperatures: [{ label: 'Package id 0', celsius: 31 }], unavailable: [],
};

test('about, startup and stats share branding and distinguish host and process uptimes', () => {
  const embeds = [aboutEmbed(config), statsEmbed(snapshot, config, true), statsEmbed(snapshot, config)];
  for (const embed of embeds) {
    const payload = embed.toJSON();
    assert.equal(payload.footer.text, FOOTER);
    assert.ok(payload.timestamp);
    assert.ok(!JSON.stringify(payload).includes(config.token));
    assert.ok(!JSON.stringify(payload).includes(config.webhookUrl));
  }
  const startup = embeds[1].toJSON();
  assert.match(startup.description, /deployment or container restart/);
  assert.equal(startup.fields.find((field) => field.name === 'Host uptime').value, '1d 1h 0m');
  assert.equal(startup.fields.find((field) => field.name === 'Bot uptime').value, '0h 0m');
});

test('webhook verification rejects a different channel before posting any metrics', async () => {
  let sends = 0;
  const reporter = new WebhookReporter(config, {
    fetch: async () => ({ channel_id: '1562960345860153445', guild_id: config.guildId }),
    send: async () => { sends++; }, destroy() {},
  });
  await assert.rejects(reporter.send(statsEmbed(snapshot, config)), /target does not match/);
  assert.equal(sends, 0);
});

test('verified reports disable mentions and send one consistent embed', async () => {
  const payloads = [];
  const reporter = new WebhookReporter(config, {
    fetch: async () => ({ channel_id: config.channelId, guild_id: config.guildId }),
    send: async (payload) => { payloads.push(payload); }, destroy() {},
  });
  await reporter.send(statsEmbed(snapshot, config));
  assert.deepEqual(payloads[0].allowedMentions, { parse: [] });
  assert.equal(payloads[0].embeds.length, 1);
});

test('report scheduling waits a full interval, never overlaps and stops cleanly', async () => {
  let runs = 0;
  let active = 0;
  let maximum = 0;
  let release;
  const firstStarted = new Promise((resolve) => {
    release = resolve;
  });
  let finish;
  const gate = new Promise((resolve) => { finish = resolve; });
  const stop = scheduleReports(async () => {
    runs++; active++; maximum = Math.max(maximum, active);
    release();
    await gate;
    active--;
  }, 10, () => {});
  try {
    assert.equal(runs, 0);
    await firstStarted;
    await delay(30);
    assert.equal(runs, 1);
    assert.equal(maximum, 1);
    stop(); finish();
    await delay(30);
    assert.equal(runs, 1);
  } finally { stop(); finish(); }
});

test('health checks require Discord readiness and a fresh heartbeat', () => {
  assert.equal(isHealthy({ ready: true, updatedAt: 1000 }, 2000), true);
  assert.equal(isHealthy({ ready: true, updatedAt: 1000 }, 100000), false);
  assert.equal(isHealthy({ ready: false, updatedAt: 1000 }, 2000), false);
  assert.equal(isHealthy({ ready: true, updatedAt: NaN }, 2000), false);
  assert.equal(isHealthy({ ready: true, updatedAt: 100000 }, 2000), false);
});
