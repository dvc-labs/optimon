import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../dist/config.js';
import { safeError } from '../dist/log.js';

const env = {
  DISCORD_TOKEN: 'not-a-real-token', APPLICATION_ID: '1562643787510063217',
  GUILD_ID: '1562082957022204006', CHANNEL_ID: '1562960345860153444',
};

test('bot reports default to fifteen minutes with only the bot token and public IDs', () => {
  const config = loadConfig(env);
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

test('owner controls default off and accept only an exact Discord user ID', () => {
  assert.equal(loadConfig(env).adminId, null);
  assert.equal(loadConfig({ ...env, ADMIN_ID: '  ' }).adminId, null);
  assert.equal(loadConfig({ ...env, ADMIN_ID: ' 1562643787510063218 ' }).adminId, '1562643787510063218');
  for (const invalid of ['dave', '1.5626437875100632e18', '00000000000000000', '18446744073709551616']) {
    assert.throws(() => loadConfig({ ...env, ADMIN_ID: invalid }), (error) => {
      assert.equal(error.message, 'ADMIN_ID must be a Discord ID stored as a string.');
      return true;
    });
  }
});

test('thermal alerts default on and reject ambiguous configuration values', () => {
  assert.equal(loadConfig(env).thermalAlerts, true);
  assert.equal(loadConfig({ ...env, THERMAL_ALERTS_ENABLED: ' FALSE ' }).thermalAlerts, false);
  for (const invalid of ['yes', '0', 'maybe']) {
    assert.throws(() => loadConfig({ ...env, THERMAL_ALERTS_ENABLED: invalid }), /THERMAL_ALERTS_ENABLED/);
  }
});

test('error diagnostics omit tokens, request URLs and request bodies', () => {
  const sensitiveUrl = `https://discord.com/api/channels/${env.CHANNEL_ID}/messages?secret=private-value`;
  const error = Object.assign(new Error(`Secret ${env.DISCORD_TOKEN} ${sensitiveUrl}`), {
    name: 'DiscordAPIError', code: 50013, status: 403,
    requestBody: { token: env.DISCORD_TOKEN }, url: sensitiveUrl,
  });
  const result = JSON.stringify(safeError(error));
  assert.match(result, /50013/);
  assert.ok(!result.includes(env.DISCORD_TOKEN));
  assert.ok(!result.includes(sensitiveUrl));
  assert.ok(!result.includes('requestBody'));
});
