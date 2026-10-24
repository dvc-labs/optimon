import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { aboutEmbed, statsEmbed, FOOTER } from '../dist/embeds.js';
import { loadConfig } from '../dist/config.js';
import { isHealthy } from '../dist/health.js';
import { scheduleReports } from '../dist/scheduler.js';
import { BotReporter } from '../dist/reporter.js';

const config = loadConfig({
  DISCORD_TOKEN: 'not-a-real-token', APPLICATION_ID: '1562643787510063217',
  GUILD_ID: '1562082957022204006', CHANNEL_ID: '1562960345860153444',
});
const snapshot = {
  capturedAt: new Date('2026-10-23T00:00:00Z'), hostUptime: 90000, botUptime: 30,
  cpuPercent: 5, cores: 6, memory: { total: 8 * 1024 ** 3, used: 1024 ** 3, available: 7 * 1024 ** 3, percent: 12.5 },
  swap: { total: 4 * 1024 ** 3, free: 4 * 1024 ** 3, used: 0, percent: 0 },
  load: [0.1, 0.2, 0.3], temperatures: [{ label: 'Package id 0', celsius: 31 }], unavailable: [],
};

test('about, startup and stats share branding and distinguish host and process uptimes', () => {
  const embeds = [aboutEmbed(config), statsEmbed(snapshot, config, true), statsEmbed(snapshot, config)];
  for (const embed of embeds) {
    const payload = embed.toJSON();
    assert.equal(payload.footer.text, FOOTER);
    assert.ok(payload.timestamp);
    assert.ok(!JSON.stringify(payload).includes(config.token));
  }
  const startup = embeds[1].toJSON();
  assert.match(startup.description, /deployment or container restart/);
  assert.equal(startup.fields.find((field) => field.name === 'Host uptime').value, '1d 1h 0m');
  assert.equal(startup.fields.find((field) => field.name === 'Bot uptime').value, '0h 0m');
  assert.equal(embeds[0].toJSON().fields.find((field) => field.name === 'Scheduled reports').value,
    `Every 15 minutes in <#${config.channelId}>`);
});

test('bot delivery rejects missing, mismatched, DM and unsendable channels before posting metrics', async () => {
  let sends = 0;
  const channel = {
    id: config.channelId, guildId: config.guildId,
    isSendable: () => true, isDMBased: () => false,
    send: async () => { sends++; },
  };
  for (const invalid of [null, { ...channel, id: '1562960345860153445' },
    { ...channel, guildId: '1562082957022204007' },
    { ...channel, isDMBased: () => true }, { ...channel, isSendable: () => false }]) {
    const reporter = new BotReporter({ channels: { fetch: async () => invalid } }, config);
    await assert.rejects(reporter.send(statsEmbed(snapshot, config)), { name: 'ReportChannelMismatch' });
  }
  assert.equal(sends, 0);
});

test('startup and scheduled snapshots use the bot channel and disable mentions', async () => {
  const payloads = [];
  const fetchedIds = [];
  const channel = {
    id: config.channelId, guildId: config.guildId,
    isSendable: () => true, isDMBased: () => false,
    send: async (payload) => { payloads.push(payload); },
  };
  const reporter = new BotReporter({ channels: { fetch: async (id) => {
    fetchedIds.push(id); return channel;
  } } }, config);
  await reporter.send(statsEmbed(snapshot, config, true));
  await reporter.send(statsEmbed(snapshot, config));
  assert.deepEqual(fetchedIds, [config.channelId, config.channelId]);
  assert.equal(payloads.length, 2);
  for (const payload of payloads) {
    assert.deepEqual(payload.allowedMentions, { parse: [] });
    assert.equal(payload.embeds.length, 1);
    assert.equal(payload.embeds[0].toJSON().footer.text, FOOTER);
  }
});

test('bot delivery propagates permission failures so the scheduler can log and retry later', async () => {
  const failure = Object.assign(new Error('Missing permissions'), { code: 50013 });
  const reporter = new BotReporter({ channels: { fetch: async () => ({
    id: config.channelId, guildId: config.guildId,
    isSendable: () => true, isDMBased: () => false,
    send: async () => { throw failure; },
  }) } }, config);
  await assert.rejects(reporter.send(statsEmbed(snapshot, config)), failure);
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
