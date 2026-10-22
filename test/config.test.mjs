import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, validateWebhookUrl } from '../dist/config.js';
import { safeError } from '../dist/log.js';

const env = {
  DISCORD_TOKEN: 'not-a-real-token', APPLICATION_ID: '1562643787510063217',
  GUILD_ID: '1562082957022204006', CHANNEL_ID: '1562960345860153444',
};
const webhook = `https://discord.com/api/webhooks/1562960345860153444/${'x'.repeat(60)}`;

test('webhook reports are opt-in and default to fifteen minutes', () => {
  const config = loadConfig(env);
  assert.equal(config.webhookUrl, null);
  assert.equal(config.intervalMinutes, 15);
  assert.equal(config.procPath, '/host-metrics/proc');
});

test('application IDs stay exact strings and the client ID alias cannot conflict', () => {
  assert.equal(loadConfig({ ...env, APPLICATION_ID: '', CLIENT_ID: env.APPLICATION_ID }).applicationId,
    env.APPLICATION_ID);
  assert.throws(() => loadConfig({ ...env, CLIENT_ID: '1562643787510063218' }), /must match/);
  assert.throws(() => loadConfig({ ...env, APPLICATION_ID: '1.5626437875100632e+18' }), /Discord ID/);
});

test('missing secrets and invalid report intervals fail clearly without exposing values', () => {
  assert.throws(() => loadConfig({ ...env, DISCORD_TOKEN: '' }), /Missing DISCORD_TOKEN/);
  for (const value of ['0', '-1', '1.5', 'NaN', '1441']) {
    assert.throws(() => loadConfig({ ...env, STATS_INTERVAL_MINUTES: value }), /STATS_INTERVAL_MINUTES/);
  }
});

test('webhook destinations cannot redirect metrics to arbitrary endpoints', () => {
  assert.equal(validateWebhookUrl(webhook), webhook);
  for (const value of [
    webhook.replace('discord.com', 'discord.com.attacker.example'),
    webhook.replace('https:', 'http:'), webhook.replace('discord.com', 'localhost'),
    webhook.replace('discord.com', 'user:password@discord.com'), `${webhook}?thread_id=123`,
  ]) assert.throws(() => validateWebhookUrl(value), /WEBHOOK_URL/);
});

test('error diagnostics omit tokens, request URLs and request bodies', () => {
  const error = Object.assign(new Error(`Secret ${env.DISCORD_TOKEN} ${webhook}`), {
    name: 'DiscordAPIError', code: 50013, status: 403,
    requestBody: { token: env.DISCORD_TOKEN }, url: webhook,
  });
  const result = JSON.stringify(safeError(error));
  assert.match(result, /50013/);
  assert.ok(!result.includes(env.DISCORD_TOKEN));
  assert.ok(!result.includes(webhook));
  assert.ok(!result.includes('requestBody'));
});
