import test from 'node:test';
import assert from 'node:assert/strict';
import { isAbsolute, resolve } from 'node:path';
import { loadConfig } from '../dist/config.js';
import { safeError } from '../dist/log.js';

const env = {
  DISCORD_TOKEN: 'not-a-real-token',
  APPLICATION_ID: '1562643787510063217',
  GUILD_ID: '1562082957022204006',
  CHANNEL_ID: '1562960345860153444',
};

test('bot reports default to sixty minutes with only the bot token and public IDs', () => {
  const config = loadConfig(env);
  assert.equal(config.intervalMinutes, 60);
  assert.equal(config.procPath, '/host-metrics/proc');
});

test('application IDs stay exact strings and the client ID alias cannot conflict', () => {
  assert.equal(
    loadConfig({ ...env, APPLICATION_ID: '', CLIENT_ID: env.APPLICATION_ID }).applicationId,
    env.APPLICATION_ID,
  );
  assert.throws(() => loadConfig({ ...env, CLIENT_ID: '1562643787510063218' }), /must match/);
  assert.throws(
    () => loadConfig({ ...env, APPLICATION_ID: '1.5626437875100632e+18' }),
    /Discord ID/,
  );
});

test('missing secrets and invalid report intervals fail clearly without exposing values', () => {
  assert.throws(() => loadConfig({ ...env, DISCORD_TOKEN: '' }), /Missing DISCORD_TOKEN/);
  for (const value of ['0', '-1', '1.5', 'NaN', '1441']) {
    assert.throws(
      () => loadConfig({ ...env, STATS_INTERVAL_MINUTES: value }),
      /STATS_INTERVAL_MINUTES/,
    );
  }
});

test('owner controls default off and accept only an exact Discord user ID', () => {
  assert.equal(loadConfig(env).adminId, null);
  assert.equal(loadConfig({ ...env, ADMIN_ID: '  ' }).adminId, null);
  assert.equal(
    loadConfig({ ...env, ADMIN_ID: ' 1562643787510063218 ' }).adminId,
    '1562643787510063218',
  );
  for (const invalid of [
    'dave',
    '1.5626437875100632e18',
    '00000000000000000',
    '18446744073709551616',
  ]) {
    assert.throws(
      () => loadConfig({ ...env, ADMIN_ID: invalid }),
      (error) => {
        assert.equal(error.message, 'ADMIN_ID must be a Discord ID stored as a string.');
        return true;
      },
    );
  }
});

test('thermal alerts default on and reject ambiguous configuration values', () => {
  assert.equal(loadConfig(env).thermalAlerts, true);
  assert.equal(loadConfig({ ...env, THERMAL_ALERTS_ENABLED: ' FALSE ' }).thermalAlerts, false);
  for (const invalid of ['yes', '0', 'maybe']) {
    assert.throws(
      () => loadConfig({ ...env, THERMAL_ALERTS_ENABLED: invalid }),
      /THERMAL_ALERTS_ENABLED/,
    );
  }
});

test('history defaults to a local data directory and explicit overrides must be absolute', () => {
  assert.equal(loadConfig(env).historyFile, resolve('data/history.json'));
  assert.equal(isAbsolute(loadConfig(env).historyFile), true);
  assert.equal(
    loadConfig({ ...env, HISTORY_FILE: '/app/data/history.json' }).historyFile,
    '/app/data/history.json',
  );
  assert.throws(
    () => loadConfig({ ...env, HISTORY_FILE: 'relative-secret-path/history.json' }),
    (error) => error.message === 'HISTORY_FILE must be an absolute path.',
  );
});

test('error diagnostics omit tokens, request URLs and request bodies', () => {
  const sensitiveUrl = `https://discord.com/api/channels/${env.CHANNEL_ID}/messages?secret=private-value`;
  const error = Object.assign(new Error(`Secret ${env.DISCORD_TOKEN} ${sensitiveUrl}`), {
    name: 'DiscordAPIError',
    code: 50013,
    status: 403,
    requestBody: { token: env.DISCORD_TOKEN },
    url: sensitiveUrl,
  });
  const result = JSON.stringify(safeError(error));
  assert.match(result, /50013/);
  assert.ok(!result.includes(env.DISCORD_TOKEN));
  assert.ok(!result.includes(sensitiveUrl));
  assert.ok(!result.includes('requestBody'));
});

test('audit retention defaults to 90 days, can be disabled and rejects ambiguous values', () => {
  assert.equal(loadConfig(env).auditRetentionDays, 90);
  assert.equal(loadConfig({ ...env, AUDIT_RETENTION_DAYS: '0' }).auditRetentionDays, 0);
  assert.equal(loadConfig({ ...env, AUDIT_RETENTION_DAYS: '30' }).auditRetentionDays, 30);
  for (const value of ['-1', '1.5', '3651', 'forever'])
    assert.throws(
      () => loadConfig({ ...env, AUDIT_RETENTION_DAYS: value }),
      /AUDIT_RETENTION_DAYS/,
    );
});

test('public exports stay outside private data directories and are disabled for local bot starts by default', () => {
  assert.equal(loadConfig(env).publicDataPath, null);
  const base = {
    ...env,
    DATABASE_FILE: '/app/data/optiplex.sqlite',
    HISTORY_FILE: '/app/data/history.json',
  };
  for (const path of ['relative', '/app/data', '/app/data/public', '/app', '/'])
    assert.throws(() => loadConfig({ ...base, PUBLIC_DATA_PATH: path }), /PUBLIC_DATA_PATH/);
  assert.equal(
    loadConfig({ ...base, PUBLIC_DATA_PATH: '/app/public-data' }).publicDataPath,
    '/app/public-data',
  );
});

test('optional disk and dashboard-link settings reject unsafe or ambiguous values', () => {
  assert.equal(loadConfig(env).diskPath, null);
  assert.equal(loadConfig(env).diskAlerts, true);
  assert.equal(loadConfig(env).dashboardUrl, null);
  assert.equal(loadConfig({ ...env, DISK_ALERTS_ENABLED: 'false' }).diskAlerts, false);
  for (const path of ['/', 'relative/path'])
    assert.throws(() => loadConfig({ ...env, HOST_DISK_PATH: path }), /HOST_DISK_PATH/);
  assert.throws(() => loadConfig({ ...env, DISK_ALERTS_ENABLED: 'yes' }), /DISK_ALERTS_ENABLED/);
  assert.equal(
    loadConfig({ ...env, DASHBOARD_PUBLIC_URL: 'https://dashboard.test/' }).dashboardUrl,
    'https://dashboard.test',
  );
  for (const url of [
    'http://dashboard.test',
    'https://private:secret@dashboard.test',
    'https://dashboard.test/a',
    'https://dashboard.test/?secret=value',
  ]) {
    assert.throws(
      () => loadConfig({ ...env, DASHBOARD_PUBLIC_URL: url }),
      (error) =>
        error.message.includes('DASHBOARD_PUBLIC_URL') && !error.message.includes('secret'),
    );
  }
});
